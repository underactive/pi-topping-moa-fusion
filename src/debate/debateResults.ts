import type { ModelRef, ThinkingLevel } from "../shared/modelRefs.ts";
import { modelRefLabel } from "../shared/modelRefs.ts";
import { debaterLabel, type ParsedStance } from "./debateContract.ts";
import { demoteHeadings } from "../opinion/opinionResults.ts";
import type { DebateRound } from "./debateRounds.ts";
import { parseStance } from "./debateContract.ts";

export interface DebateOutcome {
	ref: ModelRef;
	thinking: ThinkingLevel | undefined;
	/** State at debate close: still standing, or how it left. */
	finalStatus: "active-at-close" | "error" | "cancelled";
	finalStance?: ParsedStance;
	/** Last round this debater produced output, 0 if never. */
	lastRoundActive: number;
}

export function collectDebateOutcomes(
	models: ModelRef[],
	thinking: (ThinkingLevel | undefined)[],
	rounds: DebateRound[],
): DebateOutcome[] {
	return models.map((ref, index) => {
		let finalStatus: DebateOutcome["finalStatus"] = "active-at-close";
		let lastRoundActive = 0;
		let finalStance: ParsedStance | undefined;
		for (const round of rounds) {
			const outcome = round.outcomes.find((entry) => entry.index === index);
			if (!outcome) continue;
			if (outcome.status === "done") {
				lastRoundActive = round.round;
				finalStance = outcome.stance;
			} else {
				finalStatus = outcome.status;
			}
		}
		return { ref, thinking: thinking[index], finalStatus, finalStance, lastRoundActive };
	});
}

function firstLine(text: string): string {
	return text.trim().split(/\r?\n/, 1)[0] || "Unknown error";
}

function extractPositionParagraph(output: string): string {
	const match = output.match(/^#{1,6}\s.*\bposition\b.*$/im);
	if (!match || match.index === undefined) return output.trim();
	const rest = output.slice(match.index + match[0].length);
	const nextHeading = rest.search(/^#{1,6}\s/m);
	return (nextHeading >= 0 ? rest.slice(0, nextHeading) : rest).trim();
}

const STANCE_LABELS: Record<string, string> = {
	initial: "initial position",
	kept: "kept position",
	switched: "switched stance",
	refined: "refined position",
};

export function formatDebateMarkdown(
	topic: string,
	outcomes: DebateOutcome[],
	rounds: DebateRound[],
	slug: string,
	closingReason: string | undefined,
	totalRoundsRequested: number,
): string {
	const roster = outcomes.map((outcome, index) => {
		const thinking = outcome.thinking ?? "default";
		return `${debaterLabel(index)} = ${modelRefLabel(outcome.ref)} (thinking: ${thinking})`;
	}).join(" · ");

	const roundSections = rounds.map((round) => {
		const contributions = round.outcomes.map((outcome) => {
			const label = debaterLabel(outcome.index);
			const ref = outcomes[outcome.index]?.ref;
			const thinking = outcomes[outcome.index]?.thinking ?? "default";
			const heading = `### ${label} — ${ref ? modelRefLabel(ref) : "unknown"} (thinking: ${thinking})`;
			if (outcome.status === "cancelled") return `${heading}\n\n_Cancelled by user._`;
			if (outcome.status === "error") return `${heading}\n\n_Failed: ${firstLine(outcome.text)}_`;
			return `${heading}\n\n${demoteHeadings(outcome.text)}`;
		});
		return [`## Round ${round.round}`, contributions.join("\n\n")].join("\n\n");
	});

	const finalPositions = outcomes
		.map((outcome, index) => {
			if (outcome.finalStatus !== "active-at-close" || outcome.lastRoundActive === 0) return undefined;
			const prior = rounds[outcome.lastRoundActive - 1]?.outcomes.find((entry) => entry.index === index);
			if (!prior || prior.status !== "done") return undefined;
			const label = debaterLabel(index);
			const stance = outcome.finalStance?.stance ?? parseStance(prior.text).stance;
			const stanceLabel = STANCE_LABELS[stance] ?? stance;
			const position = extractPositionParagraph(prior.text);
			return `- **${label}** (${stanceLabel}): ${position}`;
		})
		.filter((line) => line !== undefined);

	const closedLine = closingReason
		? `Closed early after ${rounds.length} of ${totalRoundsRequested} rounds — ${closingReason}`
		: `Completed all ${totalRoundsRequested} rounds`;

	const parts = [
		`# MoA Debate — ${slug}`,
		"",
		`**Topic:** ${topic}`,
		"",
		`**Roster:** ${roster}`,
		"",
		`**Closed:** ${closedLine} · no judge — positions below are the debaters' own`,
		roundSections.join("\n\n"),
	];
	if (finalPositions.length > 0) parts.push("", "## Final Positions", finalPositions.join("\n"));
	return parts.join("\n").trimEnd();
}
