import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { shortModelName, type ModelRef } from "../shared/modelRefs.ts";
import type { MfPlanInfo, PlanReviewDecision } from "../moa/planInfo.ts";
import { ROUNDED_SINGLE_BOX, createFrame, ratioViewport, safeRenderWidth } from "./chrome.ts";
import { saveRepoPlanFile } from "../planning/planFile.ts";

const OVERLAY_HEIGHT_RATIO = 0.9;
const OVERLAY_MARGIN = 1;
/** Fixed chrome: top border, title, separator, separator, bottom border (help row(s) added separately). */
const BASE_CHROME_LINES = 5;
const MOA_META_LINES = 1; // proposing row

function getChromeLines(moaInfo: MfPlanInfo | undefined, helpLines: number): number {
	return BASE_CHROME_LINES + helpLines + (moaInfo ? MOA_META_LINES : 0);
}

function getViewportLines(moaInfo: MfPlanInfo | undefined, helpLines: number): number {
	return ratioViewport(process.stdout.rows, {
		fallbackRows: 24,
		ratio: OVERLAY_HEIGHT_RATIO,
		minimum: 6,
		margin: OVERLAY_MARGIN,
		chromeRows: getChromeLines(moaInfo, helpLines),
	});
}

/**
 * Wrap a `·`-delimited help/status line to fit within bodyWidth, spilling to a
 * second line if needed instead of truncating the whole thing to an ellipsis.
 */
function wrapDimLine(text: string, bodyWidth: number): string[] {
	if (visibleWidth(text) <= bodyWidth) return [text];

	const parts = text.split(" · ");
	const lines: string[] = [];
	let current = "";
	for (const part of parts) {
		const candidate = current ? `${current} · ${part}` : part;
		if (visibleWidth(candidate) <= bodyWidth) {
			current = candidate;
		} else {
			if (current) lines.push(current);
			current = part;
		}
	}
	if (current) lines.push(current);

	if (lines.length > 2) {
		const first = lines[0];
		const rest = lines.slice(1).join(" · ");
		lines.length = 0;
		lines.push(first, rest);
	}

	return lines.slice(0, 2).map((line) => truncateToWidth(line, bodyWidth, "…", false));
}

const MOA_SYNTHESIZED_PREFIX = "Synthesized by: ";

function padRow(content: string, bodyWidth: number): string {
	return truncateToWidth(content, bodyWidth, "…", true);
}

function formatProposersList(proposers: ModelRef[]): string {
	const content = proposers
		.map((ref, index) => `P${index + 1}: ${shortModelName(ref)}`)
		.join(", ");
	return `(${content})`;
}

function formatSplitRow(left: string, right: string | undefined, bodyWidth: number): string {
	if (!right) {
		return padRow(left, bodyWidth);
	}

	const minLeft = Math.min(visibleWidth(left), 18);
	const maxRight = Math.max(1, bodyWidth - minLeft);
	const rightPart = truncateToWidth(right, maxRight, "…", false);
	const rightVis = visibleWidth(rightPart);
	const leftPart = truncateToWidth(left, Math.max(1, bodyWidth - rightVis), "…", false);
	const gap = bodyWidth - visibleWidth(leftPart) - visibleWidth(rightPart);
	const row = gap > 0 ? leftPart + " ".repeat(gap) + rightPart : leftPart + rightPart;
	return padRow(row, bodyWidth);
}

function formatRightRow(content: string, bodyWidth: number): string {
	const truncated = truncateToWidth(content, bodyWidth, "…", false);
	const gap = bodyWidth - visibleWidth(truncated);
	return padRow(gap > 0 ? " ".repeat(gap) + truncated : truncated, bodyWidth);
}

export interface PlanReviewLabels {
	title?: string;
	approveHint?: string;
	keepHint?: string;
	chatHint?: string;
}

