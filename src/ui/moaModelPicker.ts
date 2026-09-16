/**
 * MoA model-select TUI: shown right after the plan-prompt editor closes.
 *
 * Screen 0 is the mode chooser ("Single model" vs "Mixture of Agents Fusion").
 * Choosing "Single model" resolves immediately with `{ mode: "single" }`.
 * Choosing "Mixture of Agents" opens the overview ("MoA Fusion Pre-flight") with
 * the eight slots — five proposers plus synthesizer, implementer, and verifier —
 * starting unassigned at `(none)`, plus a Load Roster row that applies a saved
 * roster to every slot wholesale, and a Start fan-out action. Enter on a slot
 * opens its two-pane model/thinking picker; confirming writes only that slot
 * and returns to the overview, cancelling returns without changing it. The
 * overview's "Start fan-out" action stays visually disabled until at least two
 * proposer slots and all three required roles are assigned, then it finishes
 * the picker.
 * Choosing every role up front means approval applies the pre-chosen
 * implementer with no second picker, and the verifier is ready to judge the
 * result once implementation settles.
 *
 * All screens live in one Component instance. Esc from a slot picker returns to
 * the overview without committing; Esc from the overview returns to the mode
 * chooser (assignments are preserved); Esc from the mode chooser cancels the
 * whole picker.
 *
 * Saved and current-model choices only seed a slot picker's initial highlight
 * while that slot is still empty — they never count as assignments, so
 * readiness always reflects explicit selections.
 *
 * Models and thinking levels both come from the model registry (see
 * modelCatalogue.ts), so a confirmed selection is usable by construction and
 * nothing verifies it after the picker closes. Whether a model actually answers
 * is decided when it runs.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth, type SelectItem, type Component, type TUI } from "@earendil-works/pi-tui";
import {
	SELECTOR_POINTER,
	SQUARE_SINGLE_BOX,
	UNSELECTED_POINTER,
	createFrame,
	ratioViewport,
	wrapWords,
} from "./chrome.ts";
import { PLAN_OVERLAY_OPTIONS } from "./menu.ts";
import { TwoPaneModelThinking } from "./twoPaneModelThinking.ts";
import { smartTruncateModelLabel } from "./modelLabel.ts";
import { proposerDiversityWarning } from "../moa/panelDependence.ts";
import { getModelCatalogue } from "../config/modelCatalogue.ts";
import {
	loadMoaConfig,
	moaSettingsExist,
	type MoaConfig,
} from "../config/settings.ts";
import {
	modelRefLabel,
	type ModelRef,
	type ThinkingLevel,
} from "../shared/modelRefs.ts";
import { defaultThinkingForModel, thinkingOptionsForModel } from "../config/settings.ts";
import { rosterSummary, type PlanRoster, type RosterSlot } from "../config/rosters.ts";

const HINT_BASE = "type filters models • ↑↓ navigate pane • tab panes/buttons • ←→ switch/select • enter select";

export const MAX_PROPOSERS = 5;
const MIN_PROPOSERS = 2;
const IMPLEMENTER_SCREEN = MAX_PROPOSERS + 2;
const VERIFIER_SCREEN = MAX_PROPOSERS + 3;
const CONFIRM_SCREEN = MAX_PROPOSERS + 4;
const ROSTER_SCREEN = MAX_PROPOSERS + 5;

// Overview row indices, in render order: Load Roster, then proposer slots,
// the three required roles, and the start action. The blank lines are visual
// separators and do not have focusable row indices.
const LOAD_ROW = 0;
const SYNTH_ROW = MAX_PROPOSERS + 1;
const IMPLEMENTER_ROW = MAX_PROPOSERS + 2;
const VERIFIER_ROW = MAX_PROPOSERS + 3;
const START_ROW = MAX_PROPOSERS + 4;
const OVERVIEW_ROW_COUNT = MAX_PROPOSERS + 5;

export type MoaPickerResult =
	| { mode: "single" }
	| {
		mode: "moa";
		proposers: ModelRef[];
		synthesizer: ModelRef;
		implementer: ModelRef;
		verifier: ModelRef;
		proposerThinking: (ThinkingLevel | undefined)[];
		synthesizerThinking: ThinkingLevel | undefined;
		implementerThinking: ThinkingLevel | undefined;
		verifierThinking: ThinkingLevel | undefined;
		thinkingSelections: Record<string, ThinkingLevel>;
	};

const MODE_ITEMS: SelectItem[] = [
	{
		value: "moa",
		label: "Mixture of Agents Fusion",
		description: "Fan out to up to 5 proposer models, then reconcile their plans with a synthesizer model, implement, and verify",
	},
	{
		value: "single",
		label: "Single model",
		description: "The active model runs the full plan-mode workflow itself.",
	},
];

/**
 * Selectable registry models for the MoA pickers and setup overlay. Every model
 * pi reports as available is offered — no locally maintained API allowlist
 * narrows this — so whether a model actually answers is still decided at run
 * time, not here.
 */
