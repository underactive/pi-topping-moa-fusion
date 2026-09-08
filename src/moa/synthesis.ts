import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AgentConfig } from "../agents/discovery.ts";
import { loadMoaConfig } from "../config/settings.ts";
import { writeProposalFiles } from "../planning/planFile.ts";
import { CancelRun } from "../runtime/cancelRun.ts";
import { getFinalOutput, getResultOutput, isFailedResult } from "../runtime/results.ts";
import { runSingleAgent } from "../runtime/runner.ts";
import { modelRefLabel, proposerBlindedLabel, TRIGGER_TURN, type ModelRef } from "../shared/modelRefs.ts";
import { activityLoopCount } from "../ui/agentStatus.ts";
import { showConflictReview } from "../ui/conflictOverlay.ts";
import { showImplementingModelPicker } from "../ui/moaModelPicker.ts";
import type { ObserveSession } from "../ui/observeOverlay.ts";
import { buildConflictContract } from "./conflictContract.ts";
import { parseConflicts } from "./conflicts.ts";
import { buildRetryCorrection, looksLikePlan, SYNTHESIZER_RETRY_HEADER, SYNTHESIZER_TASK_PREAMBLE } from "./planlessRetry.ts";
import { buildContextRetryHeader, buildContextSubsectionsContract, missingContextSubsections } from "./contextContract.ts";
import { modelExtensionOptions, resolveContextWindow, resolveModelCost } from "./modelRuntime.ts";
import { runCriteriaGeneration } from "./verificationCriteria.ts";
import type { MoaRunContext, ReviewLoopOptions, SucceededProposal } from "./runContext.ts";
import { buildVerdictContract, buildVerdictRetryHeader, missingVerdictSlots, parseProposerVerdicts, stripSynthSections } from "./verdicts.ts";

export interface SynthesisPhaseOptions {
	ctx: ExtensionContext;
	prompt: string;
	proposers: ModelRef[];
	succeeded: SucceededProposal[];
	observe: ObserveSession;
	agents: AgentConfig[];
	warnIfMutated(phase: string): Promise<void>;
}

export type SynthesisPhaseResult =
	| { status: "done" | "cancelled" }
	| { status: "review"; options: ReviewLoopOptions };

