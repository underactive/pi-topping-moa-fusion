import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { loadMoaConfig, type MoaConfig } from "../config/settings.ts";
import { modelRefLabel, type ModelRef, type ThinkingLevel } from "../shared/modelRefs.ts";
import {
	SELECTOR_POINTER,
	SQUARE_SINGLE_BOX,
	UNSELECTED_POINTER,
	createFrame,
	ratioViewport,
} from "./chrome.ts";
import { getAvailableModelRefs } from "./moaModelPicker.ts";
import { smartTruncateModelLabel } from "./modelLabel.ts";
import { TwoPaneModelThinking } from "./twoPaneModelThinking.ts";

const HINT_BASE = "type filters models • ↑↓ navigate pane • tab panes/buttons • ←→ switch/select • enter select";

export const MAX_DEBATE_MODELS = 5;
export const MIN_DEBATE_MODELS = 2;
export const MIN_DEBATE_ROUNDS = 2;
export const MAX_DEBATE_ROUNDS = 5;
export const ROUNDS_ROW = MAX_DEBATE_MODELS;
export const START_ROW = MAX_DEBATE_MODELS + 1;
export const OVERVIEW_ROW_COUNT = MAX_DEBATE_MODELS + 2;
const OVERVIEW_SCREEN = 0;
const SLOT_TITLES = ["Debater 1", "Debater 2", "Debater 3", "Debater 4", "Debater 5"];

export interface DebatePickerResult {
	models: ModelRef[];
	thinking: (ThinkingLevel | undefined)[];
	thinkingSelections: Record<string, ThinkingLevel>;
	rounds: number;
}

export class DebateModelPickerComponent implements Component {
	private screen = OVERVIEW_SCREEN;
	private overviewIndex = 0;
	private rounds: number;
	private readonly refs: (ModelRef | undefined)[] = Array.from({ length: MAX_DEBATE_MODELS }, () => undefined);
	private readonly thinking: (ThinkingLevel | undefined)[] = Array.from({ length: MAX_DEBATE_MODELS }, () => undefined);
	private readonly thinkingSelections: Record<string, ThinkingLevel> = {};
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly defaults: (ModelRef | undefined)[];
	private readonly done: (result: DebatePickerResult | undefined) => void;
	private readonly twoPane: TwoPaneModelThinking;

	constructor(
		tui: TUI,
		theme: Theme,
		availableRefs: ModelRef[],
		defaults: (ModelRef | undefined)[],
		config: MoaConfig,
		currentThinking: ThinkingLevel,
		ctx: ExtensionContext,
		done: (result: DebatePickerResult | undefined) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.defaults = defaults;
		this.done = done;
		this.rounds = Math.min(MAX_DEBATE_ROUNDS, Math.max(MIN_DEBATE_ROUNDS, config.debateRounds));
		this.twoPane = new TwoPaneModelThinking(tui, theme, availableRefs, config, currentThinking, ctx);
	}

	private assignedCount(): number {
		return this.refs.reduce((count, ref) => count + (ref ? 1 : 0), 0);
	}

	private isReady(): boolean {
		return this.assignedCount() >= MIN_DEBATE_MODELS;
	}

	private openSlot(slot: number): void {
		const committed = this.refs[slot];
		if (committed) this.twoPane.reset(committed, this.thinking[slot]);
		else this.twoPane.reset(this.defaults[slot]);
		this.screen = slot + 1;
		this.tui.requestRender();
	}

	private commitSlot(selection: { ref: ModelRef; thinking: ThinkingLevel }): void {
		const slot = this.screen - 1;
		this.refs[slot] = selection.ref;
		this.thinking[slot] = selection.thinking;
		this.thinkingSelections[modelRefLabel(selection.ref)] = selection.thinking;
		this.screen = OVERVIEW_SCREEN;
		this.tui.requestRender();
	}

	finish(): void {
		if (!this.isReady()) return;
		const models: ModelRef[] = [];
		const thinking: (ThinkingLevel | undefined)[] = [];
		for (let index = 0; index < MAX_DEBATE_MODELS; index++) {
			const ref = this.refs[index];
			if (!ref) continue;
			models.push(ref);
			thinking.push(this.thinking[index]);
		}
		this.done({ models, thinking, thinkingSelections: { ...this.thinkingSelections }, rounds: this.rounds });
	}

	handleInput(data: string): void {
		if (this.screen === OVERVIEW_SCREEN) {
			if (this.overviewIndex === ROUNDS_ROW && matchesKey(data, Key.left)) {
				this.rounds = Math.max(MIN_DEBATE_ROUNDS, this.rounds - 1);
				this.tui.requestRender();
				return;
			}
			if (this.overviewIndex === ROUNDS_ROW && matchesKey(data, Key.right)) {
				this.rounds = Math.min(MAX_DEBATE_ROUNDS, this.rounds + 1);
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.up)) {
				if (this.overviewIndex > 0) {
					this.overviewIndex--;
					this.tui.requestRender();
				}
				return;
			}
			if (matchesKey(data, Key.down)) {
				if (this.overviewIndex < OVERVIEW_ROW_COUNT - 1) {
					this.overviewIndex++;
					this.tui.requestRender();
				}
				return;
			}
			if (matchesKey(data, Key.enter)) {
				if (this.overviewIndex < ROUNDS_ROW) this.openSlot(this.overviewIndex);
				else if (this.overviewIndex === START_ROW) this.finish();
				return;
			}
			if (matchesKey(data, Key.escape)) this.done(undefined);
			return;
		}

