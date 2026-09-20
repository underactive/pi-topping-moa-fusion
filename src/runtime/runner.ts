/**
 * Subagent runner — spawns isolated pi subprocesses for moa-explore/mf-plan agents.
 * Ported from pi's subagent example.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../agents/discovery.ts";
import { normalizeMaxConcurrentAgents } from "../config/settings.ts";
import type { ThinkingLevel } from "../shared/modelRefs.ts";
import { OutputActivityTracker, PartialAssistantAssembler, formatToolActivity } from "./activityTracking.ts";
import { escalateKill, mapWithConcurrencyLimit, trackedProcesses } from "./processPool.ts";
import { getFinalOutput, type SingleResult } from "./results.ts";
import {
	StderrBeaconReader,
	isLlmMessage,
	isNonnegativeFiniteNumber,
	isValidContextTokens,
	parseSessionEvent,
	reconcileContextTokens,
} from "./wire.ts";

const MAX_PARALLEL_TASKS = 8;
const CHILD_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_DIAGNOSTIC_CHARS = 65_536;
const READ_ONLY_AGENT_TOOLS = ["read", "grep", "find", "ls"] as const;
const READ_ONLY_AGENT_TOOL_SET = new Set<string>(READ_ONLY_AGENT_TOOLS);
/**
 * Env handshake for provider bridges that wrap full local agents. Pi's --tools
 * allowlist only gates PI'S tool loop — an agentic provider (e.g.
 * cursor-bridge, whose models run Cursor agents with their own local
 * edit/shell tools in the repo cwd) can mutate files no matter what pi allows.
 * Every planning subprocess is spawned with these vars so such bridges switch
 * to their native read-only mode (cursor-bridge maps this to Cursor's "plan"
 * mode on the SDK path and `--mode plan` without `--force` on the CLI path;
 * claude-bridge maps "read" to disallowing Claude Code's mutation tools on
 * its provider path).
 */
export const READ_ONLY_SUBAGENT_ENV = Object.freeze({
	PI_CURSOR_FORCE_MODE: "plan",
	PI_CLAUDE_BRIDGE_FORCE_MODE: "read",
});
/** Opts provider extensions into the stderr usage-beacon protocol. */
const USAGE_BEACON_SUBAGENT_ENV = Object.freeze({ PI_USAGE_BEACON: "1" });

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-topping-moa-fusion-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

