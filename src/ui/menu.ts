import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type KeybindingsManager,
	Key,
	matchesKey,
	type OverlayOptions,
	truncateToWidth,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { fitVisible, SELECTOR, wrapWords } from "./chrome.ts";

/** A boolean setting that can be changed with Space. */
export interface ToggleMenuItem {
	id: string;
	label: string;
	value: boolean;
	onChange?: (value: boolean) => void;
}

/** An Enter-activated row, optionally with a right-aligned displayed value. */
export interface ActionMenuItem {
	id: string;
	label: string;
	displayValue?: string;
	/** Dimmed helper text wrapped under the row. */
	description?: string;
	onSelect: () => void;
}

/** A setting whose values are selected inline with the left/right keys. */
export interface ChoiceMenuItem {
	id: string;
	label: string;
	values: string[];
	valueIndex: number;
	/** Dimmed helper text wrapped under the row. */
	description?: string;
	onChange?: (valueIndex: number, displayValue: string) => void;
}

export type MenuItem = ToggleMenuItem | ActionMenuItem | ChoiceMenuItem;

export interface MenuButton {
	id: string;
	label: string;
	primary?: boolean;
	onSelect: () => void;
}

export interface MenuSection {
	title: string;
	items: MenuItem[];
}

export interface MenuConfig {
	title: string;
	sections: MenuSection[];
	buttons?: MenuButton[];
	/** Expand the menu frame to the available overlay width rather than its content width. */
	fullWidth?: boolean;
	hints?: string[];
	/**
	 * Cap the item rows a section renders at once, scrolling the rest with the
	 * cursor, so a tall menu stays inside the overlay's height budget.
	 */
	maxItemsPerSection?: number;
	/** Handle a key against the selected item before standard menu navigation. Returning true consumes the key. */
	onItemKey?: (item: MenuItem, data: string) => boolean;
	/** Initially focused item, used when reopening sequential overlays. */
	initialItemId?: string;
	preview?: (values: Record<string, boolean>, elapsedMs: number) => string[];
	previewIntervalMs?: number;
}

export interface MenuResult<T> {
	applied: boolean;
	values: T;
}

const DEFAULT_HINTS = ["↑↓ item", "←→ value", "⏎ select", "esc cancel"];
const MIN_WIDTH = 36;
const MAX_WIDTH = 76;
const UNSELECTED_SELECTOR = " ".repeat(SELECTOR.length);

function isToggleItem(item: MenuItem): item is ToggleMenuItem {
	return "value" in item;
}

function isChoiceItem(item: MenuItem): item is ChoiceMenuItem {
	return "values" in item;
}

// ── Shared box-drawing primitives ──────────────────────────────────────────

export function renderMenuTopBorder(theme: Theme, innerWidth: number, title: string): string {
	const shown = truncateToWidth(title, Math.max(0, innerWidth - 5));
	const fill = "═".repeat(Math.max(0, innerWidth - 5 - visibleWidth(shown)));
	return theme.fg("border", "╔═[ ")
		+ theme.bold(theme.fg("text", shown))
		+ theme.fg("border", ` ]${fill}╗`);
}

export function renderMenuBottomBorder(theme: Theme, innerWidth: number, counter = ""): string {
	return theme.fg("border", "╚")
		+ theme.fg("border", "═".repeat(Math.max(0, innerWidth - visibleWidth(counter))) + counter)
		+ theme.fg("border", "╝");
}

export function renderMenuSectionDivider(theme: Theme, innerWidth: number, title: string): string {
	const shown = truncateToWidth(title, Math.max(0, innerWidth - 3));
	return theme.fg("border", "╟")
		+ theme.fg("border", `─ ${shown} ${"─".repeat(Math.max(0, innerWidth - 3 - visibleWidth(shown)))}`)
		+ theme.fg("border", "╢");
}

export function renderMenuSeparator(theme: Theme, innerWidth: number): string {
	return theme.fg("border", "╟" + "─".repeat(innerWidth) + "╢");
}

export function renderMenuContentRow(theme: Theme, innerWidth: number, content: string): string {
	const shown = fitVisible(content, innerWidth, { truncationMark: "", padToWidth: false });
	return theme.fg("border", "║") + shown + " ".repeat(Math.max(0, innerWidth - visibleWidth(shown))) + theme.fg("border", "║");
}

