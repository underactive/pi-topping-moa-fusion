import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// mfPlanSubagent.ts transitively loads overlay modules that use TypeScript
// parameter properties, so execute this assertion script under Node's TS transform.
if (!process.execArgv.includes("--experimental-transform-types")) {
	try {
		execFileSync(process.execPath, ["--experimental-transform-types", fileURLToPath(import.meta.url)], {
			stdio: "inherit",
		});
	} catch (err) {
		process.exit(err.status ?? 1);
	}
	process.exit(0);
}

const { Value } = await import("typebox/value");
const { isFailedResult } = await import("../src/runtime/results.ts");
const {
	MF_PLAN_SUBAGENT_OUTPUT_SCHEMA,
	buildSubagentStructuredResult,
	classifySubagentResult,
} = await import("../src/planning/tools/structuredResults.ts");
const { registerMfPlanSubagentTool } = await import("../src/planning/tools/mfPlanSubagent.ts");

const CANCELLED_TEXT = "The user cancelled this subagent. Do not retry; continue planning with the information you already have.";

function usage(overrides = {}) {
	return { input: 120, output: 40, cacheRead: 10, cacheWrite: 5, cacheWrite1h: 0, cost: 0.012, turns: 2, toolCalls: 3, ...overrides };
}

function assistant(text) {
	return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
}

function result(overrides = {}) {
	return {
		agent: "moa-explore",
		agentSource: "user",
		task: "map the planner",
		exitCode: 0,
		messages: [assistant("found the planner")],
		stderr: "",
		usage: usage(),
		model: "test/model",
		stopReason: "stop",
		...overrides,
	};
}

const fixtures = {
	completed: result(),
	failedExit: result({ exitCode: 1, errorMessage: "child exited 1" }),
	failedProvider: result({ stopReason: "error", errorMessage: "provider 500" }),
	failedEmpty: result({ messages: [] }),
	cancelled: result({ cancelled: true, stopReason: "aborted", exitCode: 130, errorMessage: "Cancelled by user" }),
	aborted: result({ stopReason: "aborted", errorMessage: "Request was aborted" }),
};

function assertSerializableAndValid(value) {
	assert.deepEqual(JSON.parse(JSON.stringify(value)), value, "structured results must not carry undefined keys");
	assert.ok(Value.Check(MF_PLAN_SUBAGENT_OUTPUT_SCHEMA, value), "structured result must match the declared output schema");
}

// --- Pure classification and aggregation ---------------------------------

// Order: a user cancel wins over the "aborted" stop it produces; an "aborted"
// stop without one is a child abort; everything else falls to isFailedResult.
assert.equal(classifySubagentResult(fixtures.completed), "completed");
assert.equal(classifySubagentResult(fixtures.failedExit), "failed");
assert.equal(classifySubagentResult(fixtures.failedProvider), "failed");
assert.equal(classifySubagentResult(fixtures.failedEmpty), "failed");
assert.equal(classifySubagentResult(fixtures.cancelled), "cancelled");
assert.equal(classifySubagentResult(fixtures.aborted), "aborted");

for (const [name, fixture] of Object.entries(fixtures)) {
	const single = buildSubagentStructuredResult("single", [fixture]);
	assert.equal(single.mode, "single");
	assert.equal(single.status, classifySubagentResult(fixture), `${name}: single-mode status is the agent's status`);
	assert.equal(single.total, 1);
	assertSerializableAndValid(single);
}

const aggregate = (...results) => buildSubagentStructuredResult("parallel", results).status;
assert.equal(aggregate(fixtures.completed, fixtures.completed), "completed");
assert.equal(aggregate(fixtures.completed, fixtures.cancelled), "partial");
assert.equal(aggregate(fixtures.cancelled, fixtures.cancelled), "cancelled");
assert.equal(aggregate(fixtures.failedExit, fixtures.cancelled), "failed");
assert.equal(aggregate(fixtures.aborted, fixtures.cancelled), "aborted");
assert.equal(aggregate(fixtures.failedProvider, fixtures.aborted), "failed");

{
	const all = Object.values(fixtures);
	const structured = buildSubagentStructuredResult("parallel", all);
	assert.equal(structured.total, 6);
	assert.equal(structured.succeeded, 1);
	assert.equal(structured.failed, 3);
	assert.equal(structured.cancelled, 1);
	assert.equal(structured.aborted, 1);
	assert.equal(structured.succeeded, all.filter((r) => !isFailedResult(r)).length, "succeeded matches the text header count");
	assert.deepEqual(structured.results.map((entry) => entry.status), ["completed", "failed", "failed", "failed", "cancelled", "aborted"]);
	assertSerializableAndValid(structured);
}

