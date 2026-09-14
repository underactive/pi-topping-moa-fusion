import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type ModelRef,
	type ThinkingLevel,
	isModelRef,
	isThinkingLevel,
	modelRefLabel,
	TRIGGER_TURN,
} from "../shared/modelRefs.ts";
import { getPlan, getPlansDirectory, getRepoPlanDirectory, isValidPlanSlug } from "../planning/planFile.ts";
import { showImplementingModelPicker } from "../ui/moaModelPicker.ts";
import type { MoaRunHost } from "./runContext.js";

export interface ImplementationHandoff {
	plan: string;
	planFilePath: string;
	repoPlanSlug?: string;
	model?: ModelRef;
	thinking?: ThinkingLevel;
	/** Model that verifies the implementation against the plan once the turn settles. */
	verifier?: ModelRef;
	verifierThinking?: ThinkingLevel;
	/** Frozen markdown checklist generated at approval time for criteria-mode verification. */
	verificationCriteria?: string;
	/** How many verifier-driven repair rounds this handoff has already consumed. */
	verificationRepairs?: number;
	timestamp: number;
}

export function validateImplementationHandoff(value: unknown): ImplementationHandoff | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}

	const candidate = value as Partial<ImplementationHandoff>;
	if (typeof candidate.plan !== "string") {
		return undefined;
	}
	if (typeof candidate.planFilePath !== "string" || candidate.planFilePath.trim().length === 0) {
		return undefined;
	}
	if (typeof candidate.timestamp !== "number" || !Number.isFinite(candidate.timestamp) || candidate.timestamp <= 0) {
		return undefined;
	}

	let repoPlanSlug: string | undefined;
	if (candidate.repoPlanSlug !== undefined) {
		if (typeof candidate.repoPlanSlug !== "string" || !isValidPlanSlug(candidate.repoPlanSlug)) {
			return undefined;
		}
		repoPlanSlug = candidate.repoPlanSlug;
	}

	let model: ModelRef | undefined;
	if (candidate.model !== undefined) {
		if (!isModelRef(candidate.model)) {
			return undefined;
		}
		model = candidate.model;
	}

	let thinking: ThinkingLevel | undefined;
	if (candidate.thinking !== undefined) {
		if (!isThinkingLevel(candidate.thinking)) {
			return undefined;
		}
		thinking = candidate.thinking;
	}

	let verifier: ModelRef | undefined;
	if (candidate.verifier !== undefined) {
		if (!isModelRef(candidate.verifier)) {
			return undefined;
		}
		verifier = candidate.verifier;
	}

	let verifierThinking: ThinkingLevel | undefined;
	if (candidate.verifierThinking !== undefined) {
		if (!isThinkingLevel(candidate.verifierThinking)) {
			return undefined;
		}
		verifierThinking = candidate.verifierThinking;
	}

	let verificationCriteria: string | undefined;
	if (candidate.verificationCriteria !== undefined) {
		if (typeof candidate.verificationCriteria !== "string" || candidate.verificationCriteria.trim().length === 0) {
			return undefined;
		}
		verificationCriteria = candidate.verificationCriteria;
	}

	let verificationRepairs: number | undefined;
	if (candidate.verificationRepairs !== undefined) {
		if (typeof candidate.verificationRepairs !== "number"
			|| !Number.isInteger(candidate.verificationRepairs)
			|| candidate.verificationRepairs < 0) {
			return undefined;
		}
		verificationRepairs = candidate.verificationRepairs;
	}

	return {
		plan: candidate.plan,
		planFilePath: candidate.planFilePath,
		repoPlanSlug,
		model,
		thinking,
		verifier,
		verifierThinking,
		verificationCriteria,
		verificationRepairs,
		timestamp: candidate.timestamp,
	};
}

export function implementationTurnFailed(stopReason: string | undefined): boolean {
	return stopReason === undefined || stopReason === "error";
}

export function resolveHandoffPlan(handoff: ImplementationHandoff, repoCwd?: string): string | null {
	if (handoff.plan && handoff.plan.trim().length > 0) {
		return handoff.plan;
	}

	if (handoff.planFilePath) {
		try {
			const resolvedPath = path.resolve(handoff.planFilePath);
			const plansDir = path.resolve(getPlansDirectory());
			const repoPlanDir = repoCwd ? path.resolve(getRepoPlanDirectory(repoCwd)) : undefined;
			const withinPlansDir = resolvedPath.startsWith(`${plansDir}${path.sep}`);
			const withinRepoPlanDir = repoPlanDir !== undefined && resolvedPath.startsWith(`${repoPlanDir}${path.sep}`);
			if ((withinPlansDir || withinRepoPlanDir) && fs.existsSync(resolvedPath)) {
				const content = fs.readFileSync(resolvedPath, "utf8");
				if (content.trim().length > 0) {
					return content;
				}
			}
		} catch {
			// Fall through to repo slug fallback
		}
	}

	if (handoff.repoPlanSlug) {
		const currentSlugPlan = getPlan();
		if (currentSlugPlan && currentSlugPlan.trim().length > 0) {
			return currentSlugPlan;
		}
		if (repoCwd) {
			const repoPlanDir = getRepoPlanDirectory(repoCwd);
			const repoFilePath = path.join(repoPlanDir, `${handoff.repoPlanSlug}__plan.md`);
			try {
				if (fs.existsSync(repoFilePath)) {
					const content = fs.readFileSync(repoFilePath, "utf8");
					if (content.trim().length > 0) {
						return content;
					}
				}
			} catch {
				// No fallback plan content found
			}
		}
	}

	return null;
}

