import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, TextContent } from "@earendil-works/pi-ai";
import type {
	AgentSettledEvent,
	ExtensionAPI,
	ExtensionContext,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	ToolExecutionStartEvent,
} from "@earendil-works/pi-coding-agent";

import { installShippedAgents } from "../agents/authoritative.ts";
import { summarizePlanPromptName } from "../config/planName.ts";
import { loadMoaConfig } from "../config/settings.ts";
import {
	type ImplementationHandoff,
	implementationTurnFailed,
	runImplementationRetryFlow,
	validateImplementationHandoff,
} from "../moa/implementationRetry.ts";
import { runImplementationVerification } from "../moa/verification.ts";
import { applyImplementingSelection, resolveContextWindow, resolveModelCost } from "../moa/modelRuntime.ts";
import { validateMfPlanInfo, type MfPlanInfo } from "../moa/planInfo.ts";
import type { MoaRunHost } from "../moa/runContext.ts";
import { formatToolActivity, OutputActivityTracker, PartialAssistantAssembler } from "../runtime/activityTracking.ts";
import type { CancelSession } from "../runtime/cancelRun.ts";
import { cleanupTrackedProcesses } from "../runtime/processPool.ts";
import type { UsageStats } from "../runtime/results.ts";
import { READ_ONLY_SUBAGENT_ENV } from "../runtime/runner.ts";
import type { ModelRef, ThinkingLevel } from "../shared/modelRefs.ts";
import { showCancelOverlay } from "../ui/cancelOverlay.ts";
import { MoaProgressWidget } from "../ui/moaProgressWidget.ts";
import { showObserveOverlay, type ObserveSession } from "../ui/observeOverlay.ts";
import { ASK_USER_QUESTION_TOOL_NAME, createAskUserQuestionTracker, isAskUserQuestionInstalled } from "./askUserQuestion.ts";
import { buildPlanModeExitInstructions, buildPlanModeInstructions, buildPlanModeReentryInstructions } from "./instructions.ts";
import { latestPlanModeStateEntry, PlanModeStatePersistence } from "./modeState.ts";
import { getPlan, getPlanSlug, isValidPlanSlug, resetPlanSlug, saveRepoPlanFile, setPlanSlug } from "./planFile.ts";
import { PLAN_EXIT_CONTEXT_TYPE, PLAN_MODE_CONTEXT_TYPE, PLAN_MODE_CUSTOM_TOOLS, PLAN_MODE_READ_ONLY_TOOLS, PLAN_ONLY_REGISTERED_TOOLS } from "./tools/shared.ts";

/** Trailing chars of the implementer report kept for the verifier's evidence. */
const IMPLEMENTATION_REPORT_MAX_CHARS = 8000;
const IMPLEMENTATION_TRANSCRIPT_MESSAGE_LIMIT = 40;

/** Clamp unknown usage fields to non-negative numbers, mirroring the wire-runner accounting. */
function nonnegative(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** The subset of an in-process assistant message's usage the telemetry accumulator reads. */
interface AssistantUsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cacheWrite1h?: number;
	totalTokens?: number;
	cost?: { total?: number };
}

/** Flatten an assistant message's content (string or text parts) to plain text. */
function extractAssistantText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((part): part is { type?: string; text?: string } => !!part && typeof part === "object")
			.filter((part) => part.type === "text" && typeof part.text === "string")
			.map((part) => part.text as string)
			.join("\n");
	}
	return "";
}