export function getAvailableModelRefs(ctx: ExtensionContext): ModelRef[] {
	return getModelCatalogue(ctx.modelRegistry).availableRefs();
}

const SLOT_TITLES = ["Proposer 1", "Proposer 2", "Proposer 3", "Proposer 4", "Proposer 5"];

class MoaModelPickerComponent implements Component {
	// 0 = mode chooser; 1..MAX_PROPOSERS = proposer slots; MAX_PROPOSERS+1 =
	// synthesizer; IMPLEMENTER_SCREEN = implementer; VERIFIER_SCREEN = verifier;
	// CONFIRM_SCREEN = the overview. The overview is the hub: every slot picker is
	// opened from it and returns to it.
	private screen = 0;
	private modeIndex = 0;
	// Overview rows, in order: Load Roster, MAX_PROPOSERS proposer slots, then
	// synthesizer, implementer, verifier, and the start action (row START_ROW).
	private confirmIndex = 0;
	// Cursor on the Load Roster screen's roster list.
	private rosterIndex = 0;
	private readonly currentThinking: ThinkingLevel;
	private readonly availableLabels: Set<string>;
	private readonly sortedRosters: { roster: PlanRoster; availableSlots: number }[];
	private readonly twoPane: TwoPaneModelThinking;
	// Explicit per-slot assignments; `undefined` means the slot is still `(none)`.
	private readonly proposerRefs: (ModelRef | undefined)[] = Array.from({ length: MAX_PROPOSERS }, () => undefined);
	private readonly proposerThinking: (ThinkingLevel | undefined)[] = Array.from({ length: MAX_PROPOSERS }, () => undefined);
	private synthesizerRef: ModelRef | undefined;
	private synthesizerThinking: ThinkingLevel | undefined;
	private implementerRef: ModelRef | undefined;
	private implementerThinking: ThinkingLevel | undefined;
	private verifierRef: ModelRef | undefined;
	private verifierThinking: ThinkingLevel | undefined;
	private readonly thinkingSelections: Record<string, ThinkingLevel> = {};

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		availableRefs: ModelRef[],
		private readonly defaults: { mode: SelectItem["value"]; slots: ModelRef[] },
		private readonly config: MoaConfig,
		currentThinking: ThinkingLevel,
		rosters: PlanRoster[],
		private readonly ctx: ExtensionContext,
		private readonly done: (result: MoaPickerResult | undefined) => void,
	) {
		this.modeIndex = Math.max(0, MODE_ITEMS.findIndex((i) => i.value === this.defaults.mode));
		this.currentThinking = currentThinking;
		this.availableLabels = new Set(availableRefs.map(modelRefLabel));
		this.sortedRosters = rosters
			.map((roster) => ({
				roster,
				availableSlots: [
					...roster.proposers,
					roster.synthesizer,
					roster.implementer,
					roster.verifier,
				].filter((slot) => this.availableLabels.has(modelRefLabel(slot.ref))).length,
			}))
			.sort((a, b) => a.roster.name.localeCompare(b.roster.name));
		this.twoPane = new TwoPaneModelThinking(tui, theme, availableRefs, config, currentThinking, ctx);
	}

	/** The committed model/thinking pair for a slot picker screen, if assigned. */
	private slotSelection(screen: number): { ref: ModelRef | undefined; thinking: ThinkingLevel | undefined } {
		const role = this.nonProposerRole(screen);
		if (role) return this.getRole(role);
		return { ref: this.proposerRefs[screen - 1], thinking: this.proposerThinking[screen - 1] };
	}

	/**
	 * Open a slot's two-pane picker from the overview. A committed slot re-opens
	 * on its own choice; an empty slot highlights the saved/current default — a
	 * hint only, never an assignment until the pick is confirmed.
	 */
	private openSlot(screen: number): void {
		const committed = this.slotSelection(screen);
		if (committed.ref) this.twoPane.reset(committed.ref, committed.thinking);
		else this.twoPane.reset(this.defaults.slots[screen - 1]);
		this.screen = screen;
		this.tui.requestRender();
	}

	private confirmModeScreen(): void {
		const item = MODE_ITEMS[this.modeIndex];
		if (!item) return;
		if (item.value === "single") {
			this.done({ mode: "single" });
			return;
		}
		this.screen = CONFIRM_SCREEN;
		this.confirmIndex = 0;
		this.tui.requestRender();
	}

	/** Which single-slot role a non-proposer screen configures, if any. */
	private nonProposerRole(screen: number): "synthesizer" | "implementer" | "verifier" | undefined {
		if (screen === MAX_PROPOSERS + 1) return "synthesizer";
		if (screen === IMPLEMENTER_SCREEN) return "implementer";
		if (screen === VERIFIER_SCREEN) return "verifier";
		return undefined;
	}

	private setRole(role: "synthesizer" | "implementer" | "verifier", ref: ModelRef, thinking: ThinkingLevel): void {
		if (role === "synthesizer") { this.synthesizerRef = ref; this.synthesizerThinking = thinking; }
		else if (role === "implementer") { this.implementerRef = ref; this.implementerThinking = thinking; }
		else { this.verifierRef = ref; this.verifierThinking = thinking; }
	}

	private getRole(role: "synthesizer" | "implementer" | "verifier"): { ref: ModelRef | undefined; thinking: ThinkingLevel | undefined } {
		if (role === "synthesizer") return { ref: this.synthesizerRef, thinking: this.synthesizerThinking };
		if (role === "implementer") return { ref: this.implementerRef, thinking: this.implementerThinking };
		return { ref: this.verifierRef, thinking: this.verifierThinking };
	}

	/** Store the confirmed pair for the active slot and return to the overview. */
	private commitSlot(selection: { ref: ModelRef; thinking: ThinkingLevel }): void {
		const { ref, thinking } = selection;
		this.thinkingSelections[modelRefLabel(ref)] = thinking;
		const role = this.nonProposerRole(this.screen);
		if (role) {
			this.setRole(role, ref, thinking);
		} else {
			this.proposerRefs[this.screen - 1] = ref;
			this.proposerThinking[this.screen - 1] = thinking;
		}
		this.screen = CONFIRM_SCREEN;
		this.tui.requestRender();
	}

	/** Count of proposer slots holding an explicit assignment. */
	private assignedProposerCount(): number {
		return this.proposerRefs.reduce((n, ref) => (ref ? n + 1 : n), 0);
	}

	private diversityWarning(): string | undefined {
		const assigned = this.proposerRefs.filter((ref): ref is ModelRef => ref !== undefined);
		return proposerDiversityWarning(assigned);
	}

	/**
	 * Ready to start once at least MIN_PROPOSERS proposer slots plus all three
	 * required roles hold explicit assignments. Counts assigned slots, not
	 * distinct models — the same model may fill several slots.
	 */
	private isReady(): boolean {
		return this.assignedProposerCount() >= MIN_PROPOSERS
			&& this.synthesizerRef !== undefined
			&& this.implementerRef !== undefined
			&& this.verifierRef !== undefined;
	}

	/** Concise list of what "Start fan-out" is still waiting on. */
	private missingSummary(): string {
		const parts: string[] = [];
		const shortfall = MIN_PROPOSERS - this.assignedProposerCount();
		if (shortfall > 0) parts.push(`${shortfall} more proposer${shortfall === 1 ? "" : "s"}`);
		if (this.synthesizerRef === undefined) parts.push("synthesizer");
		if (this.implementerRef === undefined) parts.push("implementer");
		if (this.verifierRef === undefined) parts.push("verifier");
		return parts.length ? `needs ${parts.join(", ")}` : "";
	}

	/**
	 * Registry-supported thinking level for a roster slot: the roster's level
	 * when the model still offers it, otherwise the picker's usual fallback
	 * chain (saved override, current level, medium, whatever exists).
	 */
	private rosterThinking(ref: ModelRef, wanted: ThinkingLevel): ThinkingLevel {
		const registryLevels = getModelCatalogue(this.ctx.modelRegistry).thinkingLevelsFor(ref);
		const options = thinkingOptionsForModel(registryLevels);
		if (options.includes(wanted)) return wanted;
		return defaultThinkingForModel(modelRefLabel(ref), this.config, this.currentThinking, registryLevels);
	}

	/** Overview row of the first still-unassigned required slot, or the Start action when ready. */
	private firstIncompleteRow(): number {
		if (this.assignedProposerCount() < MIN_PROPOSERS) {
			for (let i = 0; i < MAX_PROPOSERS; i++) {
				if (this.proposerRefs[i] === undefined) return i + 1;
			}
		}
		if (this.synthesizerRef === undefined) return SYNTH_ROW;
		if (this.implementerRef === undefined) return IMPLEMENTER_ROW;
		if (this.verifierRef === undefined) return VERIFIER_ROW;
		return START_ROW;
	}

	/**
	 * Replace every slot assignment with a roster's — wholesale, so a 2-proposer
	 * roster clears stale picks from slots 3–5. Slots whose model is no longer
	 * available are cleared and reported; the roster definition itself is never
	 * modified.
	 */
	private applyRoster(roster: PlanRoster): void {
		const isAvailable = (slot: RosterSlot) => this.availableLabels.has(modelRefLabel(slot.ref));
		const skipped: string[] = [];
		const apply = (label: string, slot: RosterSlot | undefined, set: (ref: ModelRef, thinking: ThinkingLevel) => void, clear: () => void): void => {
			if (slot && isAvailable(slot)) {
				const thinking = this.rosterThinking(slot.ref, slot.thinking);
				set(slot.ref, thinking);
				this.thinkingSelections[modelRefLabel(slot.ref)] = thinking;
			} else {
				clear();
				if (slot) skipped.push(label);
			}
		};
		for (let i = 0; i < MAX_PROPOSERS; i++) {
			apply(SLOT_TITLES[i] ?? `Proposer ${i + 1}`, roster.proposers[i],
				(ref, thinking) => { this.proposerRefs[i] = ref; this.proposerThinking[i] = thinking; },
				() => { this.proposerRefs[i] = undefined; this.proposerThinking[i] = undefined; });
		}
		apply("Synthesizer", roster.synthesizer,
			(ref, thinking) => { this.synthesizerRef = ref; this.synthesizerThinking = thinking; },
			() => { this.synthesizerRef = undefined; this.synthesizerThinking = undefined; });
		apply("Implementer", roster.implementer,
			(ref, thinking) => { this.implementerRef = ref; this.implementerThinking = thinking; },
			() => { this.implementerRef = undefined; this.implementerThinking = undefined; });
		apply("Verifier", roster.verifier,
			(ref, thinking) => { this.verifierRef = ref; this.verifierThinking = thinking; },
			() => { this.verifierRef = undefined; this.verifierThinking = undefined; });
		if (skipped.length > 0) {
			this.ctx.ui.notify(`Roster ${roster.name}: skipped ${skipped.join(", ")} — model not available`, "warning");
		}
		this.screen = CONFIRM_SCREEN;
		this.confirmIndex = this.isReady() ? START_ROW : this.firstIncompleteRow();
		this.tui.requestRender();
	}

	/** Emit the assembled MoA result — a no-op unless every requirement is met. */
	private finish(): void {
		if (!this.isReady()) return;
		// Compact the sparse proposer slots into dense, slot-ordered arrays so the
		// paired model/thinking indices stay aligned downstream.
		const proposers: ModelRef[] = [];
		const proposerThinking: (ThinkingLevel | undefined)[] = [];
		for (let i = 0; i < MAX_PROPOSERS; i++) {
			const ref = this.proposerRefs[i];
			if (!ref) continue;
			proposers.push(ref);
			proposerThinking.push(this.proposerThinking[i]);
		}
		this.done({
			mode: "moa",
			proposers,
			synthesizer: this.synthesizerRef!,
			implementer: this.implementerRef!,
			verifier: this.verifierRef!,
			proposerThinking,
			synthesizerThinking: this.synthesizerThinking,
			implementerThinking: this.implementerThinking,
			verifierThinking: this.verifierThinking,
			thinkingSelections: { ...this.thinkingSelections },
		});
	}

	handleInput(data: string): void {
		if (this.screen === 0) {
			if (matchesKey(data, Key.enter)) {
				this.confirmModeScreen();
				return;
			}
			if (matchesKey(data, Key.escape)) {
				this.done(undefined);
				return;
			}
			if (matchesKey(data, Key.up)) {
				if (this.modeIndex > 0) {
					this.modeIndex--;
					this.tui.requestRender();
				}
				return;
			}
			if (matchesKey(data, Key.down)) {
				if (this.modeIndex < MODE_ITEMS.length - 1) {
					this.modeIndex++;
					this.tui.requestRender();
				}
				return;
			}
			return;
		}

		if (this.screen === CONFIRM_SCREEN) {
			if (matchesKey(data, Key.up)) {
				if (this.confirmIndex > 0) {
					this.confirmIndex--;
					this.tui.requestRender();
				}
				return;
			}
			if (matchesKey(data, Key.down)) {
				if (this.confirmIndex < OVERVIEW_ROW_COUNT - 1) {
					this.confirmIndex++;
					this.tui.requestRender();
				}
				return;
			}
			if (matchesKey(data, Key.enter)) {
				if (this.confirmIndex === LOAD_ROW) {
					if (this.sortedRosters.length > 0) {
						this.screen = ROSTER_SCREEN;
						this.rosterIndex = 0;
						this.tui.requestRender();
					}
					// With no rosters saved the row is a disabled no-op: Enter is swallowed.
				} else if (this.confirmIndex === START_ROW) {
					if (this.isReady()) {
						// Start action — activation is gated on readiness here, and
						// finish() re-checks so an incomplete roster can never escape.
						this.finish();
					}
				} else {
					// Rows 1..VERIFIER_ROW map to slot picker screens 1..VERIFIER_SCREEN.
					this.openSlot(this.confirmIndex);
				}
				// A disabled Start swallows Enter with no state change.
				return;
			}
			if (matchesKey(data, Key.escape)) {
				// Back to the mode chooser; assignments are preserved.
				this.screen = 0;
				this.tui.requestRender();
				return;
			}
			// Consume everything else — the hidden twoPane must not see input here.
			return;
		}

		if (this.screen === ROSTER_SCREEN) {
			if (matchesKey(data, Key.escape)) {
				this.screen = CONFIRM_SCREEN;
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.up)) {
				if (this.rosterIndex > 0) {
					this.rosterIndex--;
					this.tui.requestRender();
				}
				return;
			}
			if (matchesKey(data, Key.down)) {
				if (this.rosterIndex < this.sortedRosters.length - 1) {
					this.rosterIndex++;
					this.tui.requestRender();
				}
				return;
			}
			if (matchesKey(data, Key.enter)) {
				const entry = this.sortedRosters[this.rosterIndex];
				// A roster with no callable models is dimmed and cannot be loaded.
				if (entry && entry.availableSlots > 0) this.applyRoster(entry.roster);
				return;
			}
			return;
		}

		// Model/thinking screens (1..VERIFIER_SCREEN): confirm commits the slot and
		// returns to the overview; back returns without changing the committed pick.
		const action = this.twoPane.handleInput(data);
		if (action === "confirm") {
			this.commitSlot(this.twoPane.getSelected());
			return;
		}
		if (action === "back") {
			this.screen = CONFIRM_SCREEN;
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerWidth = Math.max(20, width - 4);
		const frame = createFrame(th, innerWidth, {
			glyphs: SQUARE_SINGLE_BOX,
			horizontalPadding: 0,
			truncationMark: "...",
			padToWidth: true,
			minimumBodyWidth: 10,
		});
		const bodyWidth = frame.bodyWidth;
		const row = (content: string) => frame.row(` ${content}`);
		const topBorder = frame.top();
		const sepBorder = frame.separator();
		const botBorder = frame.bottom();

		const viewport = ratioViewport(process.stdout.rows, {
			fallbackRows: 24,
			ratio: 0.7,
			minimum: 6,
		});
		if (this.screen === 0) {
			const lines: string[] = [
				topBorder,
				row(th.fg("accent", "Plan mode \u2014 choose how to generate this plan")),
				sepBorder,
				row(""),
			];

			for (let i = 0; i < MODE_ITEMS.length; i++) {
				const item = MODE_ITEMS[i];
				if (!item) continue;
				const isCurrent = i === this.modeIndex;
				const pointer = isCurrent ? th.fg("accent", SELECTOR_POINTER) : UNSELECTED_POINTER;
				const labelText = isCurrent
					? th.bold(th.fg("accent", item.label))
					: th.bold(item.label);
				lines.push(row(pointer + labelText));

				// Description: word-wrapped, indented, muted
				const descWidth = bodyWidth - 4; // 2-char indent inside pad's leading space
				if (item.description && descWidth > 0) {
					const descLines = wrapWords(item.description, descWidth);
					for (const dl of descLines) {
						lines.push(row(th.fg("muted", "  " + dl)));
					}
				}

				// Blank line between cards
				lines.push(row(""));
			}

			lines.push(
				row(th.fg("dim", "\u2191\u2193 navigate \u2022 enter select \u2022 esc cancel")),
				botBorder,
			);
			if (lines.length <= viewport) return lines;
			const compactItems = MODE_ITEMS.map((item, index) => {
				const isCurrent = index === this.modeIndex;
				const pointer = isCurrent ? th.fg("accent", SELECTOR_POINTER) : UNSELECTED_POINTER;
				const label = isCurrent ? th.bold(th.fg("accent", item.label)) : th.bold(item.label);
				return row(pointer + label);
			});
			return [
				topBorder,
				row(th.fg("accent", "Plan mode \u2014 choose how to generate this plan")),
				...compactItems,
				row(th.fg("dim", "\u2191\u2193 navigate \u2022 enter select \u2022 esc cancel")),
				botBorder,
			].slice(0, viewport);
		}

		if (this.screen === CONFIRM_SCREEN) {
			const ready = this.isReady();
			const active = (index: number) => index === this.confirmIndex;
			// `disabled` keeps a focusable row (pointer still shows) but muted, so
			// the not-yet-ready Start action reads as inactive even when selected.
			const slotRow = (label: string, detailText: string, index: number, disabled = false) => {
				const isActive = active(index);
				const pointer = isActive ? th.fg("accent", SELECTOR_POINTER) : UNSELECTED_POINTER;
				const labelText = disabled
					? (isActive ? th.bold(th.fg("muted", label)) : th.fg("dim", label))
					: (isActive ? th.bold(th.fg("accent", label)) : th.bold(label));
				const detailSuffix = detailText ? `  ${th.fg("muted", detailText)}` : "";
				return frame.row(` ${pointer}${labelText}${detailSuffix}`, isActive ? "selectedBg" : undefined);
			};
			const detail = (label: string, ref: ModelRef | undefined, thinking: ThinkingLevel | undefined) => {
				if (!ref) return "(none)";
				const suffix = ` \u00B7 thinking: ${thinking ?? "\u2014"}`;
				// row = leading space (1) + pointer (2) + label + 2-space gap (2) + detail
				const modelWidth = Math.max(4, bodyWidth - 5 - visibleWidth(label) - visibleWidth(suffix));
				return `${smartTruncateModelLabel(modelRefLabel(ref), modelWidth)}${suffix}`;
			};
			const startRow = slotRow("Start fan-out", ready ? "" : this.missingSummary(), START_ROW, !ready);
			const loadEnabled = this.sortedRosters.length > 0;
			const loadRow = slotRow(
				"Load Roster",
				loadEnabled ? `${this.sortedRosters.length} saved` : "no rosters saved — add one in /mf-plan-settings",
				LOAD_ROW,
				!loadEnabled,
			);
			const slotRows = [
				loadRow,
				...this.proposerRefs.map((ref, i) => {
					const label = SLOT_TITLES[i] ?? `Proposer ${i + 1}`;
					return slotRow(label, detail(label, ref, this.proposerThinking[i]), i + 1);
				}),
				slotRow("Synthesizer", detail("Synthesizer", this.synthesizerRef, this.synthesizerThinking), SYNTH_ROW),
				slotRow("Implementer", detail("Implementer", this.implementerRef, this.implementerThinking), IMPLEMENTER_ROW),
				slotRow("Verifier", detail("Verifier", this.verifierRef, this.verifierThinking), VERIFIER_ROW),
				startRow,
			];
			const warning = this.diversityWarning();
			const warningRows = warning
				? wrapWords(warning, bodyWidth - 1).map((line) => row(th.fg("dim", line)))
				: [];
			const reviewRows = [loadRow, row(""), ...slotRows.slice(1, -1), row(""), ...warningRows, startRow];
			const lines = [
				topBorder,
				row(th.fg("accent", "MoA Fusion Pre-flight")),
				sepBorder,
				...reviewRows,
				sepBorder,
				row(th.fg("dim", "\u2191\u2193 navigate \u2022 enter select \u2022 esc back")),
				botBorder,
			];
			if (lines.length <= viewport) return lines;
			// Compact: drop the hints row, then window the visual rows around the
			// pointer so the selected row stays visible without losing separators.
			const maxSlotRows = Math.max(1, viewport - 4);
			const selectedVisualIndex = this.confirmIndex === LOAD_ROW
				? 0
				: this.confirmIndex === START_ROW
					? reviewRows.length - 1
					: this.confirmIndex + 1;
			const start = Math.max(0, Math.min(selectedVisualIndex - Math.floor(maxSlotRows / 2), reviewRows.length - maxSlotRows));
			return [
				topBorder,
				row(th.fg("accent", "MoA Fusion Pre-flight")),
				sepBorder,
				...reviewRows.slice(start, start + maxSlotRows),
				botBorder,
			].slice(0, viewport);
		}

		if (this.screen === ROSTER_SCREEN) {
			const rosterRow = (label: string, summary: string, index: number, disabled: boolean) => {
				const isActive = index === this.rosterIndex;
				const pointer = isActive ? th.fg("accent", SELECTOR_POINTER) : UNSELECTED_POINTER;
				const labelText = disabled
					? (isActive ? th.bold(th.fg("muted", label)) : th.fg("dim", label))
					: (isActive ? th.bold(th.fg("accent", label)) : th.bold(label));
				const detailSuffix = summary ? `  ${th.fg("muted", summary)}` : "";
				return frame.row(` ${pointer}${labelText}${detailSuffix}`);
			};
			const rosterRows = this.sortedRosters.map((entry, index) =>
				rosterRow(entry.roster.name, rosterSummary(entry.roster), index, entry.availableSlots === 0));
			const lines: string[] = [
				topBorder,
				row(th.fg("accent", "Load Roster")),
				sepBorder,
				...(rosterRows.length > 0 ? rosterRows : [row(th.fg("dim", "No rosters saved — create them in /mf-plan-settings."))]),
				sepBorder,
				row(th.fg("dim", "\u2191\u2193 navigate \u2022 enter load \u2022 esc back")),
				botBorder,
			];
			if (lines.length <= viewport) return lines;
			// Window roster rows around the pointer, mirroring the overview's compact path.
			const maxRosterRows = Math.max(1, viewport - 4);
			const start = Math.max(0, Math.min(this.rosterIndex - Math.floor(maxRosterRows / 2), rosterRows.length - maxRosterRows));
			return [
				topBorder,
				row(th.fg("accent", "Load Roster")),
				sepBorder,
				...rosterRows.slice(start, start + maxRosterRows),
				botBorder,
			].slice(0, viewport);
		}

		// Screens 1..VERIFIER_SCREEN — model-select screens (proposers 1-5,
		// synthesizer, implementer, verifier).
		const isProposerScreen = this.screen >= 1 && this.screen <= MAX_PROPOSERS;
		const nonProposerLabel = this.screen === IMPLEMENTER_SCREEN
			? "Implementer"
			: this.screen === VERIFIER_SCREEN
				? "Verifier"
				: "Synthesizer";
		const slotLabel = isProposerScreen ? (SLOT_TITLES[this.screen - 1] ?? "Synthesizer") : nonProposerLabel;
		const roleSubtitle = this.screen === IMPLEMENTER_SCREEN
			? " \u2014 writes the approved plan"
			: this.screen === VERIFIER_SCREEN
				? " \u2014 checks the implementation against the plan"
				: "";
		const title = isProposerScreen
			? `${slotLabel} (${this.screen}/${MAX_PROPOSERS})`
			: `${slotLabel} model${roleSubtitle}`;
		const hints = HINT_BASE + " • esc back";
		const { actionRow, hintRows } = this.twoPane.renderFooter(bodyWidth, hints);
		this.twoPane.setMaxVisibleRows(Math.max(1, viewport - 8 - (hintRows.length - 1)));
		const twoPaneLines = this.twoPane.render(bodyWidth);
		const framedPane = twoPaneLines.map((line) => frame.row(line));
		const lines: string[] = [
			topBorder,
			row(th.fg("accent", title)),
			sepBorder,
			...framedPane,
			sepBorder,
			frame.row(actionRow),
			sepBorder,
			...hintRows.map((line) => frame.row(line)),
			botBorder,
		];
		if (lines.length <= viewport) return lines;
		return [
			topBorder,
			row(th.fg("accent", title)),
			...framedPane.slice(0, Math.max(1, viewport - 4)),
			frame.row(actionRow),
			botBorder,
		].slice(0, viewport);
	}

	invalidate(): void {
		this.twoPane.invalidate();
	}
}

