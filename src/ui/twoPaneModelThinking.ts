import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Key, matchesKey, SelectList, truncateToWidth, visibleWidth, type SelectItem, type TUI } from "@earendil-works/pi-tui";
import { renderMenuFooterContents } from "./menu.ts";
import { MODEL_LIST_LAYOUT } from "./modelLabel.ts";
import { getModelCatalogue } from "../config/modelCatalogue.ts";
import {
	defaultThinkingForModel,
	thinkingOptionsForModel,
	type MoaConfig,
} from "../config/settings.ts";
import {
	isThinkingLevel,
	modelRefLabel,
	THINKING_LEVELS,
	type ModelRef,
	type ThinkingLevel,
} from "../shared/modelRefs.ts";

const MAX_VISIBLE_ROWS = 10;

function modelThinkingPaneWidths(bodyWidth: number): { left: number; right: number } {
	const divider = 1;
	const longestLevel = THINKING_LEVELS.reduce((longest, level) => level.length > longest.length ? level : longest);
	// One composed inset plus SelectList's two safety columns after its selector.
	const rightMin = Math.max(visibleWidth(" Thinking"), visibleWidth(`→ ${longestLevel}`) + 3);
	const right = Math.max(1, Math.min(rightMin, Math.max(1, bodyWidth - divider - 1)));
	return { left: Math.max(1, bodyWidth - divider - right), right };
}

function buildSelectListTheme(theme: Theme) {
	const base = getSelectListTheme();
	return {
		...base,
		selectedText: (text: string) => theme.bg("selectedBg", base.selectedText(text)),
		selectedPrefix: (text: string) => theme.bg("selectedBg", base.selectedPrefix(text)),
	};
}

export function parseRef(value: string): ModelRef {
	const idx = value.indexOf("/");
	if (idx === -1) return { provider: value, id: "" };
	return { provider: value.slice(0, idx), id: value.slice(idx + 1) };
}

function toModelItems(refs: ModelRef[]): SelectItem[] {
	return refs.map((ref) => ({ value: modelRefLabel(ref), label: modelRefLabel(ref) }));
}

/**
 * Reusable two-pane selector: models on the left and model-specific thinking
 * levels on the right. The model filter always owns text input; Tab or the
 * left/right arrows move the selection focus between panes.
 */
