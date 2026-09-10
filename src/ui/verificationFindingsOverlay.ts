import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { Markdown, type Component, type TUI } from "@earendil-works/pi-tui";
import { ROUNDED_SINGLE_BOX, createFrame, ratioViewport, safeRenderWidth } from "./chrome.ts";

const OVERLAY_HEIGHT_RATIO = 0.9;
const OVERLAY_MARGIN = 1;
/** Fixed chrome: top border, title, separator, separator, help row, bottom border. */
const CHROME_LINES = 6;

/**
 * Show the complete verifier report in a read-only, scrollable overlay. This is
 * a non-terminal step in the post-verification decision: closing it returns to
 * the same repair/accept choices. Outside TUI mode there is no overlay surface,
 * so it returns immediately rather than opening a view-and-return loop the user
 * cannot actually see.
 */
export async function showVerificationFindings(ctx: ExtensionContext, findingsMarkdown: string): Promise<void> {
	if (ctx.mode !== "tui") return;
	await ctx.ui.custom<void>(
		(tui, theme, keybindings, done) => new VerificationFindingsOverlay(tui, theme, keybindings, findingsMarkdown, done),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "90%",
				minWidth: 60,
				maxHeight: "90%",
				margin: OVERLAY_MARGIN,
			},
		},
	);
}

class VerificationFindingsOverlay implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly markdown: Markdown;
	private readonly done: (value: void) => void;
	private scrollOffset = 0;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		findingsMarkdown: string,
		done: (value: void) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		this.markdown = new Markdown(findingsMarkdown, 0, 0, getMarkdownTheme());
	}

	private viewportLines(): number {
		return ratioViewport(process.stdout.rows, {
			fallbackRows: 24,
			ratio: OVERLAY_HEIGHT_RATIO,
			minimum: 6,
			margin: OVERLAY_MARGIN,
			chromeRows: CHROME_LINES,
		});
	}

	handleInput(data: string): void {
		const keys = this.keybindings;
		if (keys.matches(data, "tui.select.cancel")) {
			this.done(undefined);
			return;
		}

		let delta = 0;
		if (keys.matches(data, "tui.select.down")) delta = 1;
		else if (keys.matches(data, "tui.select.up")) delta = -1;
		else if (keys.matches(data, "tui.select.pageDown")) delta = this.viewportLines() - 2;
		else if (keys.matches(data, "tui.select.pageUp")) delta = -(this.viewportLines() - 2);
		else if (keys.matches(data, "tui.altScreen.top")) this.scrollOffset = 0;
		else if (keys.matches(data, "tui.altScreen.bottom")) this.scrollOffset = Number.MAX_SAFE_INTEGER;
		else return;

		this.scrollOffset += delta;
		this.tui.requestRender();
	}

	render(width: number): string[] {
		// Overlay re-renders can briefly receive a bogus width while handling input.
		// Never pass an unbounded value to Markdown.render(), which pads via String.repeat().
		const terminalWidth = Math.max(20, process.stdout.columns ?? 80);
		const safeWidth = safeRenderWidth(width, terminalWidth);
		const innerWidth = Math.max(20, safeWidth - 4);
		const frame = createFrame(this.theme, innerWidth, {
			glyphs: ROUNDED_SINGLE_BOX,
			horizontalPadding: 1,
			truncationMark: "…",
			padToWidth: true,
			minimumBodyWidth: 10,
		});
		const bodyWidth = frame.bodyWidth;
		const rendered = this.markdown.render(bodyWidth);
		const viewport = Math.min(this.viewportLines(), Math.max(6, rendered.length));
		const maxOffset = Math.max(0, rendered.length - viewport);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));

		const visible = rendered.slice(this.scrollOffset, this.scrollOffset + viewport);
		while (visible.length < viewport) visible.push("");

		const th = this.theme;
		const position = rendered.length > viewport
			? ` lines ${this.scrollOffset + 1}-${Math.min(this.scrollOffset + viewport, rendered.length)}/${rendered.length}`
			: ` ${rendered.length} lines`;
		// Help reflects the user's configured keybindings, not fixed labels.
		const help = [
			keyHint("tui.select.up", "scroll"),
			keyHint("tui.select.pageDown", "page"),
			keyHint("tui.altScreen.top", "top"),
			keyHint("tui.altScreen.bottom", "bottom"),
			keyHint("tui.select.cancel", "close"),
		].join(" · ");
		return [
			frame.top(),
			frame.row(th.fg("accent", "Verification findings") + th.fg("dim", position)),
			frame.separator(),
			...visible.map((line) => frame.row(line)),
			frame.separator(),
			frame.row(th.fg("dim", help)),
			frame.bottom(),
		];
	}

	invalidate(): void {
		this.markdown.invalidate();
	}

	dispose(): void {}
}
