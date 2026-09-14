/**
 * MoA (Mixture-of-Agents) configuration for /mf-plan.
 *
 * Persists the last-used mode + model selections so the picker can
 * pre-fill/remember choices across sessions. Purely a UI convenience — the
 * picker is always shown after a plan prompt is submitted, this file never
 * causes it to be skipped.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	THINKING_LEVELS,
	isModelRef,
	isThinkingLevel,
	type ModelRef,
	type ThinkingLevel,
} from "../shared/modelRefs.ts";
import { parseRosters, type PlanRoster } from "./rosters.ts";

export type MoaMode = "single" | "moa";

export const MIN_CONCURRENT_AGENTS = 1;
export const MAX_CONCURRENT_AGENTS = 8;
export const DEFAULT_MAX_CONCURRENT_AGENTS = MIN_CONCURRENT_AGENTS;

export const MIN_VERIFICATION_REPAIRS = 0;
export const MAX_VERIFICATION_REPAIRS_LIMIT = 5;
export const DEFAULT_MAX_VERIFICATION_REPAIRS = 2;

/**
 * Sanitize verifier-driven repair rounds: missing or malformed values fall back
 * to the default; finite numbers are rounded and clamped into [0, 5]. Zero
 * disables automatic repair offers after verification gaps.
 */
export function normalizeMaxVerificationRepairs(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MAX_VERIFICATION_REPAIRS;
	return Math.min(MAX_VERIFICATION_REPAIRS_LIMIT, Math.max(MIN_VERIFICATION_REPAIRS, Math.round(value)));
}

/**
 * The one place a loaded/passed concurrency value becomes safe: missing,
 * non-numeric, NaN and infinite values fall back to the default; finite
 * numbers are rounded to an integer and clamped into [MIN, MAX], so a
 * fractional or out-of-range value can never reach the runner.
 */
export function normalizeMaxConcurrentAgents(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MAX_CONCURRENT_AGENTS;
	return Math.min(MAX_CONCURRENT_AGENTS, Math.max(MIN_CONCURRENT_AGENTS, Math.round(value)));
}

export interface MoaConfig {
	mode: MoaMode;
	proposers: ModelRef[];
	opinionModels: ModelRef[];
	debateModels: ModelRef[];
	/** Round ceiling for /mf-debate, clamped to the picker's 2–5 range. */
	debateRounds: number;
	/** Child agents allowed to run at once in any fan-out, clamped to 1–8. Defaults to 1 — parallel local agents are unusably slow. */
	maxConcurrentAgents: number;
	/** Verifier-driven repair rounds after implementation, clamped to 0–5. Defaults to 2; 0 disables automatic repairs. */
	maxVerificationRepairs: number;
	synthesizer?: ModelRef;
	implementer?: ModelRef;
	verifier?: ModelRef;
	cheap?: ModelRef;
	/** Last thinking level chosen for a model in the picker, keyed by `modelRefLabel(ref)`. */
	thinkingOverrides: Record<string, ThinkingLevel>;
	/** Named model+thinking rosters loadable wholesale from the picker's Load Roster row. */
	rosters: PlanRoster[];
	/** Auto-accept recommended conflict resolutions without showing the TUI conflict overlay. */
	autoResolveConflicts: boolean;
	/** Use LLM-summarized plan names (true) or random adjective-adjective-noun phrases (false). */
	useSummaryName: boolean;
	/**
	 * Whether the user has been through the setup overlay at least once. Gates the
	 * first `/mf-plan` into setup. Kept here rather than inferred from the agent
	 * files because those always carry a shipped `model:`, so their contents cannot
	 * distinguish a shipped default from a deliberate choice.
	 */
	agentDefaultsConfigured: boolean;
}

function emptyConfig(): MoaConfig {
	return {
		mode: "single",
		proposers: [],
		opinionModels: [],
		debateModels: [],
		debateRounds: 3,
		maxConcurrentAgents: DEFAULT_MAX_CONCURRENT_AGENTS,
		maxVerificationRepairs: DEFAULT_MAX_VERIFICATION_REPAIRS,
		synthesizer: undefined,
		implementer: undefined,
		verifier: undefined,
		cheap: undefined,
		thinkingOverrides: {},
		rosters: [],
		autoResolveConflicts: false,
		useSummaryName: true,
		agentDefaultsConfigured: false,
	};
}

