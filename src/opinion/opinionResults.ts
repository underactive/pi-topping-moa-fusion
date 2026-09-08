import type { ModelRef, ThinkingLevel } from "../shared/modelRefs.ts";
import { modelRefLabel } from "../shared/modelRefs.ts";
import type { SingleResult } from "../runtime/results.ts";
import { getFinalOutput, getResultOutput, isFailedResult } from "../runtime/results.ts";

export interface OpinionOutcome {
	ref: ModelRef;
	thinking: ThinkingLevel | undefined;
	status: "done" | "error" | "cancelled";
	text: string;
}

export function collectOpinionOutcomes(
	models: ModelRef[],
	thinking: (ThinkingLevel | undefined)[],
	results: SingleResult[],
): OpinionOutcome[] {
	return models.map((ref, index) => {
		const result = results[index];
		if (!result) {
			return { ref, thinking: thinking[index], status: "error", text: "No result was returned." };
		}
		if (result.cancelled) {
			return { ref, thinking: thinking[index], status: "cancelled", text: getResultOutput(result) };
		}
		if (isFailedResult(result)) {
			return { ref, thinking: thinking[index], status: "error", text: getResultOutput(result) };
		}
		return {
			ref,
			thinking: thinking[index],
			status: "done",
			text: getFinalOutput(result.messages).trim() || "(no output)",
		};
	});
}

export function demoteHeadings(markdown: string): string {
	let fence: "```" | "~~~" | undefined;
	return markdown.split("\n").map((line) => {
		const fenceMatch = line.match(/^\s*(```|~~~)/);
		if (fenceMatch) {
			const marker = fenceMatch[1] as "```" | "~~~";
			if (!fence) fence = marker;
			else if (fence === marker) fence = undefined;
			return line;
		}
		if (fence) return line;
		return line.replace(/^(\s*)(#{1,6})(\s+)/, (_match, indent: string, hashes: string, space: string) =>
			`${indent}${"#".repeat(Math.min(6, hashes.length + 1))}${space}`,
		);
	}).join("\n");
}

function firstLine(text: string): string {
	return text.trim().split(/\r?\n/, 1)[0] || "Unknown error";
}

export function formatOpinionsMarkdown(
	question: string,
	outcomes: OpinionOutcome[],
	name?: string,
): string {
	const title = name ? `# MoA Opinions — ${name}` : "# MoA Opinions";
	const sections = outcomes.map((outcome, index) => {
		const thinking = outcome.thinking ?? "default";
		const heading = `## Opinion ${index + 1} — ${modelRefLabel(outcome.ref)} (thinking: ${thinking})`;
		if (outcome.status === "cancelled") return `${heading}\n\n_Cancelled by user._`;
		if (outcome.status === "error") return `${heading}\n\n_Failed: ${firstLine(outcome.text)}_`;
		return `${heading}\n\n${demoteHeadings(outcome.text)}`;
	});
	return [title, "", `**Question:** ${question}`, "", sections.join("\n\n---\n\n")].join("\n").trimEnd();
}