export function twoPaneWidths(innerWidth: number): { left: number; right: number } {
	const left = Math.max(1, Math.floor((innerWidth - 1) / 2));
	return { left, right: Math.max(0, innerWidth - left - 1) };
}

export function renderMenuPaneRow(theme: Theme, leftWidth: number, rightWidth: number, left: string, right: string): string {
	const shownLeft = fitVisible(left, leftWidth, { truncationMark: "", padToWidth: true });
	const shownRight = fitVisible(right, rightWidth, { truncationMark: "", padToWidth: true });
	return theme.fg("border", "║")
		+ shownLeft + " ".repeat(Math.max(0, leftWidth - visibleWidth(shownLeft)))
		+ theme.fg("border", "│")
		+ shownRight + " ".repeat(Math.max(0, rightWidth - visibleWidth(shownRight)))
		+ theme.fg("border", "║");
}

/** Standard two-row footer contents for nested TUI windows: actions, then hints. */
export function renderMenuFooterContents(
	theme: Theme,
	innerWidth: number,
	actions: string,
	hints: string,
	options?: { wrapHints?: boolean },
): string[] {
	/** Keep every returned content row frame-safe for callers that add borders directly. */
	const fit = (content: string) => {
		const shown = fitVisible(content, innerWidth, { truncationMark: "", padToWidth: false });
		return shown + " ".repeat(Math.max(0, innerWidth - visibleWidth(shown)));
	};
	const rightAlignedActions = `${" ".repeat(Math.max(0, innerWidth - visibleWidth(actions) - 2))}${actions}  `;
	const hintLines = options?.wrapHints
		? wrapWords(hints, Math.max(0, innerWidth - 2)).map((line) => theme.fg("dim", fit(`  ${line}`)))
		: [theme.fg("dim", fit(`  ${hints}`))];
	return [
		theme.fg("border", "─".repeat(innerWidth)),
		fit(rightAlignedActions),
		theme.fg("border", "─".repeat(innerWidth)),
		...hintLines,
	];
}

/** Standard framed two-row footer: right-justified actions above keyboard hints. */
export function renderMenuFooter(theme: Theme, innerWidth: number, actions: string, hints: string): string[] {
	const [topDivider, actionRow, hintDivider, hintRow] = renderMenuFooterContents(theme, innerWidth, actions, hints);
	return [
		theme.fg("border", "╟") + topDivider + theme.fg("border", "╢"),
		renderMenuContentRow(theme, innerWidth, actionRow),
		theme.fg("border", "╟") + hintDivider + theme.fg("border", "╢"),
		renderMenuContentRow(theme, innerWidth, hintRow),
	];
}

// ── MenuComponent──────────────────────────────────────────────────────────

/** Reusable box-drawing menu supporting toggle settings and action/value rows. */
export class MenuComponent implements Component {
	private readonly title: string;
	private readonly sections: MenuSection[];
	private readonly hints: string[];
	private readonly buttons: MenuButton[];
	private readonly fullWidth: boolean;
	private readonly maxItemsPerSection: number | undefined;
	private readonly onItemKey: ((item: MenuItem, data: string) => boolean) | undefined;
	private readonly theme: Theme;
	private readonly done: (result: MenuResult<Record<string, boolean>>) => void;
	private readonly tui: TUI | undefined;
	private readonly initialValues: Record<string, boolean>;
	private readonly values: Record<string, boolean> = {};
	private readonly items: MenuItem[] = [];
	private readonly previewFn: MenuConfig["preview"];
	private readonly previewOrigin: number | undefined;
	private previewTimer: ReturnType<typeof setInterval> | undefined;
	private cursor = 0;
	private focusedPane: "items" | "buttons" = "items";
	private buttonIndex = 0;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;
	private viewport: number | undefined;
	private scrollOffset = 0;