export async function showPlanReview(
	ctx: ExtensionContext,
	planMarkdown: string,
	moaInfo?: MfPlanInfo,
	planName?: string,
	allowChat = false,
	labels?: PlanReviewLabels,
): Promise<PlanReviewDecision> {
	const result = await ctx.ui.custom<PlanReviewDecision>(
		(tui, theme, _keybindings, done) => new PlanReviewOverlay(tui, theme, planMarkdown, moaInfo, ctx.cwd, planName, allowChat, labels, done),
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

	return result ?? "keep";
}

class PlanReviewOverlay implements Component {
	private readonly markdown: Markdown;
	private readonly proposerMarkdown = new Map<number, Markdown>();
	private readonly proposerLabels = new Map<number, string>();
	private readonly verdictsMarkdown: Markdown | undefined;
	private activeProposerIndex: number | undefined;
	private showVerdicts = false;
	private scrollOffset = 0;
	/** Number of help-row lines the last render used; kept for scroll math between renders. */
	private helpLineCount = 1;
	private renderCache: { markdown: Markdown; width: number; rendered: string[] } | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly planMarkdown: string,
		private readonly moaInfo: MfPlanInfo | undefined,
		private readonly repoCwd: string,
		private readonly planName: string | undefined,
		private readonly allowChat: boolean,
		private readonly labels: PlanReviewLabels | undefined,
		private readonly done: (decision: PlanReviewDecision) => void,
	) {
		this.markdown = new Markdown(stripTerminalSequences(planMarkdown), 0, 0, getMarkdownTheme());
		for (const proposal of moaInfo?.proposerPlans ?? []) {
			this.proposerMarkdown.set(proposal.proposerIndex, new Markdown(stripTerminalSequences(proposal.markdown), 0, 0, getMarkdownTheme()));
			this.proposerLabels.set(proposal.proposerIndex, shortModelName(proposal.model));
		}
		if (moaInfo?.verdictsMarkdown) {
			this.verdictsMarkdown = new Markdown(stripTerminalSequences(moaInfo.verdictsMarkdown), 0, 0, getMarkdownTheme());
		}
	}

	handleInput(data: string): void {
		const proposerIndex = Number.parseInt(data, 10) - 1;
		if (/^[1-9]$/.test(data) && this.proposerMarkdown.has(proposerIndex)) {
			this.activeProposerIndex = proposerIndex;
			this.showVerdicts = false;
			this.scrollOffset = 0;
			this.tui.requestRender();
			return;
		}
		if (data === "0" || data === "`") {
			this.activeProposerIndex = undefined;
			this.showVerdicts = false;
			this.scrollOffset = 0;
			this.tui.requestRender();
			return;
		}
		if (this.verdictsMarkdown && (data === "v" || data === "V")) {
			this.showVerdicts = !this.showVerdicts;
			this.activeProposerIndex = undefined;
			this.scrollOffset = 0;
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.enter) || data === "a" || data === "A") {
			if (this.planName) {
				try {
					saveRepoPlanFile(this.planMarkdown, this.repoCwd, this.planName, "plan");
				} catch {
					// Don't block approval if the repo save fails.
				}
			}
			this.done("approve");
			return;
		}
		if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
			this.done("keep");
			return;
		}
		if (data === "e" || data === "E") {
			this.done("edit");
			return;
		}
		if (this.allowChat && (data === "c" || data === "C")) {
			this.done("chat");
			return;
		}

		let delta = 0;
		if (matchesKey(data, Key.down) || data === "j") delta = 1;
		else if (matchesKey(data, Key.up) || data === "k") delta = -1;
		else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("f")) || data === "d") delta = getViewportLines(this.moaInfo, this.helpLineCount) - 2;
		else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("b")) || data === "u") delta = -(getViewportLines(this.moaInfo, this.helpLineCount) - 2);
		else if (matchesKey(data, Key.home)) this.scrollOffset = 0;
		else if (matchesKey(data, Key.end)) this.scrollOffset = Number.MAX_SAFE_INTEGER;
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
		const activeMarkdown = this.showVerdicts && this.verdictsMarkdown
			? this.verdictsMarkdown
			: this.activeProposerIndex === undefined
				? this.markdown
				: this.proposerMarkdown.get(this.activeProposerIndex) ?? this.markdown;
		const helpParts = [...this.proposerMarkdown.keys()]
			.map((index) => index + 1)
			.sort((a, b) => a - b)
			.join(",");
		const proposalHelp = helpParts ? ` · ${helpParts} proposer plans · \`/0 synthesized` : "";
		const verdictsHelp = this.verdictsMarkdown ? " · v verdicts" : "";
		const chatHelp = this.allowChat ? ` · c ${this.labels?.chatHint ?? "chat"}` : "";
		const helpLines = wrapDimLine(
			`↑/↓ or j/k scroll · u/d page${proposalHelp}${verdictsHelp} · e edit${chatHelp} · a/Enter ${this.labels?.approveHint ?? "approve"} · q/Esc ${this.labels?.keepHint ?? "keep planning"}`,
			bodyWidth,
		);
		this.helpLineCount = helpLines.length;

		if (!this.renderCache || this.renderCache.markdown !== activeMarkdown || this.renderCache.width !== bodyWidth) {
			this.renderCache = { markdown: activeMarkdown, width: bodyWidth, rendered: activeMarkdown.render(bodyWidth) };
		}
		const renderedPlan = this.renderCache.rendered;
		const viewport = Math.min(getViewportLines(this.moaInfo, this.helpLineCount), Math.max(6, renderedPlan.length));
		const maxOffset = Math.max(0, renderedPlan.length - viewport);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));

		const visible = renderedPlan.slice(this.scrollOffset, this.scrollOffset + viewport);
		while (visible.length < viewport) visible.push("");

		const th = this.theme;
		const position = renderedPlan.length > viewport
			? ` lines ${this.scrollOffset + 1}-${Math.min(this.scrollOffset + viewport, renderedPlan.length)}/${renderedPlan.length}`
			: ` ${renderedPlan.length} lines`;

		const showingVerdicts = this.showVerdicts && this.verdictsMarkdown !== undefined;
		const planTitle = showingVerdicts
			? "Proposer Verdicts"
			: this.activeProposerIndex === undefined
				? this.labels?.title ?? "Proposed Plan"
				: `Proposer ${this.activeProposerIndex + 1} Plan`;
		const proposerModel = this.activeProposerIndex === undefined
			? undefined
			: this.proposerLabels.get(this.activeProposerIndex);
		const nameSuffix = this.planName && this.activeProposerIndex === undefined && !showingVerdicts
			? th.fg("dim", ` · ${this.planName}`)
			: "";
		const leftTitle = th.fg("accent", planTitle)
			+ nameSuffix
			+ (proposerModel ? th.fg("dim", ` · ${proposerModel}`) : "")
			+ th.fg("dim", position);
		let rightTitle: string | undefined;
		if (this.moaInfo && this.activeProposerIndex === undefined) {
			rightTitle = th.fg("dim", MOA_SYNTHESIZED_PREFIX)
				+ th.fg("text", shortModelName(this.moaInfo.synthesizer));
		}

		const lines: string[] = [
			frame.top(),
			frame.row(formatSplitRow(leftTitle, rightTitle, bodyWidth)),
		];

		if (this.moaInfo) {
			const proposedLine = th.fg("text", formatProposersList(this.moaInfo.proposers));
			lines.push(frame.row(formatRightRow(proposedLine, bodyWidth)));
		}

		lines.push(frame.separator());

		for (const line of visible) {
			lines.push(frame.row(line));
		}

		lines.push(frame.separator());
		for (const helpLine of helpLines) {
			lines.push(frame.row(th.fg("dim", helpLine)));
		}
		lines.push(frame.bottom());

		return lines;
	}

	invalidate(): void {
		this.markdown.invalidate();
		this.verdictsMarkdown?.invalidate();
		for (const markdown of this.proposerMarkdown.values()) markdown.invalidate();
		this.renderCache = undefined;
	}

	dispose(): void {}
}
