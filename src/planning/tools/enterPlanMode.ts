import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { installShippedAgents } from "../../agents/authoritative.ts";
import { loadMoaConfig, saveMoaConfig } from "../../config/settings.ts";
import { runMoaOrchestration } from "../../moa/orchestration.ts";
import type { MfPlanInfo } from "../../moa/planInfo.ts";
import type { MoaRunHost } from "../../moa/runContext.ts";
import type { CancelSession } from "../../runtime/cancelRun.ts";
import { modelRefLabel, TRIGGER_TURN, type ModelRef, type ThinkingLevel } from "../../shared/modelRefs.ts";
import { showMoaModelPicker, showImplementingModelPicker } from "../../ui/moaModelPicker.ts";
import { showMoaSetup } from "../../ui/moaSetupOverlay.ts";
import { showPromptEditor } from "../../ui/promptEditor.ts";
import { getPlan, getPlanFilePath } from "../planFile.ts";
import { isAskUserQuestionInstalled } from "../askUserQuestion.ts";
import { buildPlanModeInstructions, buildPlanModeReentryInstructions } from "../instructions.ts";
import { ENTER_PLAN_MODE_OUTPUT_SCHEMA } from "./structuredResults.ts";

export interface InteractivePlanModeHost {
	beginInteractive(ctx: ExtensionContext): void;
	abortPlanMode(ctx: ExtensionContext): void;
	currentThinkingLevel(): ThinkingLevel;
	getLastReentryState(): boolean;
	getActiveObserveSession(): { overlayOpen: boolean } | undefined;
	openCancelOverlayIfActive(ctx: ExtensionContext): boolean;
	setActiveCancelSession(session: CancelSession | undefined): void;
	saveSubmittedPlanPrompt(ctx: ExtensionContext, prompt: string): Promise<void>;
	clearActiveRunMoaInfo(): void;
	setActiveRunMoaInfo(info: MfPlanInfo | undefined): void;
	applyImplementingSelection(ctx: ExtensionContext, selection: { ref: ModelRef; thinking: ThinkingLevel }, notice: string): Promise<void>;
	moaRunHost: MoaRunHost;
}

export async function runInteractivePlanMode(
	pi: ExtensionAPI,
	host: InteractivePlanModeHost,
	ctx: ExtensionContext,
	initialPrompt?: string,
): Promise<void> {
	host.beginInteractive(ctx);
	if (!ctx.hasUI) {
		ctx.ui.notify("Plan mode enabled. Read-only exploration with parallel subagents.");
		return;
	}
	if (!loadMoaConfig().agentDefaultsConfigured) {
		installShippedAgents();
		if (!await showMoaSetup(ctx, host.currentThinkingLevel(), { firstRun: true })) {
			host.abortPlanMode(ctx);
			ctx.ui.notify("Setup cancelled — plan mode not started. Run /mf-plan-settings to configure agents and rosters.", "warning");
			return;
		}
	}

	// While the plan-prompt flow is live, ESC opens the cancel overlay —
	// but only while subagent processes are actually in flight
	// (session.run is set during MoA fan-out/synthesis).
	// Whenever nothing is running the listener passes ESC through, so the
	// editor, the model pickers and the review overlay keep their normal
	// ESC behavior.
	const session: CancelSession = { title: "Plan agents", run: undefined, overlayOpen: false };
	host.setActiveCancelSession(session);
	const unsubscribeEsc = ctx.mode === "tui"
		? ctx.ui.onTerminalInput((data) => {
			// Terminal input listeners run ahead of pi's key-release filter, so under
			// the Kitty keyboard protocol the ESC *release* arrives here a tick after
			// the press closed an overlay and cleared `overlayOpen` — reopening it
			// instantly. Only a key press may open the overlay.
			if (isKeyRelease(data) || !matchesKey(data, Key.escape)) return undefined;
			if (host.getActiveObserveSession()?.overlayOpen) return undefined;
			if (session.overlayOpen) return undefined;
			if (!session.run) return undefined;
			return host.openCancelOverlayIfActive(ctx) ? { consume: true } : undefined;
		})
		: undefined;
	try {
		let prefill = host.getLastReentryState() ? getPlan() ?? "" : "";
		let skipEditorOnce = Boolean(initialPrompt?.trim());
		while (true) {
			let prompt: string | undefined;
			if (skipEditorOnce) {
				prompt = initialPrompt!.trim();
				skipEditorOnce = false;
				initialPrompt = undefined;
			} else prompt = await showPromptEditor(ctx, "Plan Mode — describe what you want to plan", prefill);
			if (!prompt || !prompt.trim()) {
				host.abortPlanMode(ctx);
				ctx.ui.notify("Plan mode cancelled.");
				return;
			}
			const trimmedPrompt = prompt.trim();
			prefill = trimmedPrompt;
			await host.saveSubmittedPlanPrompt(ctx, trimmedPrompt);
			const pickerResult = await showMoaModelPicker(ctx, host.currentThinkingLevel());
			if (!pickerResult || pickerResult.mode === "single") {
				host.clearActiveRunMoaInfo();
				if (pickerResult) {
					const selection = await showImplementingModelPicker(ctx, host.currentThinkingLevel(), "Single model — choose the model and thinking level");
					if (selection) await host.applyImplementingSelection(ctx, selection, `Using ${modelRefLabel(selection.ref)} for this plan.`);
				}
				ctx.ui.notify("Plan mode enabled. Processing your prompt...");
				pi.sendUserMessage(trimmedPrompt, TRIGGER_TURN);
				return;
			}
			const settings = loadMoaConfig();
			const { proposers, synthesizer, implementer, verifier, proposerThinking, synthesizerThinking, implementerThinking, verifierThinking, thinkingSelections } = pickerResult;
			saveMoaConfig({ ...settings, mode: "moa", proposers, synthesizer, implementer, verifier, thinkingOverrides: { ...settings.thinkingOverrides, ...thinkingSelections } });
			host.setActiveRunMoaInfo({ proposers, synthesizer });
			const outcome = await runMoaOrchestration(host.moaRunHost, ctx, trimmedPrompt, proposers, synthesizer, proposerThinking, synthesizerThinking, session, { implementer, implementerThinking, verifier, verifierThinking });
			if (outcome === "cancelled") { session.closeOverlay?.(); continue; }
			return;
		}
	} finally {
		unsubscribeEsc?.();
		host.setActiveCancelSession(undefined);
	}
}

