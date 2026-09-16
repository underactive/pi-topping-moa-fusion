/**
 * Auditable-reasoning contract for the MoA synthesizer.
 *
 * The moa-synthesizer prompt requires the plan's Context section to carry
 * three subsections — `### Evaluation dimensions`, `### Proposer alignment`,
 * and `### Synthesis decisions` — but models skip them under output pressure,
 * collapsing the MoA reconciliation into ordinary prose (recent plan files
 * show exactly that drift). Like the verdict contract (verdicts.ts), the
 * orchestrator knows what a complete synthesis looks like, so it validates
 * presence and rejects (one corrective retry) a first full plan that omits
 * any of the three. The requirement rides the task text because provider
 * bridges drop the agent system prompt (see planlessRetry.ts).
 */

/** Exact H3 headings the synthesizer must place under `## Context`. */
export const CONTEXT_SUBSECTION_HEADINGS = [
	"Evaluation dimensions",
	"Proposer alignment",
	"Synthesis decisions",
] as const;

/** Task-text block demanding the three Context subsections in every full plan. */
export function buildContextSubsectionsContract(): string {
	return [
		"Auditable-reasoning requirement: every full plan you emit MUST open with a `## Context` section containing these three subsections, in this order, directly after the normal Context content:",
		"",
		...CONTEXT_SUBSECTION_HEADINGS.map((heading) => `- \`### ${heading}\``),
		"",
		"- `### Evaluation dimensions` — reason separately about correctness, completeness, feasibility & effort, risk, and simplicity; never collapse them into one impression.",
		"- `### Proposer alignment` — where proposers unanimously agreed, what they unanimously rejected, and where they differed; tag every unanimous point as evidence-backed (two or more proposers cite a concrete repo location) or asserted (no citation, or all citations identical and unverified); sanity-check every asserted point against the repo with read/grep/find/ls before relying on it, stating what you checked and what you found; note when a unanimous point rests inside a single same-model cluster from the Panel dependence note; treat each same-model cluster as one vote.",
		"- `### Synthesis decisions` — what you recombined, added, or dropped, and one-line decisions for each disagreement using blinded slot labels.",
		"",
		"All MoA reconciliation commentary belongs inside `## Context` — nowhere else. A plan missing any of these three subsections will be rejected and sent back to you. They are required in every full-plan output, including revisions after conflict resolutions or user feedback.",
	].join("\n");
}

/**
 * Required headings absent from the output. Matching is case-insensitive
 * with flexible whitespace so casing drift does not burn a corrective retry;
 * the contract text still demands the exact headings.
 */
export function missingContextSubsections(output: string): string[] {
	return CONTEXT_SUBSECTION_HEADINGS.filter((heading) => {
		const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return !new RegExp(`^#{3}\\s*${escaped}\\s*$`, "im").test(output);
	});
}

export function buildContextRetryHeader(missing: string[]): string {
	const list = missing.map((heading) => `\`### ${heading}\``).join(", ");
	return `IMPORTANT: Your previous output (quoted below) is rejected because its \`## Context\` section is missing required subsection(s): ${list}. Re-emit the COMPLETE plan with \`## Context\` opening on the normal context content followed by all three subsections — \`### Evaluation dimensions\`, \`### Proposer alignment\`, \`### Synthesis decisions\` — carrying your MoA reconciliation reasoning. Do not drop or alter the rest of the plan.`;
}