	constructor(
		config: MenuConfig,
		theme: Theme,
		done: (result: MenuResult<Record<string, boolean>>) => void,
		tui?: TUI,
	) {
		this.theme = theme;
		this.done = done;
		this.tui = tui;
		this.title = config.title;
		this.sections = config.sections;
		this.buttons = config.buttons ?? [];
		this.fullWidth = config.fullWidth ?? false;
		this.maxItemsPerSection = config.maxItemsPerSection;
		this.onItemKey = config.onItemKey;
		this.hints = config.hints ?? (this.buttons.length > 0
			? ["↑↓ item", "←→ value", "⇥ switch btn", "⏎ select", "esc cancel"]
			: DEFAULT_HINTS);
		this.buttonIndex = Math.max(0, this.buttons.findIndex((button) => button.primary));
		for (const section of this.sections) {
			for (const item of section.items) {
				this.items.push(item);
				if (isToggleItem(item)) this.values[item.id] = item.value;
			}
		}
		this.initialValues = { ...this.values };
		const initialCursor = config.initialItemId
			? this.items.findIndex((item) => item.id === config.initialItemId)
			: -1;
		if (initialCursor >= 0) this.cursor = initialCursor;
		this.previewFn = config.preview;
		if (this.previewFn) {
			this.previewOrigin = Date.now();
			if (this.tui) {
				this.previewTimer = setInterval(() => {
					this.invalidate();
					this.tui?.requestRender();
				}, config.previewIntervalMs ?? 50);
			}
		}
	}

	dispose(): void {
		if (this.previewTimer) clearInterval(this.previewTimer);
		this.previewTimer = undefined;
	}

	/** Limit rendered height while keeping the title and action footer visible. */
	setViewport(lines: number | undefined): void {
		const next = lines === undefined ? undefined : Math.max(6, Math.floor(lines));
		if (next === this.viewport) return;
		this.viewport = next;
		this.invalidate();
	}

