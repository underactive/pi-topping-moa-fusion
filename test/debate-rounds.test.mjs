import assert from "node:assert/strict";

import { buildRoundTask } from "../src/debate/debateContract.ts";
import {
	buildNextRoundInputs,
	shouldStopEarly,
	survivingIndices,
} from "../src/debate/debateRounds.ts";

/** @type {import("../src/debate/debateRounds.ts").DebaterRoundOutcome} */
const done = (index, round, text, stance = "kept") => ({
	index,
	status: "done",
	text,
	stance: { stance, sidesWith: undefined },
});

/** @type {import("../src/debate/debateRounds.ts").DebateRound} */
const round1 = {
	round: 1,
	outcomes: [
		done(0, 1, "A: switch to postgres.", "initial"),
		{ index: 1, status: "error", text: "boom" },
		done(2, 1, "C: keep sqlite.", "initial"),
		{ index: 3, status: "cancelled", text: "stopped" },
	],
};

assert.deepEqual(survivingIndices(round1), [0, 2], "survivors exclude error/cancelled");

// Round 1: fewer than two survivors still stops immediately.
assert.deepEqual(
	shouldStopEarly({ round: 1, outcomes: [done(0, 1, "x", "kept")] }),
	{ stop: true, reason: "fewer than two debaters remain" },
);
assert.deepEqual(
	shouldStopEarly({ round: 1, outcomes: [] }),
	{ stop: true, reason: "fewer than two debaters remain" },
);
// Round 1: unanimous "kept" never stops — nobody has moved yet.
assert.deepEqual(
	shouldStopEarly({ round: 1, outcomes: [done(0, 1, "x", "kept"), done(2, 1, "y", "kept")] }),
	{ stop: false },
);

/** @type {import("../src/debate/debateRounds.ts").DebateRound} */
const round2AllKept = {
	round: 2,
	outcomes: [done(0, 2, "A2", "kept"), done(2, 2, "C2", "kept")],
};
assert.deepEqual(
	shouldStopEarly(round2AllKept),
	{ stop: true, reason: "all debaters held their positions" },
);

/** @type {import("../src/debate/debateRounds.ts").DebateRound} */
const round2Mixed = {
	round: 2,
	outcomes: [done(0, 2, "A2", "refined"), done(2, 2, "C2", "kept")],
};
assert.deepEqual(shouldStopEarly(round2Mixed), { stop: false });

assert.deepEqual(
	shouldStopEarly({ round: 2, outcomes: [done(0, 2, "A2", "switched"), { index: 2, status: "error", text: "x" }] }),
	{ stop: true, reason: "fewer than two debaters remain" },
);
// Unknown stance (contract miss) never counts as kept.
assert.deepEqual(
	shouldStopEarly({
		round: 2,
		outcomes: [
			done(0, 2, "A2"),
			{ index: 2, status: "done", text: "no stance markers" },
		],
	}),
	{ stop: false },
);

// Next-round inputs: each survivor sees its own prior plus every other survivor's text.
const inputs = buildNextRoundInputs("Is X safe?", round1, 2, 3);
assert.deepEqual(inputs.map((entry) => entry.index), [0, 2]);
for (const entry of inputs) {
	const own = entry.index === 0 ? "A: switch to postgres." : "C: keep sqlite.";
	const other = entry.index === 0 ? "C: keep sqlite." : "A: switch to postgres.";
	assert.match(entry.task, new RegExp(`You are Debater ${entry.index + 1}\\b`));
	assert.match(entry.task, /round 2 of 3/);
	assert.match(entry.task, new RegExp(own.replace(/[.:]/g, "\\$&")));
	assert.match(entry.task, new RegExp(other.replace(/[.:]/g, "\\$&")));
	assert.match(entry.task, /Your prior position \(round 1\):/);
}
assert.doesNotMatch(inputs[0].task, /Debater 2\b/, "error/cancelled debaters are excluded");
assert.doesNotMatch(inputs[0].task, /Debater 4\b/);

// A debater with no usable prior still gets a task; the other survivor's text reaches it.
/** @type {import("../src/debate/debateRounds.ts").DebateRound} */
const emptyRound = {
	round: 1,
	outcomes: [done(0, 1, ""), done(1, 1, "B speaks.")],
};
const emptyInputs = buildNextRoundInputs("t", emptyRound, 2, 2);
assert.equal(emptyInputs.length, 2);
assert.match(emptyInputs[0].task, /B speaks\./);

console.log("Debate round bookkeeping tests passed.");
