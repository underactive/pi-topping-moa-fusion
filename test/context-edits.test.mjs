import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.execArgv.includes("--experimental-transform-types")) {
	try {
		execFileSync(process.execPath, ["--experimental-transform-types", fileURLToPath(import.meta.url)], { stdio: "inherit" });
	} catch (err) {
		process.exit(err.status ?? 1);
	}
	process.exit(0);
}

const {
	buildVerificationPendingMessage,
	collectOmissionDrafts,
	isPlanInstructionEntry,
	isPlanModeInstructionText,
	isVerificationPendingEntry,
} = await import("../src/planning/contextEdits.ts");
const { createPlanModeController } = await import("../src/planning/planMode.ts");

assert.equal(isPlanModeInstructionText("[PLAN MODE ACTIVE] read only"), true);
assert.equal(isPlanModeInstructionText([{ type: "text", text: "[PLAN MODE RE-ENTRY] continue" }]), true);
assert.equal(isPlanModeInstructionText("ordinary text"), false);
assert.equal(isPlanModeInstructionText([{ type: "image", data: "x" }]), false);

assert.equal(isPlanInstructionEntry({ id: "a", type: "custom_message", customType: "mf-plan-context" }), true);
assert.equal(isPlanInstructionEntry({ id: "b", type: "message", message: { role: "user", content: "[PLAN MODE ACTIVE] x" } }), true);
assert.equal(isPlanInstructionEntry({ id: "c", type: "custom_message", customType: "mf-plan-exit" }), false);
assert.equal(isVerificationPendingEntry({ type: "custom_message", customType: "mf-plan-verification-pending" }), true);
assert.match(buildVerificationPendingMessage("/tmp/plan.md"), /\/tmp\/plan\.md/);

const candidates = [
	{ id: "one", type: "custom_message", customType: "mf-plan-context" },
	{ id: "two", type: "message", message: { role: "user", content: "[PLAN MODE ACTIVE] x" } },
	{ id: "three", type: "custom_message", customType: "mf-plan-context" },
	{ type: "custom_message", customType: "mf-plan-context" },
	{ id: "edit", type: "context_edit", targetId: "two", replacement: null },
];
assert.deepEqual(collectOmissionDrafts(candidates, isPlanInstructionEntry, new Set(["three"])), [
	{ type: "context_edit", targetId: "one", replacement: null },
]);