		const action = this.twoPane.handleInput(data);
		if (action === "confirm") this.commitSlot(this.twoPane.getSelected());
		else if (action === "back") {
			this.screen = OVERVIEW_SCREEN;
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
		const viewport = ratioViewport(process.stdout.rows, {
			fallbackRows: 24,
			ratio: 0.7,
			minimum: 6,
		});

		if (this.screen === OVERVIEW_SCREEN) {
			const ready = this.isReady();
			const remaining = MIN_DEBATE_MODELS - this.assignedCount();
			const slotRow = (label: string, detail: string, index: number, disabled = false) => {
				const active = index === this.overviewIndex;
				const pointer = active ? th.fg("accent", SELECTOR_POINTER) : UNSELECTED_POINTER;
				const labelText = disabled
					? (active ? th.bold(th.fg("muted", label)) : th.fg("dim", label))
					: (active ? th.bold(th.fg("accent", label)) : th.bold(label));
				return frame.row(` ${pointer}${labelText}${detail ? `  ${th.fg("muted", detail)}` : ""}`);
			};
			const detail = (label: string, ref: ModelRef | undefined, thinking: ThinkingLevel | undefined) => {
				if (!ref) return "(none)";
				const suffix = ` · thinking: ${thinking ?? "—"}`;
				const modelWidth = Math.max(4, bodyWidth - 5 - visibleWidth(label) - visibleWidth(suffix));
				return `${smartTruncateModelLabel(modelRefLabel(ref), modelWidth)}${suffix}`;
			};
			const slotRows = this.refs.map((ref, index) => {
				const label = SLOT_TITLES[index] ?? `Debater ${index + 1}`;
				return slotRow(label, detail(label, ref, this.thinking[index]), index);
			});
			const roundsRow = slotRow(
				"Rounds",
				`${this.rounds}  (←/→ to adjust)`,
				ROUNDS_ROW,
			);
			const action = slotRow(
				"Start debate",
				ready ? "" : `needs ${remaining} more debating model${remaining === 1 ? "" : "s"}`,
				START_ROW,
				!ready,
			);
			const fullRows = [...slotRows, roundsRow, row(""), action];
			const lines = [
				frame.top(),
				row(th.fg("accent", "Select Debating Models")),
				frame.separator(),
				...fullRows,
				frame.separator(),
				row(th.fg("dim", "↑↓ navigate • enter select • esc cancel")),
				frame.bottom(),
			];
			if (lines.length <= viewport) return lines;
			const maxRows = Math.max(1, viewport - 4);
			const compactRows = [...slotRows, roundsRow, action];
			const start = Math.max(0, Math.min(this.overviewIndex - Math.floor(maxRows / 2), compactRows.length - maxRows));
			return [
				frame.top(),
				row(th.fg("accent", "Select Debating Models")),
				frame.separator(),
				...compactRows.slice(start, start + maxRows),
				frame.bottom(),
			].slice(0, viewport);
		}

		const slot = this.screen - 1;
		const { actionRow, hintRows } = this.twoPane.renderFooter(bodyWidth, `${HINT_BASE} • esc back`);
		this.twoPane.setMaxVisibleRows(Math.max(1, viewport - 8 - (hintRows.length - 1)));
		const pane = this.twoPane.render(bodyWidth).map((line) => frame.row(line));
		const lines = [
			frame.top(),
			row(th.fg("accent", `Debater ${slot + 1} (${slot + 1}/${MAX_DEBATE_MODELS})`)),
			frame.separator(),
			...pane,
			frame.separator(),
			frame.row(actionRow),
			frame.separator(),
			...hintRows.map((line) => frame.row(line)),
			frame.bottom(),
		];
		if (lines.length <= viewport) return lines;
		return [frame.top(), row(th.fg("accent", `Debater ${slot + 1}`)), ...pane.slice(0, Math.max(1, viewport - 4)), frame.row(actionRow), frame.bottom()].slice(0, viewport);
	}

	invalidate(): void {
		this.twoPane.invalidate();
	}
}

export async function showDebateModelPicker(
	ctx: ExtensionContext,
	currentThinking: ThinkingLevel,
): Promise<DebatePickerResult | undefined> {
	if (!ctx.hasUI) return undefined;
	const available = getAvailableModelRefs(ctx);
	if (available.length === 0) return undefined;

	const saved = loadMoaConfig();
	const current = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
	const fallback = current ?? saved.debateModels[0];
	const defaults = Array.from({ length: MAX_DEBATE_MODELS }, (_, index) =>
		saved.debateModels[index] ?? fallback,
	);

	return await ctx.ui.custom<DebatePickerResult | undefined>(
		(tui, theme, _keybindings, done) =>
			new DebateModelPickerComponent(tui, theme, available, defaults, saved, currentThinking, ctx, done),
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