{
	// Output matches what the text paths show: the answer on success, the error otherwise.
	const [completed, failedExit, , failedEmpty] = buildSubagentStructuredResult("parallel", [
		fixtures.completed,
		fixtures.failedExit,
		fixtures.failedProvider,
		fixtures.failedEmpty,
	]).results;
	assert.equal(completed.output, "found the planner");
	assert.equal(completed.truncated, false);
	assert.equal(failedExit.output, "child exited 1");
	assert.equal(failedEmpty.output, "No agent messages were emitted.");
	assert.deepEqual(completed.usage, usage(), "usage is copied field for field");
	assert.ok(!("contextTokens" in completed.usage), "absent context tokens stay absent");
	assert.equal(completed.exitCode, 0);
	assert.equal(completed.stopReason, "stop");
	assert.equal(completed.model, "test/model");
}

{
	const [entry] = buildSubagentStructuredResult("single", [
		result({ usage: usage({ contextTokens: 4096 }), stopReason: undefined, model: undefined }),
	]).results;
	assert.equal(entry.usage.contextTokens, 4096);
	assert.ok(!("stopReason" in entry), "missing stop reason is omitted, not undefined");
	assert.ok(!("model" in entry), "missing model is omitted, not undefined");
}

{
	// The 50 KB cap is the same one the parallel text applies.
	const long = "x".repeat(60 * 1024);
	const structured = buildSubagentStructuredResult("single", [result({ messages: [assistant(long)] })]);
	const [entry] = structured.results;
	assert.equal(entry.truncated, true);
	assert.match(entry.output, /\[Output truncated\]$/);
	assert.ok(Buffer.byteLength(entry.output) < Buffer.byteLength(long));
	assertSerializableAndValid(structured);
}

// The schema rejects fields it does not declare, so drift fails loudly.
assert.equal(
	Value.Check(MF_PLAN_SUBAGENT_OUTPUT_SCHEMA, { ...buildSubagentStructuredResult("single", [fixtures.completed]), extra: true }),
	false,
);

// --- Tool execution through the injected runners -------------------------

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const tempRoot = mkdtempSync(path.join(tmpdir(), "mf-plan-subagent-structured-test-"));

function createHost(enabled = true) {
	const previousSession = { title: "previous", run: undefined, overlayOpen: false };
	let session = previousSession;
	return {
		previousSession,
		currentSession: () => session,
		isEnabled: () => enabled,
		isAskUserQuestionActive: () => false,
		currentThinkingLevel: () => "medium",
		getActiveCancelSession: () => session,
		setActiveCancelSession: (next) => { session = next; },
	};
}

function createCtx() {
	return {
		mode: "rpc",
		hasUI: false,
		cwd: tempRoot,
		model: undefined,
		modelRegistry: { getRegisteredProviderIds: () => [] },
		ui: {
			notify: () => {},
			setWidget: () => {},
			onTerminalInput: () => () => {},
			theme: { fg: (_color, text) => text },
		},
	};
}

function registerWith({ host = createHost(), single, parallel } = {}) {
	let tool;
	registerMfPlanSubagentTool({ registerTool: (definition) => { tool = definition; } }, host, {
		runSingleAgent: single ?? (async () => { throw new Error("runSingleAgent must not be called"); }),
		runParallelAgents: parallel ?? (async () => { throw new Error("runParallelAgents must not be called"); }),
	});
	return { tool, host };
}

const singleRunner = (fixture) => async (_cwd, _agents, agentName) => ({ ...fixture, agent: agentName });