	/** Update an action row in place without rebuilding the menu. */
	setItemValue(id: string, displayValue: string | undefined): void {
		const item = this.items.find((i) => i.id === id);
		if (!item || isToggleItem(item) || isChoiceItem(item)) return;
		item.displayValue = displayValue;
		this.invalidate();
		this.tui?.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done({ applied: false, values: { ...this.initialValues } });
			return;
		}
		if (matchesKey(data, Key.tab) && this.buttons.length > 0) {
			this.focusedPane = this.focusedPane === "items" ? "buttons" : "items";
			this.invalidate();
			this.tui?.requestRender();
			return;
		}
		if (this.focusedPane === "buttons") {
			if (matchesKey(data, Key.left)) {
				this.buttonIndex = (this.buttonIndex - 1 + this.buttons.length) % this.buttons.length;
				this.invalidate();
			} else if (matchesKey(data, Key.right)) {
				this.buttonIndex = (this.buttonIndex + 1) % this.buttons.length;
				this.invalidate();
			} else if (matchesKey(data, Key.enter)) {
				this.buttons[this.buttonIndex]?.onSelect();
			}
			this.tui?.requestRender();
			return;
		}
		if (this.items.length === 0) return;
		if (this.onItemKey?.(this.items[this.cursor]!, data)) {
			// The callback may have mutated the item, so the render cache must go.
			this.invalidate();
			this.tui?.requestRender();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.cursor = (this.cursor - 1 + this.items.length) % this.items.length;
			this.invalidate();
		} else if (matchesKey(data, Key.down)) {
			this.cursor = (this.cursor + 1) % this.items.length;
			this.invalidate();
		} else if (matchesKey(data, Key.pageUp)) {
			this.cursor = Math.max(0, this.cursor - Math.max(1, (this.viewport ?? 10) - 6));
			this.invalidate();
		} else if (matchesKey(data, Key.pageDown)) {
			this.cursor = Math.min(this.items.length - 1, this.cursor + Math.max(1, (this.viewport ?? 10) - 6));
			this.invalidate();
		} else if (matchesKey(data, Key.home)) {
			this.cursor = 0;
			this.invalidate();
		} else if (matchesKey(data, Key.end)) {
			this.cursor = this.items.length - 1;
			this.invalidate();
		} else if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
			const item = this.items[this.cursor]!;
			if (isChoiceItem(item) && item.values.length > 0) {
				const delta = matchesKey(data, Key.left) ? -1 : 1;
				item.valueIndex = (item.valueIndex + delta + item.values.length) % item.values.length;
				item.onChange?.(item.valueIndex, item.values[item.valueIndex]!);
				this.invalidate();
			}
		} else if (matchesKey(data, Key.space)) {
			const item = this.items[this.cursor]!;
			if (isToggleItem(item)) {
				const value = !this.values[item.id];
				this.values[item.id] = value;
				item.onChange?.(value);
				this.invalidate();
			}
		} else if (matchesKey(data, Key.enter)) {
			const item = this.items[this.cursor]!;
			if (!isToggleItem(item) && !isChoiceItem(item)) item.onSelect();
			else if (this.buttons.length === 0 && this.items.every(isToggleItem)) {
				this.done({ applied: true, values: { ...this.values } });
			}
		}
		this.tui?.requestRender();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;
		const lines = this.buildLines(width);
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	private preferredWidth(previewLines: string[] | undefined): number {
		const candidates = [MIN_WIDTH - 2, 5 + this.title.length, 2 + this.hints.join("  ").length];
		for (const line of previewLines ?? []) candidates.push(visibleWidth(line) + 1);
		for (const section of this.sections) {
			candidates.push(3 + section.title.length);
			for (const item of section.items) {
				if (isToggleItem(item)) candidates.push(15 + item.label.length);
				else if (isChoiceItem(item)) candidates.push(8 + item.label.length + item.values.reduce((sum, value) => sum + visibleWidth(value) + 2, 0));
				else candidates.push(6 + item.label.length + visibleWidth(item.displayValue ?? "Not set"));
			}
		}
		if (this.buttons.length > 0) candidates.push(this.buttons.reduce((sum, button) => sum + button.label.length + 8, 0));
		return 2 + Math.max(...candidates);
	}

	private buildLines(maxWidth: number): string[] {
		const { theme } = this;
		const previewLines = this.previewFn?.(this.values, this.previewOrigin === undefined ? 0 : Date.now() - this.previewOrigin);
		const desiredWidth = this.fullWidth
			? maxWidth
			: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, this.preferredWidth(previewLines)));
		const boxWidth = Math.max(0, Math.min(desiredWidth, maxWidth));
		const innerWidth = Math.max(0, boxWidth - 2);
		const lines = [renderMenuTopBorder(theme, innerWidth, this.title)];
		if (previewLines?.length) {
			lines.push(renderMenuSectionDivider(theme, innerWidth, "Preview"), renderMenuContentRow(theme, innerWidth, ""));
			for (const line of previewLines) lines.push(renderMenuContentRow(theme, innerWidth, ` ${line}`));
			lines.push(renderMenuContentRow(theme, innerWidth, ""));
		}
		let flatIndex = 0;
		const itemLineIndices: number[] = [];
		for (const section of this.sections) {
			lines.push(renderMenuSectionDivider(theme, innerWidth, section.title));
			const [from, to] = this.itemWindow(section, flatIndex);
			if (from > 0) lines.push(renderMenuContentRow(theme, innerWidth, theme.fg("dim", `    ↑ ${from} more`)));
			for (const [index, item] of section.items.entries()) {
				// The cursor indexes every item, so rows hidden by the window still advance it.
				const selected = flatIndex++ === this.cursor;
				if (index < from || index >= to) continue;
				itemLineIndices[flatIndex - 1] = lines.length;
				lines.push(this.renderItemRow(item, selected, innerWidth));
				const descriptionRows = this.renderDescriptionRows(item, innerWidth);
				lines.push(...descriptionRows);
				if (descriptionRows.length > 0 && index < to - 1) {
					lines.push(renderMenuContentRow(theme, innerWidth, ""));
				}
			}
			const below = section.items.length - to;
			if (below > 0) lines.push(renderMenuContentRow(theme, innerWidth, theme.fg("dim", `    ↓ ${below} more`)));
			lines.push(renderMenuContentRow(theme, innerWidth, ""));
		}
		const footerStart = lines.length;
		if (this.buttons.length > 0) {
			const texts = this.buttons.map((button, index) => {
				const isActive = index === this.buttonIndex;
				const text = isActive ? `[ ${button.label} ]` : `‹ ${button.label} ›`;
				return isActive && this.focusedPane === "buttons"
					? theme.bold(theme.fg("accent", text))
					: theme.fg("muted", text);
			});
			lines.push(...renderMenuFooter(theme, innerWidth, texts.join("    "), this.hints.join("  ")));
		} else {
			lines.push(renderMenuSeparator(theme, innerWidth), renderMenuContentRow(theme, innerWidth, theme.fg("dim", `  ${this.hints.join("  ")}`)));
		}
		const changed = Object.entries(this.values).filter(([id, value]) => this.initialValues[id] !== value).length;
		const counter = changed > 0 ? `[ ${changed} changed ]` : `[ ${this.cursor + 1}/${this.items.length} ]`;
		lines.push(renderMenuBottomBorder(theme, innerWidth, counter));
		let visibleLines = lines;
		if (this.viewport !== undefined && lines.length > this.viewport) {
			const top = lines.slice(0, 1);
			const footer = lines.slice(footerStart);
			const middle = lines.slice(1, footerStart);
			const middleHeight = Math.max(0, this.viewport - top.length - footer.length);
			const selectedMiddleLine = Math.max(0, (itemLineIndices[this.cursor] ?? 1) - 1);
			if (selectedMiddleLine < this.scrollOffset) this.scrollOffset = selectedMiddleLine;
			if (selectedMiddleLine >= this.scrollOffset + middleHeight) this.scrollOffset = selectedMiddleLine - middleHeight + 1;
			this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, Math.max(0, middle.length - middleHeight)));
			visibleLines = [...top, ...middle.slice(this.scrollOffset, this.scrollOffset + middleHeight), ...footer];
		}
		return visibleLines.map((line) => truncateToWidth(line, boxWidth, ""));
	}

	/** Slice of a capped section's items to render, kept centred on the cursor. */
	private itemWindow(section: MenuSection, sectionStart: number): [number, number] {
		const cap = this.maxItemsPerSection;
		const total = section.items.length;
		if (!cap || total <= cap) return [0, total];
		const local = this.cursor - sectionStart;
		const anchor = local >= 0 && local < total ? local : 0;
		const from = Math.min(Math.max(0, anchor - Math.floor((cap - 1) / 2)), total - cap);
		return [from, from + cap];
	}

	/** Dimmed helper text wrapped under an action/choice row. */
	private renderDescriptionRows(item: MenuItem, innerWidth: number): string[] {
		if (isToggleItem(item) || !item.description) return [];
		const indent = "    ";
		return wrapWords(item.description, Math.max(0, innerWidth - indent.length - 2)).map((line) =>
			renderMenuContentRow(this.theme, innerWidth, this.theme.fg("dim", indent + line)),
		);
	}

	private renderItemRow(item: MenuItem, selected: boolean, innerWidth: number): string {
		const th = this.theme;
		const marker = selected ? th.fg("accent", SELECTOR) : UNSELECTED_SELECTOR;
		if (isToggleItem(item)) {
			const value = this.values[item.id]!;
			const state = value ? "ON" : "OFF";
			const label = truncateToWidth(item.label, Math.max(0, innerWidth - 15));
			const left = `  ${marker} [${value ? th.fg("success", "■") : th.fg("muted", " ")}] ${th.fg("text", label)}`;
			return renderMenuContentRow(th, innerWidth, `${left}${" ".repeat(Math.max(1, innerWidth - visibleWidth(left) - state.length - 2))}${value ? th.fg("success", state) : th.fg("muted", state)}  `);
		}
		if (isChoiceItem(item)) {
			const parts = item.values.map((value, index) => {
				const text = index === item.valueIndex ? `‹${value}›` : value;
				return index === item.valueIndex ? th.fg("accent", text) : th.fg("muted", text);
			}).join("  ");
			const left = `   ${marker} ${th.fg("text", item.label)}`;
			return renderMenuContentRow(th, innerWidth, `${left}${" ".repeat(Math.max(2, innerWidth - visibleWidth(left) - visibleWidth(parts) - 2))}${parts}  `);
		}
		const value = item.displayValue ?? "Not set";
		const maxValue = Math.max(0, innerWidth - Math.min(16, visibleWidth(item.label)) - 7);
		const shownValue = truncateToWidth(value, maxValue, "...");
		const maxLabel = Math.max(0, innerWidth - visibleWidth(shownValue) - 7);
		const label = truncateToWidth(item.label, maxLabel, "...");
		const left = `  ${marker} ${selected ? th.fg("accent", label) : th.fg("text", label)}`;
		const right = selected ? th.fg("text", shownValue) : th.fg("muted", shownValue);
		return renderMenuContentRow(th, innerWidth, `${left}${" ".repeat(Math.max(1, innerWidth - visibleWidth(left) - visibleWidth(right) - 2))}${right}  `);
	}
}

