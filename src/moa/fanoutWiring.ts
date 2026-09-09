import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AgentConfig } from "../agents/discovery.ts";
import type { CancelRun, CancelSession } from "../runtime/cancelRun.ts";
import { getResultOutput, isFailedResult, type SingleResult } from "../runtime/results.ts";
import { runParallelAgentsWithModels, type ModelParallelAgentTask } from "../runtime/runner.ts";
import type { ModelRef } from "../shared/modelRefs.ts";
import type { MoaProgressWidget } from "../ui/moaProgressWidget.ts";
import type { ObserveSession } from "../ui/observeOverlay.ts";
import { resolveModelCost } from "./modelRuntime.ts";

export interface WidgetFanoutOptions {
	ctx: ExtensionContext;
	agents: AgentConfig[];
	tasks: ModelParallelAgentTask[];
	run: CancelRun;
	session: CancelSession;
	widget: MoaProgressWidget;
	observe: ObserveSession;
	models: ModelRef[];
	indexMap: (index: number) => number;
}

/**
 * Runs a batch through runParallelAgentsWithModels wired to settle the
 * CancelRun and mirror progress into the widget and observe session — the
 * settle/onProgress plumbing shared by every MoA fan-out variant.
 */
export async function runWidgetFanout(options: WidgetFanoutOptions): Promise<SingleResult[]> {
	const { ctx, agents, tasks, run, session, widget, observe, models, indexMap } = options;
	const unsubscribe = run.onChange(() => {
		run.agents.forEach((agent, index) => {
			if (agent.state === "cancelling") widget.update(indexMap(index), "cancelling");
		});
	});
	session.run = run;
	try {
		return await runParallelAgentsWithModels(
			ctx.cwd,
			agents,
			tasks,
			undefined,
			(index, result) => {
				const widgetIndex = indexMap(index);
				widget.updateTranscript(widgetIndex, result.messages);
				const observed = observe.agents[widgetIndex];
				if (observed) {
					observed.messages = result.messages;
					observed.partial = undefined;
				}
				if (result.cancelled) {
					run.settle(index, "cancelled");
					widget.update(widgetIndex, "cancelled");
					if (observed) observed.state = "cancelled";
				} else if (isFailedResult(result)) {
					run.settle(index, "error");
					widget.update(widgetIndex, "error", getResultOutput(result).slice(0, 80));
					if (observed) observed.state = "error";
				} else {
					run.settle(index, "done");
					widget.update(widgetIndex, "done");
					if (observed) observed.state = "done";
				}
			},
			(index, result) => {
				const widgetIndex = indexMap(index);
				widget.updateUsage(
					widgetIndex,
					result.usage.contextTokens,
					result.usage.turns,
					result.usage.toolCalls,
					resolveModelCost(ctx, models[widgetIndex], result.usage),
				);
				if (result.activity) widget.updateActivity(widgetIndex, result.activity);
				if (result.outputActivity) widget.updateOutput(widgetIndex, result.outputActivity.tokens, result.outputActivity.revision);
				widget.updateTranscript(widgetIndex, result.messages, result.partialAssistant);
				const observed = observe.agents[widgetIndex];
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
}
