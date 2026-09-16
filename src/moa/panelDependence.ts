/**
 * Dependence structure for the MoA proposer panel.
 *
 * Blinding invariant: nothing derived from a ModelRef (provider, id, label,
 * family) may appear in synthesizer-facing output — only integers and
 * proposerBlindedLabel slot numbers. Family-level clusters are excluded
 * because they risk de-blinding a lopsided roster.
 */

import { modelRefLabel, proposerBlindedLabel, type ModelRef } from "../shared/modelRefs.ts";

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
	return count === 1 ? singular : plural;
}

function formatClusterSentence(slots: number[]): string {
	const numbers = slots.map((index) => proposerBlindedLabel(index).replace("Proposer ", ""));
	if (numbers.length === 2) {
		return `Proposers ${numbers[0]} and ${numbers[1]} share one model.`;
	}
	const last = numbers.pop();
	return `Proposers ${numbers.join(", ")}, and ${last} share one model.`;
}

/** Blinded one-paragraph note describing panel dependence for the synthesizer. */
export function buildPanelDependenceNote(fed: readonly { ref: ModelRef; originalIndex: number }[]): string {
	const proposalCount = fed.length;
	const clusters = new Map<string, number[]>();
	const providers = new Set<string>();

	for (const { ref, originalIndex } of fed) {
		providers.add(ref.provider);
		const key = modelRefLabel(ref);
		const slots = clusters.get(key);
		if (slots) slots.push(originalIndex);
		else clusters.set(key, [originalIndex]);
	}

	const distinctModels = clusters.size;
	const distinctProviders = providers.size;

	const countsLine = [
		`Panel dependence: ${proposalCount} ${pluralize(proposalCount, "proposal")}`,
		`from ${distinctModels} distinct ${pluralize(distinctModels, "model")}`,
		`across ${distinctProviders} ${pluralize(distinctProviders, "provider")}.`,
	].join(" ");

	const clusterSentences = [...clusters.values()]
		.filter((slots) => slots.length >= 2)
		.sort((a, b) => a[0] - b[0])
		.map((slots) => formatClusterSentence([...slots].sort((a, b) => a - b)));

	const caveat = "Every proposer ran from the same prompt template, so even distinct models are not fully independent; treat agreement inside a same-model cluster as one vote, not as separate confirmation.";

	return [countsLine, ...clusterSentences, caveat].join(" ");
}

function duplicateModelSlotTotal(refs: readonly ModelRef[]): number {
	const labelCounts = new Map<string, number>();
	for (const ref of refs) {
		const label = modelRefLabel(ref);
		labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
	}
	let total = 0;
	for (const count of labelCounts.values()) {
		if (count >= 2) total += count;
	}
	return total;
}

/** Non-blocking warning for the pre-flight picker or replacement notify. */
export function proposerDiversityWarning(refs: readonly ModelRef[]): string | undefined {
	const duplicateTotal = duplicateModelSlotTotal(refs);
	if (duplicateTotal >= 2) {
		return `${duplicateTotal} proposer slots share a model; agreement between them is not independent evidence.`;
	}
	if (refs.length >= 2 && new Set(refs.map((ref) => ref.provider)).size === 1) {
		return `All ${refs.length} proposer slots share one provider; agreement between them is not independent evidence.`;
	}
	return undefined;
}

/** Slots in `refs` whose model matches `ref` (including `ref`'s own slot). */
export function duplicateModelSlotCount(refs: readonly ModelRef[], ref: ModelRef): number {
	const target = modelRefLabel(ref);
	return refs.reduce((count, candidate) => count + (modelRefLabel(candidate) === target ? 1 : 0), 0);
}