/** Persistent MoA settings, colocated with pi's user-level settings rather than generated plans. */
export function moaSettingsPath(): string {
	return join(getAgentDir(), "mf-plan", "settings.json");
}

function parseSettingsFile(path: string): MoaConfig {
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw) as Partial<MoaConfig>;
		const proposers = Array.isArray(parsed.proposers)
			? parsed.proposers.filter(isModelRef)
			: [];
		const opinionModels = Array.isArray(parsed.opinionModels)
			? parsed.opinionModels.filter(isModelRef)
			: [];
		const debateModels = Array.isArray(parsed.debateModels)
			? parsed.debateModels.filter(isModelRef)
			: [];
		const debateRounds = typeof parsed.debateRounds === "number" && Number.isFinite(parsed.debateRounds)
			? Math.min(5, Math.max(2, Math.round(parsed.debateRounds)))
			: 3;
		const maxConcurrentAgents = normalizeMaxConcurrentAgents(parsed.maxConcurrentAgents);
		const maxVerificationRepairs = normalizeMaxVerificationRepairs(parsed.maxVerificationRepairs);
		const synthesizer = isModelRef(parsed.synthesizer) ? parsed.synthesizer : undefined;
		const implementer = isModelRef(parsed.implementer) ? parsed.implementer : undefined;
		const verifier = isModelRef(parsed.verifier) ? parsed.verifier : undefined;
		const cheap = isModelRef(parsed.cheap) ? parsed.cheap : undefined;
		const mode: MoaMode = parsed.mode === "moa" ? "moa" : "single";

		const thinkingOverrides: Record<string, ThinkingLevel> = {};
		if (parsed.thinkingOverrides && typeof parsed.thinkingOverrides === "object") {
			for (const [key, value] of Object.entries(parsed.thinkingOverrides)) {
				if (typeof value === "string" && isThinkingLevel(value)) thinkingOverrides[key] = value;
			}
		}

		const autoResolveConflicts = typeof parsed.autoResolveConflicts === "boolean"
			? parsed.autoResolveConflicts
			: false;

		const useSummaryName = typeof parsed.useSummaryName === "boolean"
			? parsed.useSummaryName
			: true;

		const agentDefaultsConfigured = parsed.agentDefaultsConfigured === true;
		const rosters = parseRosters(parsed.rosters);

		return { mode, proposers, opinionModels, debateModels, debateRounds, maxConcurrentAgents, maxVerificationRepairs, synthesizer, implementer, verifier, cheap, thinkingOverrides, rosters, autoResolveConflicts, useSummaryName, agentDefaultsConfigured };
	} catch (err) {
		console.error("mf-plan: failed to parse settings, using defaults:", err);
		return emptyConfig();
	}
}

export function loadMoaConfig(): MoaConfig {
	const settingsPath = moaSettingsPath();
	if (existsSync(settingsPath)) return parseSettingsFile(settingsPath);
	return emptyConfig();
}

export function saveMoaConfig(config: MoaConfig): void {
	const path = moaSettingsPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, "\t")}\n`, "utf-8");
}

export function moaSettingsExist(): boolean {
	return existsSync(moaSettingsPath());
}

/**
 * The levels to offer for a model, in pi's canonical thinking-level order.
 * The registry's declared range is the whole answer — a level it does not list
 * is one the backend will refuse.
 */
export function thinkingOptionsForModel(registryLevels: ThinkingLevel[]): ThinkingLevel[] {
	return THINKING_LEVELS.filter((level) => registryLevels.includes(level));
}

/** Selects a model's saved level, the current level, or a sensible default in that order. */
export function defaultThinkingForModel(
	key: string,
	config: MoaConfig,
	currentLevel: ThinkingLevel,
	registryLevels: ThinkingLevel[],
): ThinkingLevel {
	const options = thinkingOptionsForModel(registryLevels);
	const saved = config.thinkingOverrides[key];
	if (saved && options.includes(saved)) return saved;
	if (options.includes(currentLevel)) return currentLevel;
	if (options.includes("medium")) return "medium";
	return options[0] ?? "medium";
}
