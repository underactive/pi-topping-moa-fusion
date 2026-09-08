import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
const { default: mfPlanExtension } = await import("../src/index.ts");
const { getPlan, getPlanSlug, writePlan } = await import("../src/planning/planFile.ts");
const { CancelRun } = await import("../src/runtime/cancelRun.ts");
const { PLAN_EXIT_CONTEXT_TYPE, PLAN_MODE_CONTEXT_TYPE } = await import("../src/planning/tools/shared.ts");
const { READ_ONLY_SUBAGENT_ENV } = await import("../src/runtime/runner.ts");

const [[envKey]] = Object.entries(READ_ONLY_SUBAGENT_ENV);
const previousEnvValue = process.env[envKey];
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const tempRoot = mkdtempSync(path.join(tmpdir(), "moa-clear-plan-test-"));
const plansDir = path.join(tempRoot, "agent", "mf-plan", "plans");

let activeTools = ["read", "write"];
const appendedEntries = [];

const fakePi = {
	registerFlag: () => {},
	registerCommand: () => {},
	registerShortcut: () => {},
	registerTool: () => {},
	registerAgentTool: () => {},
	on: () => {},
	getAllTools: () => [{ name: "read" }, { name: "write" }],
	getActiveTools: () => activeTools,
	setActiveTools: (tools) => { activeTools = [...tools]; },
	appendEntry: (type, data) => { appendedEntries.push({ type, data }); },
	getFlag: () => false,
	getThinkingLevel: () => "medium",
};

function makeCtx({ hasUI = true, confirmResult = true } = {}) {
	const notifications = [];
	const ctx = {
		hasUI,
		cwd: tempRoot,
		mode: "tui",
		ui: {
			notify: (message, level) => notifications.push({ message, level }),
			setStatus: () => {},
			theme: { fg: (_color, text) => text },
			confirm: async () => confirmResult,
		},
	};
	return { ctx, notifications };
}

const controller = createPlanModeController(fakePi);
process.env.PI_CODING_AGENT_DIR = path.join(tempRoot, "agent");

