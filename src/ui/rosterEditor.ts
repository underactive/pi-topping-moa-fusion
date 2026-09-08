/**
 * Agent-roster manager for `/mf-plan-settings`.
 *
 * A staged CRUD surface over the saved `PlanRoster` list: list → name prompt →
 * slot editor → per-slot model/thinking picker, ported from persona-audit's
 * RosterEditor. Every mutation happens on in-memory copies; persistence stays
 * with the settings overlay's Save button, so closing without saving (or the
 * overlay's Cancel) leaves settings.json untouched.
 *
 * Each roster carries one model + thinking level for every fan-out role —
 * 2–5 proposers plus synthesizer, implementer, and verifier. A roster must be
 * complete before it can be saved; drafts are never persisted.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, type TUI } from "@earendil-works/pi-tui";
import {
	MAX_ROSTER_COUNT,
	MAX_ROSTER_NAME_LENGTH,
	MAX_ROSTER_PROPOSERS,
	rosterNameError,
	rosterReadinessError,
	rosterSummary,
	type DraftRoster,
	type PlanRoster,
	type RosterSlot,
} from "../config/rosters.ts";
import type { ThinkingLevel } from "../shared/modelRefs.ts";
import { modelRefLabel } from "../shared/modelRefs.ts";
import { ratioViewport } from "./chrome.ts";
import { MenuComponent, showOverlayPrompt, type ActionMenuItem } from "./menu.ts";
import { showModelThinkingPicker } from "./moaModelPicker.ts";

const BACKSPACE = "\x7f";

type SlotRole = "synthesizer" | "implementer" | "verifier";
type SlotTarget = { kind: "proposer"; index: number } | { kind: "role"; role: SlotRole };
type ListResult = { action: "create" } | { action: "edit"; index: number } | { action: "back" };
type EditorResult =
	| { action: "save"; draft: DraftRoster }
	| { action: "pick"; target: SlotTarget; draft: DraftRoster }
	| { action: "rename"; draft: DraftRoster }
	| { action: "delete" }
	| { action: "cancel" };

const ROLE_LABELS: Record<SlotRole, string> = {
	synthesizer: "Synthesizer",
	implementer: "Implementer",
	verifier: "Verifier",
};

const proposerLabel = (index: number): string => `Proposer ${index + 1}`;
const targetLabel = (target: SlotTarget): string => target.kind === "proposer" ? proposerLabel(target.index) : ROLE_LABELS[target.role];
const targetItemId = (target: SlotTarget): string => target.kind === "proposer" ? `proposer-${target.index}` : `role-${target.role}`;

function parseTargetItemId(id: string): SlotTarget | undefined {
	if (id.startsWith("proposer-")) {
		const index = Number(id.slice("proposer-".length));
		return Number.isInteger(index) && index >= 0 && index < MAX_ROSTER_PROPOSERS ? { kind: "proposer", index } : undefined;
	}
	if (id.startsWith("role-")) {
		const role = id.slice("role-".length);
		return role === "synthesizer" || role === "implementer" || role === "verifier" ? { kind: "role", role } : undefined;
	}
	return undefined;
}

function slotValue(slot: RosterSlot | undefined): string {
	return slot ? `${modelRefLabel(slot.ref)} (thinking: ${slot.thinking})` : "(none)";
}

function cloneSlot(slot: RosterSlot | undefined): RosterSlot | undefined {
	return slot ? { ref: { ...slot.ref }, thinking: slot.thinking } : undefined;
}

function toDraft(roster: PlanRoster): DraftRoster {
	return {
		name: roster.name,
		proposers: Array.from({ length: MAX_ROSTER_PROPOSERS }, (_unused, index) => cloneSlot(roster.proposers[index])),
		synthesizer: cloneSlot(roster.synthesizer),
		implementer: cloneSlot(roster.implementer),
		verifier: cloneSlot(roster.verifier),
	};
}

function cloneDraft(draft: DraftRoster): DraftRoster {
	return {
		name: draft.name,
		proposers: draft.proposers.map(cloneSlot),
		synthesizer: cloneSlot(draft.synthesizer),
		implementer: cloneSlot(draft.implementer),
		verifier: cloneSlot(draft.verifier),
	};
}

/** Compacts the sparse proposer slots into a dense, slot-ordered list — the same rule the picker's finish() uses. */
function fromDraft(draft: DraftRoster): PlanRoster {
	return {
		name: draft.name,
		proposers: draft.proposers.filter((slot): slot is RosterSlot => slot !== undefined),
		synthesizer: draft.synthesizer!,
		implementer: draft.implementer!,
		verifier: draft.verifier!,
	};
}

