import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AgentConfig } from "../agents/discovery.ts";
import type { CancelSession } from "../runtime/cancelRun.ts";
import { CancelRun } from "../runtime/cancelRun.ts";
import { getFinalOutput, isFailedResult } from "../runtime/results.ts";
import type { ModelParallelAgentTask } from "../runtime/runner.ts";
import { modelRefLabel, TRIGGER_TURN, type ModelRef, type ThinkingLevel } from "../shared/modelRefs.ts";
import { activityLoopCount } from "../ui/agentStatus.ts";
import { showModelThinkingPicker } from "../ui/moaModelPicker.ts";
import type { MoaProgressWidget } from "../ui/moaProgressWidget.ts";
import type { ObserveSession } from "../ui/observeOverlay.ts";
import { runWidgetFanout } from "./fanoutWiring.ts";
import { buildProposerRetryTask, buildProposerTask, looksLikePlan } from "./planlessRetry.ts";
import { modelExtensionOptions, resolveContextWindow } from "./modelRuntime.ts";
import type { MoaRunContext, MoaRunHost, SucceededProposal } from "./runContext.ts";

export type FanoutPhaseResult =
	| { status: "continue"; succeeded: SucceededProposal[]; observe: ObserveSession; previousObserveSession: ObserveSession | undefined }
	| { status: "done" | "cancelled"; observe: ObserveSession; previousObserveSession: ObserveSession | undefined };

export interface FanoutPhaseOptions {
	host: MoaRunHost;
	runContext: Pick<MoaRunContext, "observeSession" | "previousObserveSession">;
	ctx: ExtensionContext;
	prompt: string;
	proposers: ModelRef[];
	proposerThinking: (ThinkingLevel | undefined)[];
	session: CancelSession;
	widget: MoaProgressWidget;
	agents: AgentConfig[];
	warnIfMutated(phase: string): Promise<void>;
	maxConcurrency: number;
}

