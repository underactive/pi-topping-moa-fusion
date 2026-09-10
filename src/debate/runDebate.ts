import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { installShippedAgents, shippedAgentsDir, withAuthoritativeMoaAgents } from "../agents/authoritative.ts";
import { discoverAgents } from "../agents/discovery.ts";
import { summarizePlanPromptName } from "../config/planName.ts";
import { loadMoaConfig, saveMoaConfig } from "../config/settings.ts";
import type { OpinionHost } from "../opinion/runOpinion.ts";
import { resolveContextWindow } from "../moa/modelRuntime.ts";
import { type CancelSession, subscribeCancelOverlayOnEsc } from "../runtime/cancelRun.ts";
import { formatMutationWarning, MutationTripwire } from "../runtime/mutationTripwire.ts";
import { type SendUserMessageOptions, type ThinkingLevel } from "../shared/modelRefs.ts";
import { MoaProgressWidget } from "../ui/moaProgressWidget.ts";
import type { ObserveSession } from "../ui/observeOverlay.ts";
import { showDebateModelPicker } from "../ui/debateModelPicker.ts";
import { showPromptEditor } from "../ui/promptEditor.ts";
import { repoDebateDisplayPath, saveRepoDebateFile } from "./debateFile.ts";
import { runDebateRounds } from "./debateFanout.ts";
import { collectDebateOutcomes, formatDebateMarkdown } from "./debateResults.ts";

/** Same host surface as the opinion flow — all three MoA flows share the controller. */
export type DebateHost = OpinionHost;

export async function runInteractiveDebate(
	pi: ExtensionAPI,
	host: DebateHost,
	ctx: ExtensionContext,
	initialPrompt?: string,
): Promise<void> {
	if (host.getActiveCancelSession()?.run) {
		ctx.ui.notify("A plan, opinion, or debate run is already in progress.", "warning");
		return;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify("/mf-debate requires an interactive session.", "warning");
		return;
	}

	installShippedAgents();
	const session: CancelSession = { title: "Debate agents", run: undefined, overlayOpen: false };
	host.setActiveCancelSession(session);
	const unsubscribeEsc = subscribeCancelOverlayOnEsc(ctx, host, session);

	try {
		let prefill = initialPrompt?.trim() ?? "";
		let skipEditorOnce = Boolean(prefill);
		while (true) {
			let topic: string | undefined;
			if (skipEditorOnce) {
				topic = prefill;
				skipEditorOnce = false;
			} else {
				topic = await showPromptEditor(ctx, "Debate — pick a topic to argue about this repo", prefill);
			}
			if (!topic?.trim()) {
				ctx.ui.notify("Debate cancelled.");
				return;
			}
			topic = topic.trim();
			prefill = topic;

			const selection = await showDebateModelPicker(ctx, host.currentThinkingLevel());
			if (!selection) return;
			const { models, thinking, thinkingSelections, rounds } = selection;
			const settings = loadMoaConfig();
			saveMoaConfig({
				...settings,
				debateModels: models,
				debateRounds: rounds,
				thinkingOverrides: { ...settings.thinkingOverrides, ...thinkingSelections },
			});

			const slug = await summarizePlanPromptName(ctx, topic);
			try {
				saveRepoDebateFile(topic, ctx.cwd, slug, "debate-prompt");
			} catch {
				ctx.ui.notify("Could not save the debate prompt artifact.", "warning");
			}

			const closeStacked = () => {
				session.closeOverlay?.();
				host.getActiveObserveSession()?.closeOverlay?.();
			};
			const widget = new MoaProgressWidget(
				ctx,
				(ref) => resolveContextWindow(ctx, ref),
				{
					closeStacked,
					title: "MoA Debate",
					phaseLabels: { Plan: "Debate" },
					fanoutWorkingText: "round 1 · forming positions",
				},
				slug,
			);
			widget.setPhaseModels({ Plan: models });
			const agents = withAuthoritativeMoaAgents(
				discoverAgents(ctx.cwd, "user").agents,
				shippedAgentsDir(),
			);
			const tripwire = new MutationTripwire();
			await tripwire.arm(ctx.cwd);
			host.setRunningProgressWidget(widget);
			let outcome;
			try {
				outcome = await runDebateRounds({ host, ctx, topic, models, thinking, rounds, session, widget, agents });
			} finally {
				host.setRunningProgressWidget(undefined);
				widget.stopWidget();
				const changed = await tripwire.check(ctx.cwd);
				if (changed.length > 0) {
					ctx.ui.notify(formatMutationWarning("MoA debate rounds", changed), "warning");
				}
			}

			if (outcome.status === "cancelled") {
				session.closeOverlay?.();
				ctx.ui.notify("Debate run cancelled.");
				continue;
			}

			const outcomes = collectDebateOutcomes(models, thinking, outcome.rounds);
			const markdown = formatDebateMarkdown(topic, outcomes, outcome.rounds, slug, outcome.stoppedEarly, rounds);
			const displayPath = repoDebateDisplayPath(slug, "debate");
			let saved = true;
			try {
				saveRepoDebateFile(markdown, ctx.cwd, slug, "debate");
			} catch {
				saved = false;
			}
			const appendOnly: SendUserMessageOptions = { triggerTurn: false };
			await pi.sendUserMessage(markdown, appendOnly);
			const active = outcomes.filter((item) => item.finalStatus === "active-at-close").length;
			const suffix = saved ? ` · saved to ${displayPath}` : " · artifact save failed";
			ctx.ui.notify(
				`${outcome.rounds.length} round${outcome.rounds.length === 1 ? "" : "s"} · ${active} of ${outcomes.length} debaters completed${suffix}`,
				active === 0 ? "error" : saved ? "info" : "warning",
			);
			return;
		}
	} finally {
		unsubscribeEsc?.();
		host.setActiveCancelSession(undefined);
	}
}