export class TwoPaneModelThinking {
	private modelList: SelectList;
	private levelList: SelectList;
	private filter = "";
	private activePane: "model" | "level" | "buttons" = "model";
	private activeButton = 0;
	private maxVisibleRows = MAX_VISIBLE_ROWS;
	private readonly modelItems: SelectItem[];

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		availableRefs: ModelRef[],
		private readonly config: MoaConfig,
		private readonly currentThinking: ThinkingLevel,
		private readonly ctx: ExtensionContext,
	) {
		this.modelItems = toModelItems(availableRefs);
		this.modelList = new SelectList([], 1, buildSelectListTheme(theme));
		this.levelList = new SelectList([], 1, buildSelectListTheme(theme));
		this.reset();
	}

	isModelPane(): boolean {
		return this.activePane === "model";
	}

	/** Limit the complete two-pane body, including filter/header/scroll rows. */
	setMaxVisibleRows(limit: number): void {
		const next = Math.max(1, Math.floor(limit));
		if (next === this.maxVisibleRows) return;
		this.maxVisibleRows = next;
		this.rebuildPreservingSelection();
	}

	reset(defaultRef?: ModelRef, defaultThinking?: ThinkingLevel): void {
		this.filter = "";
		this.activePane = "model";
		this.activeButton = 0;
		this.rebuildModelList();
		if (defaultRef) {
			const defaultIndex = this.modelItems.findIndex((item) => item.value === modelRefLabel(defaultRef));
			if (defaultIndex >= 0) this.modelList.setSelectedIndex(defaultIndex);
		}
		this.rebuildThinkingList();
		if (defaultThinking) this.selectThinking(defaultThinking);
	}

	private selectThinking(thinking: ThinkingLevel): void {
		const key = this.modelList.getSelectedItem()?.value;
		if (!key) return;
		const levels = thinkingOptionsForModel(getModelCatalogue(this.ctx.modelRegistry).thinkingLevelsFor(parseRef(key)));
		const index = levels.indexOf(thinking);
		if (index >= 0) this.levelList.setSelectedIndex(index);
	}

	private listItemRows(itemCount: number): number {
		const chromeRows = 1 + (this.filter ? 1 : 0);
		const available = Math.max(1, this.maxVisibleRows - chromeRows);
		return itemCount > available ? Math.max(1, available - 1) : available;
	}

	private filteredModelItems(): SelectItem[] {
		return this.filter.trim()
			? fuzzyFilter(this.modelItems, this.filter, (item) => item.label)
			: this.modelItems;
	}

	private rebuildModelList(): SelectItem[] {
		const items = this.filteredModelItems();
		this.modelList = new SelectList(
			items,
			Math.min(Math.max(items.length, 1), this.listItemRows(items.length)),
			buildSelectListTheme(this.theme),
			MODEL_LIST_LAYOUT,
		);
		this.modelList.onSelectionChange = () => {
			this.rebuildThinkingList();
			this.tui.requestRender();
		};
		return items;
	}

	private rebuildPreservingSelection(): void {
		const selectedModel = this.modelList.getSelectedItem()?.value;
		const selectedLevel = this.levelList.getSelectedItem()?.value;
		const items = this.rebuildModelList();
		if (selectedModel) {
			const index = items.findIndex((item) => item.value === selectedModel);
			if (index >= 0) this.modelList.setSelectedIndex(index);
		}
		this.rebuildThinkingList();
		if (selectedLevel && isThinkingLevel(selectedLevel)) this.selectThinking(selectedLevel);
	}

	private rebuildThinkingList(): void {
		const key = this.modelList.getSelectedItem()?.value;
		const registryLevels = key
			? getModelCatalogue(this.ctx.modelRegistry).thinkingLevelsFor(parseRef(key))
			: [];
		const levels = thinkingOptionsForModel(registryLevels);
		const items = (levels.length > 0 ? levels : ["off"]).map((level) => ({ value: level, label: level }));
		this.levelList = new SelectList(items, Math.min(Math.max(items.length, 1), this.listItemRows(items.length)), buildSelectListTheme(this.theme));
		if (!key) return;
		const preferred = defaultThinkingForModel(key, this.config, this.currentThinking, registryLevels);
		const preferredIndex = levels.indexOf(preferred);
		if (preferredIndex >= 0) this.levelList.setSelectedIndex(preferredIndex);
	}

	handleInput(data: string): "confirm" | "back" | undefined {
		if (matchesKey(data, Key.escape)) return "back";
		if (matchesKey(data, Key.tab)) {
			// Tab cycles Models → Thinking → action buttons → Models;
			// left/right continue to switch between Models and Thinking (or
			// between buttons, once the action bar is focused).
			this.activePane = this.activePane === "model" ? "level" : this.activePane === "level" ? "buttons" : "model";
			this.tui.requestRender();
			return undefined;
		}
		if (this.activePane === "buttons") {
			if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
				this.activeButton = this.activeButton === 0 ? 1 : 0;
				this.tui.requestRender();
				return undefined;
			}
			if (matchesKey(data, Key.enter)) {
				return this.activeButton === 0 && this.modelList.getSelectedItem() && this.levelList.getSelectedItem()
					? "confirm"
					: "back";
			}
			return undefined;
		}
		if (matchesKey(data, Key.enter)) {
			return this.modelList.getSelectedItem() && this.levelList.getSelectedItem() ? "confirm" : undefined;
		}
		if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
			this.activePane = this.activePane === "model" ? "level" : "model";
			this.tui.requestRender();
			return undefined;
		}
		if (data === "\x7f" || data === "\b") {
			this.activePane = "model";
			if (this.filter.length > 0) {
				this.filter = this.filter.slice(0, -1);
				this.rebuildPreservingSelection();
				this.tui.requestRender();
			}
			return undefined;
		}
		if (data.length === 1 && data >= " " && data !== "\x7f") {
			this.activePane = "model";
			this.filter += data;
			this.rebuildPreservingSelection();
			this.tui.requestRender();
			return undefined;
		}
		(this.activePane === "model" ? this.modelList : this.levelList).handleInput(data);
		this.tui.requestRender();
		return undefined;
	}

	getSelected(): { ref: ModelRef; thinking: ThinkingLevel } {
		const model = this.modelList.getSelectedItem();
		const level = this.levelList.getSelectedItem();
		if (!model || !level || !isThinkingLevel(level.value)) {
			throw new Error("Cannot confirm an empty model or thinking-level selection");
		}
		return { ref: parseRef(model.value), thinking: level.value };
	}

	render(bodyWidth: number): string[] {
		const { left: leftWidth, right: rightWidth } = modelThinkingPaneWidths(bodyWidth);
		const column = (text: string, width: number) => truncateToWidth(text, width, "", true);
		const paneDivider = this.theme.fg("border", "│");
		const headers = column(
			this.activePane === "model" ? this.theme.bold(this.theme.fg("accent", " Models")) : this.theme.bold(" Models"),
			leftWidth,
		) + paneDivider + column(
			` ${this.activePane === "level" ? this.theme.bold(this.theme.fg("accent", "Thinking")) : this.theme.bold("Thinking")}`,
			rightWidth,
		);
		const modelLines = this.modelList.render(Math.max(1, leftWidth - 1));
		const levelLines = this.levelList.render(Math.max(1, rightWidth - 1));
		const rows = Math.max(modelLines.length, levelLines.length);
		const lines = [
			...(this.filter ? [column(this.theme.fg("muted", ` filter: ${this.filter}`), bodyWidth)] : []),
			headers,
		];
		for (let index = 0; index < rows; index++) {
			const line = column(` ${modelLines[index] ?? ""}`, leftWidth)
				+ paneDivider
				+ column(` ${levelLines[index] ?? ""}`, rightWidth);
			lines.push(line);
		}
		return lines.slice(0, this.maxVisibleRows);
	}

	renderFooter(bodyWidth: number, hints: string): { actionRow: string; hintRows: string[] } {
		const buttonText = (label: string, index: number) => {
			const isActive = this.activeButton === index;
			const text = isActive ? `[ ${label} ]` : `‹ ${label} ›`;
			return isActive && this.activePane === "buttons"
				? this.theme.bold(this.theme.fg("accent", text))
				: this.theme.fg("muted", text);
		};
		const rows = renderMenuFooterContents(
			this.theme,
			bodyWidth,
			`${buttonText("Select", 0)}    ${buttonText("Cancel", 1)}`,
			hints,
			{ wrapHints: true },
		);
		return { actionRow: rows[1] ?? "", hintRows: rows.slice(3) };
	}

	invalidate(): void {
		this.modelList.invalidate();
		this.levelList.invalidate();
	}
}