const tempRoot = mkdtempSync(path.join(tmpdir(), "moa-context-edits-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = path.join(tempRoot, "agent");

function makeHarness(branch = []) {
	let activeTools = ["read", "write"];
	const notifications = [];
	const fakePi = {
		getThinkingLevel: () => "medium",
		getAllTools: () => [{ name: "read" }, { name: "write" }],
		getActiveTools: () => activeTools,
		setActiveTools: (tools) => { activeTools = tools; },
		appendEntry: () => {},
		on: () => () => {},
		getFlag: () => false,
	};
	const ctx = {
		hasUI: false,
		mode: "print",
		cwd: tempRoot,
		isIdle: () => true,
		ui: {
			notify: (message, type) => notifications.push({ message, type }),
			setStatus: () => {},
			theme: { fg: (_color, text) => text },
		},
		sessionManager: {
			getEntries: () => [],
			getBranch: () => branch,
		},
	};
	return { controller: createPlanModeController(fakePi), ctx, notifications };
}

function boundary(overrides = {}) {
	return {
		type: "agent_before_settle",
		entries: [],
		continue: false,
		context: { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: false },
		outcome: "completed",
		...overrides,
	};
}

try {
	const branch = [
		{ id: "plan", type: "custom_message", customType: "mf-plan-context" },
		{ id: "exit", type: "custom_message", customType: "mf-plan-exit" },
	];
	const omission = makeHarness(branch);
	omission.controller.beginInteractive(omission.ctx);
	assert.equal(omission.controller.onAgentBeforeSettle(boundary(), omission.ctx), undefined);
	omission.controller.exitPlanMode(omission.ctx);
	const prior = { type: "custom", customType: "other", data: 1 };
	const result = omission.controller.onAgentBeforeSettle(boundary({ entries: [prior] }), omission.ctx);
	assert.deepEqual(result, { entries: [prior, { type: "context_edit", targetId: "plan", replacement: null }] });
	assert.equal("continue" in result, false);
	// A rejected combined boundary proposal must be retried while an edit that
	// reached the branch remains idempotent.
	assert.deepEqual(omission.controller.onAgentBeforeSettle(boundary(), omission.ctx), {
		entries: [{ type: "context_edit", targetId: "plan", replacement: null }],
	});
	branch.push({ id: "omission", type: "context_edit", targetId: "plan", replacement: null });
	assert.equal(omission.controller.onAgentBeforeSettle(boundary(), omission.ctx), undefined);

	const handoff = { plan: "# Plan", planFilePath: "/tmp/plan.md", verifier: { provider: "p", id: "v" }, timestamp: 1 };
	const marker = makeHarness();
	marker.controller.setImplementationHandoff(handoff);
	marker.controller.markImplementationPending(marker.ctx);
	marker.controller.onMessageEnd({ message: { role: "assistant", stopReason: "stop", content: "done" } }, marker.ctx);
	const markerResult = marker.controller.onAgentBeforeSettle(boundary(), marker.ctx);
	const markerDraft = markerResult.entries.find((entry) => entry.type === "custom_message");
	assert.equal(markerDraft.customType, "mf-plan-verification-pending");
	assert.equal(markerDraft.display, false);
	assert.ok(markerDraft.content.length > 0);

	function assertNoMarker(configure, event = boundary()) {
		const harness = makeHarness();
		harness.controller.setImplementationHandoff(handoff);
		harness.controller.markImplementationPending(harness.ctx);
		configure(harness);
		const settled = harness.controller.onAgentBeforeSettle(event, harness.ctx);
		assert.equal(settled?.entries.some((entry) => entry.type === "custom_message") ?? false, false);
	}
	assertNoMarker(() => {});
	assertNoMarker(({ controller, ctx }) => controller.onMessageEnd({ message: { role: "assistant", stopReason: "stop" } }, ctx), boundary({ context: { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [{}], canContinue: true } }));
	assertNoMarker(({ controller, ctx }) => controller.onMessageEnd({ message: { role: "assistant", stopReason: "stop" } }, ctx), boundary({ outcome: "aborted" }));
	assertNoMarker(({ controller, ctx }) => controller.onMessageEnd({ message: { role: "assistant", stopReason: "aborted" } }, ctx));
	assertNoMarker(({ controller, ctx }) => controller.onMessageEnd({ message: { role: "assistant", stopReason: "error" } }, ctx));
	assertNoMarker(({ controller, ctx }) => {
		controller.setImplementationHandoff({ ...handoff, verifier: undefined });
		controller.onMessageEnd({ message: { role: "assistant", stopReason: "stop" } }, ctx);
	});
	const notPending = makeHarness();
	notPending.controller.setImplementationHandoff(handoff);
	notPending.controller.onMessageEnd({ message: { role: "assistant", stopReason: "stop" } }, notPending.ctx);
	assert.equal(notPending.controller.onAgentBeforeSettle(boundary(), notPending.ctx), undefined);

	const markerBranch = [{ id: "pending", type: "custom_message", customType: "mf-plan-verification-pending" }];
	const sweep = makeHarness(markerBranch);
	assert.deepEqual(sweep.controller.onAgentBeforeSettle(boundary(), sweep.ctx), {
		entries: [{ type: "context_edit", targetId: "pending", replacement: null }],
	});

	const resume = makeHarness(markerBranch);
	await resume.controller.onSessionStart({}, resume.ctx);
	assert.equal(resume.notifications.some(({ message }) => /mf-plan-implement/.test(message)), true);
	const resolvedResume = makeHarness([...markerBranch, { id: "omit", type: "context_edit", targetId: "pending", replacement: null }]);
	await resolvedResume.controller.onSessionStart({}, resolvedResume.ctx);
	assert.equal(resolvedResume.notifications.some(({ message }) => /mf-plan-implement/.test(message)), false);

	const fallback = makeHarness();
	fallback.ctx.sessionManager = { getEntries: () => [] };
	assert.doesNotThrow(() => fallback.controller.onAgentBeforeSettle(boundary(), fallback.ctx));
	await assert.doesNotReject(() => fallback.controller.onSessionStart({}, fallback.ctx));
} finally {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(tempRoot, { recursive: true, force: true });
}

console.log("Context edit tests passed.");
