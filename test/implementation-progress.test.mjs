import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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

// Point the agent dir at an empty temp dir so loadMoaConfig() has no verifier:
// a "done" implementer turn must not spawn a real verification subprocess here.
const agentDir = mkdtempSync(path.join(tmpdir(), "moa-implementation-progress-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { createPlanModeController } = await import("../src/planning/planMode.ts");
const { MoaProgressWidget } = await import("../src/ui/moaProgressWidget.ts");

const PROPOSERS = [
	{ provider: "anthropic", id: "claude-opus-4" },
	{ provider: "openai", id: "gpt-5" },
];
const SYNTHESIZER = { provider: "google", id: "gemini-3-pro" };
const IMPLEMENTER = { provider: "anthropic", id: "claude-opus-4" };
const CONTEXT_WINDOW = 200_000;

/** Registry entry with priced tokens so cost resolution has something to multiply. */
const REGISTRY_MODEL = {
	provider: IMPLEMENTER.provider,
	id: IMPLEMENTER.id,
	name: "Claude Opus 4",
	contextWindow: CONTEXT_WINDOW,
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};

function fakePi() {
	return {
		getThinkingLevel: () => "medium",
		getAllTools: () => [{ name: "read" }, { name: "write" }],
		getActiveTools: () => ["read", "write"],
		setActiveTools: () => {},
		appendEntry: () => {},
		getFlag: () => false,
		sendUserMessage: async () => {},
	};
}

/** Fake ExtensionContext mirroring pi's setExtensionWidget replace/dispose semantics. */
function fakeCtx() {
	const state = { widget: undefined, mounts: 0, disposed: 0, notices: [] };
	const tui = { requestRender: () => {}, terminal: { rows: 40, columns: 120 } };
	const theme = { fg: (_color, text) => text, bold: (text) => text };
	const ctx = {
		mode: "tui",
		hasUI: false,
		cwd: agentDir,
		modelRegistry: {
			find: (provider, id) => (provider === REGISTRY_MODEL.provider && id === REGISTRY_MODEL.id ? REGISTRY_MODEL : undefined),
			getRegisteredProviderIds: () => [],
		},
		ui: {
			setWidget: (_key, factory) => {
				if (state.widget) {
					state.widget.dispose?.();
					state.widget = undefined;
					state.disposed++;
				}
				if (!factory) return;
				state.widget = factory(tui, theme);
				state.mounts++;
			},
			notify: (msg, type) => state.notices.push({ msg, type }),
			setStatus: () => {},
			theme,
		},
	};
	return { ctx, state };
}

const HANDOFF = {
	plan: "# Plan",
	planFilePath: path.join(agentDir, "plan.md"),
	model: IMPLEMENTER,
	thinking: "high",
	timestamp: Date.now(),
};

/** Wire a controller with an adopted, Implement-active table, as approval does. */
function adoptedRun() {
	const { ctx, state } = fakeCtx();
	const controller = createPlanModeController(fakePi());
	const widget = new MoaProgressWidget(ctx, () => CONTEXT_WINDOW, {}, "voice-transcribe-plan");
	widget.setPhaseModels({ Plan: PROPOSERS, Synthesize: SYNTHESIZER, Implement: IMPLEMENTER });
	widget.startFanout(PROPOSERS);
	widget.update(0, "done");
	widget.update(1, "done");
	widget.switchToSynthesizing(SYNTHESIZER, "synthesizing plan…");
	widget.settleRoleRow("Synthesize", "done");
	controller.setImplementationHandoff(HANDOFF);
	widget.switchToImplementing(IMPLEMENTER, "implementing plan…");
	controller.moaRunHost.adoptProgressWidget(widget);
	controller.markImplementationPending(ctx);
	return { ctx, state, controller, widget };
}

const implementRow = (widget) => widget.progressRows().find((r) => r.phase === "Implement");

const assistantMessage = (overrides = {}) => ({
	role: "assistant",
	stopReason: "stop",
	content: [{ type: "text", text: "Implemented the plan." }],
	usage: { input: 1_000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 1_500, cost: { total: 0 } },
	...overrides,
});

const runTurn = (controller, ctx, { toolName = "read", args = { path: "src/a.ts" }, message = assistantMessage() } = {}) => {
	controller.onMessageStart({ type: "message_start", message: { role: "assistant" } }, ctx);
	controller.onMessageUpdate(
		{ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "one two three " } },
		ctx,
	);
	controller.onToolExecutionStart({ type: "tool_execution_start", toolCallId: "c1", toolName, args }, ctx);
	controller.onMessageEnd({ type: "message_end", message }, ctx);
};

try {
	// ── the Implement row accumulates live telemetry from pi's events ─────
	{
		const { ctx, state, controller, widget } = adoptedRun();
		assert.equal(controller.moaRunHost.getActiveProgressWidget(), widget, "approval hands the table to the controller");
		assert.equal(state.mounts, 1, "adoption keeps the one mounted table");
		assert.ok(controller.isImplementationPending());

		const before = implementRow(widget);
		assert.equal(before.state, "working");
		assert.equal(before.turns, 0);

		controller.onMessageStart({ type: "message_start", message: { role: "assistant" } }, ctx);
		controller.onMessageUpdate(
			{ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "one two three " } },
			ctx,
		);
		assert.equal(implementRow(widget).outputTokens, 3, "streamed deltas drive the output meter as word estimates");
		assert.equal(implementRow(widget).transcript.partial.content[0].text, "one two three ", "streamed deltas assemble a live Implement preview");
		assert.ok(state.widget.render(100).some((line) => line.includes("(generating…)")), "the live preview carries its generation marker");

		controller.onToolExecutionStart({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "src/a.ts" } }, ctx);
		controller.onToolExecutionStart({ type: "tool_execution_start", toolCallId: "c2", toolName: "bash", args: { command: "npm test" } }, ctx);
		assert.match(implementRow(widget).activity, /npm test/, "the latest tool call is the activity line");

		controller.onMessageEnd({ type: "message_end", message: assistantMessage() }, ctx);
		const after = implementRow(widget);
		assert.equal(after.turns, 1, "each assistant message end counts a turn");
		assert.equal(after.toolCalls, 2, "tool calls accumulate across the turn");
		assert.equal(after.contextTokens, 1_500, "context is the latest message's total tokens");
		assert.ok(after.costUsd > 0, "cost is priced from the registry rates");
		assert.equal(after.outputTokens, 500, "exact output usage supersedes the streamed estimate");
		assert.notEqual(after.outputRevision, before.outputRevision, "so the meter tracker is reset");
		assert.equal(after.transcript.partial, undefined, "the settled message clears the streaming partial");
		const finalizedPreview = state.widget.render(100).join("\n");
		assert.match(finalizedPreview, /Implemented the plan\./, "the final assistant message replaces the live partial");
		assert.ok(!finalizedPreview.includes("(generating…)"), "the finalized preview drops its generation marker");
		controller.onMessageEnd({
			type: "message_end",
			message: { role: "toolResult", toolCallId: "c2", toolName: "read", content: [{ type: "text", text: "tool output" }], isError: false },
		}, ctx);
		assert.equal(implementRow(widget).transcript.messages.at(-1).role, "toolResult", "surfaced tool results join the completed transcript");

		runTurn(controller, ctx, { message: assistantMessage({ usage: { input: 2_000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 2_600, cost: { total: 0 } } }) });
		const second = implementRow(widget);
		assert.equal(second.turns, 2);
		assert.equal(second.toolCalls, 3);
		assert.equal(second.contextTokens, 2_600);
		assert.ok(second.costUsd > after.costUsd, "cost keeps accumulating across turns");

		controller.onAgentSettled({ type: "agent_settled" }, ctx);
		assert.equal(implementRow(widget).state, "done", "a clean stop settles the Implement row as done");
		assert.equal(controller.isImplementationPending(), false);
		assert.equal(state.disposed, 0, "a done implementer leaves the table for verification to close");
		controller.onSessionShutdown({ reason: "test" });
		assert.equal(state.disposed, 1, "shutdown disposes the table (and its repaint timer)");
		assert.equal(controller.moaRunHost.getActiveProgressWidget(), undefined);
	}

	// ── handlers are inert when no implementation is pending ──────────────
	{
		const { ctx, state, controller, widget } = adoptedRun();
		controller.onAgentSettled({ type: "agent_settled" }, ctx);
		const settled = implementRow(widget);

		runTurn(controller, ctx);
		const afterNoise = implementRow(widget);
		assert.equal(afterNoise.transcriptRevision, settled.transcriptRevision, "an unrelated turn does not revise the transcript");
		assert.equal(afterNoise.turns, settled.turns, "an unrelated turn adds no turns");
		assert.equal(afterNoise.toolCalls, settled.toolCalls, "an unrelated turn adds no tool calls");
		assert.equal(afterNoise.activity, settled.activity, "an unrelated turn adds no activity");
		assert.equal(afterNoise.state, settled.state);
		controller.onSessionShutdown({ reason: "test" });
		assert.equal(state.disposed, 1);
	}

	// ── an error stop settles the row as error and offers the retry flow ──
	{
		const { ctx, state, controller, widget } = adoptedRun();
		runTurn(controller, ctx, { message: assistantMessage({ stopReason: "error" }) });
		controller.onAgentSettled({ type: "agent_settled" }, ctx);
		assert.equal(implementRow(widget).state, "error");
		assert.equal(state.disposed, 0, "the table stays up while the retry prompt is offered");
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.ok(state.notices.some((n) => /Implementation failed/.test(n.msg)), "headless: the retry flow reports the failure");
		controller.onSessionShutdown({ reason: "test" });
		assert.equal(state.disposed, 1);
	}

	// ── an aborted turn settles the row as cancelled and stops the table ──
	{
		const { ctx, state, controller, widget } = adoptedRun();
		runTurn(controller, ctx, { message: assistantMessage({ stopReason: "aborted" }) });
		controller.onAgentSettled({ type: "agent_settled" }, ctx);
		assert.equal(implementRow(widget).state, "cancelled");
		assert.equal(state.disposed, 1, "a cancelled implementation disposes the table immediately");
		assert.equal(controller.moaRunHost.getActiveProgressWidget(), undefined);
		controller.onSessionShutdown({ reason: "test" });
		assert.equal(state.disposed, 1, "shutdown after a stop is a no-op");
	}

	// ── a retry restarts the Implement row with fresh telemetry ───────────
	{
		const { ctx, state, controller, widget } = adoptedRun();
		runTurn(controller, ctx, { message: assistantMessage({ stopReason: "error" }) });
		controller.onAgentSettled({ type: "agent_settled" }, ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(implementRow(widget).state, "error");

		// What the "Retry with …" branch does: re-arm pending and restart the row.
		controller.markImplementationPending(ctx);
		widget.switchToImplementing(IMPLEMENTER, "retrying implementation…");
		const restarted = implementRow(widget);
		assert.equal(restarted.state, "working");
		assert.equal(restarted.turns, 0, "a settled → working restart clears the turn count");
		assert.equal(restarted.toolCalls, 0);
		assert.equal(restarted.transcript, undefined, "a retry clears output from the failed implementation attempt");
		assert.equal(restarted.statusText, "retrying implementation…");
		assert.equal(state.mounts, 1, "the retry reuses the same mounted table");

		runTurn(controller, ctx);
		assert.equal(implementRow(widget).turns, 1, "telemetry starts over from the retry");
		assert.equal(implementRow(widget).toolCalls, 1);
		controller.onSessionShutdown({ reason: "test" });
		assert.equal(state.disposed, 1);
	}

	// ── a resumed run with no table constructs and adopts one ─────────────
	{
		const { ctx, state } = fakeCtx();
		const controller = createPlanModeController(fakePi());
		controller.setActiveRunMoaInfo({ proposers: PROPOSERS, synthesizer: SYNTHESIZER });
		controller.setImplementationHandoff(HANDOFF);
		assert.equal(controller.moaRunHost.getActiveProgressWidget(), undefined);

		controller.markImplementationPending(ctx);
		const widget = controller.moaRunHost.getActiveProgressWidget();
		assert.ok(widget, "a manual resume rebuilds the table from the saved run info");
		assert.equal(state.mounts, 1);
		assert.deepEqual(widget.phaseModels().Plan, PROPOSERS, "the band is reconstructed from the run's proposers");
		assert.deepEqual(widget.phaseModels().Synthesize, SYNTHESIZER);
		assert.deepEqual(widget.phaseModels().Implement, IMPLEMENTER, "and the handoff's implementer");
		assert.equal(widget.phaseModels().Verify, undefined, "an unknown verifier is left blank rather than fabricated");
		assert.equal(widget.activePhase(), "Implement");
		const row = implementRow(widget);
		assert.equal(row.state, "working");
		assert.equal(row.statusText, "implementing plan…");
		assert.equal(row.thinking, "high", "the rebuilt Implement row carries the handoff's thinking level, tinting its meter");
		assert.equal(widget.progressRows().filter((r) => r.phase === "Plan").length, 0, "proposer rows are not fabricated for a resumed run");

		runTurn(controller, ctx);
		assert.equal(implementRow(widget).turns, 1, "the rebuilt table receives telemetry");

		// A second pending mark with the table already up must not remount.
		controller.markImplementationPending(ctx);
		assert.equal(state.mounts, 1);
		assert.equal(controller.moaRunHost.getActiveProgressWidget(), widget);

		controller.onSessionShutdown({ reason: "test" });
		assert.equal(state.disposed, 1, "shutdown disposes the rebuilt table");
	}

	// ── no run info and no ctx: nothing is fabricated ─────────────────────
	{
		const controller = createPlanModeController(fakePi());
		controller.setImplementationHandoff(HANDOFF);
		controller.markImplementationPending();
		assert.equal(controller.moaRunHost.getActiveProgressWidget(), undefined, "single-model approval has no MoA table to rebuild");
		assert.ok(controller.isImplementationPending());
		controller.onSessionShutdown({ reason: "test" });
	}

	// ── adopting a second table disposes the first ────────────────────────
	{
		const { ctx, state, controller, widget } = adoptedRun();
		const replacement = new MoaProgressWidget(ctx, () => CONTEXT_WINDOW);
		controller.moaRunHost.adoptProgressWidget(replacement);
		assert.equal(controller.moaRunHost.getActiveProgressWidget(), replacement);
		assert.equal(state.widget, undefined, "the superseded table is unmounted");
		assert.equal(state.disposed, 1);
		widget.stopWidget();
		controller.moaRunHost.stopActiveProgressWidget();
		assert.equal(controller.moaRunHost.getActiveProgressWidget(), undefined);
	}

	// ── a stale ctx (post-/reload) must not escape as an unhandled rejection ──
	// Regression: pi's ctx getters throw once the extension is reloaded. The
	// verification flow rejected on the stale ctx and the .catch handler then
	// called ctx.ui.notify on the same stale ctx, which threw inside the
	// rejection handler and crashed pi with an uncaughtException.
	for (const stopReason of ["stop", "error"]) {
		const { ctx, controller } = adoptedRun();
		controller.setImplementationHandoff({ ...HANDOFF, verifier: SYNTHESIZER });
		runTurn(controller, ctx, { message: assistantMessage({ stopReason }) });
		const staleError = () => new Error("This extension ctx is stale after session replacement or reload.");
		const staleCtx = {
			get ui() { throw staleError(); },
			get cwd() { throw staleError(); },
			get hasUI() { throw staleError(); },
			get mode() { throw staleError(); },
			modelRegistry: ctx.modelRegistry,
		};
		const unhandled = [];
		const onUnhandled = (reason) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			assert.doesNotThrow(() => controller.onAgentSettled({ type: "agent_settled" }, staleCtx));
			for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
			assert.deepEqual(unhandled, [], `stopReason=${stopReason}: a stale ctx in the post-settle flow must be swallowed, not crash the process`);
		} finally {
			process.off("unhandledRejection", onUnhandled);
			controller.onSessionShutdown({ reason: "test" });
		}
	}

	console.log("Implementation progress tests passed.");
} finally {
	rmSync(agentDir, { recursive: true, force: true });
}