// ── showMenu helper ────────────────────────────────────────────────────────

export async function showMenu<T extends Record<string, boolean>>(ctx: ExtensionCommandContext, config: MenuConfig): Promise<MenuResult<T>> {
	const initialValues = Object.fromEntries(config.sections.flatMap((section) => section.items.filter(isToggleItem).map((item) => [item.id, item.value]))) as T;
	if (ctx.mode !== "tui") return { applied: false, values: initialValues };
	return ctx.ui.custom<MenuResult<T>>((tui, theme, _keybindings, done) => new MenuComponent(config, theme, done as (result: MenuResult<Record<string, boolean>>) => void, tui), { overlay: true });
}

// ── Shared custom-overlay prompt handshake ────────────────────────────────

/**
 * Shared geometry for every sequential overlay prompt (the setup overlay, the
 * roster manager, one-shot model pickers): a centered overlay at 90% width and
 * 70% height, so consecutive `ctx.ui.custom` calls read as one continuous
 * settings surface.
 */
export const PLAN_OVERLAY_OPTIONS = {
	overlay: true,
	overlayOptions: { anchor: "center", width: "90%", minWidth: 50, maxHeight: "70%", margin: 1 },
} as const;

/** The slice of pi's extension `ui` an overlay prompt needs. Structural so tests can supply a stub. */
interface OverlayPromptUi {
	custom<T>(
		factory: (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (value: T) => void) => Component,
		options?: { overlay?: boolean; overlayOptions?: OverlayOptions },
	): Promise<T>;
}

