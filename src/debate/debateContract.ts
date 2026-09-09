import { buildRetryCorrection } from "../moa/planlessRetry.ts";

export const DEBATE_TASK_PREAMBLE =
	"You are a read-only DEBATER in a multi-round debate between several models. Your output is shown verbatim to the user and reaches your peer debaters — there is no judge, and no agent will merge or verify anything — so argue to convince your peers. You may keep or change your stance in any round. Do not implement anything, edit files, or run commands, builds, or tests; read-only tools are expected and never a blocker. You are running headless: resolve open questions with stated assumptions rather than asking the user or waiting. The required output sections (including the `## Position` argument and the `## Stance` declaration with its `**Stance:**` value) are spelled out in the agent instructions.";

/** Matches the required position argument heading, tolerating renamed sections. */
export const DEBATE_POSITION_HEADING = /^#{1,6}\s.*\b(position)\b/im;

/** Matches the stance declaration, e.g. `**Stance:** kept`. */
export const DEBATE_STANCE_LINE = /\*\*Stance:\*\*\s*(initial|kept|switched|refined)/i;

export function looksLikeDebatePosition(output: string): boolean {
	return DEBATE_POSITION_HEADING.test(output) && DEBATE_STANCE_LINE.test(output);
}

export type DebateStance = "initial" | "kept" | "switched" | "refined" | "unknown";

export interface ParsedStance {
	stance: DebateStance;
	/** Raw `Debater N` value from the `**Sides with:**` line, when present. */
	sidesWith: string | undefined;
}

export function parseStance(output: string): ParsedStance {
	const stanceMatch = output.match(DEBATE_STANCE_LINE);
	const sidesMatch = output.match(/\*\*Sides with:\*\*\s*(.+)/i);
	const stance = (stanceMatch?.[1]?.toLowerCase() ?? "unknown") as DebateStance;
	const sidesWith = sidesMatch?.[1]?.trim();
	return { stance, sidesWith: sidesWith && sidesWith.length > 0 ? sidesWith : undefined };
}

/** Anonymous slot label — debaters never see each other's real model names. */
export function debaterLabel(index: number): string {
	return `Debater ${index + 1}`;
}

/** Per-prior cap so five priors of long positions stay well under the runner's task-size warning. */
const MAX_PRIOR_CHARS = 16_000;

function quotePrior(text: string): string {
	const trimmed = text.trim();
	const prior = trimmed.length > MAX_PRIOR_CHARS
		? `${trimmed.slice(0, MAX_PRIOR_CHARS)}\n[prior position truncated]`
		: trimmed;
	return `"""\n${prior.replaceAll('"""', "''")}\n"""`;
}

export function buildOpeningTask(topic: string, index: number, totalDebaters: number): string {
	return [
		DEBATE_TASK_PREAMBLE,
		"",
		`Topic: ${topic}`,
		`You are ${debaterLabel(index)} of ${totalDebaters} debaters. This is round 1: no other debater has spoken yet, so form your own independent, repo-grounded position.`,
	].join("\n");
}

export function buildRoundTask(
	topic: string,
	index: number,
	round: number,
	totalRounds: number,
	ownPrior: string,
	others: { label: string; text: string }[],
): string {
	const parts = [
		DEBATE_TASK_PREAMBLE,
		"",
		`Topic: ${topic}`,
		`You are ${debaterLabel(index)}. This is round ${round} of ${totalRounds}.`,
		"",
		`Your prior position (round ${round - 1}):`,
		quotePrior(ownPrior),
	];
	for (const other of others) {
		parts.push("", `${other.label} (round ${round - 1}):`, quotePrior(other.text));
	}
	parts.push(
		"",
		"Respond to every other debater's position, revise your argument as warranted, and declare your stance explicitly. You may keep or change your stance.",
	);
	return parts.join("\n");
}

export const DEBATE_RETRY_HEADER =
	"IMPORTANT: You already attempted this debate task once and stopped without emitting a complete position. You are running headless: do not ask questions, wait for clarification, or refuse because only read-only tools are available. Re-emit the COMPLETE position now, including the required `## Position` argument and the `## Stance` declaration with its `**Stance:**` value.";

export function buildDebateRetryTask(originalTask: string, previousOutput: string): string {
	return [originalTask, "", "---", "", buildRetryCorrection(DEBATE_RETRY_HEADER, previousOutput)].join("\n");
}
