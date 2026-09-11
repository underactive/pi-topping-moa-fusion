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

const { createPlanModeController } = await import("../src/planning/planMode.ts");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const tempRoot = mkdtempSync(path.join(tmpdir(), "moa-footer-status-test-"));
const captured = new Map();
const statuses = [];
let idle = true;
let activeTools = ["read", "write"];

const fakePi = {
	getThinkingLevel: () => "medium",
	getAllTools: () => [{ name: "read" }, { name: "write" }],
	getActiveTools: () => activeTools,
	setActiveTools: (tools) => { activeTools = [...tools]; },
	appendEntry: () => {},
	getFlag: () => false,
	events: {
		on: (name, handler) => { captured.set(name, handler); return () => {}; },
	},
};
const ctx = {
	hasUI: true,
	cwd: tempRoot,
	mode: "json",
	isIdle: () => idle,
	ui: {
		notify: () => {},
		setStatus: (key, value) => statuses.push({ key, value }),
		theme: { fg: (color, text) => `[${color}]${text}` },
	},
};

const lastStatus = () => statuses.at(-1);
const controller = createPlanModeController(fakePi);

try {
	process.env.PI_CODING_AGENT_DIR = path.join(tempRoot, "agent");

	controller.beginInteractive(ctx);
	assert.deepEqual(lastStatus(), {
		key: "mf-plan",
		value: "[warning]● [dim]MoA Fusion (plan mode)",
	});

	idle = false;
	controller.onAgentStart({ type: "agent_start" }, ctx);
	assert.match(lastStatus().value, /^\[success\]●/);

	const blocked = captured.get("rpiv:ask-user:blocked");
	assert.equal(typeof blocked, "function");
	blocked({ active: true });
	assert.match(lastStatus().value, /^\[warning\]●/);
	blocked({ active: "yes" });
	assert.match(lastStatus().value, /^\[warning\]●/);
	blocked({ active: false });
	assert.match(lastStatus().value, /^\[success\]●/);

	controller.moaRunHost.noteRunError(ctx, "boom");
	assert.match(lastStatus().value, /^\[error\]●/);
	idle = true;
	blocked({ active: true });
	assert.match(lastStatus().value, /^\[error\]●/);
	blocked({ active: false });
	controller.onAgentStart({ type: "agent_start" }, ctx);
	assert.doesNotMatch(lastStatus().value, /^\[error\]●/);

	controller.exitPlanMode(ctx);
	idle = false;
	controller.markImplementationPending(ctx);
	assert.equal(lastStatus().value, "[success]● [dim]MoA Fusion");

	controller.onAgentSettled({ type: "agent_settled" }, ctx);
	controller.abortPlanMode(ctx);
	assert.deepEqual(lastStatus(), { key: "mf-plan", value: undefined });

	controller.beginInteractive(ctx);
	const writesBefore = statuses.length;
	controller.onAgentStart({ type: "agent_start" }, ctx);
	controller.onAgentStart({ type: "agent_start" }, ctx);
	assert.equal(statuses.length, writesBefore, "identical renders must not rewrite the footer");

	await controller.onSessionStart({}, {
		...ctx,
		mode: "tui",
		sessionManager: { getEntries: () => [] },
	});
	controller.onSessionShutdown({ reason: "test" });

	controller.beginInteractive(ctx);
	assert.match(lastStatus().value, /MoA Fusion \(plan mode\)/, "shutdown must reset the render cache");
} finally {
	controller.onSessionShutdown({ reason: "cleanup" });
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(tempRoot, { recursive: true, force: true });
}

console.log("plan footer status tests passed.");