/**
 * Open a focused custom overlay with the shared prompt geometry and resolve
 * with whatever the component hands to `done`.
 */
export function showOverlayPrompt<T>(
	ctx: { ui: OverlayPromptUi },
	create: (tui: TUI, theme: Theme, done: (value: T) => void) => Component,
): Promise<T> {
	return ctx.ui.custom<T>((tui, theme, _keybindings, done) => create(tui, theme, done), PLAN_OVERLAY_OPTIONS);
}

// ── TwoPane types ──────────────────────────────────────────────────────────

export interface TwoPaneOption {
	id: string;
	label: string;
	valueIndex: number;
	values: string[];
	onChange?: (valueIndex: number, displayValue: string) => void;
}

export interface TwoPaneCategory {
	id: string;
	label: string;
	options: TwoPaneOption[];
}

export interface TwoPaneButton {
	id: string;
	label: string;
	primary?: boolean;
	onSelect: () => void;
}

export interface TwoPaneMenuConfig {
	title: string;
	categories: TwoPaneCategory[];
	buttons: TwoPaneButton[];
	hints?: string[];
}

type TwoPane = "categories" | "options" | "buttons";

/** A reusable category/detail configuration window with cycling option values. */
export class TwoPaneMenuComponent implements Component {
	private readonly config: TwoPaneMenuConfig;
	private readonly theme: Theme;
	private readonly done: () => void;
	private readonly tui: TUI | undefined;
	private readonly hints: string[];
	private activePane: TwoPane = "categories";
	private categoryIndex = 0;
	private optionIndex = 0;
	private buttonIndex = 0;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(
		config: TwoPaneMenuConfig,
		theme: Theme,
		done: () => void,
		tui?: TUI,
	) {
		this.config = config;
		this.theme = theme;
		this.done = done;
		this.tui = tui;
		this.hints = config.hints ?? ["↑↓ select", "tab switch pane", "←→ value", "⏎ apply", "esc cancel"];
	}

