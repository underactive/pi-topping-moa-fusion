import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const { buildVerdictContract, parseProposerVerdicts, missingVerdictSlots, buildVerdictRetryTask } = await import(
	"../src/moa/verdicts.ts"
);

const verdictsBlock = [
	"## Proposer Verdicts",
	"",
	"- **Proposer 1:** adopted — its retry approach forms steps 2-4.",
	"- **Proposer 3:** partial — took the test matrix; rejected the polling loop.",
].join("\n");

// ── parseProposerVerdicts ─────────────────────────────────────────────────
{
	const output = `## Plan\n1. step\n\n${verdictsBlock}\n\n## Conflicts\n\n### Conflict: X\n- **Decision:** y`;
	const { verdictsMarkdown, remainingPlan } = parseProposerVerdicts(output);
	assert.equal(verdictsMarkdown, verdictsBlock, "section extracted verbatim, bounded by the next H2");
	assert.ok(remainingPlan.includes("## Plan"), "plan body survives");
	assert.ok(remainingPlan.includes("## Conflicts"), "following sections survive");
	assert.ok(!remainingPlan.includes("Proposer Verdicts"), "section stripped from the plan");
}
{
	const output = `## Plan\n1. step\n\n${verdictsBlock}`;
	const { verdictsMarkdown, remainingPlan } = parseProposerVerdicts(output);
	assert.ok(verdictsMarkdown?.includes("Proposer 3"), "trailing section (no following H2) extracted");
	assert.equal(remainingPlan, "## Plan\n1. step", "plan stripped cleanly");
}
{
	const output = "## Plan\n1. step";
	const { verdictsMarkdown, remainingPlan } = parseProposerVerdicts(output);
	assert.equal(verdictsMarkdown, null, "absent section yields null");
	assert.equal(remainingPlan, output, "plan unchanged when section absent");
}

// ── missingVerdictSlots ───────────────────────────────────────────────────
const labels = ["Proposer 1", "Proposer 3"];
assert.deepEqual(missingVerdictSlots(null, labels), labels, "no section means every slot is missing");
assert.deepEqual(missingVerdictSlots(verdictsBlock, labels), [], "complete coverage");
assert.deepEqual(
	missingVerdictSlots(verdictsBlock, ["Proposer 1", "Proposer 2", "Proposer 3"]),
	["Proposer 2"],
	"skipped slot detected",
);
assert.deepEqual(
	missingVerdictSlots("## Proposer Verdicts\n\n- **Proposer 1:**   ", ["Proposer 1"]),
	["Proposer 1"],
	"a verdict bullet with no justification does not count",
);
assert.deepEqual(
	missingVerdictSlots("## Proposer Verdicts\n\n* **Proposer 1**: rejected — scope creep", ["Proposer 1"]),
	[],
	"tolerates * bullets and the colon outside the bold span",
);

// ── buildVerdictContract ──────────────────────────────────────────────────
const contract = buildVerdictContract(labels);
assert.ok(contract.includes("## Proposer Verdicts"), "contract names the required section");
assert.ok(contract.includes("Proposer 1, Proposer 3"), "contract lists the exact fed slots");
assert.ok(contract.includes("rejected and sent back"), "contract states the enforcement consequence");

