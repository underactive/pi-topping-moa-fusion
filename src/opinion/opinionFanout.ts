import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AgentConfig } from "../agents/discovery.ts";
import { runWidgetFanout } from "../moa/fanoutWiring.ts";
import { modelExtensionOptions, resolveContextWindow } from "../moa/modelRuntime.ts";
import type { CancelSession } from "../runtime/cancelRun.ts";
import { CancelRun } from "../runtime/cancelRun.ts";
import { getFinalOutput, isFailedResult, type SingleResult } from "../runtime/results.ts";
import type { ModelParallelAgentTask } from "../runtime/runner.ts";
import { modelRefLabel, type ModelRef, type ThinkingLevel } from "../shared/modelRefs.ts";
import { activityLoopCount } from "../ui/agentStatus.ts";
import type { MoaProgressWidget } from "../ui/moaProgressWidget.ts";
import type { ObserveSession } from "../ui/observeOverlay.ts";
import { buildOpinionRetryTask, buildOpinionTask, looksLikeOpinion } from "./opinionContract.ts";

export interface OpinionFanoutHost {
	getActiveObserveSession(): ObserveSession | undefined;
	setActiveObserveSession(session: ObserveSession | undefined): void;
}

export interface OpinionFanoutOptions {
	host: OpinionFanoutHost;
	ctx: ExtensionContext;
	question: string;
	models: ModelRef[];
	thinking: (ThinkingLevel | undefined)[];
	session: CancelSession;
	widget: MoaProgressWidget;
	agents: AgentConfig[];
	maxConcurrency: number;
}

export type OpinionFanoutResult =
	| { status: "done"; results: SingleResult[] }
	| { status: "cancelled" };

export async function runOpinionFanout(options: OpinionFanoutOptions): Promise<OpinionFanoutResult> {
	const { host, ctx, question, models, thinking, session, widget, agents, maxConcurrency } = options;
	const originalTask = buildOpinionTask(question);
	widget.startFanout(models, thinking);
	const observe: ObserveSession = {
		title: "MoA opinions",
		phase: "fanout",
		agents: models.map((ref) => ({
			label: ref.id,
			model: ref.id,
			task: originalTask,
			messages: [],
			state: "working",
		})),
		overlayOpen: false,
	};
	const previousObserveSession = host.getActiveObserveSession();
	host.setActiveObserveSession(observe);

	try {
		const runBatch = (
			tasks: ModelParallelAgentTask[],
			indexMap: (index: number) => number,
			currentRun: CancelRun,
		): Promise<SingleResult[]> => runWidgetFanout({ ctx, agents, tasks, run: currentRun, session, widget, observe, models, indexMap, maxConcurrency });

		const run = new CancelRun();
		session.title = "Opinion agents";
		session.getExtras = (index) => {
			const status = widget.getStatus(index);
			if (!status) return undefined;
			return {
				contextTokens: status.contextTokens,
				contextWindow: resolveContextWindow(ctx, status.ref),
				activity: status.activity,
				loopCount: activityLoopCount(status.activity, status.activityHistory),
			};
		};
		const tasks = models.map((ref, index) => {
			const label = modelRefLabel(ref);
			return {
				agent: "moa-opinion",
				task: originalTask,
				model: label,
				thinking: thinking[index],
				...modelExtensionOptions(ctx, ref),
				signal: run.add(label).signal,
			};
		});
		const results = await runBatch(tasks, (index) => index, run);
		if (run.cancelAllRequested) return { status: "cancelled" };

		const retryIndices: number[] = [];
		for (let index = 0; index < results.length; index++) {
			const result = results[index];
			if (!result.cancelled && !isFailedResult(result) && !looksLikeOpinion(getFinalOutput(result.messages))) retryIndices.push(index);
		}
		if (retryIndices.length > 0) {
			const retryRun = new CancelRun();
			session.title = "Opinion agents (retry)";
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
			const retryTasks = retryIndices.map((opinionIndex) => {
				const ref = models[opinionIndex];
				const label = modelRefLabel(ref);
				const retryTask = buildOpinionRetryTask(originalTask, getFinalOutput(results[opinionIndex].messages));
				widget.update(opinionIndex, "working", "retrying: no opinion produced");
				const observed = observe.agents[opinionIndex];
				if (observed) {
					observed.state = "working";
					observed.task = retryTask;
				}
				return {
					agent: "moa-opinion",
					task: retryTask,
					model: label,
					thinking: thinking[opinionIndex],
					...modelExtensionOptions(ctx, ref),
					signal: retryRun.add(label).signal,
				};
			});
			const retryResults = await runBatch(retryTasks, (index) => retryIndices[index], retryRun);
			for (let index = 0; index < retryResults.length; index++) results[retryIndices[index]] = retryResults[index];
			if (retryRun.cancelAllRequested) return { status: "cancelled" };
		}

		return { status: "done", results };
	} finally {
		observe.closeOverlay?.();
		host.setActiveObserveSession(previousObserveSession);
	}
}