	private get category(): TwoPaneCategory | undefined { return this.config.categories[this.categoryIndex]; }
	private get options(): TwoPaneOption[] { return this.category?.options ?? []; }

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done();
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.activePane = this.activePane === "categories" ? "options" : this.activePane === "options" ? "buttons" : "categories";
			this.invalidate();
			this.tui?.requestRender();
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
			const delta = matchesKey(data, Key.up) ? -1 : 1;
			if (this.activePane === "categories" && this.config.categories.length) {
				this.categoryIndex = (this.categoryIndex + delta + this.config.categories.length) % this.config.categories.length;
				this.optionIndex = 0;
			} else if (this.activePane === "options" && this.options.length) {
				this.optionIndex = (this.optionIndex + delta + this.options.length) % this.options.length;
			} else if (this.activePane === "buttons" && this.config.buttons.length) {
				this.buttonIndex = (this.buttonIndex + delta + this.config.buttons.length) % this.config.buttons.length;
			}
			this.invalidate();
		} else if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
			if (this.activePane === "options") {
				const option = this.options[this.optionIndex];
				if (option?.values.length) {
					const delta = matchesKey(data, Key.left) ? -1 : 1;
					option.valueIndex = (option.valueIndex + delta + option.values.length) % option.values.length;
					option.onChange?.(option.valueIndex, option.values[option.valueIndex]!);
					this.invalidate();
				}
			}
		} else if (matchesKey(data, Key.enter) && this.activePane === "buttons") {
			this.config.buttons[this.buttonIndex]?.onSelect();
		}
		this.tui?.requestRender();
	}

	invalidate(): void { this.cachedWidth = undefined; this.cachedLines = undefined; }
	dispose(): void {}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;
		const { theme, config } = this;
		const longestCategory = Math.max(0, ...config.categories.map((c) => visibleWidth(c.label) + 4));
		const longestOption = Math.max(0, ...config.categories.flatMap((c) => c.options.map((o) => visibleWidth(o.label) + Math.max(0, ...o.values.map(visibleWidth)) + 9)));
		const desired = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, 2 + config.title.length + 5, 2 + longestCategory + longestOption, 2 + this.hints.join("   ").length));
		const boxWidth = Math.max(0, Math.min(desired, width));
		const innerWidth = Math.max(0, boxWidth - 2);
		const leftWidth = Math.max(12, Math.floor((innerWidth - 1) * 0.4));
		const rightWidth = Math.max(0, innerWidth - leftWidth - 1);
		const lines = [renderMenuTopBorder(theme, innerWidth, config.title)];
		const rowCount = Math.max(config.categories.length + 1, this.options.length + 1, 6);
		for (let index = 0; index < rowCount; index++) {
			let left = "";
			let right = "";
			if (index === 0) {
				left = theme.fg("dim", " Categories");
				right = theme.fg("dim", ` ${this.category?.label ?? ""}`);
			} else {
				const category = config.categories[index - 1];
				if (category) left = ` ${this.activePane === "categories" && index - 1 === this.categoryIndex ? theme.fg("accent", SELECTOR) : UNSELECTED_SELECTOR} ${category.label}`;
				const option = this.options[index - 1];
				if (option) {
					const marker = this.activePane === "options" && index - 1 === this.optionIndex ? `${theme.fg("accent", SELECTOR)} ` : `${UNSELECTED_SELECTOR} `;
					const value = option.values[option.valueIndex] ?? "";
					const valueText = `‹ ${value} ›`;
					const label = truncateToWidth(option.label, Math.max(0, rightWidth - visibleWidth(valueText) - 3), "...");
					right = `${marker}${label}${" ".repeat(Math.max(1, rightWidth - visibleWidth(marker) - visibleWidth(label) - visibleWidth(valueText)))}${theme.fg("muted", valueText)}`;
				}
			}
			lines.push(renderMenuPaneRow(theme, leftWidth, rightWidth, left, right));
		}
		lines.push(theme.fg("border", "╟") + theme.fg("border", "─".repeat(leftWidth) + "┴" + "─".repeat(rightWidth)) + theme.fg("border", "╢"));
		const buttons = config.buttons.map((button, index) => {
			const selected = this.activePane === "buttons" && index === this.buttonIndex;
			const text = button.primary ? `‹ ${button.label} ›` : `[ ${button.label} ]`;
			return selected ? theme.fg("accent", theme.bold(text)) : text;
		}).join("    ");
		lines.push(renderMenuContentRow(theme, innerWidth, buttons.padStart(Math.max(0, Math.floor((innerWidth + visibleWidth(buttons)) / 2)))));
		lines.push(renderMenuSeparator(theme, innerWidth));
		lines.push(renderMenuContentRow(theme, innerWidth, theme.fg("dim", `  ${this.hints.join("   ")}`)));
		const counter = `[ ${this.category?.label ?? ""} · ${this.options.length} opts ]`;
		lines.push(renderMenuBottomBorder(theme, innerWidth, counter));
		this.cachedWidth = width;
		this.cachedLines = lines.map((line) => truncateToWidth(line, boxWidth, ""));
		return this.cachedLines;
	}
}
