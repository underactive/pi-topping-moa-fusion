/**
 * Conflict-surfacing contract for the MoA synthesizer.
 *
 * The `## Conflicts` / `## Open Question` protocol lives in the
 * moa-synthesizer agent prompt — but provider bridges replace that system
 * prompt with their own harness (see planlessRetry.ts), so a bridged
 * synthesizer silently plans solo: it resolves every disagreement in prose
 * and never emits the markup the orchestrator's `## Conflicts` parser and
 * conflict-review overlay need. Like the verdict contract (verdicts.ts),
 * this block rides the task text — the only channel guaranteed to survive a
 * bridge's prompt override.
 *
 * The embedded worked example is exported so tests can prove it parses into
 * exactly the structure conflictOverlay.ts expects; if you change the markup
 * here, conflictOverlay.ts, agents/moa-synthesizer.md, and that test must
 * move in lockstep.
 */

/** Parser-matched worked example embedded in the contract. */
export const CONFLICT_CONTRACT_EXAMPLE = [
	"## Conflicts",
	"",
	"### Conflict: Auth storage",
	"",
	"- **Decision:** Choose where sign-in information is stored; this affects both security and how much of the existing sign-in flow can stay unchanged.",
	"- **Recommended:** Keep the current sign-in experience",
	"- **Details:** Store session IDs in `Secure`, `HttpOnly` cookies so the existing middleware stays compatible and page scripts cannot read them; backed by 2 of 3 proposals (2 distinct models).",
	"- **Alternative** (Proposer 2): Make sign-in data available to browser code",
	"- **Details:** Store JWTs in `localStorage`; this can simplify cross-service access but lets an injected page script read the token.",
].join("\n");

/** Task-text block demanding one `### Conflict:` block per substantive proposer disagreement. */
export function buildConflictContract(labels: string[]): string {
	return [
		"Conflict-surfacing requirement: when two or more proposers substantively disagree on one or more decision points, every full plan you emit MUST also include a `## Conflicts` section, placed after `## Proposer Verdicts`, with one `### Conflict:` block per disagreement. Use exactly this parser-matched markup:",
		"",
		CONFLICT_CONTRACT_EXAMPLE,
		"",
		"Rules:",
		"- Write the full plan body first using your recommended choices in place, so the plan reads as final even before user confirmation; append `## Conflicts` AFTER all other sections — it is never your entire output.",
		"- Omit the section entirely when the proposers agree on all decision points or when only one proposer covered a point — never include a conflict the user has no realistic alternative for, and never invent a disagreement to comply with this requirement.",
		"- Exactly one `**Decision:**` line per conflict, placed before its options. Exactly one `**Recommended:**` line per conflict, immediately followed by exactly one `**Details:**` line. One `**Alternative** (Proposer N)` line per other distinct approach worth surfacing, each immediately followed by its own `**Details:**` line.",
		`- Attribute alternatives only to blinded slot labels already present in your input. Blinded proposer slots in this run: ${labels.join(", ")}. Never invent or rename labels, and never output any model name, family, provider, or version anywhere.`,
		"- Write each Recommended/Alternative summary as an outcome the person can choose, understandable without code syntax, type names, or file paths; put technical specifics and tradeoffs in `**Details:**`, kept to one line.",
		"- The `**Recommended:**` pick must be justified on the merits — repo evidence, engineering judgment, or a direct match with the user's request — and a majority of proposers is not by itself a reason, especially when that majority sits inside one same-model cluster named in the Panel dependence note. The recommended option's `**Details:**` line must end with `backed by K of N proposals (M distinct models)`, where K = proposals backing that option, N = proposals received, and M = distinct models among the K (slots in one cluster count once).",
		"- Supersession rule: if your input contains user conflict resolutions (a \"User reviewed your conflict recommendations\" block) or post-review user feedback, those directives override this requirement — honor every selection, resolve any free-form chat feedback, drop the `## Conflicts` section entirely from your revised output, and emit the complete final plan without it.",
		"",
		"Clarifying-question option: only when a disagreement is a genuine ambiguity in user intent that you cannot resolve from the plans alone, output a section titled exactly `## Open Question` containing only that one question, as your ENTIRE output — write nothing else in that reply, and none of the sections above. You will be re-invoked with the user's answer appended. Prefer resolving ambiguities yourself and noting the resolution in the final plan; if your input already contains an answer to an earlier question, incorporate it and do not emit `## Open Question` again.",
	].join("\n");
}
