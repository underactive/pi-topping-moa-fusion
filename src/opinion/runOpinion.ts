import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { installShippedAgents, shippedAgentsDir, withAuthoritativeMoaAgents } from "../agents/authoritative.ts";
import { discoverAgents } from "../agents/discovery.ts";
import { summarizePlanPromptName } from "../config/planName.ts";
import { slugifyPlanName } from "../planning/planFile.ts";
import { loadMoaConfig, saveMoaConfig } from "../config/settings.ts";
import { resolveContextWindow } from "../moa/modelRuntime.ts";
import { type CancelSession, subscribeCancelOverlayOnEsc } from "../runtime/cancelRun.ts";
import { formatMutationWarning, MutationTripwire } from "../runtime/mutationTripwire.ts";
import { type SendUserMessageOptions, type ThinkingLevel } from "../shared/modelRefs.ts";
import { MoaProgressWidget } from "../ui/moaProgressWidget.ts";
import type { ObserveSession } from "../ui/observeOverlay.ts";
import { showOpinionModelPicker } from "../ui/opinionModelPicker.ts";
import { showPromptEditor } from "../ui/promptEditor.ts";
import { planNamingOverlay, withWorkingOverlay } from "../ui/workingOverlay.ts";
import { runOpinionFanout } from "./opinionFanout.ts";
import { repoOpinionDisplayPath, saveRepoOpinionFile } from "./opinionFile.ts";
import { collectOpinionOutcomes, formatOpinionsMarkdown } from "./opinionResults.ts";

export interface OpinionHost {
	currentThinkingLevel(): ThinkingLevel;
	getActiveCancelSession(): CancelSession | undefined;
	setActiveCancelSession(session: CancelSession | undefined): void;
	openCancelOverlayIfActive(ctx: ExtensionContext): boolean;
	getActiveObserveSession(): ObserveSession | undefined;
	setActiveObserveSession(session: ObserveSession | undefined): void;
	setRunningProgressWidget(widget: MoaProgressWidget | undefined): void;
}

export async function runInteractiveOpinion(
	pi: ExtensionAPI,
	host: OpinionHost,
	ctx: ExtensionContext,
	initialPrompt?: string,
): Promise<void> {
	if (host.getActiveCancelSession()?.run) {
		ctx.ui.notify("A plan or opinion run is already in progress.", "warning");
		return;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify("/mf-opinion requires an interactive session.", "warning");
		return;
	}

	installShippedAgents();
	const session: CancelSession = { title: "Opinion agents", run: undefined, overlayOpen: false };
	host.setActiveCancelSession(session);
	const unsubscribeEsc = subscribeCancelOverlayOnEsc(ctx, host, session);

	try {
		let prefill = initialPrompt?.trim() ?? "";
		let skipEditorOnce = Boolean(prefill);
		while (true) {
			let question: string | undefined;
			if (skipEditorOnce) {
				question = prefill;
				skipEditorOnce = false;
			} else {
				question = await showPromptEditor(ctx, "Opinion — ask a question about this repo", prefill);
			}
			if (!question?.trim()) {
				ctx.ui.notify("Opinion cancelled.");
				return;
			}
			question = question.trim();
			prefill = question;

			const selection = await showOpinionModelPicker(ctx, host.currentThinkingLevel());
			if (!selection) return;
			const { models, thinking, thinkingSelections } = selection;
			const settings = loadMoaConfig();
			saveMoaConfig({
				...settings,
				opinionModels: models,
				thinkingOverrides: { ...settings.thinkingOverrides, ...thinkingSelections },
			});

			const slug = await withWorkingOverlay(
				ctx,
				planNamingOverlay("opinion", () => slugifyPlanName(question)),
				(signal) => summarizePlanPromptName(ctx, question, { signal }),
			);
			try {
				saveRepoOpinionFile(question, ctx.cwd, slug, "opinion-prompt");
			} catch {
				ctx.ui.notify("Could not save the opinion prompt artifact.", "warning");
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
					title: "MoA Opinion",
					phaseLabels: { Plan: "Opinion" },
					fanoutWorkingText: "analyzing & answering",
				},
				slug,
			);
			const agents = withAuthoritativeMoaAgents(
				discoverAgents(ctx.cwd, "user").agents,
				shippedAgentsDir(),
			);
			const tripwire = new MutationTripwire();
			await tripwire.arm(ctx.cwd);
			host.setRunningProgressWidget(widget);
			let outcome;
			try {
				outcome = await runOpinionFanout({ host, ctx, question, models, thinking, session, widget, agents, maxConcurrency: settings.maxConcurrentAgents });
			} finally {
				host.setRunningProgressWidget(undefined);
				widget.stopWidget();
				const changed = await tripwire.check(ctx.cwd);
				if (changed.length > 0) {
					ctx.ui.notify(formatMutationWarning("MoA opinion fan-out", changed), "warning");
				}
			}

			if (outcome.status === "cancelled") {
				session.closeOverlay?.();
				ctx.ui.notify("Opinion run cancelled.");
				continue;
			}

			const outcomes = collectOpinionOutcomes(models, thinking, outcome.results);
			const markdown = formatOpinionsMarkdown(question, outcomes, slug);
			const displayPath = repoOpinionDisplayPath(slug, "opinions");
			let saved = true;
			try {
				saveRepoOpinionFile(markdown, ctx.cwd, slug, "opinions");
			} catch {
				saved = false;
			}
			// `sendUserMessage` routes to prompt() and ignores triggerTurn (only
			// sendCustomMessage honors it), so this report does start a model turn.
			// Genuinely append-only delivery needs pi.sendMessage({ customType, … },
			// { triggerTurn: false }) plus a message renderer — a UX change, not made here.
			const appendOnly: SendUserMessageOptions = { triggerTurn: false };
			await pi.sendUserMessage(markdown, appendOnly);
			const completed = outcomes.filter((item) => item.status === "done").length;
			const suffix = saved ? ` · saved to ${displayPath}` : " · artifact save failed";
			ctx.ui.notify(
				`${completed} of ${outcomes.length} opinions ready${suffix}`,
				completed === 0 ? "error" : saved ? "info" : "warning",
			);
			return;
		}
	} finally {
		unsubscribeEsc?.();
		host.setActiveCancelSession(undefined);
	}
}
