/**
 * Output schemas and structured results for the plan-mode tools (pi 0.99
 * `outputSchema` / `structuredContent`).
 *
 * These values are not model-facing and are not saved in the session: pi sends
 * only `content` to the model and leaves `structuredContent` out of the
 * persisted tool-result message. They reach live programmatic consumers only —
 * `tool_execution_end` events (RPC/JSON harnesses), `tool_result` handlers, and
 * codemode scripts. Each tool's text `content` is unchanged and comes from the
 * same `isFailedResult` / `getResultOutput` / `truncateOutput` calls as the
 * values here, so the two cannot disagree.
 *
 * `classifySubagentResult` is the one status derivation over `SingleResult`;
 * any other consumer of runner results can import it.
 */

import { Type, type Static } from "typebox";

import { getResultOutput, isFailedResult, truncateOutput, type SingleResult } from "../../runtime/results.ts";

const SubagentUsageSchema = Type.Object({
	input: Type.Number({ description: "Input tokens" }),
	output: Type.Number({ description: "Output tokens" }),
	cacheRead: Type.Number({ description: "Cache-read tokens" }),
	cacheWrite: Type.Number({ description: "Cache-write tokens" }),
	cacheWrite1h: Type.Number({ description: "One-hour cache-write tokens" }),
	cost: Type.Number({ description: "Total cost reported by the provider" }),
	turns: Type.Number({ description: "Assistant turns" }),
	toolCalls: Type.Number({ description: "Tool calls the agent made" }),
	contextTokens: Type.Optional(Type.Number({ description: "Context size of the latest turn, when reported" })),
}, { additionalProperties: false, description: "Token usage and cost the runner recorded for the agent" });

const SubagentAgentResultSchema = Type.Object({
	agent: Type.String({ description: "Agent name" }),
	status: Type.Union([
		Type.Literal("completed"),
		Type.Literal("failed"),
		Type.Literal("cancelled"),
		Type.Literal("aborted"),
	], { description: "cancelled: stopped by the user; aborted: the child stopped without a user cancel; failed: nonzero exit, provider error, or no messages" }),
	exitCode: Type.Number({ description: "Child process exit code" }),
	stopReason: Type.Optional(Type.String({ description: "Stop reason of the agent's last assistant message" })),
	model: Type.Optional(Type.String({ description: "Model the agent ran on" })),
	output: Type.String({ description: "Final answer, or the error for an agent that did not complete, capped at 50 KB" }),
	truncated: Type.Boolean({ description: "Whether `output` was cut at the 50 KB cap" }),
	usage: SubagentUsageSchema,
}, { additionalProperties: false });

export const MF_PLAN_SUBAGENT_OUTPUT_SCHEMA = Type.Object({
	mode: Type.Union([Type.Literal("single"), Type.Literal("parallel")], { description: "single: one agent from agent + task; parallel: the tasks array" }),
	status: Type.Union([
		Type.Literal("completed"),
		Type.Literal("partial"),
		Type.Literal("failed"),
		Type.Literal("cancelled"),
		Type.Literal("aborted"),
	], { description: "completed: every agent completed; partial: some did; otherwise failed, aborted, or cancelled, in that order of precedence" }),
	total: Type.Number({ description: "Agents requested" }),
	succeeded: Type.Number({ description: "Agents that completed" }),
	failed: Type.Number({ description: "Agents that failed" }),
	cancelled: Type.Number({ description: "Agents the user cancelled" }),
	aborted: Type.Number({ description: "Agents that stopped without a user cancel" }),
	results: Type.Array(SubagentAgentResultSchema, { description: "One entry per requested agent, in request order" }),
}, { additionalProperties: false });

export const WRITE_PLAN_OUTPUT_SCHEMA = Type.Object({
	status: Type.Literal("written", { description: "The plan file was written" }),
	filePath: Type.String({ description: "Plan file whose content was replaced" }),
	length: Type.Number({ description: "Length of the written plan in characters" }),
}, { additionalProperties: false });