export function createPlanModeController(pi: ExtensionAPI) {
	let planModeEnabled = false;
	let toolsBeforePlanMode: string[] | undefined;
	let needsExitReminder = false;
	let planSlug: string | undefined;
	let planRepoSlug: string | undefined;
	let lastReentryState = false;
	let activeCancelSession: CancelSession | undefined;
	let activeObserveSession: ObserveSession | undefined;
	let activeRunMoaInfo: MfPlanInfo | undefined;
	let implementationHandoff: ImplementationHandoff | undefined;
	let implementationPending = false;
	let lastImplementationStopReason: string | undefined;
	// The implementer's final assistant text, captured while pending so the
	// verifier can be handed the implementer's own (untrusted) report. Capped to
	// the trailing slice so a very long turn never bloats state.
	let lastImplementationReport: string | undefined;
	// The one MoA progress table, adopted from orchestration on approval and kept
	// alive across in-session implementation and verification.
	let activeProgressWidget: MoaProgressWidget | undefined;
	// In-session implementer telemetry, reset each time implementation starts.
	let implementationOutputTracker: OutputActivityTracker | undefined;
	let implementationMessages: Message[] = [];
	const implementationPartial = new PartialAssistantAssembler();
	let implementationUsage: UsageStats | undefined;
	let implementationContextTokens: number | undefined;
	let implementationTurns = 0;
	let implementationToolCalls = 0;
	let providerEnvBeforePlanMode: Record<string, string | undefined> | undefined;
	const persistence = new PlanModeStatePersistence(pi);
	// Tracks whether rpiv's ask_user_question (or whichever extension registers
	// that tool) is currently blocking the user. Owned by this controller rather
	// than a module singleton so the fake-`pi` tests stay self-contained and no
	// state leaks across sessions.
	const askUserQuestionTracker = createAskUserQuestionTracker(pi);
	// Subscribe immediately so the blocked flag is live from extension load, not
	// only after the first session_start (which the test harnesses never fire).
	// onSessionStart still resets + re-subscribes for the reload/stuck-flag case.
	askUserQuestionTracker.ensureSubscribed();

	const resetImplementationTranscript = (): void => {
		implementationMessages = [];
		implementationPartial.clear();
	};
	const currentThinkingLevel = (): ThinkingLevel => pi.getThinkingLevel();
	const stopActiveProgressWidget = (): void => {
		activeProgressWidget?.stopWidget();
		activeProgressWidget = undefined;
	};
	const persistState = (): void => persistence.persist({
		enabled: planModeEnabled,
		slug: planSlug ?? getPlanSlug(),
		repoPlanSlug: planRepoSlug,
		needsExitReminder,
		moaInfo: activeRunMoaInfo,
		implementationHandoff,
	});
	const updateStatus = (ctx: ExtensionContext): void => {
		ctx.ui.setStatus("mf-plan", planModeEnabled ? ctx.ui.theme.fg("warning", "📋 plan") : undefined);
	};
	const getPlanModeTools = (activeToolNames: string[]): string[] => {
		const filtered = activeToolNames.filter((name) => PLAN_MODE_READ_ONLY_TOOLS.has(name));
		const customTools = PLAN_MODE_CUSTOM_TOOLS.filter((name) => name !== ASK_USER_QUESTION_TOOL_NAME || isAskUserQuestionInstalled(pi));
		return [...new Set([...filtered, ...customTools])];
	};
	const applyReadOnlyProviderEnv = (): void => {
		if (providerEnvBeforePlanMode === undefined) {
			providerEnvBeforePlanMode = {};
			for (const key of Object.keys(READ_ONLY_SUBAGENT_ENV)) providerEnvBeforePlanMode[key] = process.env[key];
		}
		Object.assign(process.env, READ_ONLY_SUBAGENT_ENV);
	};
	const restoreReadOnlyProviderEnv = (): void => {
		if (providerEnvBeforePlanMode === undefined) return;
		for (const [key, value] of Object.entries(providerEnvBeforePlanMode)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		providerEnvBeforePlanMode = undefined;
	};
	const enablePlanModeTools = (): void => {
		if (toolsBeforePlanMode === undefined) toolsBeforePlanMode = pi.getActiveTools();
		applyReadOnlyProviderEnv();
		pi.setActiveTools(getPlanModeTools(toolsBeforePlanMode));
	};
	const restoreNormalModeTools = (): void => {
		const restored = toolsBeforePlanMode ?? pi.getActiveTools();
		restoreReadOnlyProviderEnv();
		pi.setActiveTools(restored.filter((name) => !PLAN_ONLY_REGISTERED_TOOLS.includes(name)));
		toolsBeforePlanMode = undefined;
	};
	const questionnaireBusy = (ctx: ExtensionContext): boolean => {
		if (!askUserQuestionTracker.isActive()) return false;
		ctx.ui.notify("Answer or dismiss the ask_user_question questionnaire first.", "warning");
		return true;
	};
	const openCancelOverlayIfActive = (ctx: ExtensionContext): boolean => {
		const session = activeCancelSession;
		if (!session || session.overlayOpen || !session.run || ctx.mode !== "tui") return false;
		// Silent: a live questionnaire owns the keyboard (Esc/F4 pass through to
		// it), so mf-plan must not open a competing overlay. Returns false so the
		// raw key listeners treat the key as unconsumed.
		if (askUserQuestionTracker.isActive()) return false;
		session.overlayOpen = true;
		void showCancelOverlay(ctx, session).finally(() => { session.overlayOpen = false; });
		return true;
	};
	const openObserveOverlayIfActive = (ctx: ExtensionContext): boolean => {
		const session = activeObserveSession;
		if (!session || session.overlayOpen || ctx.mode !== "tui") return false;
		// Silent, as above: a live questionnaire owns the keyboard.
		if (askUserQuestionTracker.isActive()) return false;
		session.overlayOpen = true;
		void showObserveOverlay(ctx, session).finally(() => { session.overlayOpen = false; });
		return true;
	};
	const abortPlanMode = (ctx: ExtensionContext): void => {
		planModeEnabled = false;
		restoreNormalModeTools();
		updateStatus(ctx);
		persistState();
	};
	const exitPlanMode = (ctx: ExtensionContext): void => {
		planModeEnabled = false;
		needsExitReminder = true;
		restoreNormalModeTools();
		ctx.ui.notify("Plan mode disabled. Full access restored.");
		updateStatus(ctx);
		persistState();
	};
	const activatePlanMode = (ctx: ExtensionContext, clearRunInfo: boolean): void => {
		planModeEnabled = true;
		needsExitReminder = false;
		planSlug = getPlanSlug();
		lastReentryState = getPlan() !== null;
		if (clearRunInfo) activeRunMoaInfo = undefined;
		implementationPending = false;
		lastImplementationStopReason = undefined;
		lastImplementationReport = undefined;
		implementationOutputTracker = undefined;
		resetImplementationTranscript();
		implementationUsage = undefined;
		implementationContextTokens = undefined;
		implementationTurns = 0;
		implementationToolCalls = 0;
		stopActiveProgressWidget();
		enablePlanModeTools();
		updateStatus(ctx);
		persistState();
	};
	const clearCompletedPlan = async (ctx: ExtensionContext): Promise<void> => {
		if (questionnaireBusy(ctx)) return;
		const session = activeCancelSession;
		if (session?.run) {
			ctx.ui.notify("An MoA run is in progress — cancel it before clearing plan state.", "warning");
			return;
		}
		if (session) {
			ctx.ui.notify("Close the open plan prompt or picker before clearing plan state.", "warning");
			return;
		}
		if (!planModeEnabled && getPlan() === null) {
			ctx.ui.notify("No active or completed plan to clear.");
			return;
		}
		if (ctx.hasUI) {
			const confirmed = await ctx.ui.confirm(
				"Clear completed plan?",
				"The next /mf-plan starts a fresh planning round with a new plan file. The approved plan stays saved in .pi/mf-plan/ and can still be re-implemented with /mf-plan-implement.",
			);
			if (!confirmed) return;
		}
		if (planModeEnabled) exitPlanMode(ctx);
		resetPlanSlug();
		planSlug = undefined;
		planRepoSlug = undefined;
		lastReentryState = false;
		activeRunMoaInfo = undefined;
		implementationPending = false;
		lastImplementationStopReason = undefined;
		lastImplementationReport = undefined;
		implementationOutputTracker = undefined;
		resetImplementationTranscript();
		implementationUsage = undefined;
		implementationContextTokens = undefined;
		implementationTurns = 0;
		implementationToolCalls = 0;
		stopActiveProgressWidget();
		persistState();
		ctx.ui.notify("Plan state cleared — the next /mf-plan starts a fresh planning round.");
	};
	const beginInteractive = (ctx: ExtensionContext): void => { activatePlanMode(ctx, false); };
	const enterFromTool = async (ctx: ExtensionContext, prompt: string | undefined): Promise<boolean> => {
		activatePlanMode(ctx, true);
		if (prompt) await saveSubmittedPlanPrompt(ctx, prompt);
		return lastReentryState;
	};
	async function saveSubmittedPlanPrompt(ctx: ExtensionContext, prompt: string): Promise<void> {
		planRepoSlug = await summarizePlanPromptName(ctx, prompt);
		persistState();
		saveRepoPlanFile(prompt, ctx.cwd, planRepoSlug, "plan-prompt");
	}
	const saveApprovedPlanToRepo = (ctx: ExtensionContext, plan: string): void => {
		if (planRepoSlug) saveRepoPlanFile(plan, ctx.cwd, planRepoSlug, "plan");
	};
	const moaRunHost: MoaRunHost = {
		pi,
		getPlanRepoSlug: () => planRepoSlug,
		getActiveObserveSession: () => activeObserveSession,
		setActiveObserveSession: (session) => { activeObserveSession = session; },
		getActiveRunMoaInfo: () => activeRunMoaInfo,
		setActiveRunMoaInfo: (info) => { activeRunMoaInfo = info; },
		persistState,
		currentThinkingLevel,
		applyImplementingSelection: (ctx, selection, notice) => applyImplementingSelection(pi, ctx, selection, notice),
		exitPlanMode,
		saveApprovedPlanToRepo,
		getImplementationHandoff: () => implementationHandoff,
		setImplementationHandoff: (handoff) => {
			implementationHandoff = handoff;
			persistState();
		},
		markImplementationPending: (ctx) => {
			implementationPending = true;
			lastImplementationStopReason = undefined;
			lastImplementationReport = undefined;
			implementationOutputTracker = new OutputActivityTracker();
			resetImplementationTranscript();
			implementationUsage = undefined;
			implementationContextTokens = undefined;
			implementationTurns = 0;
			implementationToolCalls = 0;
			// Reconstruct the table for a resumed run that never adopted one (e.g.
			// /mf-plan-implement after a restart). In-run paths already hold the
			// adopted widget, so this only fires when none exists; single-model
			// exit_plan_mode passes no ctx and has no MoA info, so it is skipped.
			if (!activeProgressWidget && ctx && activeRunMoaInfo && implementationHandoff?.model) {
				const widget = new MoaProgressWidget(ctx, (ref) => resolveContextWindow(ctx, ref), {}, planRepoSlug);
				widget.setPhaseModels({
					Plan: activeRunMoaInfo.proposers,
					Synthesize: activeRunMoaInfo.synthesizer,
					Implement: implementationHandoff.model,
					Verify: implementationHandoff.verifier,
				});
				widget.switchToImplementing(implementationHandoff.model, "implementing plan…", implementationHandoff.thinking);
				activeProgressWidget = widget;
			}
		},
		adoptProgressWidget: (widget) => {
			if (activeProgressWidget && activeProgressWidget !== widget) activeProgressWidget.stopWidget();
			activeProgressWidget = widget;
		},
		getActiveProgressWidget: () => activeProgressWidget,
		stopActiveProgressWidget,
		setActiveCancelSession: (session) => { activeCancelSession = session; },
	};

	return {
		pi,
		isEnabled: () => planModeEnabled,
		currentThinkingLevel,
		beginInteractive,
		enterFromTool,
		abortPlanMode,
		exitPlanMode,
		clearCompletedPlan,
		openCancelOverlayIfActive,
		openObserveOverlayIfActive,
		isAskUserQuestionActive: () => askUserQuestionTracker.isActive(),
		questionnaireBusy,
		getActiveCancelSession: () => activeCancelSession,
		setActiveCancelSession: (session: CancelSession | undefined) => { activeCancelSession = session; },
		getActiveObserveSession: () => activeObserveSession,
		getLastReentryState: () => lastReentryState,
		clearActiveRunMoaInfo: () => { activeRunMoaInfo = undefined; persistState(); },
		setActiveRunMoaInfo: (info: MfPlanInfo | undefined) => { activeRunMoaInfo = info; persistState(); },
		getActiveRunMoaInfo: () => activeRunMoaInfo,
		getPlanRepoSlug: () => planRepoSlug,
		setPlanRepoSlug: (slug: string) => { planRepoSlug = slug; },
		getImplementationHandoff: moaRunHost.getImplementationHandoff,
		setImplementationHandoff: moaRunHost.setImplementationHandoff,
		markImplementationPending: moaRunHost.markImplementationPending,
		isImplementationPending: () => implementationPending,
		persistState,
		saveSubmittedPlanPrompt,
		saveApprovedPlanToRepo,
		moaRunHost,
		applyImplementingSelection: moaRunHost.applyImplementingSelection,
		onMessageStart: (event: MessageStartEvent) => {
			if (!implementationPending || !activeProgressWidget) return;
			if (event.message.role === "assistant") {
				implementationOutputTracker?.messageStart(event.message);
				implementationPartial.start(event.message);
			}
		},
		onMessageUpdate: (event: MessageUpdateEvent) => {
			if (!implementationPending || !activeProgressWidget) return;
			implementationOutputTracker?.messageUpdate(event.assistantMessageEvent);
			const snapshot = implementationOutputTracker?.snapshot();
			if (snapshot) activeProgressWidget.updateRoleOutput("Implement", snapshot.tokens, snapshot.revision);
			implementationPartial.apply(event.assistantMessageEvent);
			activeProgressWidget.updateRoleTranscript("Implement", implementationMessages, implementationPartial.snapshot());
		},
		onToolExecutionStart: (event: ToolExecutionStartEvent) => {
			if (!implementationPending || !activeProgressWidget) return;
			implementationToolCalls++;
			activeProgressWidget.updateRoleActivity("Implement", formatToolActivity(event.toolName, event.args));
		},
		onMessageEnd: (event: MessageEndEvent, ctx: ExtensionContext) => {
			if (!implementationPending) return;
			const msg = event.message as { role?: string; stopReason?: string; content?: unknown; usage?: AssistantUsageLike };
			if (msg.role === "assistant") {
				lastImplementationStopReason = msg.stopReason;
				const text = extractAssistantText(msg.content);
				if (text) lastImplementationReport = text.slice(-IMPLEMENTATION_REPORT_MAX_CHARS);

				implementationOutputTracker?.messageEnd(event.message);
				// Exact usage supersedes the streamed word estimate; the revision bump
				// lets the meter reset rather than metering the correction as output.
				const output = implementationOutputTracker?.snapshot();
				if (output && activeProgressWidget) activeProgressWidget.updateRoleOutput("Implement", output.tokens, output.revision);
				if (msg.usage) {
					implementationUsage ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cost: 0, turns: 0, toolCalls: 0 };
					implementationUsage.input += nonnegative(msg.usage.input);
					implementationUsage.output += nonnegative(msg.usage.output);
					implementationUsage.cacheRead += nonnegative(msg.usage.cacheRead);
					implementationUsage.cacheWrite += nonnegative(msg.usage.cacheWrite);
					implementationUsage.cacheWrite1h += nonnegative(msg.usage.cacheWrite1h);
					implementationUsage.cost += nonnegative(msg.usage.cost?.total);
					if (typeof msg.usage.totalTokens === "number" && msg.usage.totalTokens >= 0) {
						implementationContextTokens = msg.usage.totalTokens;
					}
				}
				implementationTurns++;
				if (activeProgressWidget && implementationHandoff?.model) {
					activeProgressWidget.updateRoleUsage(
						"Implement",
						implementationContextTokens,
						implementationTurns,
						implementationToolCalls,
						resolveModelCost(ctx, implementationHandoff.model, implementationUsage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cost: 0, turns: 0, toolCalls: 0 }),
					);
				}
				implementationPartial.clear();
			}
			if (event.message.role === "assistant" || event.message.role === "toolResult") {
				implementationMessages.push(event.message);
				implementationMessages = implementationMessages.slice(-IMPLEMENTATION_TRANSCRIPT_MESSAGE_LIMIT);
				activeProgressWidget?.updateRoleTranscript("Implement", implementationMessages);
			}
		},
		onAgentSettled: (_event: AgentSettledEvent, ctx: ExtensionContext) => {
			if (!implementationPending) return;
			implementationPending = false;
			const stopReason = lastImplementationStopReason;
			const report = lastImplementationReport;
			lastImplementationStopReason = undefined;
			lastImplementationReport = undefined;

			// Settle the Implement row before any retry/verify routing. Aborted
			// runs stop the table outright (no verification follows).
			if (activeProgressWidget) {
				if (implementationTurnFailed(stopReason)) {
					activeProgressWidget.settleRoleRow("Implement", "error");
				} else if (stopReason === "aborted") {
					activeProgressWidget.settleRoleRow("Implement", "cancelled");
					stopActiveProgressWidget();
				} else {
					activeProgressWidget.settleRoleRow("Implement", "done");
				}
			}

			if (implementationTurnFailed(stopReason) && implementationHandoff) {
				void runImplementationRetryFlow(ctx, moaRunHost, implementationHandoff);
				return;
			}
			// A user-cancelled implementation must NOT be verified. implementationTurnFailed
			// returns false for "aborted" (so the retry flow above is skipped), so this
			// explicit guard is required before the verification branch.
			if (stopReason === "aborted") return;
			if (!implementationHandoff) return;
			const verifier = implementationHandoff.verifier ?? loadMoaConfig().verifier;
			if (verifier) {
				void runImplementationVerification(ctx, moaRunHost, { ...implementationHandoff, verifier }, report)
					.catch((err) => ctx.ui.notify(`Verification could not run: ${err instanceof Error ? err.message : String(err)}`, "error"));
			}
		},
		onContext: async (event: { messages: AgentMessage[] }) => {
			if (planModeEnabled) return;
			return { details: undefined, messages: event.messages.filter((message) => {
				const msg = message as AgentMessage & { customType?: string };
				if (msg.customType === PLAN_MODE_CONTEXT_TYPE || msg.customType === PLAN_EXIT_CONTEXT_TYPE) return false;
				if (msg.role !== "user") return true;
				if (typeof msg.content === "string") return !msg.content.startsWith("[PLAN MODE ACTIVE]") && !msg.content.startsWith("[PLAN MODE RE-ENTRY]");
				if (Array.isArray(msg.content)) return !msg.content.some((part) => part.type === "text" && ((part as TextContent).text?.startsWith("[PLAN MODE ACTIVE]") || (part as TextContent).text?.startsWith("[PLAN MODE RE-ENTRY]")));
				return true;
			}) };
		},
		onBeforeAgentStart: async () => {
			if (needsExitReminder) {
				needsExitReminder = false;
				persistState();
				return { message: { customType: PLAN_EXIT_CONTEXT_TYPE, content: buildPlanModeExitInstructions(), display: false } };
			}
			if (!planModeEnabled) return;
			const instructions = lastReentryState ? buildPlanModeReentryInstructions() : buildPlanModeInstructions(isAskUserQuestionInstalled(pi));
			if (lastReentryState) lastReentryState = false;
			return { message: { customType: PLAN_MODE_CONTEXT_TYPE, content: instructions, display: false } };
		},
		onSessionStart: async (_event: unknown, ctx: ExtensionContext) => {
			installShippedAgents();
			planModeEnabled = false;
			toolsBeforePlanMode = undefined;
			restoreReadOnlyProviderEnv();
			needsExitReminder = false;
			planSlug = undefined;
			planRepoSlug = undefined;
			lastReentryState = false;
			activeRunMoaInfo = undefined;
			activeCancelSession = undefined;
			activeObserveSession = undefined;
			implementationHandoff = undefined;
			implementationPending = false;
			lastImplementationStopReason = undefined;
			lastImplementationReport = undefined;
			implementationOutputTracker = undefined;
			resetImplementationTranscript();
			implementationUsage = undefined;
			implementationContextTokens = undefined;
			implementationTurns = 0;
			implementationToolCalls = 0;
			stopActiveProgressWidget();
			// Clear any blocked flag left by a questionnaire that died without its
			// finally (a fresh session must not inherit a stuck "answer first" gate),
			// then re-subscribe (retaining the handle means no stacked handlers).
			askUserQuestionTracker.reset();
			askUserQuestionTracker.ensureSubscribed();
			persistence.reset();
			resetPlanSlug();
			if (pi.getFlag("mf-plan") === true) planModeEnabled = true;
			const restored = latestPlanModeStateEntry(ctx.sessionManager.getEntries());
			if (restored) {
				planModeEnabled = restored.enabled ?? planModeEnabled;
				needsExitReminder = restored.needsExitReminder ?? false;
				if (isValidPlanSlug(restored.slug) && setPlanSlug(restored.slug)) planSlug = restored.slug;
				planRepoSlug = isValidPlanSlug(restored.repoPlanSlug) ? restored.repoPlanSlug : undefined;
				activeRunMoaInfo = validateMfPlanInfo(restored.moaInfo);
				implementationHandoff = validateImplementationHandoff(restored.implementationHandoff);
			}
			if (planModeEnabled) {
				lastReentryState = getPlan() !== null;
				enablePlanModeTools();
			} else {
				pi.setActiveTools(pi.getActiveTools().filter((name) => !PLAN_ONLY_REGISTERED_TOOLS.includes(name)));
			}
			updateStatus(ctx);
		},
		onSessionShutdown: (_event: { reason: string }) => {
			implementationPending = false;
			lastImplementationStopReason = undefined;
			lastImplementationReport = undefined;
			resetImplementationTranscript();
			stopActiveProgressWidget();
			restoreReadOnlyProviderEnv();
			cleanupTrackedProcesses();
		},
	};
}

export type PlanModeController = ReturnType<typeof createPlanModeController>;
