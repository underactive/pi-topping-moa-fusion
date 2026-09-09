import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as path from "node:path";

import { installShippedAgents, shippedAgentsDir, withAuthoritativeMoaAgents } from "../../agents/authoritative.ts";
import { discoverAgents, parseAgentFile } from "../../agents/discovery.ts";
import { modelExtensionOptions } from "../../moa/modelRuntime.ts";
import { CancelRun, type CancelRowExtras, type CancelSession } from "../../runtime/cancelRun.ts";
import { MutationTripwire, formatMutationWarning } from "../../runtime/mutationTripwire.ts";
import { getFinalOutput, getResultOutput, isFailedResult, truncateOutput } from "../../runtime/results.ts";
import { runParallelAgents, runSingleAgent } from "../../runtime/runner.ts";
import { parseRef as parseModelRefLabel, type ThinkingLevel } from "../../shared/modelRefs.ts";
import { activityLoopCount } from "../../ui/agentStatus.ts";
import { showCancelOverlay } from "../../ui/cancelOverlay.ts";
import { PLAN_SUBAGENT_NAMES } from "./shared.ts";

export interface MfPlanSubagentHost {
	isEnabled(): boolean;
	/** True while an ask_user_question questionnaire is waiting for the user. */
	isAskUserQuestionActive(): boolean;
	currentThinkingLevel(): ThinkingLevel;
	getActiveCancelSession(): CancelSession | undefined;
	setActiveCancelSession(session: CancelSession | undefined): void;
}