export interface EnterPlanModeHost {
	isEnabled(): boolean;
	enterFromTool(ctx: ExtensionContext, prompt: string | undefined): Promise<boolean>;
}

export function registerEnterPlanModeTool(pi: ExtensionAPI, host: EnterPlanModeHost): void {
	pi.registerTool({
		name: "enter_plan_mode",
		label: "Enter Plan Mode",
		description: [
			"Enter plan mode to design an implementation before writing code.",
			"Switches the session to read-only tools and runs the single-model planning workflow on the current session model.",
			"Write the plan with write_plan, then call exit_plan_mode for user approval.",
			"Use when the user asks for a plan, design, or implementation approach.",
			"Mixture-of-Agents planning is not available through this tool — the user starts that with /mf-plan.",
		].join(" "),
		parameters: Type.Object({
			plan_prompt: Type.Optional(
				Type.String({ description: "Short description of what is being planned (used to name the plan file)" }),
			),
		}),
		outputSchema: ENTER_PLAN_MODE_OUTPUT_SCHEMA,
		// Swaps the active tools and provider env, persists state, and with a
		// plan_prompt writes the prompt record under .pi/mf-plan/. Not read-only;
		// destructive is left at the default because that write can overwrite.
		annotations: { readOnlyHint: false },
		// enter_plan_mode is paired with a same-message ask_user_question only in
		// the single-model path; marking it sequential means the questionnaire
		// resolves first, so mf-plan's own overlays never draw over it.
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (host.isEnabled()) {
				return {
					details: undefined,
					content: [{ type: "text", text: "Already in plan mode. Continue planning and call exit_plan_mode when your plan is ready." }],
					isError: true,
				};
			}

			const reentry = await host.enterFromTool(ctx, params.plan_prompt?.trim());
			ctx.ui.notify("Plan mode enabled by the agent (single model). Read-only until the plan is approved.");
			const instructions = reentry ? buildPlanModeReentryInstructions() : buildPlanModeInstructions(isAskUserQuestionInstalled(pi));
			return {
				details: undefined,
				content: [{
					type: "text",
					text: `Plan mode enabled (single model — the current session model). Mutating tools are disabled until your plan is approved via exit_plan_mode.\n\n${instructions}`,
				}],
				structuredContent: { status: "entered", mode: "single", reentry, planFilePath: getPlanFilePath() },
			};
		},
	});
}
