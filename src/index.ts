import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

import { installShippedAgents, shippedAgentsDir, withAuthoritativeMoaAgents } from "./agents/authoritative.ts";
import { discoverAgents } from "./agents/discovery.ts";
import {
	buildImplementationKickoffMessage,
	resolveHandoffPlan,
	type ImplementationHandoff,
} from "./moa/implementationRetry.ts";
import { modelRefLabel, TRIGGER_TURN } from "./shared/modelRefs.ts";
import { loadMoaConfig } from "./config/settings.ts";
import { getPlanFilePath, getRepoPlanDirectory, isApprovedRepoPlanFilename, isValidPlanSlug, readRepoPlanFile, saveRepoPlanFile } from "./planning/planFile.ts";
import { showImplementingModelPicker } from "./ui/moaModelPicker.ts";
import { showPlanReview } from "./ui/planReviewOverlay.ts";
import { showMoaSetup } from "./ui/moaSetupOverlay.ts";
import { runCriteriaGeneration } from "./moa/verificationCriteria.ts";
import { stripSynthSections } from "./moa/verdicts.ts";
import { runInteractiveOpinion, type OpinionHost } from "./opinion/runOpinion.ts";
import { runInteractiveDebate } from "./debate/runDebate.ts";
import { createSpecRunner } from "./spec/runSpec.ts";
import { createPlanModeController } from "./planning/planMode.ts";
import { registerEnterPlanModeTool, runInteractivePlanMode } from "./planning/tools/enterPlanMode.ts";
import { registerExitPlanModeTool } from "./planning/tools/exitPlanMode.ts";
import { registerMfPlanSubagentTool } from "./planning/tools/mfPlanSubagent.ts";
import { registerWritePlanTool } from "./planning/tools/writePlan.ts";