/**
 * Show the MoA model-select picker. In MoA mode it covers every role up front
 * — proposers, synthesizer, implementer, and verifier — so approval applies
 * the pre-picked implementer with no second picker. Returns `undefined` if the
 * user cancelled outright (Esc from the mode screen) — cancels and keeps the
 * current model without prompting. Returns `{ mode: "single" }` when the
 * user chose "Single model", which additionally opens the
 * implementing-model picker downstream.
 */
export async function showMoaModelPicker(
	ctx: ExtensionContext,
	currentThinking: ThinkingLevel,
): Promise<MoaPickerResult | undefined> {
	if (!ctx.hasUI) return { mode: "single" };

	const available = getAvailableModelRefs(ctx);

	if (available.length === 0) {
		// No models to pick from — fall back silently to single-model behavior.
		return { mode: "single" };
	}

	const saved = loadMoaConfig();
	const defaultMode = moaSettingsExist() ? saved.mode : "moa";
	const currentModelRef: ModelRef | undefined = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
	const hasValidSaved = saved.proposers.length >= MIN_PROPOSERS
		&& saved.proposers.length <= MAX_PROPOSERS
		&& saved.synthesizer !== undefined;
	const defaultSlots: ModelRef[] = hasValidSaved
		? (() => {
			const fill = currentModelRef ?? saved.proposers[0]!;
			const slots = Array.from({ length: MAX_PROPOSERS + 3 }, () => fill);
			for (let i = 0; i < saved.proposers.length && i < MAX_PROPOSERS; i++) {
				slots[i] = saved.proposers[i]!;
			}
			slots[MAX_PROPOSERS] = saved.synthesizer!;
			slots[MAX_PROPOSERS + 1] = saved.implementer ?? fill;
			slots[MAX_PROPOSERS + 2] = saved.verifier ?? fill;
			return slots;
		})()
		: currentModelRef
			? Array.from({ length: MAX_PROPOSERS + 3 }, () => currentModelRef)
			: [];

	return await ctx.ui.custom<MoaPickerResult | undefined>(
		(tui, theme, _keybindings, done) =>
			new MoaModelPickerComponent(
				tui,
				theme,
				available,
				{ mode: defaultMode, slots: defaultSlots },
				saved,
				currentThinking,
				saved.rosters,
				ctx,
				done,
			),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "82%",
				minWidth: 64,
				maxHeight: "70%",
				margin: 1,
			},
		},
	);
}

