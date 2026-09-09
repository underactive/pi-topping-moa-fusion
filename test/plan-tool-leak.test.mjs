import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// src/index.ts transitively loads overlay modules that use TypeScript parameter
// properties, so execute this assertion script under Node's TS transform.
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

const { default: mfPlanExtension } = await import("../src/index.ts");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const tempRoot = mkdtempSync(path.join(tmpdir(), "moa-plan-tool-leak-test-"));

let activeTools = ["read", "write", "enter_plan_mode"];
let setActiveToolsCalls = 0;
let sessionEntries = [];
const sentMessages = [];
const tools = new Map();
const commands = new Map();
const handlers = new Map();
const fakePi = {
	getThinkingLevel: () => "medium",
	getAllTools: () => [
		{ name: "read" },
		{ name: "write" },
		{ name: "enter_plan_mode" },
		...[...tools.values()].map((tool) => ({ name: tool.name })),
	],
	getActiveTools: () => [...activeTools],
	setActiveTools: (names) => { setActiveToolsCalls++; activeTools = [...names]; },
	appendEntry: () => {},
	registerFlag: () => {},
	registerCommand: (name, options) => commands.set(name, options),
	registerShortcut: () => {},
	registerTool: (tool) => {
		tools.set(tool.name, tool);
		// pi activates newly registered tools immediately in the current session.
		if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
	},
	on: (event, handler) => { handlers.set(event, handler); },
	getFlag: () => false,
	sendUserMessage: (text, options) => { sentMessages.push({ text, options, toolsAtDispatch: [...activeTools] }); },
	events: { on: () => () => {}, emit: () => {} },
};
const ctx = {
	hasUI: false,
	mode: "rpc",
	cwd: tempRoot,
	model: { provider: "test", id: "model" },
	ui: {
		notify: () => {},
		setStatus: () => {},
		theme: { fg: (_color, text) => text },
	},
	sessionManager: { getEntries: () => sessionEntries },
};

try {
	process.env.PI_CODING_AGENT_DIR = path.join(tempRoot, "agent");
	mfPlanExtension(fakePi);

	// Registration activates all four tools, but extension startup must immediately
	// remove the three plan-only tools while preserving the entry tool.
	assert.ok(activeTools.includes("enter_plan_mode"));
	assert.ok(activeTools.includes("write"));
	assert.ok(!activeTools.includes("write_plan"));
	assert.ok(!activeTools.includes("exit_plan_mode"));
	assert.ok(!activeTools.includes("mf_plan_subagent"));

	// A leaked tool set must be repaired before the next normal model turn.
	activeTools.push("write_plan", "exit_plan_mode", "mf_plan_subagent");
	await handlers.get("before_agent_start")({}, ctx);
	assert.ok(activeTools.includes("enter_plan_mode"));
	assert.ok(activeTools.includes("write"));
	assert.ok(!activeTools.includes("write_plan"));
	assert.ok(!activeTools.includes("exit_plan_mode"));
	assert.ok(!activeTools.includes("mf_plan_subagent"));
	const callsAfterCleanup = setActiveToolsCalls;
	await handlers.get("before_agent_start")({}, ctx);
	assert.equal(setActiveToolsCalls, callsAfterCleanup);

	// Restore plan mode and a valid implementation handoff from persisted state.
	// This reproduces the restart path where plan-only tools are active before
	// /mf-plan-implement dispatches the kickoff turn.
	sessionEntries = [{
		type: "custom",
		customType: "mf-plan",
		data: {
			enabled: true,
			implementationHandoff: {
				plan: "approved implementation plan",
				planFilePath: path.join(tempRoot, "approved-plan.md"),
				timestamp: Date.now(),
			},
		},
	}];
	await handlers.get("session_start")({}, ctx);
	assert.ok(activeTools.includes("write_plan"));
	assert.ok(activeTools.includes("exit_plan_mode"));
	assert.ok(activeTools.includes("mf_plan_subagent"));
	assert.ok(!activeTools.includes("write"));
	assert.ok(!activeTools.includes("enter_plan_mode"));

	await commands.get("mf-plan-implement").handler("", ctx);
	assert.equal(sentMessages.length, 1);
	assert.deepEqual(sentMessages[0].options, { triggerTurn: true });
	assert.match(sentMessages[0].text, /manual resume/);
	assert.ok(sentMessages[0].toolsAtDispatch.includes("enter_plan_mode"));
	assert.ok(sentMessages[0].toolsAtDispatch.includes("write"));
	assert.ok(!sentMessages[0].toolsAtDispatch.includes("write_plan"));
	assert.ok(!sentMessages[0].toolsAtDispatch.includes("exit_plan_mode"));
	assert.ok(!sentMessages[0].toolsAtDispatch.includes("mf_plan_subagent"));
	assert.deepEqual(activeTools, sentMessages[0].toolsAtDispatch);
} finally {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(tempRoot, { recursive: true, force: true });
}

console.log("Plan-only tool leak tests passed.");
