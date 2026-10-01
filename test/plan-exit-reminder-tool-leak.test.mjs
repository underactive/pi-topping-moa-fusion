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
const { PLAN_EXIT_CONTEXT_TYPE, PLAN_ONLY_REGISTERED_TOOLS } = await import("../src/planning/tools/shared.ts");
const USER_TOOLS = ["read", "write", "edit"];
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const tempRoot = mkdtempSync(path.join(tmpdir(), "mf-plan-exit-reminder-leak-test-"));

let activeTools = [...USER_TOOLS, "enter_plan_mode"];
let setActiveToolsCalls = 0;
const tools = new Map();
const handlers = new Map();
const fakePi = {
	getThinkingLevel: () => "medium",
	getAllTools: () => [...USER_TOOLS.map((name) => ({ name })), ...[...tools.keys()].map((name) => ({ name }))],
	getActiveTools: () => [...activeTools],
	setActiveTools: (names) => { setActiveToolsCalls++; activeTools = [...names]; },
	appendEntry: () => {},
	registerFlag: () => {},
	registerCommand: () => {},
	registerShortcut: () => {},
	registerTool: (tool) => {
		tools.set(tool.name, tool);
		if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
	},
	on: (event, handler) => { handlers.set(event, handler); },
	getFlag: () => false,
	sendUserMessage: () => {},
	events: { on: () => () => {}, emit: () => {} },
};
// A session that left plan mode and still owes the model its exit reminder.
const sessionEntries = [{ type: "custom", customType: "mf-plan", data: { enabled: false, needsExitReminder: true } }];
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

function assertNormalLoadout() {
	for (const name of PLAN_ONLY_REGISTERED_TOOLS) assert.ok(!activeTools.includes(name), `${name} must be inactive`);
	for (const name of [...USER_TOOLS, "enter_plan_mode"]) assert.ok(activeTools.includes(name), `${name} must stay active`);
}

try {
	process.env.PI_CODING_AGENT_DIR = path.join(tempRoot, "agent");
	mfPlanExtension(fakePi);
	await handlers.get("session_start")({}, ctx);
	assertNormalLoadout();

	// The plan-only set leaks back in before the reminder turn runs.
	activeTools.push(...PLAN_ONLY_REGISTERED_TOOLS);
	const reminder = await handlers.get("before_agent_start")({}, ctx);
	assert.equal(reminder?.message?.customType, PLAN_EXIT_CONTEXT_TYPE, "the first turn still carries the exit reminder");
	assertNormalLoadout();

	// Once clean, later turns make no further tool changes.
	const callsAfterRepair = setActiveToolsCalls;
	const next = await handlers.get("before_agent_start")({}, ctx);
	assert.equal(next, undefined, "the reminder is delivered once");
	assert.equal(setActiveToolsCalls, callsAfterRepair);
	assertNormalLoadout();

	await handlers.get("session_shutdown")({ reason: "test" }, ctx);
} finally {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(tempRoot, { recursive: true, force: true });
}

console.log("Exit-reminder turn tool-leak tests passed.");
