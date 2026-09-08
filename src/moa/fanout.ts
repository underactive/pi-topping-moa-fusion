import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AgentConfig } from "../agents/discovery.ts";
import type { CancelSession } from "../runtime/cancelRun.ts";
import { CancelRun } from "../runtime/cancelRun.ts";
import { getFinalOutput, getResultOutput, isFailedResult } from "../runtime/results.ts";
import { runParallelAgentsWithModels, type ModelParallelAgentTask } from "../runtime/runner.ts";
import { modelRefLabel, TRIGGER_TURN, type ModelRef, type ThinkingLevel } from "../shared/modelRefs.ts";
import { activityLoopCount } from "../ui/agentStatus.ts";
import type { MoaProgressWidget } from "../ui/moaProgressWidget.ts";
import type { ObserveSession } from "../ui/observeOverlay.ts";
import { buildProposerRetryTask, buildProposerTask, looksLikePlan } from "./planlessRetry.ts";
import { modelExtensionOptions, resolveContextWindow, resolveModelCost } from "./modelRuntime.ts";
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
}

export async function runFanoutPhase(options: FanoutPhaseOptions): Promise<FanoutPhaseResult> {
	const { host, runContext, ctx, prompt, proposers, proposerThinking, session, widget, agents, warnIfMutated } = options;
	widget.startFanout(proposers, proposerThinking);
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
	const runFanout = async (tasks: ModelParallelAgentTask[], indexMap: (index: number) => number, currentRun: CancelRun) => {
		const unsubscribe = currentRun.onChange(() => {
			currentRun.agents.forEach((agent, index) => {
				if (agent.state === "cancelling") widget.update(indexMap(index), "cancelling");
			});
		});
		session.run = currentRun;
		try {
			return await runParallelAgentsWithModels(
				ctx.cwd,
				agents,
				tasks,
				undefined,
				(index, result) => {
					const proposerIndex = indexMap(index);
					widget.updateTranscript(proposerIndex, result.messages);
					const observed = observe.agents[proposerIndex];
					if (observed) {
						observed.messages = result.messages;
						observed.partial = undefined;
					}
					if (result.cancelled) {
						currentRun.settle(index, "cancelled");
						widget.update(proposerIndex, "cancelled");
						if (observed) observed.state = "cancelled";
					} else if (isFailedResult(result)) {
						currentRun.settle(index, "error");
						widget.update(proposerIndex, "error", getResultOutput(result).slice(0, 80));
						if (observed) observed.state = "error";
					} else {
						currentRun.settle(index, "done");
						widget.update(proposerIndex, "done");
						if (observed) observed.state = "done";
					}
				},
				(index, result) => {
					const proposerIndex = indexMap(index);
					widget.updateUsage(
						proposerIndex,
						result.usage.contextTokens,
						result.usage.turns,
						result.usage.toolCalls,
						resolveModelCost(ctx, proposers[proposerIndex], result.usage),
					);
					if (result.activity) widget.updateActivity(proposerIndex, result.activity);
					if (result.outputActivity) widget.updateOutput(proposerIndex, result.outputActivity.tokens, result.outputActivity.revision);
					widget.updateTranscript(proposerIndex, result.messages, result.partialAssistant);
					const observed = observe.agents[proposerIndex];
					if (observed) {
						observed.messages = result.messages;
						observed.partial = result.partialAssistant;
					}
				},
			);
		} finally {
			unsubscribe();
			session.run = undefined;
		}
	};

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
			widget.update(proposerIndex, "working", "retrying: no plan produced");
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