export const ENTER_PLAN_MODE_OUTPUT_SCHEMA = Type.Object({
	status: Type.Literal("entered", { description: "Plan mode is now on" }),
	mode: Type.Literal("single", { description: "The tool always starts single-model planning; MoA planning starts from /mf-plan" }),
	reentry: Type.Boolean({ description: "Whether a plan file already existed, so planning continues it" }),
	planFilePath: Type.String({ description: "Plan file write_plan writes to" }),
}, { additionalProperties: false });

export const EXIT_PLAN_MODE_OUTPUT_SCHEMA = Type.Object({
	status: Type.Union([Type.Literal("approved"), Type.Literal("keep_planning")], { description: "approved: plan mode has exited; keep_planning: the user sent the plan back and plan mode is still on" }),
	planFilePath: Type.String({ description: "Plan file that was reviewed" }),
	headless: Type.Boolean({ description: "Whether the plan was auto-approved without a UI (MOA_PLAN_AUTO_APPROVE=1)" }),
	kickoff: Type.Union([
		Type.Literal("inline"),
		Type.Literal("follow_up"),
		Type.Literal("none"),
	], { description: "inline: this result is the implementation kickoff; follow_up: the kickoff is queued as the next user message; none: no implementation was started" }),
	repoPlanSlug: Type.Optional(Type.String({ description: "Name of the plan's copies under .pi/mf-plan/" })),
}, { additionalProperties: false });

export type MfPlanSubagentStructuredResult = Static<typeof MF_PLAN_SUBAGENT_OUTPUT_SCHEMA>;
export type SubagentAgentResult = Static<typeof SubagentAgentResultSchema>;
export type SubagentAgentStatus = SubagentAgentResult["status"];
export type WritePlanStructuredResult = Static<typeof WRITE_PLAN_OUTPUT_SCHEMA>;
export type EnterPlanModeStructuredResult = Static<typeof ENTER_PLAN_MODE_OUTPUT_SCHEMA>;
export type ExitPlanModeStructuredResult = Static<typeof EXIT_PLAN_MODE_OUTPUT_SCHEMA>;

/**
 * A user cancel wins over the stop reason it produces; an `aborted` stop
 * without one is a child abort nobody asked for. The runner marks every
 * cancelled result failed, so `completed` is exactly `!isFailedResult`.
 */
export function classifySubagentResult(result: SingleResult): SubagentAgentStatus {
	if (result.cancelled) return "cancelled";
	if (result.stopReason === "aborted") return "aborted";
	return isFailedResult(result) ? "failed" : "completed";
}

function aggregateStatus(statuses: readonly SubagentAgentStatus[]): MfPlanSubagentStructuredResult["status"] {
	const completed = statuses.filter((status) => status === "completed").length;
	if (completed === statuses.length) return "completed";
	if (completed > 0) return "partial";
	if (statuses.includes("failed")) return "failed";
	if (statuses.includes("aborted")) return "aborted";
	return "cancelled";
}

function toAgentResult(result: SingleResult): SubagentAgentResult {
	const fullOutput = getResultOutput(result);
	const output = truncateOutput(fullOutput);
	const { usage } = result;
	return {
		agent: result.agent,
		status: classifySubagentResult(result),
		exitCode: result.exitCode,
		...(result.stopReason ? { stopReason: result.stopReason } : {}),
		...(result.model ? { model: result.model } : {}),
		output,
		truncated: output !== fullOutput,
		usage: {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			cacheWrite1h: usage.cacheWrite1h,
			cost: usage.cost,
			turns: usage.turns,
			toolCalls: usage.toolCalls,
			...(usage.contextTokens !== undefined ? { contextTokens: usage.contextTokens } : {}),
		},
	};
}

/** Results stay in request order; a single-mode run's status is its agent's status. */
export function buildSubagentStructuredResult(
	mode: MfPlanSubagentStructuredResult["mode"],
	results: readonly SingleResult[],
): MfPlanSubagentStructuredResult {
	const entries = results.map(toAgentResult);
	const count = (status: SubagentAgentStatus): number => entries.filter((entry) => entry.status === status).length;
	return {
		mode,
		status: aggregateStatus(entries.map((entry) => entry.status)),
		total: entries.length,
		succeeded: count("completed"),
		failed: count("failed"),
		cancelled: count("cancelled"),
		aborted: count("aborted"),
		results: entries,
	};
}