try {
	// 1. No-op when there is nothing to clear.
	{
		const { ctx, notifications } = makeCtx();
		await controller.clearCompletedPlan(ctx);
		assert.equal(appendedEntries.length, 0);
		assert.deepEqual(notifications, [{ message: "No active or completed plan to clear.", level: undefined }]);
	}

	// 2. Clearing a completed plan rotates the slug and preserves artifacts.
	let freshSlug;
	const oldSlug = getPlanSlug();
	writePlan("# Done");
	assert.equal(getPlan(), "# Done");
	const handoff = {
		plan: "# Done",
		planFilePath: path.join(plansDir, `${oldSlug}.md`),
		model: { provider: "test", id: "model" },
		timestamp: Date.now(),
	};
	controller.setImplementationHandoff(handoff);
	controller.markImplementationPending();
	{
		const entriesBeforeClear = appendedEntries.length;
		const { ctx, notifications } = makeCtx();
		await controller.clearCompletedPlan(ctx);
		assert.equal(appendedEntries.length, entriesBeforeClear + 1);
		freshSlug = getPlanSlug();
		assert.notEqual(freshSlug, oldSlug);
		assert.equal(getPlan(), null);
		assert.ok(existsSync(path.join(plansDir, `${oldSlug}.md`)), "old plan file must remain on disk");
		assert.deepEqual(controller.getImplementationHandoff(), handoff);
		assert.equal(controller.isImplementationPending(), false);
		const persisted = appendedEntries.at(-1).data;
		assert.equal(persisted.slug, freshSlug);
		assert.equal(persisted.enabled, false);
		assert.deepEqual(persisted.implementationHandoff, handoff);
		assert.match(notifications.at(-1).message, /Plan state cleared/);
	}

	// 3. Restore roundtrip: a resumed session restores the fresh slug, not the old one.
	{
		const { ctx } = makeCtx();
		const sessionEntries = appendedEntries.map((entry) => ({ type: "custom", customType: entry.type, data: entry.data }));
		await controller.onSessionStart({}, { ...ctx, sessionManager: { getEntries: () => sessionEntries } });
		assert.equal(getPlanSlug(), freshSlug);
		assert.equal(getPlan(), null);
		assert.equal(controller.getImplementationHandoff()?.plan, "# Done");
	}

	// 4. Fresh re-entry after clear: no prefill, no re-entry instructions.
	{
		const { ctx } = makeCtx();
		controller.beginInteractive(ctx);
		assert.equal(controller.isEnabled(), true);
		assert.equal(controller.getLastReentryState(), false);
		controller.exitPlanMode(ctx);
		assert.equal(controller.isEnabled(), false);
	}

	// 5. Clearing while plan mode is enabled exits it and restores normal tools.
	{
		const { ctx } = makeCtx();
		controller.beginInteractive(ctx);
		await controller.clearCompletedPlan(ctx);
		assert.equal(controller.isEnabled(), false);
		assert.deepEqual(activeTools, ["read", "write"]);
		const persisted = appendedEntries.at(-1).data;
		assert.notEqual(persisted.slug, freshSlug);
		assert.equal(persisted.enabled, false);
		assert.equal(persisted.needsExitReminder, true);
	}

	// 6. Cancelled confirmation leaves state unchanged.
	const wipSlug = getPlanSlug();
	writePlan("# WIP");
	{
		const entriesBefore = appendedEntries.length;
		const { ctx } = makeCtx({ confirmResult: false });
		await controller.clearCompletedPlan(ctx);
		assert.equal(getPlanSlug(), wipSlug);
		assert.equal(getPlan(), "# WIP");
		assert.equal(appendedEntries.length, entriesBefore);
	}

	// 7. Refuse while an MoA run is in progress.
	{
		controller.setActiveCancelSession({ title: "test", run: new CancelRun(), overlayOpen: false });
		const entriesBefore = appendedEntries.length;
		const { ctx, notifications } = makeCtx();
		await controller.clearCompletedPlan(ctx);
		assert.match(notifications.at(-1).message, /cancel it before clearing/);
		assert.equal(notifications.at(-1).level, "warning");
		assert.equal(getPlanSlug(), wipSlug);
		assert.equal(appendedEntries.length, entriesBefore);
		controller.setActiveCancelSession(undefined);
	}

	// 8. Refuse while an interactive plan prompt or picker is open.
	{
		controller.setActiveCancelSession({ title: "test", run: undefined, overlayOpen: false });
		const { ctx, notifications } = makeCtx();
		await controller.clearCompletedPlan(ctx);
		assert.match(notifications.at(-1).message, /Close the open plan prompt or picker/);
		assert.equal(notifications.at(-1).level, "warning");
		assert.equal(getPlanSlug(), wipSlug);
		controller.setActiveCancelSession(undefined);
	}

	// 9. Headless mode clears without a confirmation dialog.
	{
		const { ctx, notifications } = makeCtx({ hasUI: false });
		await controller.clearCompletedPlan(ctx);
		assert.equal(getPlan(), null);
		assert.notEqual(getPlanSlug(), wipSlug);
		assert.match(notifications.at(-1).message, /Plan state cleared/);
	}

	// 10. Command and F5 shortcut registration.
	{
		const extensionCommands = new Map();
		const shortcutCalls = [];
		mfPlanExtension({
			...fakePi,
			registerCommand: (name, options) => extensionCommands.set(name, options),
			registerShortcut: (key, options) => shortcutCalls.push({ key, options }),
		});
		assert.equal(typeof extensionCommands.get("mf-plan-clear")?.handler, "function");
		const f5 = shortcutCalls.find((call) => call.key === "f5");
		assert.ok(f5, "F5 shortcut registered");
		assert.match(f5.options.description, /Clear completed plan/);
	}

	// 11. Companion fix: re-entering plan mode suppresses the stale exit reminder.
	{
		const { ctx } = makeCtx();
		controller.exitPlanMode(ctx);
		let result = await controller.onBeforeAgentStart();
		assert.equal(result?.message.customType, PLAN_EXIT_CONTEXT_TYPE);
		result = await controller.onBeforeAgentStart();
		assert.equal(result, undefined);
		controller.beginInteractive(ctx);
		result = await controller.onBeforeAgentStart();
		assert.equal(result?.message.customType, PLAN_MODE_CONTEXT_TYPE);
		assert.ok(!String(result.message.content).includes("[PLAN MODE RE-ENTRY]"));
		controller.exitPlanMode(ctx);
	}
} finally {
	if (previousEnvValue === undefined) delete process.env[envKey];
	else process.env[envKey] = previousEnvValue;
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(tempRoot, { recursive: true, force: true });
}
