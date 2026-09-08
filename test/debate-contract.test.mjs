import assert from "node:assert/strict";

import {
	DEBATE_TASK_PREAMBLE,
	buildDebateRetryTask,
	buildOpeningTask,
	buildRoundTask,
	debaterLabel,
	looksLikeDebatePosition,
	parseStance,
} from "../src/debate/debateContract.ts";

assert.equal(looksLikeDebatePosition("## Position\nUse the existing path.\n\n## Stance\n\n**Stance:** kept\n\n**Sides with:** none"), true);
assert.equal(looksLikeDebatePosition("### My Position\nargue\n**Stance:** Switched"), true);
assert.equal(looksLikeDebatePosition("## Position\nA strong claim."), false, "stance line is required");
assert.equal(looksLikeDebatePosition("**Stance:** kept"), false, "position heading is required");
assert.equal(looksLikeDebatePosition("Is this safe?"), false);
assert.equal(looksLikeDebatePosition("## Responses to Other Debaters\nnope"), false);
// Anti-echo: a model that parrots the preamble must not satisfy the detector.
assert.equal(looksLikeDebatePosition(DEBATE_TASK_PREAMBLE), false);

// Preamble must not name a model or reveal identities.
assert.doesNotMatch(DEBATE_TASK_PREAMBLE, /claude|gpt|gemini/i);

assert.equal(debaterLabel(0), "Debater 1");
assert.equal(debaterLabel(4), "Debater 5");

// parseStance covers all four values plus unknown fallbacks.
for (const stance of ["initial", "kept", "switched", "refined"]) {
	const parsed = parseStance(`## Stance\n**Stance:** ${stance}\n**Sides with:** Debater 2`);
	assert.equal(parsed.stance, stance);
	assert.equal(parsed.sidesWith, "Debater 2");
}
assert.deepEqual(parseStance("**Stance:** whatever"), { stance: "unknown", sidesWith: undefined });
assert.deepEqual(parseStance("no markers"), { stance: "unknown", sidesWith: undefined });
assert.equal(parseStance("**Sides with:**").sidesWith, undefined);

const opening = buildOpeningTask("Is X safe?", 2, 5);
assert.ok(opening.startsWith(DEBATE_TASK_PREAMBLE));
assert.match(opening, /You are Debater 3 of 5/);
assert.match(opening, /Topic: Is X safe\?/);
assert.doesNotMatch(opening, /prior position/i, "opening task has no priors");

const prior = "## Position\nI hold A.\n\n## Stance\n**Stance:** kept";
const roundTask = buildRoundTask("Is X safe?", 1, 2, 3, prior, [
	{ label: "Debater 1", text: "## Position\nI hold B." },
	{ label: "Debater 3", text: "## Position\nI hold C." },
]);
assert.match(roundTask, /You are Debater 2/);
assert.match(roundTask, /round 2 of 3/);
assert.match(roundTask, /Your prior position \(round 1\):/);
assert.match(roundTask, /I hold A\./);
assert.match(roundTask, /### Debater 1 \(round 1\):|Debater 1 \(round 1\):/);
assert.match(roundTask, /I hold B\./);
assert.match(roundTask, /Debater 3 \(round 1\):/);
assert.match(roundTask, /I hold C\./);
assert.ok(roundTask.indexOf("I hold A.") < roundTask.indexOf("Debater 1 (round 1):"), "own prior comes first");
assert.doesNotMatch(roundTask, /claude|gpt|gemini/i, "priors are blinded to slot labels");

// Truncation: long priors are capped with a marker, and quotes inside are defanged.
const longPrior = "x".repeat(20_000);
const truncated = buildRoundTask("t", 0, 2, 2, longPrior, []);
assert.match(truncated, /\[prior position truncated\]/);
assert.ok(truncated.length < 20_000, "prior is capped well below its original length");
const quotePrior = 'has """ triple quotes';
const quoted = buildRoundTask("t", 0, 2, 2, quotePrior, []);
assert.match(quoted, /has '' triple quotes/, "embedded triple quotes are defanged");

const retry = buildDebateRetryTask("original task", "stopped early");
assert.match(retry, /original task/);
assert.match(retry, /stopped early/);
assert.match(retry, /IMPORTANT: You already attempted this debate task once/);
assert.equal(looksLikeDebatePosition(retry), false, "retry header echoes section names in backticks only");

console.log("Debate contract tests passed.");
