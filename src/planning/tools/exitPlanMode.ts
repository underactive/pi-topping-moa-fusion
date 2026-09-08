import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { summarizePlanPromptName } from "../../config/planName.ts";
import { buildImplementationKickoffMessage } from "../../moa/implementationRetry.ts";
import { stripSynthSections } from "../../moa/verdicts.ts";
import { FOLLOW_UP } from "../../shared/modelRefs.ts";
import type { MfPlanInfo, PlanReviewDecision } from "../../moa/planInfo.ts";
import { showPlanReview } from "../../ui/planReviewOverlay.ts";
import { ASK_USER_QUESTION_PENDING_MESSAGE } from "../askUserQuestion.ts";
import { getPlan, getPlanFilePath, saveRepoPlanFile, writePlan } from "../planFile.ts";

import type { ImplementationHandoff } from "../../moa/implementationRetry.ts";

export interface ExitPlanModeHost {
	pi: ExtensionAPI;
	isEnabled(): boolean;
	/** True while an ask_user_question questionnaire is waiting for the user. */
	isAskUserQuestionActive(): boolean;
	exitPlanMode(ctx: ExtensionContext): void;
	getPlanRepoSlug(): string | undefined;
	setPlanRepoSlug(slug: string): void;
	persistState(): void;
	getActiveRunMoaInfo(): MfPlanInfo | undefined;
	saveApprovedPlanToRepo(ctx: ExtensionContext, plan: string): void;
	getImplementationHandoff(): ImplementationHandoff | undefined;
	setImplementationHandoff(handoff: ImplementationHandoff | undefined): void;
	markImplementationPending(): void;
}

export function registerExitPlanModeTool(pi: ExtensionAPI, host: ExitPlanModeHost): void {
	pi.registerTool({
		name: "exit_plan_mode",
		label: "Exit Plan Mode",
		description: "Use when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval. Reads the plan from the plan file — does NOT take plan content as a parameter. Only use for tasks that require writing code; not for pure research.",
		parameters: Type.Object({}),
		// exit_plan_mode opens a model/UI surface the model may not have asked
		// the user about yet; marking it sequential means a same-message
		// ask_user_question resolves first, so approval never lands on unread
		// answers.
		executionMode: "sequential",

		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!host.isEnabled()) {
				return {
					details: undefined,
					content: [{ type: "text", text: "You are not in plan mode. This tool is only for exiting plan mode after writing a plan. If your plan was already approved, continue with implementation." }],
					isError: true,
				};
			}

			const plan = getPlan();
			const filePath = getPlanFilePath();

			if (!plan || plan.trim() === "") {
				return {
					details: undefined,
					content: [{ type: "text", text: `No plan content found at ${filePath}. Please write your plan to this file using the write_plan tool before calling exit_plan_mode.` }],
					isError: true,
				};
			}

			// A waiting questionnaire must be answered before the plan is approved.
			// Placed before summarization and the UI branch so it never triggers a
			// plan-name model call and cannot fire in headless runs (rpiv strips its
			// tool there, so the flag stays false).
			if (host.isAskUserQuestionActive()) {
				return { details: undefined, content: [{ type: "text", text: ASK_USER_QUESTION_PENDING_MESSAGE }], isError: true };
			}

			// Non-interactive mode: auto-approve requires explicit opt-in
			if (!ctx.hasUI) {
				if (process.env.MOA_PLAN_AUTO_APPROVE !== "1") {
					return {
						details: undefined,
						content: [{ type: "text", text: "Auto-approve is disabled in headless mode. Set MOA_PLAN_AUTO_APPROVE=1 to enable, or refine the plan further and try again." }],
						isError: true,
					};
				}
				host.exitPlanMode(ctx);
				host.setImplementationHandoff({
					plan,
					planFilePath: filePath,
					repoPlanSlug: host.getPlanRepoSlug(),
					model: ctx.model,
					timestamp: Date.now(),
				});
				host.markImplementationPending();
				return {
					details: undefined,
					content: [
						{
							type: "text",
							text: buildImplementationKickoffMessage(plan, filePath),
						},
					],
				};
			}

			if (!host.getPlanRepoSlug()) {
				host.setPlanRepoSlug(await summarizePlanPromptName(ctx, plan));
				host.persistState();
			}

			// Interactive TUI: show the proposed plan in a scrollable review overlay.
			// RPC has UI primitives but no terminal custom component, so keep the select fallback there.
			let currentPlan = plan;
			while (true) {
				let decision: PlanReviewDecision;
				if (ctx.mode === "tui") {
					decision = await showPlanReview(ctx, currentPlan, host.getActiveRunMoaInfo(), host.getPlanRepoSlug());
				} else {
					const choice = await ctx.ui.select("Exit plan mode?", ["Approve — start implementing", "Keep planning", "Edit plan"]);
					decision = choice?.startsWith("Approve") ? "approve" : choice?.startsWith("Edit") ? "edit" : "keep";
				}

				if (decision === "edit") {
					const edited = await ctx.ui.editor("Edit Plan", currentPlan);
					if (edited?.trim()) {
						currentPlan = stripSynthSections(edited.trim());
						writePlan(currentPlan);
						const repoPlanSlug = host.getPlanRepoSlug();
						if (repoPlanSlug) saveRepoPlanFile(currentPlan, ctx.cwd, repoPlanSlug, "plan");
					}
					continue;
				}
				if (decision === "approve") {
					if (ctx.mode !== "tui") host.saveApprovedPlanToRepo(ctx, currentPlan);
					host.exitPlanMode(ctx);
					host.setImplementationHandoff({
						plan: currentPlan,
						planFilePath: filePath,
						repoPlanSlug: host.getPlanRepoSlug(),
						model: ctx.model,
						timestamp: Date.now(),
					});
					host.markImplementationPending();
					// Deliver the go-ahead as a follow-up (a fresh turn) rather than in this
					// tool result. An agentic-bridge query is created read-only for the whole
					// planning turn; returning "start coding" here just resumes that read-only
					// query. Instead we tell the model to STOP so the read-only query ends,
					// then the queued follow-up runs as a new, full-access query that re-reads
					// the restored env. (terminate:true is worse: the bridge replays the
					// trailing tool result as a continuation that inherits the read-only tools.)
					host.pi.sendUserMessage(
						buildImplementationKickoffMessage(currentPlan, filePath),
						FOLLOW_UP,
					);
					return {
						details: undefined,
						content: [{ type: "text", text: "Plan approved and saved. Plan mode has exited. Stop here — do not write files, run commands, or call any tools in this turn. A follow-up message will tell you to begin implementation." }],
					};
				}

				return { content: [{ type: "text", text: "User wants to keep refining the plan. Continue working on the plan file and call exit_plan_mode when ready." }], details: undefined };
			}
		},
	});
}
