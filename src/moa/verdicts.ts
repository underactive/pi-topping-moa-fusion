/**
 * Proof-of-judging contract for the MoA synthesizer.
 *
 * A synthesizer can emit a perfectly plausible plan without ever weighing the
 * proposals it was handed — nothing in prose distinguishes "synthesized from
 * five proposals" from "planned solo". The orchestrator knows exactly which
 * blinded slots it fed in, so it demands a parseable `## Proposer Verdicts`
 * section with one verdict per slot and rejects (one corrective retry) any
 * first full plan that skips a slot. Like the rest of the synthesis
 * discipline, the requirement rides the task text because provider bridges
 * drop the agent system prompt (see planlessRetry.ts).
 */

import { parseConflicts } from "./conflicts.ts";
import { buildRetryCorrection } from "./planlessRetry.ts";

const VERDICTS_SECTION_RE = /^##\s*Proposer Verdicts\s*$/m;
const VERDICT_BULLET_RE = /^[-*]\s+\*\*(Proposer \d+):?\*\*:?\s*(.+)$/gm;

/** Task-text block demanding one verdict per fed proposal slot. */
export function buildVerdictContract(labels: string[]): string {
	return [
		"Judging proof requirement: every full plan you emit MUST include a `## Proposer Verdicts` section, placed after `## Risks` and before any `## Conflicts`, with exactly one bullet per proposal in this format:",
		"",
		"- **Proposer N:** adopted | partial | rejected — one line naming what you took or rejected from that proposal and why.",
		"",
		`Proposals requiring a verdict: ${labels.join(", ")}. A plan missing a verdict for any of these will be rejected and sent back to you.`,
	].join("\n");
}

export interface VerdictParse {
	/** The full section including its heading, or null when absent. */
	verdictsMarkdown: string | null;
	remainingPlan: string;
}

/** Extract and strip the `## Proposer Verdicts` section (bounded by the next H2). */
export function parseProposerVerdicts(output: string): VerdictParse {
	const startMatch = VERDICTS_SECTION_RE.exec(output);
	if (!startMatch) return { verdictsMarkdown: null, remainingPlan: output };

	const sectionStart = startMatch.index;
	const afterHeader = sectionStart + startMatch[0].length;
	const rest = output.slice(afterHeader);
	const nextMatch = /^##\s+/m.exec(rest);
	const sectionEnd = nextMatch ? afterHeader + nextMatch.index : output.length;

	const verdictsMarkdown = output.slice(sectionStart, sectionEnd).trim();
	const remainingPlan = (output.slice(0, sectionStart) + output.slice(sectionEnd))
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return { verdictsMarkdown, remainingPlan };
}

export function stripSynthSections(text: string): string {
	const withoutOpenQuestion = text.replace(
		/^##\s*Open Question\s*$[\s\S]*?(?=^##\s+|(?![\s\S]))/m,
		"",
	);
	return parseProposerVerdicts(parseConflicts(withoutOpenQuestion).remainingPlan).remainingPlan
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Fed slot labels that have no verdict bullet with a non-empty justification. */
export function missingVerdictSlots(verdictsMarkdown: string | null, labels: string[]): string[] {
	if (!verdictsMarkdown) return [...labels];
	const covered = new Set<string>();
	for (const match of verdictsMarkdown.matchAll(VERDICT_BULLET_RE)) {
		if (match[2].trim()) covered.add(match[1]);
	}
	return labels.filter((label) => !covered.has(label));
}

export function buildVerdictRetryHeader(missing: string[]): string {
	return `IMPORTANT: Your previous output (quoted below) is rejected because it does not prove you evaluated every proposal: no verdict was found for ${missing.join(", ")}. Re-read those proposals from your input now and re-emit the COMPLETE plan including a \`## Proposer Verdicts\` section with one \`- **Proposer N:** adopted | partial | rejected — reason\` bullet for every proposal you received. Do not drop or alter the rest of the plan beyond what re-evaluating those proposals requires.`;
}

export function buildVerdictRetryTask(originalTask: string, previousOutput: string, missing: string[]): string {
	return [originalTask, "", "---", "", buildRetryCorrection(buildVerdictRetryHeader(missing), previousOutput)].join("\n");
}
