import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { summarizePlanPromptName } from "../config/planName.ts";
import {
	nextFreeRepoPlanSlug,
	repoPlanDisplayPath,
	saveRepoPlanFile,
	slugifyPlanName,
} from "../planning/planFile.ts";
import type { CancelSession } from "../runtime/cancelRun.ts";
import type { ThinkingLevel } from "../shared/modelRefs.ts";
import { showPlanReview } from "../ui/planReviewOverlay.ts";
import { showPromptEditor } from "../ui/promptEditor.ts";
import { planNamingOverlay, withWorkingOverlay } from "../ui/workingOverlay.ts";
import {
	MAX_SPEC_QUESTIONS,
	MAX_SPEC_REVISIONS,
	SPEC_SYSTEM_PROMPT,
	buildBriefRetryTask,
	buildBriefTask,
	buildPlanHandoff,
	buildQuestionRetryTask,
	buildQuestionTask,
	buildSpecArtifact,
	missingSpecSections,
	normalizeBrief,
	parseNextStep,
	type SpecAnswer,
} from "./specContract.ts";

export interface SpecHost {
	currentThinkingLevel(): ThinkingLevel;
	getActiveCancelSession(): CancelSession | undefined;
	isEnabled(): boolean;
	questionnaireBusy(ctx: ExtensionContext): boolean;
}

type ModelReply = { ok: true; text: string } | { ok: false; error: string };