class ImplementingModelPickerComponent implements Component {
	private readonly twoPane: TwoPaneModelThinking;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		availableRefs: ModelRef[],
		config: MoaConfig,
		currentThinking: ThinkingLevel,
		private readonly ctx: ExtensionContext,
		defaultRef: ModelRef | undefined,
		defaultThinking: ThinkingLevel | undefined,
		private readonly title: string,
		private readonly done: (result: { ref: ModelRef; thinking: ThinkingLevel } | undefined) => void,
	) {
		this.twoPane = new TwoPaneModelThinking(tui, theme, availableRefs, config, currentThinking, ctx);
		this.twoPane.reset(defaultRef, defaultThinking);
	}

	handleInput(data: string): void {
		const action = this.twoPane.handleInput(data);
		if (action === "confirm") this.done(this.twoPane.getSelected());
		else if (action === "back") this.done(undefined);
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerWidth = Math.max(20, width - 4);
		const frame = createFrame(th, innerWidth, {
			glyphs: SQUARE_SINGLE_BOX,
			horizontalPadding: 0,
			truncationMark: "...",
			padToWidth: true,
			minimumBodyWidth: 10,
		});
		const bodyWidth = frame.bodyWidth;
		const row = (content: string) => frame.row(` ${content}`);
		const viewport = ratioViewport(process.stdout.rows, {
			fallbackRows: 24,
			ratio: 0.7,
			minimum: 6,
		});
		const { actionRow, hintRows } = this.twoPane.renderFooter(bodyWidth, HINT_BASE + " • esc keep current");
		this.twoPane.setMaxVisibleRows(Math.max(1, viewport - 8 - (hintRows.length - 1)));
		const twoPaneLines = this.twoPane.render(bodyWidth);
		const framedPane = twoPaneLines.map((line) => frame.row(line));
		const lines = [
			frame.top(),
			row(th.fg("accent", this.title)),
			frame.separator(),
			...framedPane,
			frame.separator(),
			frame.row(actionRow),
			frame.separator(),
			...hintRows.map((line) => frame.row(line)),
			frame.bottom(),
		];
		if (lines.length <= viewport) return lines;
		return [
			frame.top(),
			row(th.fg("accent", this.title)),
			...framedPane.slice(0, Math.max(1, viewport - 4)),
			frame.row(actionRow),
			frame.bottom(),
		].slice(0, viewport);
	}

	invalidate(): void {
		this.twoPane.invalidate();
	}
}