export default function mfPlanExtension(pi: ExtensionAPI): void {
	const controller = createPlanModeController(pi);
	const opinionHost: OpinionHost = {
		currentThinkingLevel: controller.currentThinkingLevel,
		getActiveCancelSession: controller.getActiveCancelSession,
		setActiveCancelSession: controller.setActiveCancelSession,
		openCancelOverlayIfActive: controller.openCancelOverlayIfActive,
		getActiveObserveSession: controller.getActiveObserveSession,
		setActiveObserveSession: (session) => { controller.moaRunHost.setActiveObserveSession(session); },
		setRunningProgressWidget: controller.moaRunHost.setRunningProgressWidget,
	};
	const debateHost = opinionHost;
	const runSpec = createSpecRunner(controller);
	const togglePlanMode = async (ctx: Parameters<typeof controller.exitPlanMode>[0], prompt?: string): Promise<void> => {
		if (controller.questionnaireBusy(ctx)) return;
		if (controller.getActiveCancelSession()?.run) {
			ctx.ui.notify("An MoA run is in progress.", "warning");
			return;
		}
		if (controller.isEnabled()) controller.exitPlanMode(ctx);
		else await runInteractivePlanMode(pi, controller, ctx, prompt);
	};

	pi.registerFlag("mf-plan", {
		description: "Start in MoA Fusion plan mode (read-only with 5-phase workflow)",
		type: "boolean",
		default: false,
	});
	pi.registerCommand("mf-plan", {
		description: "Toggle 'Mixture of Agents' plan mode — append a prompt (e.g. /mf-plan add dark mode) to skip the editor",
		handler: async (args, ctx) => togglePlanMode(ctx, args.trim() || undefined),
	});
	pi.registerCommand("mf-preview", {
		description: "Toggle the MoA live preview under the agent table in the active run",
		handler: async (_args, ctx) => { controller.toggleLivePreview(ctx); },
	});
	pi.registerCommand("mf-opinion", {
		description: "Ask up to 5 models for independent read-only opinions — append a question (e.g. /mf-opinion is X sound?) to skip the editor",
		handler: async (args, ctx) => { if (controller.questionnaireBusy(ctx)) return; await runInteractiveOpinion(pi, opinionHost, ctx, args.trim() || undefined); },
	});
	pi.registerCommand("mf-debate", {
		description: "Run a read-only multi-round debate between up to 5 models — append a topic (e.g. /mf-debate is X sound?) to skip the editor",
		handler: async (args, ctx) => { if (controller.questionnaireBusy(ctx)) return; await runInteractiveDebate(pi, debateHost, ctx, args.trim() || undefined); },
	});
	pi.registerCommand("mf-spec", {
		description: "Clarify a rough request into an approved planning brief for /mf-plan — append the request (e.g. /mf-spec add dark mode) to skip the editor",
		handler: async (args, ctx) => runSpec(ctx, args.trim() || undefined),
	});
	pi.registerCommand("mf-plan-clear", {
		description: "Clear the completed plan state so /mf-plan starts a fresh planning round (approved plans stay in .pi/mf-plan/)",
		handler: async (_args, ctx) => { if (controller.questionnaireBusy(ctx)) return; await controller.clearCompletedPlan(ctx); },
	});
	pi.registerCommand("mf-plan-settings", {
		description: "Configure the explore and cheap/fast agents, agent rosters for MoA roles, plan options, and max concurrent agents",
		handler: async (_args, ctx) => {
			if (controller.questionnaireBusy(ctx)) return;
			installShippedAgents();
			const saved = await showMoaSetup(ctx, controller.currentThinkingLevel());
			if (saved) ctx.ui.notify("MoA Fusion Settings saved.");
		},
	});
	pi.registerCommand("mf-plan-implement", {
		description: "Retry implementation of the last approved MoA plan, optionally with a different model",
		handler: async (_args, ctx) => {
			if (controller.questionnaireBusy(ctx)) return;
			if (controller.isEnabled()) controller.exitPlanMode(ctx);
			let handoff = controller.getImplementationHandoff();
			let plan: string | null = null;
			let filePath = getPlanFilePath();

			if (handoff) {
				plan = resolveHandoffPlan(handoff, ctx.cwd);
				filePath = handoff.planFilePath || filePath;
			}

			if (!plan) {
				// Fall back to scanning repo plan directory for saved plans
				const repoDir = getRepoPlanDirectory(ctx.cwd);
				let planFiles: { filename: string; fullPath: string; mtime: number; slug: string }[] = [];
				try {
					if (fs.existsSync(repoDir)) {
						const entries = fs.readdirSync(repoDir);
						planFiles = entries
							.filter(isApprovedRepoPlanFilename)
							.map((file) => {
								const slug = file.slice(0, -"__plan.md".length);
								const fullPath = path.join(repoDir, file);
								const stat = fs.statSync(fullPath);
								return { filename: file, fullPath, mtime: stat.mtimeMs, slug };
							})
							.filter((file) => isValidPlanSlug(file.slug))
							.sort((a, b) => b.mtime - a.mtime);
					}
				} catch {
					// Fall through if reading directory fails
				}

				if (planFiles.length === 0) {
					ctx.ui.notify("No approved plan found — run /mf-plan first.", "warning");
					return;
				}

				if (!ctx.hasUI) {
					ctx.ui.notify("No in-session approved plan found — run /mf-plan in an interactive session first.", "warning");
					return;
				}

				const options = planFiles.map((f) => f.slug);
				const selectedSlug = await ctx.ui.select("Select plan found on disk to review:", options);
				if (!selectedSlug) return;
				const chosenFile = planFiles.find((f) => f.slug === selectedSlug);
				if (!chosenFile) {
					ctx.ui.notify("Selected plan could not be resolved.", "error");
					return;
				}

				let diskPlan: string;
				try {
					diskPlan = fs.readFileSync(chosenFile.fullPath, "utf8");
				} catch {
					ctx.ui.notify(`Failed to read plan from ${chosenFile.fullPath}.`, "error");
					return;
				}

				// Plans found on disk are repo artifacts, not something this session's user
				// necessarily authored or has seen — require an explicit content review
				// before treating one as approved, unlike the in-session handoff above.
				let approved = false;
				if (ctx.mode === "tui") {
					while (true) {
						const decision = await showPlanReview(ctx, diskPlan, undefined, chosenFile.slug, false);
						if (decision === "edit") {
							const edited = await ctx.ui.editor("Edit Plan", diskPlan);
							if (edited?.trim()) diskPlan = stripSynthSections(edited.trim());
							continue;
						}
						approved = decision === "approve";
						break;
					}
				} else {
					approved = await ctx.ui.confirm(
						`Approve plan found on disk: ${chosenFile.slug}?`,
						`This plan was found in .pi/mf-plan/ and may not have been written in this session. Review before approving:\n\n${diskPlan}`,
					);
				}

				if (!approved) {
					ctx.ui.notify("Plan not approved — implementation not started.", "warning");
					return;
				}

				plan = diskPlan;
				filePath = chosenFile.fullPath;
				handoff = {
					plan,
					planFilePath: filePath,
					repoPlanSlug: chosenFile.slug,
					model: ctx.model,
					timestamp: Date.now(),
				};
			}

			const selection = await showImplementingModelPicker(
				ctx,
				controller.currentThinkingLevel(),
				"Resume implementation — choose a model and thinking level",
			);

			if (ctx.hasUI && !selection) {
				ctx.ui.notify("Implementation resume cancelled.", "warning");
				return;
			}

			if (selection) {
				await controller.applyImplementingSelection(
					ctx,
					selection,
					`Switched to ${modelRefLabel(selection.ref)} for implementation.`,
				);
			}

			// Verify a resumed implementation too: prefer the handoff's own verifier,
			// else fall back to the configured verifier so /mf-plan-implement after a
			// restart (or on a plan that predates the verifier role) is still checked.
			const config = loadMoaConfig();
			const resolvedVerifier = handoff?.verifier ?? config.verifier;
			const resolvedVerifierThinking = handoff?.verifierThinking
				?? (resolvedVerifier ? config.thinkingOverrides[modelRefLabel(resolvedVerifier)] : undefined);
			let resolvedCriteria = handoff?.verificationCriteria
				?? (handoff?.repoPlanSlug ? readRepoPlanFile(ctx.cwd, handoff.repoPlanSlug, "criteria") : undefined);
			if (!resolvedCriteria && resolvedVerifier && config.synthesizer) {
				installShippedAgents();
				const generated = await runCriteriaGeneration({
					ctx,
					agents: withAuthoritativeMoaAgents(discoverAgents(ctx.cwd, "user").agents, shippedAgentsDir()),
					synthesizer: config.synthesizer,
					thinking: config.thinkingOverrides[modelRefLabel(config.synthesizer)],
					plan,
				});
				if (generated) {
					resolvedCriteria = generated.markdown;
					if (handoff?.repoPlanSlug) saveRepoPlanFile(resolvedCriteria, ctx.cwd, handoff.repoPlanSlug, "criteria");
				} else {
					ctx.ui.notify("Verification criteria could not be generated; the verifier will judge plan steps directly.", "warning");
				}
			}
			const updatedHandoff: ImplementationHandoff = {
				...handoff,
				plan,
				planFilePath: filePath,
				model: selection?.ref ?? handoff?.model ?? ctx.model,
				thinking: selection?.thinking ?? handoff?.thinking ?? controller.currentThinkingLevel(),
				verifier: resolvedVerifier,
				verifierThinking: resolvedVerifierThinking,
				verificationCriteria: resolvedCriteria,
				verificationRepairs: handoff?.verificationRepairs ?? 0,
				timestamp: Date.now(),
			};
			controller.setImplementationHandoff(updatedHandoff);
			controller.markImplementationPending(ctx);

			const note = "This is a manual resume of the approved plan.";
			await pi.sendUserMessage(
				buildImplementationKickoffMessage(plan, filePath, note),
				TRIGGER_TURN,
			);
		},
	});
	// Secondary cancel trigger, and the only one in the mf_plan_subagent
	// tool path — there the main agent is streaming, so plain ESC must keep
	// pi's default abort-the-whole-turn behavior.
	pi.registerShortcut(Key.f4, {
		description: "Cancel running plan subagents",
		handler: async (ctx) => { if (controller.questionnaireBusy(ctx)) return; controller.openCancelOverlayIfActive(ctx); },
	});
	pi.registerShortcut(Key.f3, {
		description: "Observe running plan agents",
		handler: async (ctx) => { if (controller.questionnaireBusy(ctx)) return; controller.openObserveOverlayIfActive(ctx); },
	});
	pi.registerShortcut(Key.f2, {
		description: "Toggle the live preview under tool activity",
		handler: async (ctx) => { controller.toggleLivePreview(ctx); },
	});

	registerEnterPlanModeTool(pi, controller);
	registerWritePlanTool(pi, controller.isEnabled);
	registerMfPlanSubagentTool(pi, controller);
	registerExitPlanModeTool(pi, controller);

	// Deliberately not context_with_system (pi 0.87.0): its result is sent
	// verbatim, so a filtering mistake could drop pi's prompt and tool declarations.
	// Keep injection in before_agent_start, filtering in context, and durable
	// omissions in agent_before_settle so pi continues to own prompt/tool state.
	pi.on("context", controller.onContext);
	pi.on("before_agent_start", controller.onBeforeAgentStart);
	pi.on("agent_start", controller.onAgentStart);
	pi.on("message_start", controller.onMessageStart);
	pi.on("message_update", controller.onMessageUpdate);
	pi.on("tool_execution_start", controller.onToolExecutionStart);
	pi.on("message_end", controller.onMessageEnd);
	pi.on("agent_before_settle", controller.onAgentBeforeSettle);
	pi.on("agent_settled", controller.onAgentSettled);
	pi.on("session_start", controller.onSessionStart);
	pi.on("session_shutdown", controller.onSessionShutdown);
}