export function getReadOnlyAgentTools(configuredTools?: string[]): string[] {
	if (!configuredTools) return [...READ_ONLY_AGENT_TOOLS];
	return configuredTools.filter((tool) => READ_ONLY_AGENT_TOOL_SET.has(tool));
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

export interface RunSingleAgentOptions {
	/**
	 * Load all configured pi extensions in the child process. Retained as a
	 * fallback for extension-registered providers whose entry point cannot be
	 * isolated explicitly.
	 */
	loadExtensions?: boolean;
	/**
	 * Load exactly this provider extension. Combined with `--no-extensions`,
	 * this keeps unrelated global/project extensions out of MoA child processes.
	 */
	extensionPath?: string;
	/**
	 * Called on every streamed turn boundary (each `message_end`) with the live,
	 * in-progress result. Lets callers observe running usage — notably
	 * `usage.contextTokens` (the latest turn's total context size) — so a progress
	 * widget can show a growing context-usage bar while the agent works.
	 * `contextTokens` advances from `message_update` usage, authoritative
	 * `message_end` usage, and the stderr beacon; see
	 * docs/handoff-bridge-live-context.md.
	 */
	onProgress?: (result: SingleResult) => void;
	/**
	 * Resolve with a `cancelled: true` result instead of throwing
	 * "Subagent was aborted" when the abort signal fires. Lets parallel
	 * orchestration treat a user-cancelled agent as a graceful failure while
	 * sibling agents keep running. The throwing default is kept for callers
	 * that string-match the abort error (e.g. the MoA ping's warm retry).
	 */
	resolveOnAbort?: boolean;
	/** Abort grace period; exposed for focused process-boundary tests. */
	killTimeoutMs?: number;
}

export async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: AgentToolResult<unknown>) => void) | undefined,
	modelOverride?: string,
	thinkingOverride?: ThinkingLevel,
	options: RunSingleAgentOptions = {},
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cost: 0, turns: 0, toolCalls: 0 },
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (options.extensionPath) {
		args.push("--no-extensions", "-e", options.extensionPath);
	} else if (!options.loadExtensions) {
		args.push("--no-extensions");
	}
	const effectiveModel = modelOverride ?? agent.model;
	if (effectiveModel) args.push("--model", effectiveModel);
	// MoA fan-out and mf-plan pass explicit levels; the frontmatter default
	// only applies to tool-path agents spawned without one (e.g. moa-explore).
	const effectiveThinking = thinkingOverride ?? agent.thinking;
	if (effectiveThinking) args.push("--thinking", effectiveThinking);
	// Always pass an explicit read-only allowlist. Agent definitions live in a
	// user-writable directory and may be stale, customized, or omit `tools`;
	// none of those cases may grant a planning subprocess mutation capabilities.
	args.push("--tools", getReadOnlyAgentTools(agent.tools).join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cost: 0, turns: 0, toolCalls: 0 },
		model: effectiveModel,
	};

	const taskBytes = Buffer.byteLength(task);
	if (taskBytes > 128 * 1024) {
		currentResult.stderr = `Task argument size: ${taskBytes} bytes (exceeds 128 KiB).\n`;
	}

	const outputActivity = new OutputActivityTracker();
	const partialMessage = new PartialAssistantAssembler();

	const emitUpdate = () => {
		currentResult.outputActivity = outputActivity.snapshot();
		if (onUpdate) {
			onUpdate({
				details: undefined,
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
			});
		}
		options.onProgress?.(currentResult);
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				// Read-only handshake for agentic provider bridges (see
				// READ_ONLY_SUBAGENT_ENV). The pi --tools allowlist above cannot
				// restrain a bridged agent's own tools.
				env: { ...process.env, ...READ_ONLY_SUBAGENT_ENV, ...USAGE_BEACON_SUBAGENT_ENV },
			});
			trackedProcesses.add(proc);

			// Auto-remove from tracking when the process exits (normal or otherwise).
			proc.on("close", () => {
				trackedProcesses.delete(proc);
			});

			let buffer = "";
			const stderrReader = new StderrBeaconReader();
			let contextUsageIsAuthoritative = false;
			let idleTimer: ReturnType<typeof setTimeout> | undefined;
			const resetIdleTimer = () => {
				if (idleTimer) clearTimeout(idleTimer);
				idleTimer = setTimeout(() => escalateKill(proc, options.killTimeoutMs ?? 5000), CHILD_IDLE_TIMEOUT_MS);
			};
			resetIdleTimer();

			const appendDiagnostics = (diagnostics: string) => {
				currentResult.stderr = (currentResult.stderr + diagnostics).slice(-MAX_DIAGNOSTIC_CHARS);
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				try {
					const event = parseSessionEvent(line);
					if (!event) {
						appendDiagnostics("event parse error: invalid session event\n");
						return;
					}
					if (event.type === "message_start") {
					outputActivity.messageStart(event.message);
					partialMessage.start(event.message);
					if (event.message.role === "assistant") contextUsageIsAuthoritative = false;
				}

					if (event.type === "message_update") {
					outputActivity.messageUpdate(event.assistantMessageEvent);
					partialMessage.apply(event.assistantMessageEvent);
					currentResult.partialAssistant = partialMessage.snapshot();
					// Interim context reading. Providers that run a whole task as one turn emit a
					// single message_end, so without this the CTX bar sits at 0% for the run.
					// A malformed or absent reading is ignored rather than rejected upstream, so a
					// bad number never costs the run its text deltas.
					// "beacon" source: never lowers a value and never overrides an authoritative
					// message_end reading for the same turn.
					const liveTotal = event.usage?.totalTokens;
					if (isValidContextTokens(liveTotal)) {
						const reconciled = reconcileContextTokens(
							currentResult.usage.contextTokens,
							contextUsageIsAuthoritative,
							liveTotal,
							"beacon",
						);
						currentResult.usage.contextTokens = reconciled.contextTokens;
						contextUsageIsAuthoritative = reconciled.authoritative;
					}
					emitUpdate();
				}

					if (event.type === "message_end" && isLlmMessage(event.message)) {
					const msg = event.message;
					currentResult.messages.push(msg);
					currentResult.partialAssistant = undefined;
					partialMessage.clear();
					outputActivity.messageEnd(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							const nonnegative = (value: unknown): number => isNonnegativeFiniteNumber(value) ? value : 0;
							currentResult.usage.input += nonnegative(usage.input);
							currentResult.usage.output += nonnegative(usage.output);
							currentResult.usage.cacheRead += nonnegative(usage.cacheRead);
							currentResult.usage.cacheWrite += nonnegative(usage.cacheWrite);
							currentResult.usage.cacheWrite1h += nonnegative(usage.cacheWrite1h);
							currentResult.usage.cost += nonnegative(usage.cost?.total);
							if (isValidContextTokens(usage.totalTokens)) {
								const reconciled = reconcileContextTokens(
									currentResult.usage.contextTokens,
									contextUsageIsAuthoritative,
									usage.totalTokens,
									"message_end",
								);
								currentResult.usage.contextTokens = reconciled.contextTokens;
								contextUsageIsAuthoritative = reconciled.authoritative;
							}
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				// Real-time activity: surface the tool the agent is invoking right now,
				// so progress UIs can show what each parallel agent is doing (and spot
				// an agent stuck looping on the same call).
					if (event.type === "tool_execution_start") {
					currentResult.usage.toolCalls++;
					currentResult.activity = formatToolActivity(event.toolName, event.args);
					emitUpdate();
				}
				} catch (error) {
					appendDiagnostics(`event parse error: ${String(error)}\n`);
				}
			};

			const processStderr = (chunk: string, flush = false) => {
				const { beacons, diagnostics } = stderrReader.push(chunk, flush);
				appendDiagnostics(diagnostics);
				for (const beacon of beacons) {
					const reconciled = reconcileContextTokens(
						currentResult.usage.contextTokens,
						contextUsageIsAuthoritative,
						beacon,
						"beacon",
					);
					if (!reconciled.changed) continue;
					currentResult.usage.contextTokens = reconciled.contextTokens;
					contextUsageIsAuthoritative = reconciled.authoritative;
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				resetIdleTimer();
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = (lines.pop() || "").slice(-MAX_DIAGNOSTIC_CHARS);
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				resetIdleTimer();
				processStderr(data.toString());
			});

			proc.on("close", (code, closeSignal) => {
				if (idleTimer) clearTimeout(idleTimer);
				if (buffer.trim()) processLine(buffer);
				processStderr("", true);
				currentResult.signalCode = closeSignal;
				resolve(code ?? (closeSignal ? 1 : 0));
			});

			proc.on("error", (error) => {
				if (idleTimer) clearTimeout(idleTimer);
				const errorCode = "code" in error && typeof error.code === "string" ? error.code : undefined;
				const spawnError = `Failed to spawn subprocess${errorCode ? ` (${errorCode})` : ""}: ${error.message}`;
				if (!currentResult.errorMessage) currentResult.errorMessage = spawnError;
				if (!currentResult.stderr.includes(spawnError)) appendDiagnostics(`${spawnError}\n`);
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					escalateKill(proc, options.killTimeoutMs ?? 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) {
			if (options.resolveOnAbort) {
				// A SIGTERM'd child reports close(null) → exitCode 0; force nonzero
				// so isFailedResult/success counting stays honest.
				if (currentResult.exitCode === 0) currentResult.exitCode = 130;
				currentResult.stopReason = "aborted";
				currentResult.cancelled = true;
				if (!currentResult.errorMessage) currentResult.errorMessage = "Cancelled by user";
				return currentResult;
			}
			throw new Error("Subagent was aborted");
		}
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
		if (tmpPromptDir)
			try { fs.rmdirSync(tmpPromptDir); } catch { /* ignore */ }
	}
}

/**
 * Result for a task whose abort signal fired while it was still queued behind
 * the concurrency limit — never spawned, reported as cancelled.
 */
function cancelledPlaceholderResult(agent: string, task: string): SingleResult {
	return {
		agent,
		agentSource: "unknown",
		task,
		exitCode: 130,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cost: 0, turns: 0, toolCalls: 0 },
		stopReason: "aborted",
		errorMessage: "Cancelled by user",
		cancelled: true,
	};
}

export interface ParallelAgentTask {
	agent: string;
	task: string;
	model?: string;
	thinking?: ThinkingLevel;
	loadExtensions?: boolean;
	extensionPath?: string;
	signal?: AbortSignal;
}

export interface ModelParallelAgentTask extends ParallelAgentTask {
	model: string;
}

export interface ParallelRunOptions {
	/** Max child processes in flight. Normalized here, so an omitted or malformed value falls back to the safe default. */
	maxConcurrency?: number;
	/** Called once a queued task acquires a process-pool slot, immediately before it begins. */
	onStart?: (index: number) => void;
}

/** Run multiple agents in parallel with concurrency limit. */
export async function runParallelAgents(
	defaultCwd: string,
	agents: AgentConfig[],
	tasks: ParallelAgentTask[],
	signal: AbortSignal | undefined,
	onUpdate: ((partial: AgentToolResult<unknown>) => void) | undefined,
	onEach?: (index: number, result: SingleResult) => void,
	onProgress?: (index: number, result: SingleResult) => void,
	options: ParallelRunOptions = {},
): Promise<SingleResult[]> {
	if (tasks.length > MAX_PARALLEL_TASKS) {
		throw new Error(`Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`);
	}

	const maxConcurrency = normalizeMaxConcurrentAgents(options.maxConcurrency);

	const allResults: SingleResult[] = new Array(tasks.length);

	for (let i = 0; i < tasks.length; i++) {
		allResults[i] = {
			agent: tasks[i].agent,
			agentSource: "unknown",
			task: tasks[i].task,
			exitCode: -1, // -1 = still running
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cost: 0, turns: 0, toolCalls: 0 },
		};
	}

	const startedIndices = new Set<number>();

	const emitParallelUpdate = () => {
		if (onUpdate) {
			const done = allResults.filter((r) => r.exitCode !== -1).length;
			const running = startedIndices.size - done;
			onUpdate({
				details: undefined,
				content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
			});
		}
	};

	const results = await mapWithConcurrencyLimit(tasks, maxConcurrency, async (t, index) => {
		const taskSignal = t.signal ?? signal;
		if (taskSignal?.aborted) {
			// Cancelled while queued behind the configured concurrency limit — never spawn.
			const placeholder = cancelledPlaceholderResult(t.agent, t.task);
			allResults[index] = placeholder;
			emitParallelUpdate();
			onEach?.(index, placeholder);
			return placeholder;
		}
		const result = await runSingleAgent(
			defaultCwd,
			agents,
			t.agent,
			t.task,
			undefined,
			taskSignal,
			undefined,
			t.model,
			t.thinking,
			{
				loadExtensions: t.loadExtensions,
				extensionPath: t.extensionPath,
				resolveOnAbort: true,
				onProgress: onProgress ? (r) => onProgress(index, r) : undefined,
			},
		);
		allResults[index] = result;
		emitParallelUpdate();
		onEach?.(index, result);
		return result;
	}, (index) => {
		startedIndices.add(index);
		options.onStart?.(index);
	});

	return results;
}

