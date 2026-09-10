import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const UI_TICK_MS = 100;

export const BRAILLE_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const QUADRANT_SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const;

export interface BoxGlyphs {
	topLeft: string;
	topRight: string;
	bottomLeft: string;
	bottomRight: string;
	vertical: string;
	horizontal: string;
	leftJoin: string;
	rightJoin: string;
}

export const ROUNDED_SINGLE_BOX: BoxGlyphs = {
	topLeft: "╭",
	topRight: "╮",
	bottomLeft: "╰",
	bottomRight: "╯",
	vertical: "│",
	horizontal: "─",
	leftJoin: "├",
	rightJoin: "┤",
};

export const SQUARE_SINGLE_BOX: BoxGlyphs = {
	topLeft: "┌",
	topRight: "┐",
	bottomLeft: "└",
	bottomRight: "┘",
	vertical: "│",
	horizontal: "─",
	leftJoin: "├",
	rightJoin: "┤",
};

export interface Frame {
	frameWidth: number;
	bodyWidth: number;
	top(): string;
	separator(): string;
	bottom(): string;
	row(content: string, background?: Parameters<Theme["bg"]>[0]): string;
}

/**
 * Shared selection glyph for list rows across menus and pickers.
 * SELECTOR is 1 visible column; SELECTOR_POINTER appends a trailing space
 * (2 columns) so it lines up with UNSELECTED_POINTER, which is 2 spaces.
 */
export const SELECTOR = ">";
export const SELECTOR_POINTER = `${SELECTOR} `;
export const UNSELECTED_POINTER = "  ";

export function safeRenderWidth(
	suppliedWidth: number,
	terminalWidth = 80,
	minimum = 20,
): number {
	const safeTerminalWidth = Math.max(minimum, Math.floor(terminalWidth));
	return Number.isFinite(suppliedWidth)
		? Math.max(minimum, Math.min(Math.floor(suppliedWidth), safeTerminalWidth))
		: safeTerminalWidth;
}

export function fitVisible(
	content: string,
	width: number,
	options: { truncationMark: string; padToWidth: boolean },
): string {
	return truncateToWidth(content, Math.max(0, width), options.truncationMark, options.padToWidth);
}

export function createFrame(
	theme: Pick<Theme, "fg" | "bg">,
	frameWidth: number,
	options: {
		glyphs: BoxGlyphs;
		horizontalPadding: number;
		truncationMark: string;
		padToWidth: boolean;
		minimumBodyWidth?: number;
	},
): Frame {
	const width = Math.max(2, frameWidth);
	const padding = Math.max(0, Math.floor(options.horizontalPadding));
	const bodyWidth = Math.max(options.minimumBodyWidth ?? 0, width - 2 - padding * 2);
	const border = (text: string) => theme.fg("border", text);
	const ruleWidth = Math.max(0, width - 2);
	const fit = (content: string) => fitVisible(content, bodyWidth, {
		truncationMark: options.truncationMark,
		padToWidth: options.padToWidth,
	});
	const sidePadding = " ".repeat(padding);
	return {
		frameWidth: width,
		bodyWidth,
		top: () => border(options.glyphs.topLeft + options.glyphs.horizontal.repeat(ruleWidth) + options.glyphs.topRight),
		separator: () => border(options.glyphs.leftJoin + options.glyphs.horizontal.repeat(ruleWidth) + options.glyphs.rightJoin),
		bottom: () => border(options.glyphs.bottomLeft + options.glyphs.horizontal.repeat(ruleWidth) + options.glyphs.bottomRight),
		row: (content: string, background?: Parameters<Theme["bg"]>[0]) => {
			// Borders stay unhighlighted; only the padded inner cell picks up the background.
			const inner = sidePadding + fit(content) + sidePadding;
			// Array.map supplies a numeric index as the second callback argument;
			// ignore non-theme values so existing frame.row callbacks stay safe.
			const highlighted = typeof background === "string" ? theme.bg(background, inner) : inner;
			return border(options.glyphs.vertical) + highlighted + border(options.glyphs.vertical);
		},
	};
}

/** Word-wrap `text` into lines of at most `width` visible columns. */
export function wrapWords(text: string, width: number, truncationMark = "…"): string[] {
	if (width <= 0) return [];
	const lines: string[] = [];
	let current = "";
	for (const word of text.split(/\s+/).filter(Boolean)) {
		const candidate = current ? `${current} ${word}` : word;
		if (visibleWidth(candidate) <= width) {
			current = candidate;
			continue;
		}
		if (current) lines.push(current);
		current = truncateToWidth(word, width, truncationMark);
	}
	if (current) lines.push(current);
	return lines;
}

export function ratioViewport(
	terminalRows: number | undefined,
	options: {
		fallbackRows: number;
		ratio: number;
		minimum: number;
		margin?: number;
		chromeRows?: number;
	},
): number {
	const rows = terminalRows ?? options.fallbackRows;
	const margin = options.margin ?? 0;
	const ratioHeight = Math.floor(rows * options.ratio);
	const availableHeight = rows - margin * 2;
	const overlayHeight = Math.min(ratioHeight, availableHeight);
	return Math.max(options.minimum, overlayHeight - (options.chromeRows ?? 0));
}
