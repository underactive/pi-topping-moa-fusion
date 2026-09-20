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
const PLAN_ONLY_TOOLS = ["write_plan", "exit_plan_mode", "mf_plan_subagent"];
const NORMAL_TOOLS = ["read", "grep", "write", "edit", "enter_plan_mode"];
const PLAN_TOOLS = ["read", "grep", ...PLAN_ONLY_TOOLS];
const READ_ONLY_ENV_KEYS = ["PI_CURSOR_FORCE_MODE", "PI_CLAUDE_BRIDGE_FORCE_MODE"];
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousReadOnlyEnv = Object.fromEntries(READ_ONLY_ENV_KEYS.map((key) => [key, process.env[key]]));
const tempRoot = mkdtempSync(path.join(tmpdir(), "mf-plan-resume-tools-test-"));

function createHarness() {
	let activeTools = [...NORMAL_TOOLS];
	let sessionEntries = [];
	const appendedEntries = [];
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	const fakePi = {
		getThinkingLevel: () => "medium",
		getAllTools: () => [
			...NORMAL_TOOLS.map((name) => ({ name })),
			...[...tools.values()].map((tool) => ({ name: tool.name })),
		],
		getActiveTools: () => [...activeTools],
		setActiveTools: (names) => { activeTools = [...names]; },
		appendEntry: (type, data) => { appendedEntries.push({ type, data }); },
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
		sendUserMessage: () => {},
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

	mfPlanExtension(fakePi);

	return {
		appendedEntries,
		commands,
		ctx,
		handlers,
		getActiveTools: () => [...activeTools],
		async start(entries, transcriptTools) {
			sessionEntries = entries;
			if (transcriptTools) activeTools = [...transcriptTools];
			await handlers.get("session_start")({}, ctx);
		},
		async shutdown() {
			await handlers.get("session_shutdown")({ reason: "test" }, ctx);
		},
	};
}

function stateEntry(data) {
	return [{ type: "custom", customType: "mf-plan", data }];
}

function assertNoPlanOnlyTools(activeTools) {
	for (const name of PLAN_ONLY_TOOLS) assert.ok(!activeTools.includes(name), `${name} must be inactive`);
}

try {
	process.env.PI_CODING_AGENT_DIR = path.join(tempRoot, "agent");

	// 1. A fresh plan-mode entry persists the clean pre-plan loadout.
	{
		const harness = createHarness();
		await harness.start([]);
		await harness.commands.get("mf-plan").handler("", harness.ctx);
		const persisted = harness.appendedEntries.findLast((entry) => entry.type === "mf-plan" && entry.data.enabled);
		assert.ok(persisted, "entering plan mode must persist its state");
		assert.ok(persisted.data.toolsBeforePlanMode.includes("write"));
		assertNoPlanOnlyTools(persisted.data.toolsBeforePlanMode);
		await harness.shutdown();
	}

	// 2. A valid persisted snapshot wins over the transcript-restored plan loadout.
	{
		const harness = createHarness();
		await harness.start(
			stateEntry({ enabled: true, slug: "valid-resume", toolsBeforePlanMode: NORMAL_TOOLS }),
			PLAN_TOOLS,
		);
		assert.ok(!harness.getActiveTools().includes("write"));
		assert.ok(!harness.getActiveTools().includes("edit"));
		const rePersisted = harness.appendedEntries.findLast((entry) => entry.type === "mf-plan" && entry.data.enabled);
		assert.ok(rePersisted, "resuming a persisted plan-mode entry must re-persist its state");
		assert.deepEqual(
			rePersisted.data.toolsBeforePlanMode,
			NORMAL_TOOLS,
			"the valid snapshot must be reused, not overwritten by the registered fallback",
		);
		await harness.commands.get("mf-plan").handler("", harness.ctx);
		const restored = harness.getActiveTools();
		assert.ok(restored.includes("write"));
		assert.ok(restored.includes("edit"));
		assertNoPlanOnlyTools(restored);
		await harness.shutdown();
	}

	// 3. A legacy entry without a snapshot falls back to all registered non-plan tools.
	{
		const harness = createHarness();
		await harness.start(stateEntry({ enabled: true, slug: "legacy-resume" }), PLAN_TOOLS);
		const repaired = harness.appendedEntries.findLast((entry) => entry.type === "mf-plan" && entry.data.enabled);
		assert.ok(repaired?.data.toolsBeforePlanMode.includes("write"), "legacy state must be repaired and persisted");
		await harness.commands.get("mf-plan").handler("", harness.ctx);
		const restored = harness.getActiveTools();
		assert.ok(restored.includes("write"));
		assertNoPlanOnlyTools(restored);
		assert.equal(new Set(restored).size, restored.length, "registered fallback must be deduplicated");
		await harness.shutdown();
	}

	// 4. A snapshot contaminated with a plan-only tool is rejected and repaired.
	{
		const harness = createHarness();
		await harness.start(
			stateEntry({ enabled: true, slug: "poisoned-resume", toolsBeforePlanMode: ["read", "write_plan"] }),
			PLAN_TOOLS,
		);
		const repaired = harness.appendedEntries.findLast((entry) => entry.type === "mf-plan" && entry.data.enabled);
		assert.ok(repaired?.data.toolsBeforePlanMode.includes("write"));
		assertNoPlanOnlyTools(repaired.data.toolsBeforePlanMode);
		await harness.commands.get("mf-plan").handler("", harness.ctx);
		const restored = harness.getActiveTools();
		assert.ok(restored.includes("write"));
		assertNoPlanOnlyTools(restored);
		await harness.shutdown();
	}
} finally {
	for (const [key, value] of Object.entries(previousReadOnlyEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(tempRoot, { recursive: true, force: true });
}

console.log("Plan resume tool-loadout tests passed.");