try {
	process.env.PI_CODING_AGENT_DIR = path.join(tempRoot, "agent");
	const ctx = createCtx();
	const runSingle = (fixture, params = { agent: "moa-explore", task: "map the planner" }) => {
		const { tool } = registerWith({ single: singleRunner(fixture) });
		return tool.execute("call-1", params, undefined, undefined, ctx);
	};

	// Success: the text is exactly the agent's answer.
	{
		const outcome = await runSingle(fixtures.completed);
		assert.equal(outcome.content[0].text, "found the planner");
		assert.notEqual(outcome.isError, true);
		assert.equal(outcome.structuredContent.status, "completed");
		assert.equal(outcome.structuredContent.mode, "single");
		assertSerializableAndValid(outcome.structuredContent);
	}

	// isFailedResult: the existing "Agent failed:" error, now with a structured value.
	{
		const outcome = await runSingle(fixtures.failedExit);
		assert.equal(outcome.isError, true);
		assert.equal(outcome.content[0].text, "Agent failed: child exited 1");
		assert.equal(outcome.structuredContent.status, "failed");
		assert.equal(outcome.structuredContent.results[0].exitCode, 1);
		assertSerializableAndValid(outcome.structuredContent);
	}

	// User cancel: the existing sentence, not an error.
	{
		const outcome = await runSingle(fixtures.cancelled);
		assert.equal(outcome.content[0].text, CANCELLED_TEXT);
		assert.notEqual(outcome.isError, true);
		assert.equal(outcome.structuredContent.status, "cancelled");
		assertSerializableAndValid(outcome.structuredContent);
	}

	// A child abort nobody asked for stays a failure in text, "aborted" structurally.
	{
		const outcome = await runSingle(fixtures.aborted);
		assert.equal(outcome.isError, true);
		assert.match(outcome.content[0].text, /^Agent failed: /);
		assert.equal(outcome.structuredContent.status, "aborted");
		assertSerializableAndValid(outcome.structuredContent);
	}

	// Whole-turn abort keeps throwing and restores the previous cancel session.
	for (const mode of ["single", "parallel"]) {
		const { tool, host } = registerWith({
			single: singleRunner(fixtures.completed),
			parallel: async (_cwd, _agents, tasks) => tasks.map((task) => ({ ...fixtures.completed, agent: task.agent })),
		});
		const params = mode === "single"
			? { agent: "moa-explore", task: "map the planner" }
			: { tasks: [{ agent: "moa-explore", task: "a" }, { agent: "mf-plan", task: "b" }] };
		await assert.rejects(tool.execute("call-abort", params, AbortSignal.abort(), undefined, ctx), /Subagent was aborted/);
		assert.equal(host.currentSession(), host.previousSession, `${mode}: the previous cancel session is restored`);
	}

	// Parallel: header text unchanged, results in request order.
	{
		const { tool } = registerWith({
			parallel: async (_cwd, _agents, tasks, _signal, _onUpdate, onEach) => {
				const results = [
					{ ...fixtures.completed, agent: tasks[0].agent },
					{ ...fixtures.cancelled, agent: tasks[1].agent },
				];
				results.forEach((r, index) => onEach?.(index, r));
				return results;
			},
		});
		const outcome = await tool.execute("call-parallel", {
			tasks: [{ agent: "moa-explore", task: "a" }, { agent: "mf-plan", task: "b" }],
		}, undefined, undefined, ctx);
		assert.ok(outcome.content[0].text.startsWith("Parallel: 1/2 succeeded, 1 cancelled by user\n\n"));
		assert.notEqual(outcome.isError, true);
		assert.equal(outcome.structuredContent.mode, "parallel");
		assert.equal(outcome.structuredContent.status, "partial");
		assert.deepEqual(outcome.structuredContent.results.map((entry) => [entry.agent, entry.status]), [
			["moa-explore", "completed"],
			["mf-plan", "cancelled"],
		]);
		assertSerializableAndValid(outcome.structuredContent);
	}

	// Precondition errors stay plain text errors without a structured value.
	{
		const { tool } = registerWith({ host: createHost(false) });
		const outcome = await tool.execute("call-disabled", { agent: "moa-explore", task: "a" }, undefined, undefined, ctx);
		assert.equal(outcome.isError, true);
		assert.equal(outcome.content[0].text, "Error: mf_plan_subagent is only available in plan mode.");
		assert.equal(outcome.structuredContent, undefined);
	}
	{
		const { tool } = registerWith();
		const outcome = await tool.execute("call-rogue", { agent: "rogue", task: "a" }, undefined, undefined, ctx);
		assert.equal(outcome.isError, true);
		assert.equal(outcome.content[0].text, 'Agent "rogue" is not allowed in plan mode. Use only moa-explore or mf-plan.');
		assert.equal(outcome.structuredContent, undefined);
	}
	{
		const { tool } = registerWith();
		const outcome = await tool.execute("call-invalid", {}, undefined, undefined, ctx);
		assert.equal(outcome.isError, true);
		assert.match(outcome.content[0].text, /^Invalid parameters\. Provide agent\+task or tasks array\./);
		assert.equal(outcome.structuredContent, undefined);
	}
} finally {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(tempRoot, { recursive: true, force: true });
}

console.log("mf_plan_subagent structured result tests passed.");
