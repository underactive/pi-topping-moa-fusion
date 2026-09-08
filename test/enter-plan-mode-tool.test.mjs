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
const tempRoot = mkdtempSync(path.join(tmpdir(), "moa-enter-plan-tool-test-"));

let activeTools = ["read", "write", "enter_plan_mode"];
const tools = new Map();
const commands = new Map();
const fakePi = {
	getThinkingLevel: () => "medium",
	getAllTools: () => [{ name: "read" }, { name: "write" }, { name: "enter_plan_mode" }],
	getActiveTools: () => activeTools,
	setActiveTools: (names) => { activeTools = names; },
	appendEntry: () => {},
	registerFlag: () => {},
	registerCommand: (name, options) => commands.set(name, options),
	registerShortcut: () => {},
	registerTool: (tool) => tools.set(tool.name, tool),
	on: () => {},
	getFlag: () => false,
	events: { on: () => () => {}, emit: () => {} },
};
const ctx = {
	hasUI: false,
	cwd: tempRoot,
	ui: {
		notify: () => {},
		setStatus: () => {},
		theme: { fg: (_color, text) => text },
	},
};

try {
	process.env.PI_CODING_AGENT_DIR = path.join(tempRoot, "agent");
	mfPlanExtension(fakePi);
	const enterTool = tools.get("enter_plan_mode");
	assert.equal(typeof enterTool?.execute, "function");

	// Entering swaps to the plan-mode tool set and returns workflow instructions.
	const result = await enterTool.execute("call-1", {}, undefined, undefined, ctx);
	assert.notEqual(result.isError, true);
	const text = result.content[0].text;
	assert.match(text, /Plan mode enabled \(single model/);
	assert.match(text, /PLAN MODE/);
	assert.ok(activeTools.includes("write_plan"));
	assert.ok(activeTools.includes("exit_plan_mode"));
	assert.ok(!activeTools.includes("write"));
	assert.ok(!activeTools.includes("enter_plan_mode"));

	// Re-entry while already in plan mode is an error.
	const again = await enterTool.execute("call-2", {}, undefined, undefined, ctx);
	assert.equal(again.isError, true);

	// Toggling plan mode off restores the pre-plan tool set.
	await commands.get("mf-plan").handler("", ctx);
	assert.deepEqual([...activeTools].sort(), ["enter_plan_mode", "read", "write"]);
} finally {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(tempRoot, { recursive: true, force: true });
}

console.log("enter_plan_mode tool tests passed.");
