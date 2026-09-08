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

const agentDir = mkdtempSync(path.join(tmpdir(), "moa-review-transition-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { runReviewLoop } = await import("../src/moa/reviewLoop.ts");

const SYNTHESIZER = { provider: "openai", id: "gpt-synth" };
const IMPLEMENTER = { provider: "openai", id: "gpt-implement" };
const VERIFIER = { provider: "anthropic", id: "claude-verify" };
const calls = [];
let handoff;

const assistantMessage = (text) => ({ role: "assistant", content: [{ type: "text", text }] });

const widget = {
	settleRoleRow: (phase, state) => calls.push(["settle", phase, state]),
	setPhaseModels: () => calls.push(["models"]),
	switchToImplementing: (ref, status, thinking) => calls.push(["implement", ref, status, thinking]),
};

const host = {
	pi: { sendUserMessage: () => calls.push(["message"]) },
	setActiveRunMoaInfo: () => {},
	getActiveRunMoaInfo: () => undefined,
	persistState: () => {},
	getPlanRepoSlug: () => undefined,
	currentThinkingLevel: () => "medium",
	applyImplementingSelection: async () => {},
	exitPlanMode: () => {},
	saveApprovedPlanToRepo: () => {},
	setImplementationHandoff: (value) => { handoff = value; },
	markImplementationPending: () => calls.push(["pending"]),
	adoptProgressWidget: () => calls.push(["adopt"]),
};

try {
	await runReviewLoop({
		host,
		ctx: {
			mode: "print",
			cwd: agentDir,
			ui: { select: async () => "Approve — start implementing", notify: () => {} },
		},
		session: {},
		widget,
		proposers: [],
		succeeded: [],
		initialPlan: "# Plan\n\nImplement it.",
		synthConversation: [],
		getSynthesizer: () => SYNTHESIZER,
		getSynthesizerThinking: () => "high",
		getLatestVerdicts: () => null,
		setLatestVerdicts: () => {},
		rebuildSynthTask: () => {},
		getSynthTask: () => "",
		runSynthWithRecovery: async () => assert.fail("approval must not rerun synthesis"),
		warnIfMutated: async () => {},
		roles: { implementer: IMPLEMENTER, verifier: VERIFIER },
	});

	assert.deepEqual(calls.slice(0, 3), [
		["settle", "Synthesize", "done"],
		["models"],
		["implement", IMPLEMENTER, "implementing plan…", "medium"],
	], "approval settles synthesis before activating implementation under the implementer's thinking level");
	assert.deepEqual(handoff.model, IMPLEMENTER);
	assert.deepEqual(handoff.verifier, VERIFIER);

	const criteriaCalls = [];
	let criteriaHandoff;
	await runReviewLoop({
		host: { ...host, setImplementationHandoff: (value) => { criteriaHandoff = value; } },
		ctx: {
			mode: "print",
			cwd: agentDir,
			ui: { select: async () => "Approve — start implementing", notify: () => {} },
		},
		session: {},
		widget: {
			...widget,
			switchToSynthesizing: (...args) => criteriaCalls.push(["synthesizing", ...args]),
		},
		proposers: [],
		succeeded: [],
		initialPlan: "# Criteria plan\n\nImplement it.",
		synthConversation: [],
		getSynthesizer: () => SYNTHESIZER,
		getSynthesizerThinking: () => "high",
		getLatestVerdicts: () => null,
		setLatestVerdicts: () => {},
		rebuildSynthTask: () => {},
		getSynthTask: () => "",
		runSynthWithRecovery: async () => assert.fail("approval must not rerun synthesis"),
		warnIfMutated: async () => {},
		roles: { implementer: IMPLEMENTER, verifier: VERIFIER },
		generateVerificationCriteria: async (plan) => {
			criteriaCalls.push(["criteria", plan]);
			return { markdown: "## Verification Criteria\n- **C1:** test", criteria: [{ id: "C1", text: "test" }] };
		},
	});
	assert.deepEqual(criteriaCalls, [["criteria", "# Criteria plan\n\nImplement it."]]);
	assert.equal(criteriaHandoff.verificationCriteria, "## Verification Criteria\n- **C1:** test");

	// A chat round reactivates the synthesizer under the LIVE thinking selection,
	// so a level changed mid-review is reflected on the next round rather than a
	// value captured once at review entry.
	const chatCalls = [];
	let chatThinking = "low";
	const chatReplies = ["Chat with synthesizer", "Chat with synthesizer", "Approve — start implementing"];
	let chatReplyIndex = 0;
	await runReviewLoop({
		host: { ...host, setImplementationHandoff: () => {} },
		ctx: {
			mode: "print",
			cwd: agentDir,
			ui: {
				select: async () => chatReplies[chatReplyIndex++],
				editor: async () => "please adjust the plan",
				notify: () => {},
			},
		},
		session: {},
		widget: {
			settleRoleRow: () => {},
			setPhaseModels: () => {},
			switchToImplementing: () => {},
			switchToSynthesizing: (ref, status, thinking) => chatCalls.push(["synthesizing", ref, status, thinking]),
			stopWidget: () => {},
			adoptProgressWidget: () => {},
		},
		proposers: [],
		succeeded: [],
		initialPlan: "# Chat plan\n\nImplement it.",
		synthConversation: [],
		getSynthesizer: () => SYNTHESIZER,
		getSynthesizerThinking: () => chatThinking,
		getLatestVerdicts: () => null,
		setLatestVerdicts: () => {},
		rebuildSynthTask: () => {},
		getSynthTask: () => "",
		runSynthWithRecovery: async () => {
			// The user raises the thinking level while the synthesizer works.
			if (chatThinking === "low") chatThinking = "xhigh";
			return { cancelled: false, failed: false, result: { messages: [assistantMessage("# Revised\n\nDo it.")] } };
		},
		warnIfMutated: async () => {},
		roles: { implementer: IMPLEMENTER, verifier: VERIFIER },
	});
	assert.deepEqual(chatCalls, [
		["synthesizing", SYNTHESIZER, "synthesizing plan…", "low"],
		["synthesizing", SYNTHESIZER, "synthesizing plan…", "xhigh"],
	], "each chat round reads the current synthesizer thinking selection afresh");

	console.log("Review-loop phase transition tests passed.");
} finally {
	rmSync(agentDir, { recursive: true, force: true });
}