// ── buildVerdictRetryTask ─────────────────────────────────────────────────
const retry = buildVerdictRetryTask("the original task", "a plan with no verdicts", ["Proposer 2"]);
assert.ok(retry.startsWith("the original task"), "retry leads with the original task");
assert.ok(retry.includes("no verdict was found for Proposer 2"), "retry names the missing slots");
assert.ok(retry.includes("a plan with no verdicts"), "retry quotes the previous output");
assert.ok(buildVerdictRetryTask("t", "", ["Proposer 1"]).includes("(no output)"), "blank previous output is labelled");
assert.doesNotMatch(buildVerdictRetryTask("t", 'before """ after', ["Proposer 1"]), /before """ after/, "quoted output cannot escape its delimiter");

// ── orchestration wiring (source contract) ────────────────────────────────
const root = path.resolve(import.meta.dirname, "..");
const synthesis = readFileSync(path.join(root, "src/moa/synthesis.ts"), "utf8");
const reviewLoop = readFileSync(path.join(root, "src/moa/reviewLoop.ts"), "utf8");
const phaseSequencer = readFileSync(path.join(root, "src/moa/orchestration.ts"), "utf8");

// The outer sequencer passes successful fan-out results into synthesis, then
// owns the typed synthesis-result-to-review transition.
assert.match(phaseSequencer, /const synthesis = await runSynthesisPhase\(runContext, \{[\s\S]*?succeeded: fanout\.succeeded/);
assert.match(phaseSequencer, /import \{ runReviewLoop \} from "\.\/reviewLoop\.ts"/);
assert.match(phaseSequencer, /if \(synthesis\.status !== "review"\) return synthesis\.status;\s*return await runReviewLoop\(synthesis\.options\);/);
assert.doesNotMatch(synthesis, /from "\.\/reviewLoop\.ts"/);
assert.doesNotMatch(synthesis, /runReviewLoop/);
assert.match(synthesis, /status: "review",\s*options: \{[\s\S]*?initialPlan: synthOutput,[\s\S]*?getLatestVerdicts:/);

// The contract rides the task text (bridges drop the agent system prompt).
assert.match(synthesis, /\$\{buildVerdictContract\(fedLabels\)\}/);

// A plan missing verdicts is rejected once with the missing slots named,
// after the planless retry and before conflict parsing / writePlan.
assert.match(
	synthesis,
	/if \(!questionMatch && missingVerdicts\.length > 0 && !verdictRetried && round < MAX_SYNTH_ROUNDS - 1\) \{[\s\S]*?verdictRetried = true;[\s\S]*?buildRetryCorrection\(buildVerdictRetryHeader\(missingVerdicts\), synthOutput\)[\s\S]*?synthConversation\.push\(verdictRetryCorr\);[\s\S]*?rebuildSynthTask\(\);/,
);
const planlessRetryAt = synthesis.indexOf("buildRetryCorrection(SYNTHESIZER_RETRY_HEADER, synthOutput)");
const verdictRetryAt = synthesis.indexOf("buildRetryCorrection(buildVerdictRetryHeader(missingVerdicts), synthOutput)");
const conflictsAt = synthesis.indexOf("const { conflicts, remainingPlan } = parseConflicts(synthOutput)");
assert.ok(
	planlessRetryAt > 0 && verdictRetryAt > planlessRetryAt && conflictsAt > verdictRetryAt,
	"verdict gate sits between the planless retry and conflict parsing",
);

// Verdicts are stripped from the plan file and threaded to the review overlay.
const stripAt = synthesis.indexOf("synthOutput = stripSynthSections(synthOutput)");
const reviewHandoffAt = synthesis.lastIndexOf('status: "review"');
assert.ok(stripAt > 0 && reviewHandoffAt > stripAt, "verdicts are stripped before synthesis returns the review handoff");
assert.match(reviewLoop, /writePlan\(currentPlan\);[\s\S]*?setActiveRunMoaInfo\(\{/);
assert.match(reviewLoop, /setActiveRunMoaInfo\(\{[\s\S]*?proposers,[\s\S]*?synthesizer: getSynthesizer\(\),[\s\S]*?proposerPlans,[\s\S]*?verdictsMarkdown: getLatestVerdicts\(\) \?\? undefined/);
assert.match(reviewLoop, /\{ proposers, synthesizer, proposerPlans, verdictsMarkdown: getLatestVerdicts\(\) \?\? undefined \},[\s\S]*?host\.getPlanRepoSlug\(\)/);

// The user is warned when no proof of judging ever materialized.
assert.match(synthesis, /produced no proposer verdicts even after a retry/);

console.log("proposer-verdicts tests passed");