/**
 * Delegation directive appended to every implementation kickoff (initial,
 * retry, /mf-plan-implement, and verifier repair, since all reuse this
 * builder). Phrased to degrade gracefully when no subagent/task tool is
 * available, so no per-call capability flag has to be threaded through.
 */
const SUBAGENT_DELEGATION_DIRECTIVE =
	"Where your environment provides a subagent/task tool, delegate independent, well-scoped pieces of this plan — codebase exploration, edits confined to disjoint files, running a test suite — launching independent ones in parallel; keep ownership of integration and of any file two steps touch, and never rely on a delegated result you have not read back. If no such tool is available, proceed directly.";

export function buildImplementationKickoffMessage(
	plan: string,
	planFilePath: string,
	note?: string,
): string {
	const noteParagraph = note ? `${note}\n\n` : "";
	return `${noteParagraph}User has approved your plan. You can now start coding. Start with updating your todo list if applicable.

${SUBAGENT_DELEGATION_DIRECTIVE}

Your plan has been saved to: ${planFilePath}
You can refer back to it if needed during implementation.

## Approved Plan:
${plan}`;
}

export async function runImplementationRetryFlow(
	ctx: ExtensionContext,
	host: MoaRunHost,
	handoff: ImplementationHandoff,
	failureReason?: string,
): Promise<void> {
	const plan = resolveHandoffPlan(handoff, ctx.cwd);
	if (!plan) {
		host.noteRunError(ctx, "Implementation failed and the approved plan content could not be retrieved.");
		ctx.ui.notify("Implementation failed and approved plan content could not be retrieved from disk.", "error");
		return;
	}

	if (!ctx.hasUI) {
		host.noteRunError(ctx, "Implementation failed with no interactive retry available.");
		const reasonStr = failureReason ? `: ${failureReason}` : "";
		ctx.ui.notify(`Implementation failed${reasonStr}. Run /mf-plan-implement to retry with the same or a different model.`, "error");
		return;
	}

	const currentLabel = ctx.model ? modelRefLabel(ctx.model) : "current model";
	const options = [
		`Retry with ${currentLabel}`,
		"Choose a different model",
		"Continue manually",
	];

	const selection = await ctx.ui.select(
		"Implementation failed — the plan is still available. What next?",
		options,
	);

	if (!selection || selection === "Continue manually") {
		host.stopActiveProgressWidget();
		ctx.ui.notify(`Implementation paused. The approved plan is saved at ${handoff.planFilePath}. Run /mf-plan-implement anytime to resume.`, "info");
		return;
	}

	if (selection.startsWith("Retry with")) {
		host.markImplementationPending(ctx);
		if (handoff.model) host.getActiveProgressWidget()?.switchToImplementing(handoff.model, "retrying implementation", handoff.thinking);
		const note = failureReason
			? `The previous implementation attempt failed with: ${failureReason}. Review the current state of the code and continue implementing the approved plan.`
			: "The previous implementation attempt failed. Review the current state of the code and continue implementing the approved plan.";
		await host.pi.sendUserMessage(
			buildImplementationKickoffMessage(plan, handoff.planFilePath, note),
			TRIGGER_TURN,
		);
		return;
	}

	if (selection === "Choose a different model") {
		const newSelection = await showImplementingModelPicker(
			ctx,
			host.currentThinkingLevel(),
			"Implementation failed — choose a different model",
		);

		if (!newSelection) {
			// User cancelled model picker; re-run retry flow
			return runImplementationRetryFlow(ctx, host, handoff, failureReason);
		}

		await host.applyImplementingSelection(
			ctx,
			newSelection,
			`Switched to ${modelRefLabel(newSelection.ref)} for implementation.`,
		);
		const updatedHandoff: ImplementationHandoff = {
			...handoff,
			model: newSelection.ref,
			thinking: newSelection.thinking,
			timestamp: Date.now(),
		};
		host.setImplementationHandoff(updatedHandoff);
		host.markImplementationPending(ctx);

		const widget = host.getActiveProgressWidget();
		if (widget) {
			const moaInfo = host.getActiveRunMoaInfo();
			widget.setPhaseModels({
				Plan: moaInfo?.proposers,
				Synthesize: moaInfo?.synthesizer,
				Implement: newSelection.ref,
				Verify: updatedHandoff.verifier,
			});
			widget.switchToImplementing(newSelection.ref, "retrying implementation", newSelection.thinking);
		}

		const note = `Switched implementation model to ${modelRefLabel(newSelection.ref)}. Review the current state of the code and continue implementing the approved plan.`;
		await host.pi.sendUserMessage(
			buildImplementationKickoffMessage(plan, handoff.planFilePath, note),
			TRIGGER_TURN,
		);
	}
}
