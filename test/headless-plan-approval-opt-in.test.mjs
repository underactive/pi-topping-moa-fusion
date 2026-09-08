import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousAutoApprove = process.env.MOA_PLAN_AUTO_APPROVE;
const tempRoot = mkdtempSync(path.join(tmpdir(), "moa-headless-opt-in-test-"));
let activeTools = ["read", "write", "enter_plan_mode"];
const tools = new Map();
const fakePi = {
	getThinkingLevel: () => "medium",
	getAllTools: () => [{ name: "read" }, { name: "write" }, { name: "enter_plan_mode" }],
	getActiveTools: () => activeTools,
	setActiveTools: (names) => { activeTools = names; },
	appendEntry: () => {},
	registerFlag: () => {},
	registerCommand: () => {},
	registerShortcut: () => {},
	registerTool: (tool) => tools.set(tool.name, tool),
	on: () => {},
	getFlag: () => false,
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
	delete process.env.MOA_PLAN_AUTO_APPROVE;
	const { default: mfPlanExtension } = await import("../src/index.ts");
	mfPlanExtension(fakePi);

	await tools.get("enter_plan_mode").execute("enter", {}, undefined, undefined, ctx);
	await tools.get("write_plan").execute("write", { content: "## Plan\n1. Update the implementation." }, undefined, undefined, ctx);
	const planModeTools = [...activeTools];

	const result = await tools.get("exit_plan_mode").execute("exit", {}, undefined, undefined, ctx);

	assert.deepEqual(
		{ isError: result.isError, activeTools },
		{ isError: true, activeTools: planModeTools },
	);
} finally {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	if (previousAutoApprove === undefined) delete process.env.MOA_PLAN_AUTO_APPROVE;
	else process.env.MOA_PLAN_AUTO_APPROVE = previousAutoApprove;
	rmSync(tempRoot, { recursive: true, force: true });
}

console.log("headless plan approval opt-in test passed.");
