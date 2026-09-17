/**
 * LLM-based 4-word plan name generation for repo-local plan files.
 */

import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadMoaConfig } from "./settings.ts";
import { fallbackPlanName, generateWordSlug, trySlugifyPlanName } from "../planning/planFile.ts";

function buildSummarizePrompt(prompt: string): string {
	return [
		"Summarize the following planning request in exactly 4 words.",
		"Reply with ONLY those 4 words separated by spaces, no punctuation, all lowercase.",
		"",
		"<request>",
		prompt,
		"</request>",
	].join("\n");
}

/** The name used when summarization is skipped, unavailable, or fails. */
export function planNameFallback(prompt: string): string {
	return trySlugifyPlanName(prompt) ?? fallbackPlanName();
}

export interface PlanNameOptions {
	/** Caller cancellation — esc from the working overlay. */
	signal?: AbortSignal;
}

/** Call the active model to summarize a plan prompt into a 4-word slug. */
export async function summarizePlanPromptName(ctx: ExtensionContext, prompt: string, options?: PlanNameOptions): Promise<string> {
	const fallback = () => planNameFallback(prompt);

	const config = loadMoaConfig();

	// When summary names are disabled, use a random adjective-adjective-noun phrase directly.
	if (!config.useSummaryName) return generateWordSlug();

	const cheapRef = config.cheap;
	const model = cheapRef
		? ctx.modelRegistry.find(cheapRef.provider, cheapRef.id) ?? ctx.model
		: ctx.model;
	if (!model) return fallback();

	// Short-circuit before auth resolution so an already-aborted signal costs nothing.
	if (options?.signal?.aborted) return fallback();

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth?.ok || !auth.apiKey) return fallback();

	try {
		// Naming a plan file is not a reasoning task, and the cheap/fast model is
		// chosen to be cheap. Omitting `reasoning` is how pi's simple-stream API
		// spells "thinking off" (its ThinkingLevel type has no "off" member), so
		// providers send their disabled-reasoning mapping rather than a default.
		const response = await completeSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: buildSummarizePrompt(prompt) }],
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				signal: options?.signal,
			},
		);

		// An aborted request can resolve with stopReason "aborted" and empty text
		// rather than throwing — fall back explicitly instead of slugifying a stub.
		if (response.stopReason === "aborted") return fallback();

		const text = response.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("")
			.trim();

		const slug = trySlugifyPlanName(text);
		return slug ?? fallback();
	} catch {
		return fallback();
	}
}