export function registerMfPlanSubagentTool(pi: ExtensionAPI, host: MfPlanSubagentHost): void {
	pi.registerTool({
		name: "mf_plan_subagent",
		label: "Moa Plan Subagent",
		description: [
			"ONLY usable inside /mf-plan plan mode — errors in any other context.",
			"For general-purpose delegation outside plan mode, use the subagent tool instead.",
			"Delegate exploration and planning tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array).",
			"Agents: moa-explore (fast codebase recon), mf-plan (implementation planning).",
			`Default scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
		].join(" "),

		// mf_plan_subagent can share a message with ask_user_question; marking it
		// sequential means the questionnaire resolves first so its overlay never
		// draws over a live questionnaire.
		executionMode: "sequential",
		parameters: Type.Object({
			agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
			task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
			tasks: Type.Optional(
				Type.Array(
					Type.Object({
						agent: Type.String({ description: "Name of the agent to invoke" }),
						task: Type.String({ description: "Task to delegate to the agent" }),
					}),
					{ description: "Array of {agent, task} for parallel execution" },
				),
			),
			agentScope: Type.Optional(
				StringEnum(["user", "project", "both"] as const, {
					description: 'Which agent directories to use. Default: "user".',
					default: "user",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!host.isEnabled()) {
				return {
					details: undefined,
					content: [{ type: "text", text: "Error: mf_plan_subagent is only available in plan mode." }],
					isError: true,
				};
			}

			const requestedAgents = params.tasks?.length
				? params.tasks.map((task) => task.agent)
				: params.agent ? [params.agent] : [];
			const unsupportedAgent = requestedAgents.find((name) => !PLAN_SUBAGENT_NAMES.has(name));
			if (unsupportedAgent) {
				return {
					details: undefined,
					content: [{ type: "text", text: `Agent "${unsupportedAgent}" is not allowed in plan mode. Use only moa-explore or mf-plan.` }],
					isError: true,
				};
			}

			const agentScope = (params.agentScope ?? "user") as "user" | "project" | "both";
			// Defensive re-install (matches runMoaOrchestration): guarantees
			// moa-explore.md/mf-plan.md exist on disk even right after an in-session update.
			installShippedAgents();
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = withAuthoritativeMoaAgents(discovery.agents, shippedAgentsDir());

			// Guard moa-explore and mf-plan from repo-discoverable overrides:
			// a committed agents/moa-explore.md can carry a malicious prompt.
			// User-installed copies (source: "user") are untouched.
			for (const name of PLAN_SUBAGENT_NAMES) {
				const index = agents.findIndex((a) => a.name === name);
				if (index >= 0 && agents[index]!.source === "project") {
					const shipped = parseAgentFile(path.join(shippedAgentsDir(), `${name}.md`), "user");
					if (shipped) agents[index] = shipped;
					else agents.splice(index, 1);
				}
			}

			// mf-plan follows the session model the user picked (both the
			// single-model picker and the MoA implementing picker route through
			// pi.setModel), so planning quality tracks that choice. Frontmatter is
			// only a fallback; moa-explore stays on its own configured model.
			const sessionModel = ctx.model;
			const planOverride = sessionModel
				? { model: `${sessionModel.provider}/${sessionModel.id}`, thinking: host.currentThinkingLevel() }
				: undefined;
			const overrideFor = (agentName: string) => (agentName === "mf-plan" ? planOverride : undefined);

			// An agent whose effective model belongs to an extension-registered
			// provider (claude-bridge, cursor-bridge) cannot resolve in a child that
			// spawns with --no-extensions. Same opt-in the MoA fan-out already does;
			// built-in and bare ids fall through to no extension loading.
			const agentExtensionOptions = (agentName: string): { loadExtensions?: boolean; extensionPath?: string } => {
				const model = overrideFor(agentName)?.model ?? agents.find((agent) => agent.name === agentName)?.model;
				return model ? modelExtensionOptions(ctx, parseModelRefLabel(model)) : {};
			};

			// Same cooperative-boundary tripwire as the MoA orchestration: explore/
			// plan children are spawned read-only, but agentic provider bridges can
			// bypass pi's tool loop — detect and surface any working-tree change.
			const tripwire = new MutationTripwire();
			await tripwire.arm(ctx.cwd);
			const warnIfMutated = async (): Promise<void> => {
				const changed = await tripwire.check(ctx.cwd);
				if (changed.length > 0) ctx.ui.notify(formatMutationWarning("plan-mode subagents", changed), "error");
			};

			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);

			if (hasTasks) {
				// Parallel mode — each task gets its own abort signal (combined
				// with pi's turn signal) so F4 can kill one stuck agent
				// while its siblings keep working.
				const tasks = params.tasks!;
				const run = new CancelRun();
				const extras: CancelRowExtras[] = tasks.map(() => ({}));
				const histories: string[][] = tasks.map(() => []);
				const toolSession: CancelSession = {
					title: "Plan subagents",
					run,
					getExtras: (i) => extras[i],
					overlayOpen: false,
				};
				const prevSession = host.getActiveCancelSession();
				host.setActiveCancelSession(toolSession);
				const unsubscribeF4 = ctx.mode === "tui"
					? ctx.ui.onTerminalInput((data) => {
						if (isKeyRelease(data) || !matchesKey(data, Key.f4)) return undefined;
						// A live questionnaire owns F4; pass the key through to it.
						if (host.isAskUserQuestionActive()) return undefined;
						if (toolSession.overlayOpen || !toolSession.run) return undefined;
						toolSession.overlayOpen = true;
						void showCancelOverlay(ctx, toolSession).finally(() => { toolSession.overlayOpen = false; });
						return { consume: true };
					})
					: undefined;
				ctx.ui.setStatus("mf-plan-cancel", "f4: cancel agents");
				try {
					const taskList = tasks.map((t, i) => ({
						agent: t.agent,
						task: t.task,
						...overrideFor(t.agent),
						...agentExtensionOptions(t.agent),
						signal: run.add(`${t.agent} #${i + 1}`, signal).signal,
					}));
					const results = await runParallelAgents(
						ctx.cwd,
						agents,
						taskList,
						signal,
						onUpdate,
						(index, result) => {
							run.settle(index, result.cancelled ? "cancelled" : isFailedResult(result) ? "error" : "done");
						},
						(index, result) => {
							if (result.activity) {
								histories[index].push(result.activity);
								while (histories[index].length > 8) histories[index].shift();
							}
							extras[index] = {
								contextTokens: result.usage.contextTokens,
								activity: result.activity,
								loopCount: activityLoopCount(result.activity, histories[index]),
							};
						},
					);

					// resolveOnAbort makes the runner resolve on abort; rethrow so a
					// whole-turn abort (pi's ESC) keeps its original semantics.
					if (signal?.aborted) throw new Error("Subagent was aborted");

					const successCount = results.filter((r) => !isFailedResult(r)).length;
					const cancelledCount = results.filter((r) => r.cancelled).length;
					const summaries = results.map((r) => {
						if (r.cancelled) {
							return `### [${r.agent}] cancelled by user\n\nThe user cancelled this subagent before it finished. Do not retry it; proceed with the results from the other agents.`;
						}
						const output = truncateOutput(getResultOutput(r));
						const status = isFailedResult(r) ? "failed" : "completed";
						return `### [${r.agent}] ${status}\n\n${output}`;
					});

					const header = `Parallel: ${successCount}/${results.length} succeeded${cancelledCount > 0 ? `, ${cancelledCount} cancelled by user` : ""}`;
					return {
						details: undefined,
						content: [
							{
								type: "text",
								text: `${header}\n\n${summaries.join("\n\n---\n\n")}`,
							},
						],
					};
				} finally {
					unsubscribeF4?.();
					toolSession.closeOverlay?.();
					host.setActiveCancelSession(prevSession);
					ctx.ui.setStatus("mf-plan-cancel", undefined);
					await warnIfMutated();
				}
			}

			if (hasSingle) {
				// Single mode — one cancellable slot.
				const run = new CancelRun();
				const slot = run.add(params.agent!, signal);
				const toolSession: CancelSession = { title: "Plan subagent", run, overlayOpen: false };
				const prevSession = host.getActiveCancelSession();
				host.setActiveCancelSession(toolSession);
				const unsubscribeF4 = ctx.mode === "tui"
					? ctx.ui.onTerminalInput((data) => {
						if (isKeyRelease(data) || !matchesKey(data, Key.f4)) return undefined;
						// A live questionnaire owns F4; pass the key through to it.
						if (host.isAskUserQuestionActive()) return undefined;
						if (toolSession.overlayOpen || !toolSession.run) return undefined;
						toolSession.overlayOpen = true;
						void showCancelOverlay(ctx, toolSession).finally(() => { toolSession.overlayOpen = false; });
						return { consume: true };
					})
					: undefined;
				ctx.ui.setStatus("mf-plan-cancel", "f4: cancel agent");
				try {
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						params.agent!,
						params.task!,
						undefined,
						slot.signal,
						onUpdate,
						overrideFor(params.agent!)?.model,
						overrideFor(params.agent!)?.thinking,
						{ ...agentExtensionOptions(params.agent!), resolveOnAbort: true },
					);
					run.settle(0, result.cancelled ? "cancelled" : isFailedResult(result) ? "error" : "done");

					if (signal?.aborted) throw new Error("Subagent was aborted");

					if (result.cancelled) {
						return {
							details: undefined,
							content: [{ type: "text", text: "The user cancelled this subagent. Do not retry; continue planning with the information you already have." }],
						};
					}
					if (isFailedResult(result)) {
						return {
							details: undefined,
							content: [{ type: "text", text: `Agent failed: ${getResultOutput(result)}` }],
							isError: true,
						};
					}
					return {
						details: undefined,
						content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					};
				} finally {
					unsubscribeF4?.();
					toolSession.closeOverlay?.();
					host.setActiveCancelSession(prevSession);
					ctx.ui.setStatus("mf-plan-cancel", undefined);
					await warnIfMutated();
				}
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				details: undefined,
				content: [{ type: "text", text: `Invalid parameters. Provide agent+task or tasks array. Available agents: ${available}` }],
				isError: true,
			};
		},
	});
}
