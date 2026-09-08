import type { Message } from "@earendil-works/pi-ai";
import { getMarkdownTheme, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { transcriptBody, truncateFromStart } from "./agentTranscript.ts";
import { ROUNDED_SINGLE_BOX, UI_TICK_MS, createFrame, ratioViewport, safeRenderWidth } from "./chrome.ts";

export interface ObserveAgentData {
	label: string;
	model: string;
	task: string;
	messages: Message[];
	partial?: Message;
	state: "working" | "done" | "error" | "cancelled";
}

export interface ObserveSession {
	title: string;
	phase: "fanout" | "synthesizing";
	agents: ObserveAgentData[];
	synthesizer?: ObserveAgentData;
	overlayOpen: boolean;
	closeOverlay?: () => void;
}

const OVERLAY_MARGIN = 1;
const OVERLAY_HEIGHT_RATIO = 0.9;
const MAX_RENDERED_CHARS = 40_000;
const MAX_TASK_WIDTH = 120;

/** Render completed plus currently streaming message content for an observed agent. */
export function formatAgentMarkdown(agent: ObserveAgentData): string {
	const task = truncateToWidth(agent.task.replace(/\s+/g, " ").trim(), MAX_TASK_WIDTH, "…", false);
	const header = [`## ${agent.label}`, `_${agent.model} · ${agent.state}_`, "", `**Task:** ${task}`, ""].join("\n");
	const contentBudget = Math.max(0, MAX_RENDERED_CHARS - header.length - 1);
	const body = transcriptBody(agent.messages, agent.partial, agent.state, contentBudget);
	const result = `${header}${body}`;
	return result.length <= MAX_RENDERED_CHARS ? result : truncateFromStart(result, MAX_RENDERED_CHARS);
}

export async function showObserveOverlay(ctx: ExtensionContext, session: ObserveSession): Promise<void> {
	if (ctx.mode !== "tui") return;
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => new ObserveOverlayComponent(tui, theme, session, done),
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "90%", minWidth: 60, maxHeight: "90%", margin: OVERLAY_MARGIN },
		},
	);
}

class ObserveOverlayComponent implements Component {
	private selected = 0;
	private scrollOffset = 0;
	/** When true, viewport stays pinned to the newest output (default). */
	private pinnedToBottom = true;
	private closed = false;
	private markdownCache: {
		agent: ObserveAgentData | undefined;
		messagesLength: number;
		partial: Message | undefined;
		state: ObserveAgentData["state"] | undefined;
		width: number;
		rendered: string[];
	} | undefined;
	private readonly timer: ReturnType<typeof setInterval>;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly session: ObserveSession,
		private readonly done: (value: void) => void,
	) {
		this.timer = setInterval(() => tui.requestRender(), UI_TICK_MS);
		session.closeOverlay = () => this.finish();
	}

	private finish(): void {
		if (this.closed) return;
		this.closed = true;
		this.done(undefined);
	}

	private activeAgent(): ObserveAgentData | undefined {
		return this.session.phase === "synthesizing" ? this.session.synthesizer : this.session.agents[this.selected];
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
			this.finish();
			return;
		}
		if (data === "p" || data === "P") {
			this.pinnedToBottom = !this.pinnedToBottom;
			if (this.pinnedToBottom) this.scrollOffset = Number.MAX_SAFE_INTEGER;
			this.tui.requestRender();
			return;
		}
		if (this.session.phase === "fanout" && /^[1-9]$/.test(data)) {
			const index = Number.parseInt(data, 10) - 1;
			if (this.session.agents[index]) {
				this.selected = index;
				this.scrollOffset = 0;
				this.pinnedToBottom = true;
				this.tui.requestRender();
			}
			return;
		}
		if (this.pinnedToBottom && (matchesKey(data, Key.down) || data === "j" || matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("f")) || data === "d")) {
			return;
		}
		let delta = 0;
		if (matchesKey(data, Key.down) || data === "j") delta = 1;
		else if (matchesKey(data, Key.up) || data === "k") {
			delta = -1;
			this.pinnedToBottom = false;
		}
		else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("f")) || data === "d") delta = 12;
		else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("b")) || data === "u") {
			delta = -12;
			this.pinnedToBottom = false;
		}
		else if (matchesKey(data, Key.home)) {
			this.scrollOffset = 0;
			this.pinnedToBottom = false;
		}
		else if (matchesKey(data, Key.end)) {
			this.scrollOffset = Number.MAX_SAFE_INTEGER;
			this.pinnedToBottom = true;
		}
		else return;
		if (delta < 0) this.pinnedToBottom = false;
		this.scrollOffset += delta;
		this.tui.requestRender();
	}

	render(width: number): string[] {
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
		const agent = this.activeAgent();
		const messagesLength = agent?.messages.length ?? 0;
		if (!this.markdownCache
			|| this.markdownCache.agent !== agent
			|| this.markdownCache.messagesLength !== messagesLength
			|| this.markdownCache.partial !== agent?.partial
			|| this.markdownCache.state !== agent?.state
			|| this.markdownCache.width !== bodyWidth) {
			const markdown = new Markdown(agent ? formatAgentMarkdown(agent) : "_(no agent selected)_", 0, 0, getMarkdownTheme());
			this.markdownCache = {
				agent,
				messagesLength,
				partial: agent?.partial,
				state: agent?.state,
				width: bodyWidth,
				rendered: markdown.render(bodyWidth),
			};
		}
		const rendered = this.markdownCache.rendered;
		const viewport = Math.max(4, Math.min(rendered.length, ratioViewport(process.stdout.rows, {
			fallbackRows: 24,
			ratio: OVERLAY_HEIGHT_RATIO,
			minimum: 4,
			chromeRows: 6,
		})));
		const maxOffset = Math.max(0, rendered.length - viewport);
		if (this.pinnedToBottom) this.scrollOffset = maxOffset;
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
		const visible = rendered.slice(this.scrollOffset, this.scrollOffset + viewport);
		while (visible.length < viewport) visible.push("");
		const running = (this.session.phase === "fanout" ? this.session.agents : [this.session.synthesizer]).filter((item) => item?.state === "working").length;
		const pin = this.pinnedToBottom ? " · pinned" : "";
		const modelTag = this.activeAgent()?.model;
		const title = `${this.session.title} · ${this.session.phase === "fanout" ? "fan-out" : "synthesizing"} · ${running} running${pin}`;
		const tab = this.session.phase === "fanout" ? ` · ${this.selected + 1}/${this.session.agents.length}` : "";
		const modelName = modelTag ? ` · ${modelTag}` : "";
		const pinHelp = this.pinnedToBottom ? "p unpin" : "p pin bottom";
		const help = this.session.phase === "fanout"
			? `↑↓/jk scroll · u/d page · ${pinHelp} · # switch agent · esc/q close`
			: `↑↓/jk scroll · u/d page · ${pinHelp} · esc/q close`;
		const th = this.theme;
		return [
			frame.top(),
			frame.row(th.fg("accent", "Observe agents") + th.fg("dim", ` ${title}${tab}${modelName}`)),
			frame.separator(),
			...visible.map(frame.row),
			frame.separator(),
			frame.row(th.fg("dim", help)),
			frame.bottom(),
		];
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.timer);
		if (this.session.closeOverlay) this.session.closeOverlay = undefined;
	}
}
