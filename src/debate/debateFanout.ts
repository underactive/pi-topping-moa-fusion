import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AgentConfig } from "../agents/discovery.ts";
import { modelExtensionOptions, resolveContextWindow, resolveModelCost } from "../moa/modelRuntime.ts";
import type { CancelSession } from "../runtime/cancelRun.ts";
import { CancelRun } from "../runtime/cancelRun.ts";
import { getFinalOutput, getResultOutput, isFailedResult, type SingleResult } from "../runtime/results.ts";
import { runParallelAgentsWithModels, type ModelParallelAgentTask } from "../runtime/runner.ts";
import { modelRefLabel, type ModelRef, type ThinkingLevel } from "../shared/modelRefs.ts";
import { activityLoopCount } from "../ui/agentStatus.ts";
import type { MoaProgressWidget } from "../ui/moaProgressWidget.ts";
import type { ObserveSession } from "../ui/observeOverlay.ts";
import {
	buildDebateRetryTask,
	buildOpeningTask,
	looksLikeDebatePosition,
	parseStance,
} from "./debateContract.ts";
import type { DebateRound } from "./debateRounds.ts";
import { buildNextRoundInputs, shouldStopEarly } from "./debateRounds.ts";

export interface DebateFanoutHost {
	getActiveObserveSession(): ObserveSession | undefined;
	setActiveObserveSession(session: ObserveSession | undefined): void;
}

export interface DebateFanoutOptions {
	host: DebateFanoutHost;
	ctx: ExtensionContext;
	topic: string;
	models: ModelRef[];
	thinking: (ThinkingLevel | undefined)[];
	rounds: number;
	session: CancelSession;
	widget: MoaProgressWidget;
	agents: AgentConfig[];
	maxConcurrency: number;
}

export type DebateFanoutResult =
	| { status: "done"; rounds: DebateRound[]; stoppedEarly?: string }
	| { status: "cancelled" };

interface CumulativeUsage {
	turns: number;
	toolCalls: number;
	costUsd: number | undefined;
}

/**
 * Runs the debate's round loop: every round, each surviving debater gets a
 * fresh subprocess fed every other survivor's labeled prior position. Each
 * round's subprocess replaces the widget row, so TURNS/TOOLS/COST readings
 * accumulate across rounds per slot.
 */