/**
 * Show a one-shot two-pane picker for one model + thinking level, shared by the
 * implementing-model prompt and the roster editor's per-slot picks. Defaults
 * the highlight to `defaultRef`/`defaultThinking` when given. Returns the
 * chosen pair, or `undefined` if the user cancelled or no UI is available
 * (non-interactive mode).
 */
export async function showModelThinkingPicker(
	ctx: ExtensionContext,
	currentThinking: ThinkingLevel,
	title: string,
	defaultRef?: ModelRef,
	defaultThinking?: ThinkingLevel,
): Promise<{ ref: ModelRef; thinking: ThinkingLevel } | undefined> {
	if (!ctx.hasUI) return undefined;

	const available = getAvailableModelRefs(ctx);
	if (available.length === 0) return undefined;

	const saved = loadMoaConfig();

	return await ctx.ui.custom<{ ref: ModelRef; thinking: ThinkingLevel } | undefined>(
		(tui, theme, _keybindings, done) =>
			new ImplementingModelPickerComponent(
				tui,
				theme,
				available,
				saved,
				currentThinking,
				ctx,
				defaultRef,
				defaultThinking,
				title,
				done,
			),
		PLAN_OVERLAY_OPTIONS,
	);
}

/**
 * Show a one-shot picker for which model implements the approved MoA plan.
 * Defaults the highlighted selection to the saved implementing model, then the active model.
 * Returns the chosen model and thinking level, or `undefined` if the user cancelled or
 * no UI is available (non-interactive mode).
 */
export async function showImplementingModelPicker(
	ctx: ExtensionContext,
	currentThinking: ThinkingLevel,
	title = "Implementing model — choose a model and thinking level",
): Promise<{ ref: ModelRef; thinking: ThinkingLevel } | undefined> {
	if (!ctx.hasUI) return undefined;

	const saved = loadMoaConfig();
	const preferredRef = saved.implementer
		?? (ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined);

	return await showModelThinkingPicker(ctx, currentThinking, title, preferredRef);
}
