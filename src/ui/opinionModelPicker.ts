import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { loadMoaConfig, type MoaConfig } from "../config/settings.ts";
import { modelRefLabel, type ModelRef, type ThinkingLevel } from "../shared/modelRefs.ts";
import { SQUARE_SINGLE_BOX, createFrame, ratioViewport } from "./chrome.ts";
import { getAvailableModelRefs } from "./moaModelPicker.ts";
import { smartTruncateModelLabel } from "./modelLabel.ts";
import { TwoPaneModelThinking } from "./twoPaneModelThinking.ts";

const HINT_BASE = "type filters models • ↑↓ navigate pane • tab panes/buttons • ←→ switch/select • enter select";

export const MAX_OPINION_MODELS = 5;
export const MIN_OPINION_MODELS = 1;
export const START_ROW = MAX_OPINION_MODELS;
export const OVERVIEW_ROW_COUNT = MAX_OPINION_MODELS + 1;
const OVERVIEW_SCREEN = 0;
const SLOT_TITLES = ["Opinion 1", "Opinion 2", "Opinion 3", "Opinion 4", "Opinion 5"];

export interface OpinionPickerResult {
	models: ModelRef[];
	thinking: (ThinkingLevel | undefined)[];
	thinkingSelections: Record<string, ThinkingLevel>;
}

export class OpinionModelPickerComponent implements Component {
	private screen = OVERVIEW_SCREEN;
	private overviewIndex = 0;
	private readonly refs: (ModelRef | undefined)[] = Array.from({ length: MAX_OPINION_MODELS }, () => undefined);
	private readonly thinking: (ThinkingLevel | undefined)[] = Array.from({ length: MAX_OPINION_MODELS }, () => undefined);
	private readonly thinkingSelections: Record<string, ThinkingLevel> = {};
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly defaults: (ModelRef | undefined)[];
	private readonly done: (result: OpinionPickerResult | undefined) => void;
	private readonly twoPane: TwoPaneModelThinking;

	constructor(
		tui: TUI,
		theme: Theme,
		availableRefs: ModelRef[],
		defaults: (ModelRef | undefined)[],
		config: MoaConfig,
		currentThinking: ThinkingLevel,
		ctx: ExtensionContext,
		done: (result: OpinionPickerResult | undefined) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.defaults = defaults;
		this.done = done;
		this.twoPane = new TwoPaneModelThinking(tui, theme, availableRefs, config, currentThinking, ctx);
	}

	private assignedCount(): number {
		return this.refs.reduce((count, ref) => count + (ref ? 1 : 0), 0);
	}

	private isReady(): boolean {
		return this.assignedCount() >= MIN_OPINION_MODELS;
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
		for (let index = 0; index < MAX_OPINION_MODELS; index++) {
			const ref = this.refs[index];
			if (!ref) continue;
			models.push(ref);
			thinking.push(this.thinking[index]);
		}
		this.done({ models, thinking, thinkingSelections: { ...this.thinkingSelections } });
	}

	handleInput(data: string): void {
		if (this.screen === OVERVIEW_SCREEN) {
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
				if (this.overviewIndex < START_ROW) this.openSlot(this.overviewIndex);
				else this.finish();
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
			const slotRow = (label: string, detail: string, index: number, disabled = false) => {
				const active = index === this.overviewIndex;
				const pointer = active ? th.fg("accent", "▸ ") : "  ";
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
				const label = SLOT_TITLES[index] ?? `Opinion ${index + 1}`;
				return slotRow(label, detail(label, ref, this.thinking[index]), index);
			});
			const action = slotRow("Get opinions", ready ? "" : "needs 1 opinion model", START_ROW, !ready);
			const fullRows = [...slotRows, row(""), action];
			const lines = [
				frame.top(),
				row(th.fg("accent", "Select Opinion Models")),
				frame.separator(),
				...fullRows,
				frame.separator(),
				row(th.fg("dim", "↑↓ navigate • enter select • esc cancel")),
				frame.bottom(),
			];
			if (lines.length <= viewport) return lines;
			const maxRows = Math.max(1, viewport - 4);
			const compactRows = [...slotRows, action];
			const start = Math.max(0, Math.min(this.overviewIndex - Math.floor(maxRows / 2), compactRows.length - maxRows));
			return [
				frame.top(),
				row(th.fg("accent", "Select Opinion Models")),
				frame.separator(),
				...compactRows.slice(start, start + maxRows),
				frame.bottom(),
			].slice(0, viewport);
		}

		const slot = this.screen - 1;
		const { actionRow, hintRows } = this.twoPane.renderFooter(bodyWidth, `${HINT_BASE} • esc back`);
		this.twoPane.setMaxVisibleRows(Math.max(1, viewport - 8 - (hintRows.length - 1)));
		const pane = this.twoPane.render(bodyWidth).map(frame.row);
		const lines = [
			frame.top(),
			row(th.fg("accent", `Opinion ${slot + 1} (${slot + 1}/${MAX_OPINION_MODELS})`)),
			frame.separator(),
			...pane,
			frame.separator(),
			frame.row(actionRow),
			frame.separator(),
			...hintRows.map(frame.row),
			frame.bottom(),
		];
		if (lines.length <= viewport) return lines;
		return [frame.top(), row(th.fg("accent", `Opinion ${slot + 1}`)), ...pane.slice(0, Math.max(1, viewport - 4)), frame.row(actionRow), frame.bottom()].slice(0, viewport);
	}

	invalidate(): void {
		this.twoPane.invalidate();
	}
}

export async function showOpinionModelPicker(
	ctx: ExtensionContext,
	currentThinking: ThinkingLevel,
): Promise<OpinionPickerResult | undefined> {
	if (!ctx.hasUI) return undefined;
	const available = getAvailableModelRefs(ctx);
	if (available.length === 0) return undefined;

	const saved = loadMoaConfig();
	const current = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
	const fallback = current ?? saved.opinionModels[0];
	const defaults = Array.from({ length: MAX_OPINION_MODELS }, (_, index) =>
		saved.opinionModels[index] ?? fallback,
	);

	return await ctx.ui.custom<OpinionPickerResult | undefined>(
		(tui, theme, _keybindings, done) =>
			new OpinionModelPickerComponent(tui, theme, available, defaults, saved, currentThinking, ctx, done),
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
