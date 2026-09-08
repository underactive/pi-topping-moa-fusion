/**
 * LLM-based 4-word plan name generation for repo-local plan files.
 */

import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadMoaConfig } from "./settings.ts";
import { fallbackPlanName, generateWordSlug, slugifyPlanName } from "../planning/planFile.ts";

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

/** Call the active model to summarize a plan prompt into a 4-word slug. */
export async function summarizePlanPromptName(ctx: ExtensionContext, prompt: string): Promise<string> {
	const promptSlug = slugifyPlanName(prompt);
	const fallback = () => promptSlug || fallbackPlanName();

	const config = loadMoaConfig();

	// When summary names are disabled, use a random adjective-adjective-noun phrase directly.
	if (!config.useSummaryName) return generateWordSlug();

	const cheapRef = config.cheap;
	const model = cheapRef
		? ctx.modelRegistry.find(cheapRef.provider, cheapRef.id) ?? ctx.model
		: ctx.model;
	if (!model) return fallback();

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
			},
		);

		const text = response.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("")
			.trim();

		const slug = slugifyPlanName(text);
		return slug || fallback();
	} catch {
		return fallback();
	}
}