export async function runFanoutPhase(options: FanoutPhaseOptions): Promise<FanoutPhaseResult> {
	const { host, runContext, ctx, prompt, proposers, proposerThinking, session, widget, agents, warnIfMutated, maxConcurrency } = options;
	widget.startFanout(proposers, proposerThinking, maxConcurrency);
	const observe: ObserveSession = {
		title: "MoA fan-out",
		phase: "fanout",
		agents: proposers.map((ref) => {
			// The observer is display-only: omit the provider while task routing
			// continues to use modelRefLabel(ref) below.
			return { label: ref.id, model: ref.id, task: prompt, messages: [], state: "working" };
		}),
		overlayOpen: false,
	};
	const previousObserveSession = host.getActiveObserveSession();
	// Publish ownership before fan-out can await or throw so runMoaPhases' outer
	// finally always restores the predecessor and closes this observer.
	runContext.previousObserveSession = previousObserveSession;
	runContext.observeSession = observe;
	host.setActiveObserveSession(observe);

	const run = new CancelRun();
	session.title = "MoA fan-out";
	session.getExtras = (i) => {
		const status = widget.getStatus(i);
		if (!status) return undefined;
		return {
			contextTokens: status.contextTokens,
			contextWindow: resolveContextWindow(ctx, status.ref),
			activity: status.activity,
			loopCount: activityLoopCount(status.activity, status.activityHistory),
		};
	};
	const runFanout = (tasks: ModelParallelAgentTask[], indexMap: (index: number) => number, currentRun: CancelRun) =>
		runWidgetFanout({ ctx, agents, tasks, run: currentRun, session, widget, observe, models: proposers, indexMap, maxConcurrency });

	// The planning contract travels inside the task text — the only channel
	// guaranteed to survive a bridge's system-prompt override. The observer keeps
	// the raw prompt so its 120-char header stays readable.
	const proposerTask = buildProposerTask(prompt);
	const tasks = proposers.map((ref, index) => {
		const label = modelRefLabel(ref);
		return {
			agent: "moa-proposer",
			task: proposerTask,
			model: label,
			thinking: proposerThinking[index],
			...modelExtensionOptions(ctx, ref),
			signal: run.add(label).signal,
		};
	});
	const results = await runFanout(tasks, (index) => index, run);
	await warnIfMutated("MoA proposer fan-out");
	if (run.cancelAllRequested) {
		widget.stopWidget();
		ctx.ui.notify("MoA run cancelled.");
		return { status: "cancelled", observe, previousObserveSession };
	}

	// A proposer cancelled from the cancel overlay must not silently drop out of
	// the run: the user who killed it decides what replaces it, mirroring the
	// synthesizer-failure precedent. A slot dropped here stays `cancelled` in
	// results, so it is already excluded from `succeeded` — "continue without"
	// needs no other handling. This runs after the cancel-all check and before
	// the planless-retry pass, so a replacement that returns no plan then gets
	// that retry for free.
	const cancelledSlots = results.flatMap((r, i) => r.cancelled ? [i] : []);
	if (cancelledSlots.length > 0 && ctx.hasUI) {
		// Stop the stacked overlays and the sticky widget before the modal so the
		// select/picker are not fighting them. session.run is already undefined
		// (cleared in runWidgetFanout's finally), so ESC reaches the modal, not a
		// reopened cancel overlay.
		session.closeOverlay?.();
		widget.stopWidget();
		for (const index of cancelledSlots) {
			while (true) {
				const label = modelRefLabel(proposers[index]);
				const choice = await ctx.ui.select(
					`Proposer ${index + 1} (${label}) was cancelled — what next?`,
					["Select a different model", "Continue without this proposer"],
				);
				if (choice !== "Select a different model") break;
				const picked = await showModelThinkingPicker(
					ctx,
					host.currentThinkingLevel(),
					`Replacement for Proposer ${index + 1}`,
					proposers[index],
					proposerThinking[index],
				);
				if (!picked) continue;
				// Rewrite the shared phase/synthesis/observe arrays in place: the
				// same object is held by the widget band, the cost resolution,
				// synthesis, and the persisted activeRunMoaInfo.
				proposers[index] = picked.ref;
				proposerThinking[index] = picked.thinking;
				host.persistState();
				widget.replaceProposerModel(index, picked.ref, picked.thinking);
				// Rewrite the observe row's identity, not just its messages, so F3
				// shows the replacement and not the cancelled agent's corpse.
				const observed = observe.agents[index];
				if (observed) {
					observed.label = picked.ref.id;
					observed.model = picked.ref.id;
					observed.task = proposerTask;
					observed.messages = [];
					observed.partial = undefined;
					observed.state = "working";
				}
				const replaceRun = new CancelRun();
				session.title = "MoA fan-out (replacement)";
				session.getExtras = () => {
					const status = widget.getStatus(index);
					if (!status) return undefined;
					return {
						contextTokens: status.contextTokens,
						contextWindow: resolveContextWindow(ctx, status.ref),
						activity: status.activity,
						loopCount: activityLoopCount(status.activity, status.activityHistory),
					};
				};
				// The slot was killed, not planless — rerun the fresh proposer task.
				const [replacement] = await runFanout(
					[
						{
							agent: "moa-proposer",
							task: proposerTask,
							model: modelRefLabel(picked.ref),
							thinking: picked.thinking,
							...modelExtensionOptions(ctx, picked.ref),
							signal: replaceRun.add(modelRefLabel(picked.ref)).signal,
						},
					],
					() => index,
					replaceRun,
				);
				results[index] = replacement;
				await warnIfMutated("MoA proposer replacement");
				// Cancel ALL during a replacement ends the run, like the other exits.
				if (replaceRun.cancelAllRequested) {
					widget.stopWidget();
					ctx.ui.notify("MoA run cancelled.");
					return { status: "cancelled", observe, previousObserveSession };
				}
				// A cancelled or planless replacement re-asks the same two options
				// until the user chooses to move on.
				if (replacement.cancelled || isFailedResult(replacement)) {
					session.closeOverlay?.();
					widget.stopWidget();
					ctx.ui.notify(
						`Replacement proposer ${modelRefLabel(picked.ref)} did not produce a plan.`,
						"warning",
					);
					continue;
				}
				break;
			}
		}
		// A prompt stopped the widget; re-show the table so the planless-retry pass
		// and synthesis render into a mounted table even when the user dropped
		// every cancelled slot.
		widget.resumeTable();
	}

	const retryIndices: number[] = [];
	for (let index = 0; index < results.length; index++) {
		const result = results[index];
		if (!isFailedResult(result) && !result.cancelled && !looksLikePlan(getFinalOutput(result.messages))) retryIndices.push(index);
	}
	if (retryIndices.length > 0) {
		ctx.ui.notify(`MoA: retrying ${retryIndices.length} proposer(s) — no plan produced.`);
		const retryRun = new CancelRun();
		session.title = "MoA fan-out (retry)";
		session.getExtras = (index) => {
			const status = widget.getStatus(retryIndices[index]);
			if (!status) return undefined;
			return {
				contextTokens: status.contextTokens,
				contextWindow: resolveContextWindow(ctx, status.ref),
				activity: status.activity,
				loopCount: activityLoopCount(status.activity, status.activityHistory),
			};
		};
		const retryTasks = retryIndices.map((proposerIndex) => {
			const ref = proposers[proposerIndex];
			const label = modelRefLabel(ref);
			const retryTask = buildProposerRetryTask(proposerTask, getFinalOutput(results[proposerIndex].messages));
			widget.update(proposerIndex, "queued", "retrying: no plan produced");
			const observed = observe.agents[proposerIndex];
			if (observed) {
				observed.state = "working";
				observed.task = retryTask;
			}
			return {
				agent: "moa-proposer",
				task: retryTask,
				model: label,
				thinking: proposerThinking[proposerIndex],
				...modelExtensionOptions(ctx, ref),
				signal: retryRun.add(label).signal,
			};
		});
		const retryResults = await runFanout(retryTasks, (index) => retryIndices[index], retryRun);
		for (let index = 0; index < retryResults.length; index++) results[retryIndices[index]] = retryResults[index];
		await warnIfMutated("MoA proposer retry");
		if (retryRun.cancelAllRequested) {
			widget.stopWidget();
			ctx.ui.notify("MoA run cancelled.");
			return { status: "cancelled", observe, previousObserveSession };
		}
	}

	const succeeded: SucceededProposal[] = [];
	for (let index = 0; index < results.length; index++) {
		const result = results[index];
		if (!isFailedResult(result)) succeeded.push({ ref: proposers[index], plan: getFinalOutput(result.messages), originalIndex: index });
	}
	if (succeeded.length === 0) {
		widget.stopWidget();
		ctx.ui.notify("All MoA proposer models failed. Falling back to single-model planning.", "error");
		host.pi.sendUserMessage(prompt, TRIGGER_TURN);
		return { status: "done", observe, previousObserveSession };
	}
	return { status: "continue", succeeded, observe, previousObserveSession };
}
