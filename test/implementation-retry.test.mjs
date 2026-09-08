import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Execute under Node's TS transform
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

const {
	implementationTurnFailed,
	validateImplementationHandoff,
	resolveHandoffPlan,
	buildImplementationKickoffMessage,
	runImplementationRetryFlow,
} = await import("../src/moa/implementationRetry.ts");
const { serializePlanModeState } = await import("../src/planning/modeState.ts");
const { getRepoPlanDirectory } = await import("../src/planning/planFile.ts");
const { default: mfPlanExtension } = await import("../src/index.ts");

const tempRoot = mkdtempSync(path.join(tmpdir(), "moa-implementation-retry-test-"));

try {
	// 1. implementationTurnFailed tests
	assert.equal(implementationTurnFailed(undefined), true, "undefined stopReason means failure");
	assert.equal(implementationTurnFailed("error"), true, "'error' stopReason means failure");
	assert.equal(implementationTurnFailed("aborted"), false, "'aborted' stopReason is not failure");
	assert.equal(implementationTurnFailed("stop"), false, "'stop' stopReason is not failure");
	assert.equal(implementationTurnFailed("tool_use"), false, "'tool_use' stopReason is not failure");
	assert.equal(implementationTurnFailed("length"), false, "'length' stopReason is not failure");

	// 2. validateImplementationHandoff tests
	const validHandoff = {
		plan: "# Test Plan",
		planFilePath: "/path/to/plan.md",
		repoPlanSlug: "bright-owl",
		model: { provider: "anthropic", id: "claude-3-5-sonnet" },
		thinking: "high",
		verifier: { provider: "anthropic", id: "claude-opus-4-6" },
		verifierThinking: "medium",
		verificationCriteria: "## Verification Criteria\n- **C1:** Field exists — src/foo.ts",
		verificationRepairs: 0,
		timestamp: 1700000000000,
	};
	assert.deepEqual(validateImplementationHandoff(validHandoff), validHandoff);

	// Optional fields omitted
	assert.ok(validateImplementationHandoff({
		plan: "# Minimal",
		planFilePath: "/path/to/plan.md",
		timestamp: Date.now(),
	}));

	// Invalid cases
	assert.equal(validateImplementationHandoff(null), undefined);
	assert.equal(validateImplementationHandoff(123), undefined);
	assert.equal(validateImplementationHandoff({ plan: 123, planFilePath: "/a", timestamp: 1 }), undefined);
	assert.equal(validateImplementationHandoff({ plan: "ok", planFilePath: "", timestamp: 1 }), undefined);
	assert.equal(validateImplementationHandoff({ plan: "ok", planFilePath: "/a", timestamp: 0 }), undefined);
	assert.equal(validateImplementationHandoff({ plan: "ok", planFilePath: "/a", timestamp: 1, repoPlanSlug: "bad slug with spaces!" }), undefined);
	assert.equal(validateImplementationHandoff({ plan: "ok", planFilePath: "/a", timestamp: 1, model: { provider: 123 } }), undefined);
	assert.equal(validateImplementationHandoff({ plan: "ok", planFilePath: "/a", timestamp: 1, thinking: "invalid-level" }), undefined);
	// New verifier / repair fields validate when present and reject garbage.
	assert.equal(validateImplementationHandoff({ plan: "ok", planFilePath: "/a", timestamp: 1, verifier: { provider: 123 } }), undefined);
	assert.equal(validateImplementationHandoff({ plan: "ok", planFilePath: "/a", timestamp: 1, verifierThinking: "invalid-level" }), undefined);
	assert.equal(validateImplementationHandoff({ plan: "ok", planFilePath: "/a", timestamp: 1, verificationRepairs: -1 }), undefined);
	assert.equal(validateImplementationHandoff({ plan: "ok", planFilePath: "/a", timestamp: 1, verificationRepairs: 1.5 }), undefined);
	assert.equal(validateImplementationHandoff({ plan: "ok", planFilePath: "/a", timestamp: 1, verificationCriteria: 1 }), undefined);
	assert.ok(validateImplementationHandoff({ plan: "ok", planFilePath: "/a", timestamp: 1, verifier: { provider: "anthropic", id: "claude-opus-4-6" }, verifierThinking: "low", verificationRepairs: 2 }));

	// 3. resolveHandoffPlan tests
	assert.equal(resolveHandoffPlan({ plan: "# Inline Plan", planFilePath: "/none", timestamp: 1 }), "# Inline Plan");

	// planFilePath is only trusted when it resolves inside the repo's plan directory.
	const repoPlanDir = getRepoPlanDirectory(tempRoot);
	const planFileOnDisk = path.join(repoPlanDir, "disk-plan.md");
	writeFileSync(planFileOnDisk, "# Plan from disk", "utf8");
	assert.equal(resolveHandoffPlan({ plan: "", planFilePath: planFileOnDisk, timestamp: 1 }, tempRoot), "# Plan from disk");

	// A planFilePath outside the confined directories is rejected, even if it exists on disk.
	const outsidePlanFile = path.join(tempRoot, "outside-plan.md");
	writeFileSync(outsidePlanFile, "# Untrusted content", "utf8");
	assert.equal(resolveHandoffPlan({ plan: "", planFilePath: outsidePlanFile, timestamp: 1 }, tempRoot), null);

	// 4. buildImplementationKickoffMessage tests
	const defaultKickoff = buildImplementationKickoffMessage("# My Plan", "/path/to/file.md");
	assert.ok(defaultKickoff.includes("User has approved your plan."));
	assert.ok(defaultKickoff.includes("Your plan has been saved to: /path/to/file.md"));
	assert.ok(defaultKickoff.includes("## Approved Plan:\n# My Plan"));
	// The kickoff message carries the subagent delegation directive on every path.
	assert.ok(defaultKickoff.includes("delegate independent, well-scoped pieces"));

	const noteKickoff = buildImplementationKickoffMessage("# My Plan", "/path/to/file.md", "Previous attempt failed.");
	assert.ok(noteKickoff.startsWith("Previous attempt failed.\n\nUser has approved your plan."));

	// 5. serializePlanModeState with oversized handoff plan
	const oversizedHandoff = {
		plan: "x".repeat(600 * 1024),
		planFilePath: "/path/to/plan.md",
		repoPlanSlug: "bright-owl",
		timestamp: Date.now(),
	};
	const serializedResult = serializePlanModeState({
		enabled: false,
		slug: "test-slug",
		implementationHandoff: oversizedHandoff,
	});
	assert.equal(serializedResult.state.implementationHandoff?.plan, "");
	assert.equal(serializedResult.state.implementationHandoff?.planFilePath, "/path/to/plan.md");
	assert.ok(Buffer.byteLength(serializedResult.serialized, "utf8") <= 512 * 1024);

	// 6. runImplementationRetryFlow tests
	let sentMessages = [];
	let appliedSelections = [];
	let pendingMarked = false;
	let currentHandoff = validHandoff;
	// The adopted MoA Fusion table: retry restarts its Implement row, manual
	// continuation disposes it.
	const widgetCalls = [];
	let widgetStopped = 0;
	const fakeWidget = {
		switchToImplementing: (ref, status, thinking) => widgetCalls.push(["switchToImplementing", ref, status, thinking]),
		setPhaseModels: (models) => widgetCalls.push(["setPhaseModels", models]),
	};

	const fakeHost = {
		pi: {
			sendUserMessage: async (text) => { sentMessages.push(text); },
		},
		currentThinkingLevel: () => "high",
		applyImplementingSelection: async (_ctx, selection) => { appliedSelections.push(selection); },
		setImplementationHandoff: (h) => { currentHandoff = h; },
		markImplementationPending: () => { pendingMarked = true; },
		getActiveRunMoaInfo: () => undefined,
		getActiveProgressWidget: () => fakeWidget,
		stopActiveProgressWidget: () => { widgetStopped++; },
	};

	// 6a. No UI context -> notify only
	let notifications = [];
	const commandContext = {
	hasUI: false,
	cwd: tempRoot,
	ui: {
		notify: (msg, type) => { notifications.push({ msg, type }); },
		setStatus: () => {},
		theme: { fg: (_color, text) => text },
	},
};
	await runImplementationRetryFlow(commandContext, fakeHost, validHandoff, "Auth token expired");
	assert.equal(notifications.length, 1);
	assert.ok(notifications[0].msg.includes("Implementation failed: Auth token expired"));
	assert.equal(sentMessages.length, 0);

	// 6b. UI with "Retry" selection
	let selectPrompt = "";
	let selectOptions = [];
	const retryCtx = {
		hasUI: true,
		cwd: tempRoot,
		model: { provider: "anthropic", id: "claude-3-5-sonnet" },
		ui: {
			notify: (msg, type) => { notifications.push({ msg, type }); },
			select: async (prompt, options) => {
				selectPrompt = prompt;
				selectOptions = options;
				return options[0]; // "Retry with..."
			},
		},
	};
	pendingMarked = false;
	await runImplementationRetryFlow(retryCtx, fakeHost, validHandoff, "Rate limit reached");
	assert.ok(pendingMarked, "Retry should mark implementation pending");
	assert.equal(sentMessages.length, 1);
	assert.ok(sentMessages[0].includes("The previous implementation attempt failed with: Rate limit reached"));
	assert.deepEqual(
		widgetCalls.at(-1),
		["switchToImplementing", validHandoff.model, "retrying implementation…", validHandoff.thinking],
		"a retry restarts the adopted table's Implement row with the same model and its unchanged thinking level",
	);
	assert.equal(widgetStopped, 0, "a retry keeps the table mounted");

	// 6b'. UI with "Choose a different model" refreshes the band and the row.
	widgetCalls.length = 0;
	sentMessages = [];
	const pickedRef = { provider: "openai", id: "gpt-5" };
	const pickCtx = {
		...retryCtx,
		ui: {
			...retryCtx.ui,
			select: async (_prompt, options) => options.find((option) => option === "Choose a different model") ?? options[0],
			// The model picker is a TUI custom component; stand in for it by
			// resolving the selection it would have produced.
			custom: async () => ({ ref: pickedRef, thinking: "high" }),
		},
		modelRegistry: {
			getAvailable: () => [{ provider: pickedRef.provider, id: pickedRef.id, name: "GPT-5", reasoning: false }],
			find: () => ({ provider: pickedRef.provider, id: pickedRef.id, name: "GPT-5", reasoning: false }),
			getRegisteredProviderIds: () => [],
		},
	};
	appliedSelections = [];
	await runImplementationRetryFlow(pickCtx, fakeHost, validHandoff, "Rate limit reached");
	assert.deepEqual(appliedSelections.at(-1)?.ref, pickedRef, "the chosen model is applied");
	assert.deepEqual(currentHandoff.model, pickedRef, "the handoff records the new implementer");
	const band = widgetCalls.find(([name]) => name === "setPhaseModels");
	assert.ok(band, "switching models refreshes the band");
	assert.deepEqual(band[1].Implement, pickedRef, "the band's Implement cell shows the newly chosen model");
	assert.deepEqual(widgetCalls.at(-1), ["switchToImplementing", pickedRef, "retrying implementation…", "high"], "the Implement row restarts under the new model and its newly selected thinking level");
	assert.equal(sentMessages.length, 1, "and the kickoff is re-sent");
	assert.ok(sentMessages[0].includes("Switched implementation model to openai/gpt-5"));
	currentHandoff = validHandoff;

	// 6c. UI with "Continue manually" selection
	sentMessages = [];
	notifications = [];
	const manualCtx = {
		hasUI: true,
		cwd: tempRoot,
		model: { provider: "anthropic", id: "claude-3-5-sonnet" },
		ui: {
			notify: (msg, type) => { notifications.push({ msg, type }); },
			select: async () => "Continue manually",
		},
	};
	await runImplementationRetryFlow(manualCtx, fakeHost, validHandoff);
	assert.equal(sentMessages.length, 0);
	assert.ok(notifications.some((n) => n.msg.includes("Implementation paused")));
	assert.equal(widgetStopped, 1, "continuing manually disposes the adopted table");

	// 7. Full lifecycle test via extension events
	const handlers = new Map();
	const commands = new Map();
	const tools = new Map();
	const appendedEntries = [];
	let activeTools = ["read", "write"];

	const fakePi = {
		getThinkingLevel: () => "medium",
		getAllTools: () => [{ name: "read" }, { name: "write" }],
		getActiveTools: () => activeTools,
		setActiveTools: (t) => { activeTools = t; },
		appendEntry: (type, data) => { appendedEntries.push({ type, data }); },
		registerFlag: () => {},
		registerCommand: (name, options) => commands.set(name, options),
		registerShortcut: () => {},
		registerTool: (t) => tools.set(t.name, t),
		on: (name, handler) => handlers.set(name, handler),
		getFlag: () => false,
		sendUserMessage: async (text) => { sentMessages.push(text); },
	};

	mfPlanExtension(fakePi);

	const messageEndHandler = handlers.get("message_end");
	const agentSettledHandler = handlers.get("agent_settled");
	const sessionStartHandler = handlers.get("session_start");
	const implementCommand = commands.get("mf-plan-implement");

	assert.equal(typeof messageEndHandler, "function");
	assert.equal(typeof agentSettledHandler, "function");
	assert.equal(typeof sessionStartHandler, "function");
	assert.equal(typeof implementCommand?.handler, "function");

	// Test session restore of handoff
	const sessionManager = {
		getEntries: () => [
			{
				type: "custom",
				customType: "mf-plan",
				data: {
					enabled: false,
					slug: "neat-fox",
					implementationHandoff: validHandoff,
				},
			},
		],
	};
	await sessionStartHandler({}, { ...commandContext, sessionManager });

	// Test /mf-plan-implement command execution
	sentMessages = [];
	await implementCommand.handler("", commandContext);
	assert.equal(sentMessages.length, 1);
	assert.ok(sentMessages[0].includes("This is a manual resume of the approved plan."));
	assert.ok(sentMessages[0].includes("# Test Plan"));

	console.log("All implementation-retry unit and lifecycle tests passed!");
} finally {
	rmSync(tempRoot, { recursive: true, force: true });
}
