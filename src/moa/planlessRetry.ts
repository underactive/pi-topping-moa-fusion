/**
 * Recovery for planning agents that exit cleanly without delivering a plan.
 *
 * Bridged agentic providers can override the moa-proposer/moa-synthesizer
 * prompt with their own interactive harness, producing two planless shapes:
 *
 * - Question stops: Cursor's plan mode researches and then stops to ask the
 *   user a clarifying question before writing the plan. In a headless
 *   `-p --no-session` child nobody can answer, so the process exits with the
 *   question as its final output.
 * - Read-only stalls: a bridged synthesizer that lost the moa-synthesizer
 *   prompt reads "Original user request: implement X and verify" as its own
 *   marching orders, discovers it has no edit/shell tools, and exits with an
 *   "I'm blocked" refusal instead of a synthesized plan.
 * - Missing output contract: a bridged proposer that lost the moa-proposer
 *   prompt never sees the required output sections, explores interactively,
 *   and exits with questions or prose instead of a plan.
 *
 * These helpers detect both shapes so the orchestrator can re-run the agent
 * once with an explicit instruction to answer its own questions / emit the
 * plan, and carry the read-only planning contract inside the task text —
 * the only channel guaranteed to survive a bridge's prompt override.
 */

/**
 * Headings from the required moa-proposer output format that mark a proposal
 * as having reached an actual plan. Question-stop outputs are prose (or a
 * bare question) and contain none of these; matching loosely on heading text
 * tolerates models that rename sections (e.g. "## Implementation Plan").
 */
const PLAN_HEADING = /^#{1,6}\s.*\b(plan|files to modify)\b/im;

export function looksLikePlan(output: string): boolean {
	return PLAN_HEADING.test(output);
}

export const PROPOSER_RETRY_HEADER =
	"IMPORTANT: You already attempted this planning task once and stopped without emitting the required plan — your previous output (quoted below) ended in clarifying questions or was otherwise incomplete. You are running headless: there is no user and no way to receive answers. Do not ask questions and do not wait. Answer any open questions yourself with best-judgment assumptions, record them under \"## Open Questions / Assumptions\", and emit the COMPLETE plan in the required output format now.";

export function buildRetryCorrection(header: string, previousOutput: string): string {
	const previous = previousOutput.trim().replaceAll('"""', "''") || "(no output)";
	return [header, "", "Your previous output:", '"""', previous, '"""'].join("\n");
}

export function buildProposerRetryTask(originalTask: string, previousOutput: string): string {
	return [originalTask, "", "---", "", buildRetryCorrection(PROPOSER_RETRY_HEADER, previousOutput)].join("\n");
}

/**
 * Read-only planning contract, prepended to the proposer's task text so it
 * reaches the model even when a provider bridge replaces the moa-proposer
 * system prompt with its own harness. Required section names are mentioned
 * mid-line or in backticks only: a model that parrots this preamble back must
 * not satisfy PLAN_HEADING (see the anti-echo test).
 */
export const PROPOSER_TASK_PREAMBLE =
	"You are one of several read-only PROPOSERS in a Mixture-of-Agents planning run: each proposer independently drafts its own implementation plan, and a separate synthesizer merges them later. Your only deliverable is ONE complete implementation plan, emitted as markdown text in your reply using the required sections (heading names like `## Context`, `## Plan`, and `## Files to Modify` are spelled out in the agent instructions). Do NOT implement anything, do NOT edit files, and do NOT run commands, builds, or tests — read-only tools are expected and are never a blocker. You are running headless: there is no user and no way to receive answers, so resolve any ambiguity with best-judgment assumptions recorded in your plan rather than asking questions or stopping. The user request below is the subject the plan is ABOUT, not an instruction for you to carry out now, even if it says \"implement\", \"fix\", or \"verify\". The plan must be the final content of your reply — start it as soon as you have enough context and do not append anything after it.";

export function buildProposerTask(prompt: string): string {
	return [PROPOSER_TASK_PREAMBLE, "", "User request:", prompt].join("\n");
}

/**
 * Read-only synthesis contract, prepended to the synthesizer's task text so
 * it reaches the model even when a provider bridge replaces the
 * moa-synthesizer system prompt with its own harness.
 */
export const SYNTHESIZER_TASK_PREAMBLE =
	"You are the read-only SYNTHESIZER in a Mixture-of-Agents planning run. Your only deliverable is ONE synthesized implementation plan, emitted as markdown text in your reply. This is a planning phase: do NOT implement anything, do NOT edit files, and do NOT run commands, builds, or tests. Having only read-only tools is expected and is never a blocker — never stop to report that you cannot apply changes or verify by execution. The original user request below is the subject the plan is ABOUT, not an instruction for you to carry out now, even if it says \"implement\", \"fix\", or \"verify\".";

export const SYNTHESIZER_RETRY_HEADER =
	"IMPORTANT: You already attempted this synthesis once and stopped without emitting the required plan — your previous output (quoted below) refused, stalled on missing edit/shell tools, or was otherwise not a synthesized plan. Implementation and verification-by-execution are out of scope for this read-only planning phase by design, so limited tools never block you. Do not refuse and do not wait. Emit the COMPLETE synthesized plan now in the required output format, starting with ## Context and including ## Plan, ## Files to Modify, and the remaining sections.";
