/**
 * Named agent rosters for MoA plan runs.
 *
 * A roster bundles one model + thinking level for every fan-out role — up to
 * five proposers plus synthesizer, implementer, and verifier — so a whole
 * assignment set can be reused across runs and loaded wholesale from the
 * picker's "Load Roster" row. Rosters are defined in `/mf-plan-settings` and
 * persisted in settings.json; they are pure data here: nothing in this module
 * consults the model registry, so an unavailable provider must never erase a
 * saved definition. Availability is filtered where rosters are applied.
 *
 * Pure module — no I/O — so tests need none.
 */

import { isModelRef, isThinkingLevel, shortModelName, type ModelRef, type ThinkingLevel } from "../shared/modelRefs.ts";

export const MIN_ROSTER_PROPOSERS = 2;
export const MAX_ROSTER_PROPOSERS = 5;
export const MAX_ROSTER_NAME_LENGTH = 24;
export const MAX_ROSTER_COUNT = 20;
export const ROSTER_NAME_PATTERN = /^[A-Za-z0-9]+$/;

/** One model + thinking level assignment for a single role slot. */
export interface RosterSlot {
	ref: ModelRef;
	thinking: ThinkingLevel;
}

/** A complete saved team: a dense slot-ordered proposer list plus the three required roles. */
export interface PlanRoster {
	name: string;
	/** Dense in slot order, `MIN_ROSTER_PROPOSERS..MAX_ROSTER_PROPOSERS` entries. */
	proposers: RosterSlot[];
	synthesizer: RosterSlot;
	implementer: RosterSlot;
	verifier: RosterSlot;
}

/** An in-progress roster in the editor: proposer slots may be empty and required roles unset. */
export interface DraftRoster {
	name: string;
	/** Fixed `MAX_ROSTER_PROPOSERS` length; `undefined` entries are unassigned. */
	proposers: (RosterSlot | undefined)[];
	synthesizer?: RosterSlot;
	implementer?: RosterSlot;
	verifier?: RosterSlot;
}

export function isRosterSlot(value: unknown): value is RosterSlot {
	return !!value
		&& typeof value === "object"
		&& isModelRef((value as RosterSlot).ref)
		&& typeof (value as RosterSlot).thinking === "string"
		&& isThinkingLevel((value as RosterSlot).thinking);
}

/** Sanitise a parsed `rosters` array the way persona-audit does its rosters. */
export function parseRosters(value: unknown): PlanRoster[] {
	const rosters: PlanRoster[] = [];
	const names = new Set<string>();
	if (!Array.isArray(value)) return rosters;
	for (const entry of value) {
		if (rosters.length >= MAX_ROSTER_COUNT) break;
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as Partial<PlanRoster>;
		if (typeof candidate.name !== "string" || !Array.isArray(candidate.proposers)) continue;
		const name = candidate.name.trim();
		const normalizedName = name.toLowerCase();
		if (
			name.length < 1
			|| name.length > MAX_ROSTER_NAME_LENGTH
			|| !ROSTER_NAME_PATTERN.test(name)
			|| names.has(normalizedName)
		) continue;
		if (!isRosterSlot(candidate.synthesizer) || !isRosterSlot(candidate.implementer) || !isRosterSlot(candidate.verifier)) continue;

		const proposers: RosterSlot[] = [];
		for (const slot of candidate.proposers) {
			if (isRosterSlot(slot)) proposers.push(slot);
			if (proposers.length >= MAX_ROSTER_PROPOSERS) break;
		}
		if (proposers.length < MIN_ROSTER_PROPOSERS) continue;
		names.add(normalizedName);
		rosters.push({ name, proposers, synthesizer: candidate.synthesizer, implementer: candidate.implementer, verifier: candidate.verifier });
	}
	return rosters;
}

/** Validation message for a prospective roster name, or undefined when acceptable. */
export function rosterNameError(name: string, rosters: { name: string }[], currentIndex?: number): string | undefined {
	if (name.length < 1 || name.length > MAX_ROSTER_NAME_LENGTH || !ROSTER_NAME_PATTERN.test(name)) {
		return `Roster names must be 1–${MAX_ROSTER_NAME_LENGTH} alphanumeric characters.`;
	}
	if (rosters.some((roster, index) => index !== currentIndex && roster.name.toLowerCase() === name.toLowerCase())) {
		return `A roster named ${name} already exists.`;
	}
	return undefined;
}

/** Compact one-line summary of a roster's models, e.g. "P: opus, haiku · S: opus · I: opus · V: haiku". */
export function rosterSummary(roster: PlanRoster): string {
	const proposers = roster.proposers.map((slot) => shortModelName(slot.ref)).join(", ");
	return `P: ${proposers} · S: ${shortModelName(roster.synthesizer.ref)} · I: ${shortModelName(roster.implementer.ref)} · V: ${shortModelName(roster.verifier.ref)}`;
}

/** What a draft is still missing before it can be saved, or undefined when complete. */
export function rosterReadinessError(draft: DraftRoster): string | undefined {
	const assigned = draft.proposers.filter((slot) => slot !== undefined).length;
	const missing: string[] = [];
	const shortfall = MIN_ROSTER_PROPOSERS - assigned;
	if (shortfall > 0) missing.push(shortfall === 1 ? "1 more proposer" : `${shortfall} proposers`);
	if (!draft.synthesizer) missing.push("a synthesizer");
	if (!draft.implementer) missing.push("an implementer");
	if (!draft.verifier) missing.push("a verifier");
	if (missing.length === 0) return undefined;
	if (missing.length === 1) return `A roster needs ${missing[0]}.`;
	return `A roster needs ${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}.`;
}