export async function askSpecModel(
	ctx: ExtensionContext,
	host: SpecHost,
	task: string,
	signal: AbortSignal,
): Promise<ModelReply> {
	const model = ctx.model;
	if (!model) return { ok: false, error: "No active model — choose one with /model." };
	try {
		const thinking = host.currentThinkingLevel();
		const response = await ctx.modelRegistry.streamSimple(
			model,
			{
				systemPrompt: SPEC_SYSTEM_PROMPT,
				messages: [{ role: "user", content: [{ type: "text", text: task }], timestamp: Date.now() }],
			},
			thinking === "off" ? { signal } : { signal, reasoning: thinking },
		).result();
		if (response.stopReason === "aborted") return { ok: false, error: "cancelled" };
		if (response.stopReason === "error") return { ok: false, error: response.errorMessage ?? "model error" };
		const text = response.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("")
			.trim();
		return text ? { ok: true, text } : { ok: false, error: "empty reply" };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

const STOP = Symbol("stop-spec-work");
type WorkResult = ModelReply | typeof STOP;

export function createSpecRunner(host: SpecHost): (ctx: ExtensionContext, initialRequest?: string) => Promise<void> {
	let specActive = false;

	return async (ctx, initialRequest) => {
		if (host.questionnaireBusy(ctx)) return;
		if (host.getActiveCancelSession()?.run) {
			ctx.ui.notify("An MoA run is in progress.", "warning");
			return;
		}
		if (host.isEnabled()) {
			ctx.ui.notify("Plan mode is active. /mf-spec hands off to a fresh /mf-plan, so exit plan mode first (/mf-plan).", "warning");
			return;
		}
		if (specActive) {
			ctx.ui.notify("A /mf-spec session is already open.", "warning");
			return;
		}

		const suppliedRequest = initialRequest?.trim();
		if (!ctx.hasUI) {
			if (!suppliedRequest) {
				ctx.ui.notify('/mf-spec needs a request argument in non-interactive mode (e.g. pi -p "/mf-spec add dark mode").', "warning");
				return;
			}
			if (process.env.MOA_PLAN_AUTO_APPROVE !== "1") {
				ctx.ui.notify("/mf-spec cannot get approval in non-interactive mode. Set MOA_PLAN_AUTO_APPROVE=1 to generate and save the brief without review.", "warning");
				return;
			}
			specActive = true;
			try {
				await runHeadless(ctx, host, suppliedRequest);
			} finally {
				specActive = false;
			}
			return;
		}

		specActive = true;
		try {
			await runInteractive(ctx, host, suppliedRequest);
		} finally {
			specActive = false;
		}
	};
}

async function requestDraft(
	ctx: ExtensionContext,
	host: SpecHost,
	request: string,
	answers: SpecAnswer[],
	options?: { headless?: boolean; revision?: { previousBrief: string; feedback: string } },
): Promise<{ artifact?: string; missing?: string[]; error?: string; cancelled?: boolean }> {
	const task = buildBriefTask({ request, repoName: path.basename(ctx.cwd), answers, ...options });
	const run = (prompt: string): Promise<WorkResult> => withWorkingOverlay<WorkResult>(
		ctx,
		{ title: "Drafting the planning brief", detail: "turning your request into a structured brief", hint: "esc stop drafting", skip: () => STOP },
		(signal) => askSpecModel(ctx, host, prompt, signal),
	);
	let reply = await run(task);
	if (reply === STOP) return { cancelled: true };
	if (!reply.ok) return { error: reply.error };
	let brief = normalizeBrief(reply.text);
	let missing = missingSpecSections(brief);
	if (missing.length) {
		reply = await run(buildBriefRetryTask(task, reply.text, missing));
		if (reply === STOP) return { cancelled: true };
		if (!reply.ok) return { error: reply.error };
		brief = normalizeBrief(reply.text);
		missing = missingSpecSections(brief);
	}
	return { artifact: buildSpecArtifact({ request, answers, brief, createdAt: new Date() }), missing };
}

async function runHeadless(ctx: ExtensionContext, host: SpecHost, request: string): Promise<void> {
	const drafted = await requestDraft(ctx, host, request, [], { headless: true });
	if (!drafted.artifact || drafted.missing?.length) {
		const reason = drafted.error ?? drafted.missing?.join(", ") ?? "cancelled";
		ctx.ui.notify(`The brief could not be generated (${reason}) — nothing saved.`, "error");
		return;
	}
	try {
		const slug = nextFreeRepoPlanSlug(ctx.cwd, slugifyPlanName(request), "spec");
		saveRepoPlanFile(drafted.artifact, ctx.cwd, slug, "spec");
		const displayPath = repoPlanDisplayPath(slug, "spec");
		ctx.ui.notify(`Planning brief saved to ${displayPath}\n\n${buildPlanHandoff(drafted.artifact, displayPath)}`);
	} catch (error) {
		ctx.ui.notify(`Could not save the planning brief: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

async function runInteractive(ctx: ExtensionContext, host: SpecHost, initialRequest?: string): Promise<void> {
	const request = initialRequest ?? (await showPromptEditor(ctx, "Spec — describe what you want to build"))?.trim();
	if (!request) {
		ctx.ui.notify("Spec cancelled.");
		return;
	}

	const answers: SpecAnswer[] = [];
	while (answers.length < MAX_SPEC_QUESTIONS) {
		const task = buildQuestionTask({ request, repoName: path.basename(ctx.cwd), answers });
		const ask = (prompt: string): Promise<WorkResult> => withWorkingOverlay<WorkResult>(
			ctx,
			{
				title: "Choosing the next question",
				detail: `clarifying your request · ${answers.length}/${MAX_SPEC_QUESTIONS} asked`,
				hint: "esc stop asking",
				skip: () => STOP,
			},
			(signal) => askSpecModel(ctx, host, prompt, signal),
		);
		let reply = await ask(task);
		if (reply === STOP) {
			if (!await shouldDraftAfterInterrupt(ctx)) return;
			break;
		}
		let next = reply.ok ? parseNextStep(reply.text) : { kind: "malformed" as const };
		if (reply.ok && next.kind === "malformed") {
			reply = await ask(buildQuestionRetryTask(task, reply.text));
			if (reply === STOP) {
				if (!await shouldDraftAfterInterrupt(ctx)) return;
				break;
			}
			next = reply.ok ? parseNextStep(reply.text) : { kind: "malformed" as const };
		}
		if (!reply.ok || next.kind === "malformed") {
			const detail = reply.ok ? "malformed reply" : reply.error;
			ctx.ui.notify(`Could not get a clarifying question: ${detail}; drafting with the answers so far.`, "warning");
			break;
		}
		if (next.kind === "ready") break;
		if (answers.some((answer) => answer.question.toLowerCase() === next.question.toLowerCase())) break;
		const answer = await ctx.ui.editor(`Q${answers.length + 1}/${MAX_SPEC_QUESTIONS} · ${next.area} — ${next.question}`);
		if (answer === undefined) {
			if (!await shouldDraftAfterInterrupt(ctx)) return;
			break;
		}
		answers.push({ question: next.question, area: next.area, answer: answer.trim() });
	}

	let revisions = 0;
	let artifact: string | undefined;
	while (!artifact) {
		const drafted = await requestDraft(ctx, host, request, answers);
		if (drafted.artifact) {
			artifact = drafted.artifact;
			if (drafted.missing?.length) ctx.ui.notify(`Brief is missing: ${drafted.missing.join(", ")}; edit or revise it before approving.`, "warning");
			break;
		}
		if (!drafted.cancelled) ctx.ui.notify(`The brief could not be drafted: ${drafted.error ?? "empty reply"}`, "error");
		const choice = await ctx.ui.select("The brief was not drafted", ["Try drafting again", "Cancel /mf-spec — nothing is saved"]);
		if (choice !== "Try drafting again") return;
	}

	while (true) {
		let decision: "approve" | "keep" | "edit" | "chat";
		if (ctx.mode === "tui") {
			decision = await showPlanReview(ctx, artifact, undefined, undefined, revisions < MAX_SPEC_REVISIONS, {
				title: "Planning Brief",
				approveHint: "approve & save",
				keepHint: "close",
				chatHint: "revise",
			});
		} else {
			const edited = await ctx.ui.editor("Planning Brief — review or edit, then submit", artifact);
			if (edited?.trim()) {
				artifact = edited;
				const missing = missingSpecSections(artifact);
				if (missing.length) ctx.ui.notify(`Brief is missing: ${missing.join(", ")}.`, "warning");
			}
			const options = ["Approve — save the brief", ...(revisions < MAX_SPEC_REVISIONS ? ["Revise with feedback"] : []), "Discard — nothing is saved"];
			const choice = await ctx.ui.select("Save this planning brief?", options);
			decision = choice?.startsWith("Approve") ? "approve" : choice?.startsWith("Revise") ? "chat" : "keep";
			if (decision === "keep") {
				ctx.ui.notify("Planning brief discarded — nothing saved.");
				return;
			}
		}

		if (decision === "edit") {
			const edited = await ctx.ui.editor("Edit Planning Brief", artifact);
			if (edited?.trim()) {
				artifact = edited;
				const missing = missingSpecSections(artifact);
				if (missing.length) ctx.ui.notify(`Brief is missing: ${missing.join(", ")}.`, "warning");
			}
			continue;
		}
		if (decision === "chat") {
			if (revisions >= MAX_SPEC_REVISIONS) {
				ctx.ui.notify("Maximum planning brief revision rounds reached; edit or approve the brief instead.", "warning");
				continue;
			}
			const feedback = (await showPromptEditor(ctx, "Revise the brief — what should change?"))?.trim();
			if (!feedback) continue;
			revisions++;
			const revised = await requestDraft(ctx, host, request, answers, { revision: { previousBrief: normalizeBrief(artifact), feedback } });
			if (!revised.artifact) {
				ctx.ui.notify(`Could not revise the planning brief: ${revised.error ?? "cancelled"}; keeping the previous brief.`, "error");
				continue;
			}
			artifact = revised.artifact;
			if (revised.missing?.length) ctx.ui.notify(`Brief is missing: ${revised.missing.join(", ")}; edit or revise it before approving.`, "warning");
			continue;
		}
		if (decision === "keep") {
			const choice = await ctx.ui.select("Discard this planning brief?", ["Back to the brief", "Discard — nothing is saved"]);
			if (choice === "Discard — nothing is saved") {
				ctx.ui.notify("Planning brief discarded — nothing saved.");
				return;
			}
			continue;
		}

		const named = await withWorkingOverlay(
			ctx,
			planNamingOverlay("spec", () => slugifyPlanName(request)),
			(signal) => summarizePlanPromptName(ctx, request, { signal }),
		);
		let savedSlug: string | undefined;
		while (!savedSlug) {
			try {
				const candidate = nextFreeRepoPlanSlug(ctx.cwd, named, "spec");
				saveRepoPlanFile(artifact, ctx.cwd, candidate, "spec");
				savedSlug = candidate;
			} catch (error) {
				ctx.ui.notify(`Could not save the planning brief: ${error instanceof Error ? error.message : String(error)}`, "error");
				const choice = await ctx.ui.select("The planning brief was not saved", ["Retry saving", "Open the brief in an editor to copy it", "Discard"]);
				if (choice === "Retry saving") continue;
				if (choice === "Open the brief in an editor to copy it") {
					await ctx.ui.editor("Copy the planning brief", artifact);
					continue;
				}
				return;
			}
		}

		const displayPath = repoPlanDisplayPath(savedSlug, "spec");
		const handoff = buildPlanHandoff(artifact, displayPath);
		if (ctx.mode === "tui") {
			if (ctx.ui.getEditorText().trim() === "") {
				ctx.ui.setEditorText(handoff);
				ctx.ui.notify(`Planning brief saved to ${displayPath}. The /mf-plan prompt is in your input box; review it and press Enter to start planning.`);
			} else {
				ctx.ui.notify(`Planning brief saved to ${displayPath}. Your input box isn't empty, so the /mf-plan prompt wasn't inserted; copy it from the 'Planning prompt for /mf-plan' section.`);
			}
		} else {
			ctx.ui.notify(`Planning brief saved to ${displayPath}\n\n${handoff}`);
		}
		return;
	}
}

async function shouldDraftAfterInterrupt(ctx: ExtensionContext): Promise<boolean> {
	const choice = await ctx.ui.select("Stop the clarifying questions?", [
		"Draft the brief with the answers so far",
		"Cancel /mf-spec — nothing is saved",
	]);
	if (choice === "Draft the brief with the answers so far") return true;
	ctx.ui.notify("Spec cancelled.");
	return false;
}
