import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const { looksLikePlan, buildProposerRetryTask, buildProposerTask, SYNTHESIZER_TASK_PREAMBLE, PROPOSER_TASK_PREAMBLE } = await import(
	"../src/moa/planlessRetry.ts"
);

// ── looksLikePlan: complete proposals ─────────────────────────────────────
assert.equal(
	looksLikePlan("## Context\nstuff\n\n## Plan\n1. do thing\n\n## Files to Modify\n- `a.ts`"),
	true,
	"canonical proposer output counts as a plan",
);
assert.equal(looksLikePlan("# Implementation Plan\n1. step"), true, "renamed plan heading still counts");
assert.equal(looksLikePlan("### Files to Modify\n- `a.ts` - change"), true, "files heading alone counts");
assert.equal(looksLikePlan("## plan\nlowercase heading"), true, "heading match is case-insensitive");

// ── looksLikePlan: question-stop / incomplete outputs ─────────────────────
assert.equal(
	looksLikePlan("Before I write the plan, could you clarify which auth flow you mean?"),
	false,
	"a bare clarifying question is not a plan (prose mention of 'plan' is not a heading)",
);
assert.equal(looksLikePlan(""), false, "empty output is not a plan");
assert.equal(
	looksLikePlan("I explored the repo. A few questions:\n1. Should X use Y?\n2. Is Z in scope?"),
	false,
	"numbered questions are not a plan",
);
assert.equal(looksLikePlan("## Open Questions\n- which flag?"), false, "question-only heading is not a plan");
assert.equal(
	looksLikePlan(
		"I'm blocked: this session has only read-only tools — no edit, write, or shell. I can't apply the changes, and I can't run npm test.\n\nTwo ways forward: re-run this task in a session with edit and shell tools, or I can write the patch out as text. Which do you prefer?",
	),
	false,
	"a read-only refusal is not a plan",
);

// ── buildProposerRetryTask ────────────────────────────────────────────────
const task = buildProposerRetryTask("add a retry flag", "Which retry flag do you mean?");
assert.ok(task.startsWith("add a retry flag"), "retry task leads with the original request");
assert.ok(task.includes("Which retry flag do you mean?"), "retry task quotes the previous output");
assert.ok(task.includes("headless"), "retry task explains no user can answer");
assert.ok(
	buildProposerRetryTask("t", "   ").includes("(no output)"),
	"blank previous output is labelled rather than quoted empty",
);

// ── synthesizer read-only discipline ──────────────────────────────────
assert.ok(
	SYNTHESIZER_TASK_PREAMBLE.includes("do NOT implement"),
	"preamble forbids implementing",
);
assert.ok(
	SYNTHESIZER_TASK_PREAMBLE.includes("never a blocker"),
	"preamble declares read-only tooling expected, not a blocker",
);
assert.ok(
	SYNTHESIZER_TASK_PREAMBLE.includes("not an instruction"),
	"preamble frames the user request as the plan's subject, not marching orders",
);

// ── proposer task preamble: the contract rides in the task text ─────────
assert.ok(
	PROPOSER_TASK_PREAMBLE.includes("read-only"),
	"proposer preamble declares the read-only planning role",
);
assert.ok(
	PROPOSER_TASK_PREAMBLE.includes("headless"),
	"proposer preamble explains no user can answer questions",
);
assert.ok(
	PROPOSER_TASK_PREAMBLE.includes("## Files to Modify"),
	"proposer preamble names the required output sections",
);
const proposerTask = buildProposerTask("add a retry flag");
assert.ok(proposerTask.startsWith(PROPOSER_TASK_PREAMBLE), "proposer task leads with the contract");
assert.ok(proposerTask.includes("User request:\nadd a retry flag"), "proposer task carries the user request");

// A model that parrots its instructions back must not satisfy the plan check:
// neither preamble, retry header, nor correction may contain a line-start
// heading that PLAN_HEADING would match.
assert.equal(looksLikePlan(PROPOSER_TASK_PREAMBLE), false, "an echoed proposer preamble is not mistaken for a plan");
assert.equal(looksLikePlan(SYNTHESIZER_TASK_PREAMBLE), false, "an echoed preamble is not mistaken for a plan");

// ── orchestration wiring (source contract) ───────────────────────────
const orchestration = ["src/moa/fanout.ts", "src/moa/synthesis.ts"]
	.map((file) => readFileSync(path.resolve(import.meta.dirname, "..", file), "utf8"))
	.join("\n");

// The synthesizer task must lead with the read-only contract — the only
// channel that survives a bridge's system-prompt override.
assert.match(orchestration, /const baseSynthTask = `\$\{SYNTHESIZER_TASK_PREAMBLE\}\\n\\nOriginal user request:/);

// A planless synthesis round is retried exactly once, never on the last
// round, and never when the output is an Open Question awaiting the user.
assert.match(
	orchestration,
	/if \(!questionMatch && !looksLikePlan\(synthOutput\) && !synthPlanlessRetried && round < MAX_SYNTH_ROUNDS - 1\) \{[\s\S]*?synthPlanlessRetried = true;[\s\S]*?buildRetryCorrection\(SYNTHESIZER_RETRY_HEADER, synthOutput\)[\s\S]*?synthConversation\.push\(synthRetryCorr\);[\s\S]*?rebuildSynthTask\(\);/,
);

// The retry decision must run BEFORE conflict parsing so a refusal never
// reaches writePlan as the proposed plan on its first appearance.
const retryAt = orchestration.indexOf("buildRetryCorrection(SYNTHESIZER_RETRY_HEADER, synthOutput)");
const conflictsAt = orchestration.indexOf("const { conflicts, remainingPlan } = parseConflicts(synthOutput)");
assert.ok(retryAt > 0 && conflictsAt > retryAt, "planless retry precedes conflict parsing / plan write");

// The proposer half of the recovery stays wired too, and the planning
// contract reaches every proposer through the task text (the only channel
// that survives a bridge's system-prompt override).
assert.match(orchestration, /!looksLikePlan\(getFinalOutput\(result\.messages\)\)/);
assert.match(orchestration, /const proposerTask = buildProposerTask\(prompt\);/);
assert.match(orchestration, /task: proposerTask,/);
assert.match(orchestration, /buildProposerRetryTask\(proposerTask, getFinalOutput\(results\[proposerIndex\]\.messages\)\)/);

console.log("planless-retry tests passed");