export async function runSynthesisPhase(
	runContext: MoaRunContext,
	options: SynthesisPhaseOptions,
): Promise<SynthesisPhaseResult> {
	const { host, session, widget } = runContext;
	const { ctx, prompt, proposers, succeeded, observe, agents, warnIfMutated } = options;
	widget.switchToSynthesizing(runContext.synthesizer, "adjudicating proposed plans…", runContext.synthesizerThinking);

	// Proposals are both inlined and staged on disk. Inlining is what
	// guarantees the synthesizer actually weighs every proposal — behind a
	// file reference alone it could silently read three of five and still
	// emit a confident plan. The staged copies exist for the case inlining
	// cannot survive: compaction reserves a flat 16k tokens regardless of
	// context window, so a small-window synthesizer can cross the threshold
	// on its first turn and reconcile an LLM summary of the proposals
	// instead of the proposals themselves.
	runContext.proposalFiles = writeProposalFiles(
		succeeded.map(({ plan, originalIndex }) => ({ label: proposerBlindedLabel(originalIndex), plan })),
	);
	const stagedFiles = runContext.proposalFiles?.files;

	const proposals = succeeded
		.map(({ plan, originalIndex }, i) => {
			const stagedPath = stagedFiles?.[i]?.path;
			const pointer = stagedPath ? `\nVerbatim copy on disk: ${stagedPath}\n` : "";
			return `### Proposal from ${proposerBlindedLabel(originalIndex)}\n${pointer}\n${plan}`;
		})
		.join("\n\n---\n\n");

	// The preamble carries the read-only planning contract inside the task
	// itself: bridged providers can replace the moa-synthesizer system prompt
	// with their own harness, and without it they read an "implement X"
	// user request as marching orders and stall on their read-only tools.
	// The verdict and conflict contracts ride the task text for the same
	// reason: a bridged synthesizer that loses the agent prompt never learns
	// the ## Conflicts markup and silently resolves every disagreement solo.
	const fedLabels = succeeded.map(({ originalIndex }) => proposerBlindedLabel(originalIndex));
	const baseSynthTask = `${SYNTHESIZER_TASK_PREAMBLE}\n\nOriginal user request:\n${prompt}\n\n---\n\nIndependent proposer plans:\n\n${proposals}\n\n---\n\n${buildVerdictContract(fedLabels)}\n\n---\n\n${buildContextSubsectionsContract()}\n\n---\n\n${buildConflictContract(fedLabels)}`;
	const rebuildSynthTask = () => {
		synthTask = [baseSynthTask, ...runContext.synthConversation.slice(-2)].join("\n\n---\n\n");
	};
	let synthTask = baseSynthTask;
	let synthOutput = "";
	// Initial pass + rounds for Open-Question clarifications and/or conflict-review re-synths.
	const MAX_SYNTH_ROUNDS = 5;
	let synthPlanlessRetried = false;
	let verdictRetried = false;
	let contextRetried = false;
	// Whether any accepted round's output carried all three Context subsections
	// — conflict/chat revisions may legitimately drop them once seen, so the
	// final warning keys on this rather than on the last output alone.
	let contextSubsectionsSeen = false;
	const runSynthesizerRound = async (task: string) => {
		const synthRun = new CancelRun();
		const label = modelRefLabel(runContext.synthesizer);
		session.title = "MoA synthesis";
		session.getExtras = () => {
			const s = widget.getRoleStatus("Synthesize");
			return {
				contextTokens: s.contextTokens,
				contextWindow: s.ref ? resolveContextWindow(ctx, s.ref) : undefined,
				activity: s.activity,
				loopCount: activityLoopCount(s.activity, s.activityHistory),
			};
		};
		observe.phase = "synthesizing";
		observe.title = "MoA synthesis";
		observe.synthesizer = {
			label: runContext.synthesizer.id,
			model: runContext.synthesizer.id,
			task,
			messages: [],
			state: "working",
		};
		const synthSlot = synthRun.add(label);
		widget.updateRoleTranscript("Synthesize", []);
		session.run = synthRun;
		try {
			const result = await runSingleAgent(
				ctx.cwd, agents, "moa-synthesizer", task, undefined, synthSlot.signal, undefined,
				label, runContext.synthesizerThinking, {
					...modelExtensionOptions(ctx, runContext.synthesizer),
					resolveOnAbort: true,
					onProgress: (r) => {
						widget.updateRoleUsage(
							"Synthesize",
							r.usage.contextTokens,
							r.usage.turns,
							r.usage.toolCalls,
							resolveModelCost(ctx, runContext.synthesizer, r.usage),
						);
						if (r.activity) widget.updateRoleActivity("Synthesize", r.activity);
						if (r.outputActivity) widget.updateRoleOutput("Synthesize", r.outputActivity.tokens, r.outputActivity.revision);
						widget.updateRoleTranscript("Synthesize", r.messages, r.partialAssistant);
						if (observe.synthesizer) {
							observe.synthesizer.messages = r.messages;
							observe.synthesizer.partial = r.partialAssistant;
						}
					},
				},
			);
			if (result.cancelled || synthRun.cancelAllRequested) {
				if (observe.synthesizer) observe.synthesizer.state = "cancelled";
				return { result, cancelled: true };
			}
			if (isFailedResult(result)) {
				if (observe.synthesizer) observe.synthesizer.state = "error";
				return { result, failed: true };
			}
			widget.updateRoleTranscript("Synthesize", result.messages);
			if (observe.synthesizer) {
				observe.synthesizer.messages = result.messages;
				observe.synthesizer.partial = undefined;
				observe.synthesizer.state = "done";
			}
			return { result, cancelled: false, failed: false };
		} finally {
			session.run = undefined;
		}
	};

	const runSynthWithRecovery = async (task: string) => {
		let round = await runSynthesizerRound(task);
		while (round.failed && !round.cancelled) {
			session.closeOverlay?.();
			widget.stopWidget();
			const action = await resolveSynthesizerFailure(getResultOutput(round.result));
			if (action === "abandon") break;
			widget.switchToSynthesizing(runContext.synthesizer, action === "switch" ? "retrying with a new model…" : "retrying…", runContext.synthesizerThinking);
			round = await runSynthesizerRound(task);
		}
		return round;
	};

	// A synthesizer crash (500 with no body, a 401 credits error, etc.) must
	// never silently discard the fan-out: the proposer plans already cost
	// real work, so offer to retry, switch models, or — as a last resort —
	// hand the plans to the session model instead of re-running from the
	// bare prompt. Switching reassigns `synthesizer` itself, so every
	// closure above that reads it (runSynthesizerRound, widget calls,
	// activeRunMoaInfo below) picks up the new model automatically.
	const resolveSynthesizerFailure = async (errorMessage: string): Promise<"retry" | "switch" | "abandon"> => {
		while (true) {
			if (!ctx.hasUI) return "abandon";
			ctx.ui.notify(`Synthesizer failed: ${errorMessage}`, "error");
			const label = modelRefLabel(runContext.synthesizer);
			const choice = await ctx.ui.select(
				"Synthesizer failed — proposer plans are still available. What next?",
				[`Retry ${label}`, "Choose a different model", "Give up on MoA synthesis"],
			);
			if (choice === `Retry ${label}`) return "retry";
			if (choice === "Choose a different model") {
				const picked = await showImplementingModelPicker(ctx, host.currentThinkingLevel(), "Synthesizer failed — choose a different model");
				if (!picked) continue;
				runContext.synthesizer = picked.ref;
				runContext.synthesizerThinking = picked.thinking;
				widget.setPhaseModels({
					Plan: proposers,
					Synthesize: picked.ref,
					Implement: runContext.roles?.implementer,
					Verify: runContext.roles?.verifier,
				});
				return "switch";
			}
			return "abandon";
		}
	};

	for (let round = 0; round < MAX_SYNTH_ROUNDS; round++) {
		const synthRound = await runSynthWithRecovery(synthTask);
		const synthResult = synthRound.result;
		if (synthRound.cancelled) {
			widget.stopWidget();
			await warnIfMutated("MoA synthesis");
			ctx.ui.notify("Synthesis cancelled.");
			return { status: "cancelled" };
		}
		if (synthRound.failed) {
			widget.stopWidget();
			await warnIfMutated("MoA synthesis");
			ctx.ui.notify("Synthesizer unavailable — handing the proposer plans to the session model.", "warning");
			host.pi.sendUserMessage(
				`The MoA synthesizer model failed and no other model was picked. Acting as the synthesizer yourself, review the independent proposer plans below and produce one final plan for the user's original request.\n\n${synthTask}`,
				TRIGGER_TURN,
			);
			return { status: "done" };
		}
		synthOutput = getFinalOutput(synthResult.messages);
		const questionMatch = synthOutput.match(/^##\s*Open Question\s*\n([\s\S]*)$/m);

		if (questionMatch && round < MAX_SYNTH_ROUNDS - 1) {
			widget.stopWidget();
			// A lingering cancel overlay must not fight the input prompt for focus.
			session.closeOverlay?.();
			const rawQuestion = questionMatch[1].trim();
			const question = rawQuestion.split("\n##")[0].slice(0, 2000).trim();
			const answer = await ctx.ui.editor(question);
			if (!answer || !answer.trim()) {
				// User declined to answer — proceed with whatever the synthesizer has so far.
				break;
			}
			runContext.synthConversation.push(`Synthesizer asked: ${question}\nUser answered: ${answer.trim()}\n\nNow produce the full plan.`);
			rebuildSynthTask();
			widget.switchToSynthesizing(runContext.synthesizer, "adjudicating proposed plans…", runContext.synthesizerThinking);
			continue;
		}

		// Like proposers, a synthesizer can exit cleanly without delivering a
		// plan — e.g. a bridged agent that lost the moa-synthesizer prompt
		// refuses with "I'm blocked: read-only tools" instead of synthesizing.
		// Writing that refusal to the plan file would present it to the user
		// as the proposed plan, so re-run once with a corrective instruction.
		if (!questionMatch && !looksLikePlan(synthOutput) && !synthPlanlessRetried && round < MAX_SYNTH_ROUNDS - 1) {
			synthPlanlessRetried = true;
			const synthRetryCorr = buildRetryCorrection(SYNTHESIZER_RETRY_HEADER, synthOutput);
			runContext.synthConversation.push(synthRetryCorr);
			rebuildSynthTask();
			widget.switchToSynthesizing(runContext.synthesizer, "retrying: no plan produced…", runContext.synthesizerThinking);
			continue;
		}

		// Proof of judging: a plan without a verdict for every fed proposal
		// slot is indistinguishable from a solo plan that ignored the fan-out,
		// so reject it once with the missing slots named. Gate on the latest
		// verdicts seen across rounds — conflict/chat revisions may omit the
		// section once a complete set was already captured.
		const verdictCheck = parseProposerVerdicts(synthOutput);
		if (verdictCheck.verdictsMarkdown) runContext.latestVerdicts = verdictCheck.verdictsMarkdown;
		const missingVerdicts = missingVerdictSlots(runContext.latestVerdicts, fedLabels);
		if (!questionMatch && missingVerdicts.length > 0 && !verdictRetried && round < MAX_SYNTH_ROUNDS - 1) {
			verdictRetried = true;
			const verdictRetryCorr = buildRetryCorrection(buildVerdictRetryHeader(missingVerdicts), synthOutput);
			runContext.synthConversation.push(verdictRetryCorr);
			rebuildSynthTask();
			widget.switchToSynthesizing(runContext.synthesizer, "retrying: missing proposer verdicts…", runContext.synthesizerThinking);
			continue;
		}

		// Auditable reasoning: a plan whose Context lacks the three mandated
		// subsections hides how the proposals were weighed and recombined, so
		// reject it once with the missing headings named. Sits after the
		// verdict gate (same structural-completeness class) and before conflict
		// parsing so a retry never re-opens already-parsed conflicts.
		const missingContext = missingContextSubsections(synthOutput);
		if (!questionMatch && missingContext.length > 0 && !contextRetried && round < MAX_SYNTH_ROUNDS - 1) {
			contextRetried = true;
			const contextRetryCorr = buildRetryCorrection(buildContextRetryHeader(missingContext), synthOutput);
			runContext.synthConversation.push(contextRetryCorr);
			rebuildSynthTask();
			widget.switchToSynthesizing(runContext.synthesizer, "retrying: missing context sections…", runContext.synthesizerThinking);
			continue;
		}
		if (!questionMatch && missingContext.length === 0) contextSubsectionsSeen = true;

		const { conflicts, remainingPlan } = parseConflicts(synthOutput);

		// Diagnostic only: on the initial synthesis pass, 2+ proposers succeeded
		// but the synthesizer emitted no ## Conflicts at all. This is expected
		// when proposers genuinely agreed on every decision point, but it's also
		// the exact symptom of a stale/non-conflict-aware synthesizer prompt, so
		// surface a low-severity hint rather than fail silently either way.
		if (round === 0 && conflicts.length === 0 && succeeded.length >= 2) {
			ctx.ui.notify(
				"MoA synthesizer returned no conflicts — if proposers disagreed, verify the bundled synthesizer prompt is in effect.",
				"warning",
			);
		}

		if (conflicts.length > 0) {
			const isLastRound = round === MAX_SYNTH_ROUNDS - 1;
			if ((round < MAX_SYNTH_ROUNDS - 1 || (isLastRound && ctx.mode === "tui")) && !loadMoaConfig().autoResolveConflicts) {
				widget.stopWidget();
				// A lingering cancel overlay must not fight the conflict overlay for focus.
				session.closeOverlay?.();
				const review = await showConflictReview(ctx, conflicts);

				if (review.cancelled) {
					await warnIfMutated("MoA synthesis");
					ctx.ui.notify("MoA synthesis cancelled.");
					return { status: "cancelled" };
				}

				const feedbackParts: string[] = ["User reviewed your conflict recommendations:"];
				for (const conflict of conflicts) {
					const answer = review.answers.get(conflict.id);
					feedbackParts.push(`\n### Conflict: ${conflict.label}`);
					if (!answer) continue;
					if (answer.kind === "chat") {
						feedbackParts.push(`User wants to chat: ${answer.chatText ?? ""}`);
					} else {
						const opt = conflict.options.find((o) => o.value === answer.optionValue);
						if (answer.kind === "recommended") {
							feedbackParts.push(`User confirmed your recommendation: ${opt?.label ?? answer.optionValue}`);
						} else {
							feedbackParts.push(
								`User chose the alternative from ${opt?.proposerLabel ?? "a proposer"}: ${opt?.label ?? answer.optionValue}`,
							);
						}
					}
				}
				feedbackParts.push(
					"\nIncorporate these resolutions and re-emit the final plan. Drop the ## Conflicts section. Keep the answer complete.",
				);
				const feedback = feedbackParts.join("\n");

				runContext.synthConversation.push(feedback);
				rebuildSynthTask();
				widget.switchToSynthesizing(runContext.synthesizer, "synthesizing plan…", runContext.synthesizerThinking);
				if (isLastRound) {
					const finalRound = await runSynthWithRecovery(synthTask);
					if (finalRound.cancelled) {
						widget.stopWidget();
						await warnIfMutated("MoA synthesis");
						ctx.ui.notify("Synthesis cancelled.");
						return { status: "cancelled" };
					}
					if (!finalRound.failed) {
						synthOutput = getFinalOutput(finalRound.result.messages);
					}
					break;
				}
				continue;
			} else {
				ctx.ui.notify(`Auto-accepted ${conflicts.length} recommended conflict choice${conflicts.length === 1 ? "" : "s"}.`);
				synthOutput = remainingPlan;
				break;
			}
		}

		synthOutput = remainingPlan;
		break;
	}

	widget.stopWidget();

	await warnIfMutated("MoA synthesis");

	synthOutput = stripSynthSections(synthOutput);
	if (runContext.latestVerdicts === null) {
		ctx.ui.notify(
			"MoA synthesizer produced no proposer verdicts even after a retry — there is no proof the proposals were evaluated.",
			"warning",
		);
	}
	if (!contextSubsectionsSeen) {
		ctx.ui.notify(
			"MoA synthesizer omitted the required Context subsections (Evaluation dimensions, Proposer alignment, Synthesis decisions) even after a retry — the reconciliation reasoning is not auditable in this plan.",
			"warning",
		);
	}

	return {
		status: "review",
		options: {
			host,
			ctx,
			session,
			widget,
			proposers,
			succeeded,
			initialPlan: synthOutput,
			synthConversation: runContext.synthConversation,
			getSynthesizer: () => runContext.synthesizer,
			getSynthesizerThinking: () => runContext.synthesizerThinking,
			getLatestVerdicts: () => runContext.latestVerdicts,
			setLatestVerdicts: (markdown) => { runContext.latestVerdicts = markdown; },
			rebuildSynthTask,
			getSynthTask: () => synthTask,
			runSynthWithRecovery,
			warnIfMutated,
			roles: runContext.roles,
			generateVerificationCriteria: (plan) => runCriteriaGeneration({
				ctx,
				agents,
				synthesizer: runContext.synthesizer,
				thinking: runContext.synthesizerThinking,
				plan,
				session,
				widget,
				observe,
			}),
		},
	};
}