export async function runDebateRounds(options: DebateFanoutOptions): Promise<DebateFanoutResult> {
	const { host, ctx, topic, models, thinking, rounds: totalRounds, session, widget, agents, maxConcurrency } = options;
	const alive = models.map(() => true);
	const positions: (string | undefined)[] = models.map(() => undefined);
	const completedRounds: DebateRound[] = [];
	const cumulative: CumulativeUsage[] = models.map(() => ({ turns: 0, toolCalls: 0, costUsd: undefined }));

	const observe: ObserveSession = {
		title: "MoA debate",
		phase: "fanout",
		agents: models.map((ref) => ({
			label: ref.id,
			model: ref.id,
			task: "",
			messages: [],
			state: "working",
		})),
		overlayOpen: false,
	};
	const previousObserveSession = host.getActiveObserveSession();
	host.setActiveObserveSession(observe);

	try {
		const runBatch = async (
			entries: { index: number; task: string }[],
			currentRun: CancelRun,
		): Promise<SingleResult[]> => {
			const unsubscribe = currentRun.onChange(() => {
				currentRun.agents.forEach((agent, batchIndex) => {
					if (agent.state === "cancelling") widget.update(entries[batchIndex].index, "cancelling");
				});
			});
			session.run = currentRun;
			try {
				const tasks: ModelParallelAgentTask[] = entries.map((entry) => {
					const ref = models[entry.index];
					return {
						agent: "moa-debater",
						task: entry.task,
						model: modelRefLabel(ref),
						thinking: thinking[entry.index],
						...modelExtensionOptions(ctx, ref),
						signal: currentRun.add(modelRefLabel(ref)).signal,
					};
				});
				return await runParallelAgentsWithModels(
					ctx.cwd,
					agents,
					tasks,
					undefined,
					(batchIndex, result) => {
						const debateIndex = entries[batchIndex].index;
						widget.updateTranscript(debateIndex, result.messages);
						const observed = observe.agents[debateIndex];
						if (observed) {
							observed.messages = result.messages;
							observed.partial = undefined;
						}
						if (result.cancelled) {
							currentRun.settle(batchIndex, "cancelled");
							widget.update(debateIndex, "cancelled");
							if (observed) observed.state = "cancelled";
						} else if (isFailedResult(result)) {
							currentRun.settle(batchIndex, "error");
							widget.update(debateIndex, "error", getResultOutput(result).slice(0, 80));
							if (observed) observed.state = "error";
						} else {
							currentRun.settle(batchIndex, "done");
							widget.update(debateIndex, "done");
							if (observed) observed.state = "done";
						}
					},
					(batchIndex, result) => {
						const debateIndex = entries[batchIndex].index;
						const base = cumulative[debateIndex];
						const roundCost = resolveModelCost(ctx, models[debateIndex], result.usage);
						widget.updateUsage(
							debateIndex,
							result.usage.contextTokens,
							base.turns + result.usage.turns,
							base.toolCalls + result.usage.toolCalls,
							base.costUsd === undefined && roundCost === undefined
								? undefined
								: (base.costUsd ?? 0) + (roundCost ?? 0),
						);
						if (result.activity) widget.updateActivity(debateIndex, result.activity);
						if (result.outputActivity) widget.updateOutput(debateIndex, result.outputActivity.tokens, result.outputActivity.revision);
						widget.updateTranscript(debateIndex, result.messages, result.partialAssistant);
						const observed = observe.agents[debateIndex];
						if (observed) {
							observed.messages = result.messages;
							observed.partial = result.partialAssistant;
						}
					},
					{ maxConcurrency },
				);
			} finally {
				unsubscribe();
				session.run = undefined;
			}
		};

		const makeGetExtras = (entries: { index: number }[]) => (batchIndex: number) => {
			const debateIndex = entries[batchIndex].index;
			const status = widget.getStatus(debateIndex);
			if (!status) return undefined;
			return {
				contextTokens: status.contextTokens,
				contextWindow: resolveContextWindow(ctx, status.ref),
				activity: status.activity,
				loopCount: activityLoopCount(status.activity, status.activityHistory),
			};
		};

		const foldUsage = (entries: { index: number }[], results: SingleResult[]): void => {
			for (let batchIndex = 0; batchIndex < results.length; batchIndex++) {
				const debateIndex = entries[batchIndex].index;
				const base = cumulative[debateIndex];
				const usage = results[batchIndex].usage;
				const cost = resolveModelCost(ctx, models[debateIndex], usage);
				cumulative[debateIndex] = {
					turns: base.turns + usage.turns,
					toolCalls: base.toolCalls + usage.toolCalls,
					costUsd: base.costUsd === undefined && cost === undefined ? undefined : (base.costUsd ?? 0) + (cost ?? 0),
				};
			}
		};

		widget.startFanout(models, thinking);

		let stoppedEarly: string | undefined;
		for (let round = 1; round <= totalRounds; round++) {
			const entries: { index: number; task: string }[] = round === 1
				? models.map((_, index) => ({
					index,
					task: buildOpeningTask(topic, index, models.length),
				}))
				: buildNextRoundInputs(topic, completedRounds[completedRounds.length - 1], round, totalRounds);

			if (round > 1) {
				for (const entry of entries) {
					// Re-activates the settled row and resets its transcript.
					widget.update(entry.index, "working", `round ${round}/${totalRounds} · responding`);
					const observed = observe.agents[entry.index];
					if (observed) {
						observed.state = "working";
						observed.task = entry.task;
					}
				}
			} else {
				for (const entry of entries) observe.agents[entry.index].task = entry.task;
			}

			const run = new CancelRun();
			session.title = `Debate agents — round ${round}/${totalRounds}`;
			session.getExtras = makeGetExtras(entries);
			let results = await runBatch(entries, run);
			if (run.cancelAllRequested) return { status: "cancelled" };

			// One-shot retry for survivors whose output lacks the position/stance contract.
			const retryEntries: { index: number; task: string }[] = [];
			const retriedEntries: { index: number }[] = [];
			const retriedResults: SingleResult[] = [];
			for (let batchIndex = 0; batchIndex < results.length; batchIndex++) {
				const result = results[batchIndex];
				if (result.cancelled || isFailedResult(result)) continue;
				if (looksLikeDebatePosition(getFinalOutput(result.messages))) continue;
				const entry = entries[batchIndex];
				retryEntries.push({
					index: entry.index,
					task: buildDebateRetryTask(entry.task, getFinalOutput(result.messages)),
				});
				retriedEntries.push(entry);
				retriedResults.push(result);
			}
			if (retryEntries.length > 0) {
				// The first attempt genuinely spent tokens; fold it in before the retry overwrites it.
				foldUsage(retriedEntries, retriedResults);
				const retryRun = new CancelRun();
				session.title = `Debate agents — round ${round}/${totalRounds} (retry)`;
				session.getExtras = makeGetExtras(retryEntries);
				for (const entry of retryEntries) {
					widget.update(entry.index, "working", "retrying: no position produced");
					const observed = observe.agents[entry.index];
					if (observed) {
						observed.state = "working";
						observed.task = entry.task;
					}
				}
				const retryResults = await runBatch(retryEntries, retryRun);
				for (let batchIndex = 0; batchIndex < retryResults.length; batchIndex++) {
					const slot = entries.findIndex((entry) => entry.index === retryEntries[batchIndex].index);
					results[slot] = retryResults[batchIndex];
				}
				if (retryRun.cancelAllRequested) return { status: "cancelled" };
			}

			foldUsage(entries, results);

			const outcomes = entries
				.map((entry, batchIndex) => ({ entry, result: results[batchIndex] }))
				.sort((a, b) => a.entry.index - b.entry.index)
				.map(({ entry, result }) => {
					if (result.cancelled) {
						alive[entry.index] = false;
						return { index: entry.index, status: "cancelled" as const, text: getResultOutput(result) };
					}
					if (isFailedResult(result)) {
						alive[entry.index] = false;
						return { index: entry.index, status: "error" as const, text: getResultOutput(result) };
					}
					const text = getFinalOutput(result.messages).trim() || "(no output)";
					positions[entry.index] = text;
					return { index: entry.index, status: "done" as const, text, stance: parseStance(text) };
				});

			const roundRecord: DebateRound = { round, outcomes };
			completedRounds.push(roundRecord);

			const stop = shouldStopEarly(roundRecord);
			if (stop.stop) {
				stoppedEarly = stop.reason;
				break;
			}
		}

		return { status: "done", rounds: completedRounds, stoppedEarly };
	} finally {
		observe.closeOverlay?.();
		host.setActiveObserveSession(previousObserveSession);
	}
}
