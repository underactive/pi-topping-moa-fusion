import { getPlanFilePath, saveRepoPlanFile, writePlan } from "../planning/planFile.ts";
import { getFinalOutput, getResultOutput } from "../runtime/results.ts";
import { modelRefLabel, TRIGGER_TURN, type ModelRef, type ThinkingLevel } from "../shared/modelRefs.ts";
import { showPlanReview } from "../ui/planReviewOverlay.ts";
import { showImplementingModelPicker } from "../ui/moaModelPicker.ts";
import { buildImplementationKickoffMessage, type ImplementationHandoff } from "./implementationRetry.ts";
import { parseConflicts } from "./conflicts.ts";
import type { ReviewLoopOptions } from "./runContext.ts";
import type { MoaProposerPlan, PlanReviewDecision } from "./planInfo.ts";
import { parseProposerVerdicts, stripSynthSections } from "./verdicts.ts";

export const MAX_REVIEW_CHAT_ROUNDS = 5;

export async function runReviewLoop(options: ReviewLoopOptions): Promise<"done"> {
	const {
		host, ctx, session, widget, proposers, succeeded, synthConversation,
		getSynthesizer, getSynthesizerThinking, getLatestVerdicts, setLatestVerdicts, rebuildSynthTask,
		getSynthTask, runSynthWithRecovery, warnIfMutated,
	} = options;
	let currentPlan = options.initialPlan;
	writePlan(currentPlan);
	const proposerPlans: MoaProposerPlan[] = succeeded.map(({ ref, plan, originalIndex }) => ({
		proposerIndex: originalIndex,
		model: ref,
		markdown: plan,
	}));
	host.setActiveRunMoaInfo({
		proposers,
		synthesizer: getSynthesizer(),
		proposerPlans,
		verdictsMarkdown: getLatestVerdicts() ?? undefined,
	});
	host.persistState();
	let chatRounds = 0;

	while (true) {
		session.closeOverlay?.();
		const synthesizer = getSynthesizer();
		let decision: PlanReviewDecision;
		if (ctx.mode === "tui") {
			decision = await showPlanReview(
				ctx,
				currentPlan,
				{ proposers, synthesizer, proposerPlans, verdictsMarkdown: getLatestVerdicts() ?? undefined },
				host.getPlanRepoSlug(),
				chatRounds < MAX_REVIEW_CHAT_ROUNDS,
			);
		} else {
			const choice = await ctx.ui.select("Exit plan mode?", ["Approve — start implementing", "Keep planning", "Edit plan", "Chat with synthesizer"]);
			decision = choice?.startsWith("Approve") ? "approve" : choice?.startsWith("Edit") ? "edit" : choice?.startsWith("Chat") ? "chat" : "keep";
		}

		if (decision === "edit") {
			session.closeOverlay?.();
			const edited = await ctx.ui.editor("Edit Plan", currentPlan);
			if (edited?.trim()) {
				currentPlan = stripSynthSections(edited.trim());
				writePlan(currentPlan);
				const repoPlanSlug = host.getPlanRepoSlug();
				if (repoPlanSlug) saveRepoPlanFile(currentPlan, ctx.cwd, repoPlanSlug, "plan");
			}
			continue;
		}

		if (decision === "chat") {
			if (chatRounds >= MAX_REVIEW_CHAT_ROUNDS) {
				ctx.ui.notify("Maximum synthesizer review rounds reached; edit or approve the plan instead.", "warning");
				continue;
			}
			session.closeOverlay?.();
			const feedback = await ctx.ui.editor("Describe the changes you want:");
			if (!feedback?.trim()) continue;
			chatRounds++;
			synthConversation.push(`The user reviewed your synthesized plan and gave this feedback:\n${feedback.trim()}\n\nRevise the plan accordingly and re-emit the complete final plan. Drop any ## Conflicts or ## Open Question sections.`);
			rebuildSynthTask();
			widget.switchToSynthesizing(getSynthesizer(), "synthesizing plan", getSynthesizerThinking());
			const synthRound = await runSynthWithRecovery(getSynthTask());
			widget.stopWidget();
			await warnIfMutated("MoA synthesis");
			if (synthRound.cancelled) {
				ctx.ui.notify("Synthesis cancelled.");
				continue;
			}
			if (synthRound.failed) {
				ctx.ui.notify(`Synthesizer failed: ${getResultOutput(synthRound.result)} — keeping the previous plan.`, "error");
				continue;
			}
			const revisionVerdicts = parseProposerVerdicts(parseConflicts(getFinalOutput(synthRound.result.messages)).remainingPlan);
			if (revisionVerdicts.verdictsMarkdown) setLatestVerdicts(revisionVerdicts.verdictsMarkdown);
			const activeRunMoaInfo = host.getActiveRunMoaInfo();
			if (activeRunMoaInfo) {
				activeRunMoaInfo.synthesizer = getSynthesizer();
				if (revisionVerdicts.verdictsMarkdown) activeRunMoaInfo.verdictsMarkdown = revisionVerdicts.verdictsMarkdown;
				host.persistState();
			}
			currentPlan = revisionVerdicts.remainingPlan;
			writePlan(currentPlan);
			const repoPlanSlug = host.getPlanRepoSlug();
			if (repoPlanSlug) saveRepoPlanFile(currentPlan, ctx.cwd, repoPlanSlug, "plan");
			continue;
		}

		if (decision === "approve") {
			if (ctx.mode !== "tui") host.saveApprovedPlanToRepo(ctx, currentPlan);
			const roles = options.roles;
			let generatedCriteria: Awaited<ReturnType<NonNullable<typeof options.generateVerificationCriteria>>> | undefined;
			if (roles?.verifier && options.generateVerificationCriteria) {
				generatedCriteria = await options.generateVerificationCriteria(currentPlan);
				if (generatedCriteria) {
					const repoPlanSlug = host.getPlanRepoSlug();
					if (repoPlanSlug) saveRepoPlanFile(generatedCriteria.markdown, ctx.cwd, repoPlanSlug, "criteria");
					ctx.ui.notify(`Verification criteria ready: ${generatedCriteria.criteria.length} checks.`);
				} else {
					ctx.ui.notify("Verification criteria could not be generated; the verifier will judge plan steps directly.", "warning");
				}
			}
			// The implementer was picked up front in the MoA picker, so approval
			// applies it directly with no second picker. The post-approval picker
			// is kept only as a fallback for a run restored without a roles roster.
			let implementationSelection: { ref: ModelRef; thinking: ThinkingLevel } | undefined;
			if (roles?.implementer) {
				implementationSelection = { ref: roles.implementer, thinking: roles.implementerThinking ?? host.currentThinkingLevel() };
			} else {
				implementationSelection = await showImplementingModelPicker(ctx, host.currentThinkingLevel());
			}
			if (implementationSelection) {
				await host.applyImplementingSelection(
					ctx,
					implementationSelection,
					`Switched to ${modelRefLabel(implementationSelection.ref)} for implementation.`,
				);
			}
			host.exitPlanMode(ctx);
			const filePath = getPlanFilePath();
			const handoff: ImplementationHandoff = {
				plan: currentPlan,
				planFilePath: filePath,
				repoPlanSlug: host.getPlanRepoSlug(),
				model: implementationSelection?.ref ?? ctx.model,
				thinking: implementationSelection?.thinking ?? host.currentThinkingLevel(),
				verifier: roles?.verifier,
				verifierThinking: roles?.verifierThinking,
				verificationCriteria: generatedCriteria?.markdown,
				verificationRepairs: 0,
				timestamp: Date.now(),
			};
			host.setImplementationHandoff(handoff);
			if (handoff.model) {
				// The review overlay pauses the table without settling synthesis. Close
				// that row before implementation so its status and last tool activity
				// cannot continue rendering as a second active agent.
				widget.settleRoleRow("Synthesize", "done");
				widget.setPhaseModels({
					Plan: proposers,
					Synthesize: getSynthesizer(),
					Implement: handoff.model,
					Verify: roles?.verifier,
				});
				widget.switchToImplementing(handoff.model, "implementing plan", handoff.thinking);
				host.adoptProgressWidget(widget);
			}
			host.markImplementationPending(ctx);
			host.pi.sendUserMessage(buildImplementationKickoffMessage(currentPlan, filePath), TRIGGER_TURN);
		} else {
			ctx.ui.notify("Continuing to refine the MoA-synthesized plan.");
			host.pi.sendUserMessage(`The plan file already contains a Mixture-of-Agents synthesized plan for this request. Read it, refine it further if needed, and call exit_plan_mode when ready.`, TRIGGER_TURN);
		}
		return "done";
	}
}