/**
 * Run multiple agents in parallel, each with its own model override.
 * Sibling to runParallelAgents for MoA fan-out, where every task uses the
 * same agent (e.g. "moa-proposer") but a different model per slot.
 */
export async function runParallelAgentsWithModels(
	defaultCwd: string,
	agents: AgentConfig[],
	tasks: ModelParallelAgentTask[],
	signal: AbortSignal | undefined,
	onEach: ((index: number, result: SingleResult) => void) | undefined,
	onProgress?: (index: number, result: SingleResult) => void,
	options: ParallelRunOptions = {},
): Promise<SingleResult[]> {
	if (tasks.length > MAX_PARALLEL_TASKS) {
		throw new Error(`Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`);
	}

	const maxConcurrency = normalizeMaxConcurrentAgents(options.maxConcurrency);

	const results = await mapWithConcurrencyLimit(tasks, maxConcurrency, async (t, index) => {
		const taskSignal = t.signal ?? signal;
		if (taskSignal?.aborted) {
			// Cancelled while queued behind the configured concurrency limit — never spawn.
			const placeholder = cancelledPlaceholderResult(t.agent, t.task);
			onEach?.(index, placeholder);
			return placeholder;
		}
		const result = await runSingleAgent(
			defaultCwd,
			agents,
			t.agent,
			t.task,
			undefined,
			taskSignal,
			undefined,
			t.model,
			t.thinking,
			{
				loadExtensions: t.loadExtensions,
				extensionPath: t.extensionPath,
				resolveOnAbort: true,
				onProgress: onProgress ? (r) => onProgress(index, r) : undefined,
			},
		);
		onEach?.(index, result);
		return result;
	}, options.onStart);

	return results;
}
