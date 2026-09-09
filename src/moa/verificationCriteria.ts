import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AgentConfig } from "../agents/discovery.ts";
import { CancelRun, type CancelSession } from "../runtime/cancelRun.ts";
import { getFinalOutput, isFailedResult } from "../runtime/results.ts";
import { runSingleAgent } from "../runtime/runner.ts";
import { modelRefLabel, type ModelRef, type ThinkingLevel } from "../shared/modelRefs.ts";
import { activityLoopCount } from "../ui/agentStatus.ts";
import type { ObserveSession } from "../ui/observeOverlay.ts";
import type { MoaProgressWidget } from "../ui/moaProgressWidget.ts";
import { buildRetryCorrection } from "./planlessRetry.ts";
import { modelExtensionOptions, resolveContextWindow, resolveModelCost } from "./modelRuntime.ts";

export const VERIFICATION_CRITERIA_HEADING = "## Verification Criteria";
export const MAX_VERIFICATION_CRITERIA = 30;

export const CRITERIA_TASK_PREAMBLE =
	"You are the read-only SYNTHESIZER in a Mixture-of-Agents planning run. Your only deliverable is a pass/fail verification checklist for the already approved plan, emitted as markdown text in your reply. Do NOT implement, edit, or run anything. Having only read-only tools is expected and is never a blocker.";

export interface VerificationCriterion {
	id: string;
	text: string;
}

export function buildCriteriaTask(plan: string): string {
	return [
		CRITERIA_TASK_PREAMBLE,
		"---",
		`## Approved plan (frozen)\n${plan}`,
		"---",
		`Your output must contain exactly one ${VERIFICATION_CRITERIA_HEADING} section and no prose outside it. Emit 3–${MAX_VERIFICATION_CRITERIA} bullets in this exact form:\n- **C<n>:** <observable binary condition> — <how to check: file, symbol, grep, expected state>\n\nEvery criterion must be checkable by reading the repository only; do not require execution. Cover at least one criterion per plan step in plan order, every named file or call site, and implied regression/scope constraints (such as preserving an existing export or avoiding unrelated files). Never reference proposer labels or model names.`,
	].join("\n\n");
}

/** Collect `- …`/`* …` bullets under a heading, stopping at the next heading. */
export function sectionBullets(output: string, heading: RegExp): string[] {
	const lines = output.split("\n");
	const start = lines.findIndex((line) => heading.test(line));
	if (start < 0) return [];
	const bullets: string[] = [];
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (/^\s*#{1,6}\s/.test(line)) break;
		const match = line.match(/^\s*[-*]\s+(.*\S)\s*$/);
		if (match) bullets.push(match[1].trim());
	}
	return bullets;
}

export function parseVerificationCriteria(output: string): VerificationCriterion[] {
	const seen = new Set<string>();
	const criteria: VerificationCriterion[] = [];
	for (const bullet of sectionBullets(output, /^\s*##\s+Verification Criteria\b/i)) {
		const match = bullet.match(/^\*\*(C\d+):?\*\*:?[\s]*(.+)$/i);
		if (!match) continue;
		const id = match[1].toUpperCase();
		if (seen.has(id)) continue;
		seen.add(id);
		criteria.push({ id, text: match[2].trim() });
		if (criteria.length >= MAX_VERIFICATION_CRITERIA) break;
	}
	return criteria;
}

export function formatCriteriaMarkdown(criteria: VerificationCriterion[]): string {
	return [VERIFICATION_CRITERIA_HEADING, ...criteria.map((criterion) => `- **${criterion.id}:** ${criterion.text}`)].join("\n");
}

export const CRITERIA_RETRY_HEADER =
	"IMPORTANT: Your previous output did not contain any parseable verification criteria. Emit only the required ## Verification Criteria section now, with 3–30 bullets in the exact **C<n>:** format. Do not ask questions, implement anything, or add prose outside the section.";

export function buildCriteriaRetryTask(originalTask: string, previousOutput: string): string {
	return [originalTask, "", "---", "", buildRetryCorrection(CRITERIA_RETRY_HEADER, previousOutput)].join("\n");
}

export async function runCriteriaGeneration(input: {
	ctx: ExtensionContext;
	agents: AgentConfig[];
	synthesizer: ModelRef;
	thinking: ThinkingLevel | undefined;
	plan: string;
	session?: CancelSession;
	widget?: MoaProgressWidget;
	observe?: ObserveSession;
}): Promise<{ criteria: VerificationCriterion[]; markdown: string } | undefined> {
	const { ctx, agents, synthesizer, thinking, plan, session, widget } = input;
	widget?.switchToSynthesizing(synthesizer, "writing verification criteria…", thinking);
	const run = new CancelRun();
	const slot = run.add(modelRefLabel(synthesizer));
	if (session) {
		session.title = "MoA verification criteria";
		session.run = run;
		session.getExtras = () => {
			const status = widget?.getRoleStatus("Synthesize");
			return { contextTokens: status?.contextTokens, contextWindow: status?.ref ? resolveContextWindow(ctx, status.ref) : undefined, activity: status?.activity, loopCount: activityLoopCount(status?.activity, status?.activityHistory) };
		};
	}
	const runTask = async (task: string): Promise<string | undefined> => {
		widget?.updateRoleTranscript("Synthesize", []);
		try {
			const result = await runSingleAgent(ctx.cwd, agents, "moa-synthesizer", task, undefined, slot.signal, undefined, modelRefLabel(synthesizer), thinking, {
				...modelExtensionOptions(ctx, synthesizer),
				resolveOnAbort: true,
				onProgress: (progress) => {
					widget?.updateRoleUsage("Synthesize", progress.usage.contextTokens, progress.usage.turns, progress.usage.toolCalls, resolveModelCost(ctx, synthesizer, progress.usage));
					if (progress.activity) widget?.updateRoleActivity("Synthesize", progress.activity);
					if (progress.outputActivity) widget?.updateRoleOutput("Synthesize", progress.outputActivity.tokens, progress.outputActivity.revision);
					widget?.updateRoleTranscript("Synthesize", progress.messages, progress.partialAssistant);
				},
			});
			widget?.updateRoleTranscript("Synthesize", result.messages);
			if (result.cancelled || run.cancelAllRequested || isFailedResult(result)) return undefined;
			return getFinalOutput(result.messages);
		} catch { return undefined; }
	};
	try {
		let output = await runTask(buildCriteriaTask(plan));
		let criteria = output ? parseVerificationCriteria(output) : [];
		if (criteria.length === 0 && output !== undefined) {
			output = await runTask(buildCriteriaRetryTask(buildCriteriaTask(plan), output));
			criteria = output ? parseVerificationCriteria(output) : [];
		}
		return criteria.length > 0 ? { criteria, markdown: formatCriteriaMarkdown(criteria) } : undefined;
	} finally {
		if (session) { session.run = undefined; session.getExtras = undefined; }
	}
}
