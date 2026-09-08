import assert from "node:assert/strict";

import { collectDebateOutcomes, formatDebateMarkdown } from "../src/debate/debateResults.ts";

const models = [
	{ provider: "one", id: "model-a" },
	{ provider: "two", id: "model-b" },
	{ provider: "three", id: "model-c" },
];
const thinking = ["high", undefined, "low"];

/** @type {import("../src/debate/debateRounds.ts").DebateRound[]} */
const rounds = [
	{
		round: 1,
		outcomes: [
			{ index: 0, status: "done", text: "## Position\nGo with A.\n\n## Stance\n**Stance:** initial", stance: { stance: "initial", sidesWith: undefined } },
			{ index: 1, status: "error", text: "quota exhausted\nmore detail" },
			{ index: 2, status: "done", text: "## Position\nGo with B.\n\n## Stance\n**Stance:** refined", stance: { stance: "refined", sidesWith: undefined } },
		],
	},
	{
		round: 2,
		outcomes: [
			{ index: 0, status: "done", text: "## Position\nStill A, with caveats.\n\n## Stance\n**Stance:** kept", stance: { stance: "kept", sidesWith: undefined } },
			{ index: 2, status: "cancelled", text: "aborted" },
		],
	},
];

const outcomes = collectDebateOutcomes(models, thinking, rounds);
assert.deepEqual(outcomes.map((o) => o.finalStatus), ["active-at-close", "error", "cancelled"]);
assert.equal(outcomes[0].lastRoundActive, 2);
assert.equal(outcomes[0].finalStance?.stance, "kept");
assert.equal(outcomes[1].lastRoundActive, 0);
assert.equal(outcomes[2].lastRoundActive, 1);
assert.equal(outcomes[2].finalStance?.stance, "refined");

const markdown = formatDebateMarkdown("Which store?", outcomes, rounds, "choose-a-store", "all debaters held their positions", 3);
assert.match(markdown, /^# MoA Debate — choose-a-store/);
assert.match(markdown, /\*\*Topic:\*\* Which store\?/);
assert.match(markdown, /Debater 1 = one\/model-a \(thinking: high\)/);
assert.match(markdown, /Debater 2 = two\/model-b \(thinking: default\)/);
assert.match(markdown, /no judge — positions below are the debaters' own/);
assert.match(markdown, /Closed early after 2 of 3 rounds — all debaters held their positions/);
assert.match(markdown, /## Round 1/);
assert.match(markdown, /## Round 2/);
assert.match(markdown, /### Debater 1 — one\/model-a \(thinking: high\)/);
assert.match(markdown, /### Debater 2 — two\/model-b \(thinking: default\)/);
assert.match(markdown, /_Failed: quota exhausted_/);
assert.match(markdown, /_Cancelled by user\._/);
// Agent headings nest beneath the debater heading.
assert.match(markdown, /### Debater 1 — one\/model-a \(thinking: high\)[\s\S]*?### Position\nStill A, with caveats\./);
assert.match(markdown, /## Final Positions/);
assert.match(markdown, /\*\*Debater 1\*\* \(kept position\): Still A, with caveats\./);
assert.doesNotMatch(markdown, /Debater 2\*\* \(kept/, "a debater that never produced output has no final position");
assert.doesNotMatch(markdown, /\bwinner\b|\bverdict\b|\bsynthesis\b/i);

// A debate that ran its full length states that instead of an early-stop reason.
const fullMarkdown = formatDebateMarkdown("t", outcomes, rounds, "slug", undefined, 2);
assert.match(fullMarkdown, /Completed all 2 rounds/);

console.log("Debate results tests passed.");
