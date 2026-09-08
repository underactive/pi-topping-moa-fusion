import { buildRetryCorrection } from "../moa/planlessRetry.ts";

export const OPINION_TASK_PREAMBLE =
	"You are a read-only analyst in a multi-model opinion run. Your only deliverable is one independent, repo-grounded opinion emitted as markdown in your reply. Do not implement anything, edit files, or run commands, builds, or tests. Read-only tools are expected and never a blocker. No later agent will merge or judge your answer, so commit to a clear recommendation. You are running headless: resolve open questions with stated assumptions rather than asking the user or waiting.";

export const OPINION_HEADING = /^#{1,6}\s.*\b(opinion|answer|recommendation|assessment|verdict)\b/im;

export function looksLikeOpinion(output: string): boolean {
	return OPINION_HEADING.test(output);
}

export const OPINION_RETRY_HEADER =
	"IMPORTANT: You already attempted this opinion task once and stopped without emitting a complete opinion. You are running headless: do not ask questions, wait for clarification, or refuse because only read-only tools are available. Re-emit the COMPLETE independent opinion now, using the required headings beginning with ## Opinion.";

export function buildOpinionTask(question: string): string {
	return [OPINION_TASK_PREAMBLE, "", "Question:", question].join("\n");
}

export function buildOpinionRetryTask(originalTask: string, previousOutput: string): string {
	return [originalTask, "", "---", "", buildRetryCorrection(OPINION_RETRY_HEADER, previousOutput)].join("\n");
}