/**
 * MenuComponent renders through this wrapper so its scrollable viewport tracks
 * the terminal rows the way every other overlay in this extension does.
 */
class ViewportMenu implements Component {
	constructor(private readonly menu: MenuComponent) {}

	handleInput(data: string): void {
		this.menu.handleInput(data);
	}

	render(width: number): string[] {
		this.menu.setViewport(ratioViewport(process.stdout.rows, { fallbackRows: 24, ratio: 0.7, minimum: 6 }));
		return this.menu.render(width);
	}

	invalidate(): void {
		this.menu.invalidate();
	}

	dispose(): void {
		this.menu.dispose();
	}
}

async function promptRosterName(ctx: ExtensionContext, rosters: PlanRoster[], currentName = "", currentIndex?: number): Promise<string | undefined> {
	for (;;) {
		const entered = await ctx.ui.input("Roster name", currentName || `1–${MAX_ROSTER_NAME_LENGTH} letters or numbers`);
		if (entered === undefined) return undefined;
		const name = entered.trim();
		const error = rosterNameError(name, rosters, currentIndex);
		if (!error) return name;
		ctx.ui.notify(error, "warning");
	}
}

function showRosterList(ctx: ExtensionContext, rosters: PlanRoster[]): Promise<ListResult> {
	return showOverlayPrompt(ctx, (tui, theme, finish) => {
		const items: ActionMenuItem[] = rosters
			.map((roster, index) => ({ roster, index }))
			.sort((a, b) => a.roster.name.localeCompare(b.roster.name))
			.map(({ roster, index }) => ({
				id: `roster-${index}`,
				label: roster.name,
				displayValue: `${roster.proposers.length + 3} roles assigned`,
				description: rosterSummary(roster),
				onSelect: () => finish({ action: "edit", index }),
			}));
		if (rosters.length < MAX_ROSTER_COUNT) {
			items.push({ id: "create", label: "Create roster", onSelect: () => finish({ action: "create" }) });
		}
		return new ViewportMenu(new MenuComponent(
			{
				title: "MoA Fusion: Agent rosters",
				fullWidth: true,
				maxItemsPerSection: 8,
				sections: [{ title: "Rosters", items }],
				buttons: [{ id: "back", label: "Back", primary: true, onSelect: () => finish({ action: "back" }) }],
			},
			theme,
			() => finish({ action: "back" }),
			tui,
		));
	});
}

function showSlotEditor(ctx: ExtensionContext, draft: DraftRoster, focusItemId: string, canDelete: boolean): Promise<EditorResult> {
	const working = cloneDraft(draft);
	return showOverlayPrompt(ctx, (tui, theme, finish) => {
		const proposerItems: ActionMenuItem[] = working.proposers.map((slot, index) => ({
			id: `proposer-${index}`,
			label: proposerLabel(index),
			displayValue: slotValue(slot),
			onSelect: () => finish({ action: "pick", target: { kind: "proposer", index }, draft: cloneDraft(working) }),
		}));
		const roleItems: ActionMenuItem[] = (["synthesizer", "implementer", "verifier"] as const).map((role) => ({
			id: `role-${role}`,
			label: ROLE_LABELS[role],
			displayValue: slotValue(working[role]),
			onSelect: () => finish({ action: "pick", target: { kind: "role", role }, draft: cloneDraft(working) }),
		}));
		const items = [...proposerItems, ...roleItems];
		const itemById = new Map(items.map((item) => [item.id, item]));
		return new ViewportMenu(new MenuComponent(
			{
				title: `Agent roster: ${working.name}`,
				fullWidth: true,
				initialItemId: focusItemId,
				hints: ["↑↓ slot", "⏎ choose", "⌫ clear", "⇥ buttons", "esc cancel"],
				sections: [
					{ title: "proposers", items: proposerItems },
					{ title: "roles", items: roleItems },
				],
				onItemKey: (item, data) => {
					if (data !== BACKSPACE && data !== "\b" && !matchesKey(data, Key.delete)) return false;
					const target = parseTargetItemId(item.id);
					if (!target) return true;
					if (target.kind === "proposer") working.proposers[target.index] = undefined;
					else working[target.role] = undefined;
					const row = itemById.get(item.id);
					if (row) row.displayValue = "(none)";
					return true;
				},
				buttons: [
					{
						id: "save", label: "Save roster", primary: true,
						onSelect: () => {
							const error = rosterReadinessError(working);
							if (error) {
								ctx.ui.notify(error, "warning");
								return;
							}
							finish({ action: "save", draft: cloneDraft(working) });
						},
					},
					{ id: "rename", label: "Rename", onSelect: () => finish({ action: "rename", draft: cloneDraft(working) }) },
					...(canDelete ? [{ id: "delete", label: "Delete", onSelect: () => finish({ action: "delete" } as const) }] : []),
					{ id: "cancel", label: "Cancel", onSelect: () => finish({ action: "cancel" }) },
				],
			},
			theme,
			() => finish({ action: "cancel" }),
			tui,
		));
	});
}

