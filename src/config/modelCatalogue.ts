/**
 * Cached view of the models pi reports as usable, with the thinking levels the
 * registry declares for each.
 *
 * The registry is the only authority the pickers consult: it decides both which
 * models may be selected and which thinking levels each one supports, so a
 * confirmed selection needs no further verification. Whether a model actually
 * answers is decided when it runs, not here.
 */

import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { isThinkingLevel, modelRefLabel, parseRef, type ModelRef, type ThinkingLevel } from "../shared/modelRefs.ts";

export interface ModelCatalogue {
	/** Selectable models, sorted by `provider/id`. */
	availableRefs(): ModelRef[];
	/** Levels the registry declares for a model, in pi's canonical order. */
	thinkingLevelsFor(ref: ModelRef): ThinkingLevel[];
}

/** The slice of pi's `ModelRegistry` a catalogue is built from. */
export interface CatalogueRegistry {
	getAvailable(): Model<Api>[];
}

// Lives for as long as the registry object itself: pi hands extensions a stable
// registry per session, and dropping the registry drops its catalogue with it.
const CATALOGUES = new WeakMap<CatalogueRegistry, ModelCatalogue>();

export function getModelCatalogue(registry: CatalogueRegistry): ModelCatalogue {
	const cached = CATALOGUES.get(registry);
	if (cached) return cached;
	const built = buildCatalogue(registry);
	CATALOGUES.set(registry, built);
	return built;
}

function buildCatalogue(registry: CatalogueRegistry): ModelCatalogue {
	const levels = new Map<string, ThinkingLevel[]>();
	for (const model of registry.getAvailable()) {
		const key = `${model.provider}/${model.id}`;
		if (levels.has(key)) continue;
		levels.set(key, getSupportedThinkingLevels(model).filter(isThinkingLevel));
	}

	const refs = [...levels.keys()]
		.sort((a, b) => a.localeCompare(b))
		.map((key) => parseRef(key));

	return {
		availableRefs: () => [...refs],
		thinkingLevelsFor: (ref) => levels.get(modelRefLabel(ref)) ?? [],
	};
}
