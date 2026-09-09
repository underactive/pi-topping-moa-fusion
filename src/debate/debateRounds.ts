import { buildRoundTask, parseStance, type ParsedStance } from "./debateContract.ts";

/** What one debater produced (or failed to produce) in one round. */
export interface DebaterRoundOutcome {
	index: number;
	status: "done" | "error" | "cancelled";
	text: string;
	stance?: ParsedStance;
}

export interface DebateRound {
	round: number;
	outcomes: DebaterRoundOutcome[];
}

/** Slots whose last round completed — the only ones carried into the next round. */
export function survivingIndices(round: DebateRound): number[] {
	return round.outcomes.filter((outcome) => outcome.status === "done").map((outcome) => outcome.index);
}

/**
 * Stop conditions checked after every round: fewer than two survivors means
 * no debate is possible, and (from round 2 on, since nobody has moved yet in
 * round 1) a unanimous "kept" round means nobody moved.
 */
export function shouldStopEarly(round: DebateRound): { stop: boolean; reason?: string } {
	const survivors = round.outcomes.filter((outcome) => outcome.status === "done");
	if (survivors.length < 2) return { stop: true, reason: "fewer than two debaters remain" };
	if (round.round >= 2 && survivors.every((outcome) => outcome.stance?.stance === "kept")) {
		return { stop: true, reason: "all debaters held their positions" };
	}
	return { stop: false };
}

/**
 * Per-survivor task text for the next round: each survivor receives its own
 * prior plus every other survivor's labeled text. Settled (errored/cancelled)
 * agents that never produced text contribute nothing.
 */
export function buildNextRoundInputs(
	topic: string,
	previousRound: DebateRound,
	round: number,
	totalRounds: number,
): { index: number; task: string }[] {
	const survivors = survivingIndices(previousRound);
	const priorOf = new Map<number, string>();
	for (const outcome of previousRound.outcomes) {
		if (outcome.status === "done" && outcome.text.trim().length > 0) priorOf.set(outcome.index, outcome.text);
	}
	return survivors.map((index) => {
		const ownPrior = priorOf.get(index) ?? "";
		const others = survivors
			.filter((other) => other !== index)
			.filter((other) => priorOf.has(other))
			.map((other) => ({ label: `Debater ${other + 1}`, text: priorOf.get(other)! }));
		return { index, task: buildRoundTask(topic, index, round, totalRounds, ownPrior, others) };
	});
}

export { parseStance };