async function editRoster(
	ctx: ExtensionContext,
	rosters: PlanRoster[],
	roster: DraftRoster,
	currentIndex: number | undefined,
	currentThinking: ThinkingLevel,
): Promise<PlanRoster | "delete" | undefined> {
	let draft = cloneDraft(roster);
	let focusItemId = "proposer-0";
	for (;;) {
		const result = await showSlotEditor(ctx, draft, focusItemId, currentIndex !== undefined);
		if (result.action === "cancel") return undefined;
		if (result.action === "save") return fromDraft(result.draft);
		if (result.action === "delete") {
			if (await ctx.ui.confirm("Delete agent roster?", `Delete ${draft.name}? This is staged until settings are saved.`)) return "delete";
			continue;
		}
		if (result.action === "rename") {
			const name = await promptRosterName(ctx, rosters, result.draft.name, currentIndex);
			draft = { ...result.draft, name: name ?? result.draft.name };
			continue;
		}
		const target = result.target;
		const current = target.kind === "proposer" ? result.draft.proposers[target.index] : result.draft[target.role];
		const pick = await showModelThinkingPicker(
			ctx,
			currentThinking,
			`${targetLabel(target)} — choose a model and thinking level`,
			current?.ref,
			current?.thinking,
		);
		draft = cloneDraft(result.draft);
		if (pick) {
			const slot: RosterSlot = { ref: pick.ref, thinking: pick.thinking };
			if (target.kind === "proposer") draft.proposers[target.index] = slot;
			else draft[target.role] = slot;
		}
		focusItemId = targetItemId(target);
	}
}

/** Manage a staged roster collection; persistence remains the settings overlay's Save action's responsibility. */
export async function showRosterManager(
	ctx: ExtensionContext,
	initial: PlanRoster[],
	deps: { currentThinking: ThinkingLevel },
): Promise<PlanRoster[]> {
	const rosters = initial.map((roster) => ({ ...roster, proposers: [...roster.proposers] }));
	for (;;) {
		const action = await showRosterList(ctx, rosters);
		if (action.action === "back") return rosters;
		if (action.action === "create") {
			const name = await promptRosterName(ctx, rosters);
			if (!name) continue;
			const created = await editRoster(
				ctx,
				rosters,
				{
					name,
					proposers: Array.from({ length: MAX_ROSTER_PROPOSERS }, () => undefined),
					synthesizer: undefined,
					implementer: undefined,
					verifier: undefined,
				},
				undefined,
				deps.currentThinking,
			);
			if (created && created !== "delete") rosters.push(created);
			continue;
		}
		const current = rosters[action.index];
		if (!current) continue;
		const edited = await editRoster(ctx, rosters, toDraft(current), action.index, deps.currentThinking);
		if (edited === "delete") rosters.splice(action.index, 1);
		else if (edited) rosters[action.index] = edited;
	}
}
