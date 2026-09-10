/**
 * Cancel overlay — interactive list of in-flight subagents.
 *
 * Opened by ESC during MoA orchestration (or F4 in either planning
 * path). Lists each agent with its live state, tool activity, loop badge and
 * context bar, plus a "Cancel ALL" entry. Enter cancels the selected agent
 * (the overlay stays open so more can be cancelled / the row can be watched
 * flipping to ✗); selecting Cancel ALL aborts the whole run and closes.
 *
 * The component renders directly from `session.run` on every frame (driven by
 * the 100ms spinner interval), so it never shows stale rows and transparently
 * survives the orchestrator swapping `session.run` between phases (fan-out →
 * synthesis) while it is open.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import type { CancelSession } from "../runtime/cancelRun.ts";
import { LOOP_THRESHOLD, usageBar } from "./agentStatus.ts";
import {
	BRAILLE_SPINNER_FRAMES,
	ROUNDED_SINGLE_BOX,
	SELECTOR,
	UI_TICK_MS,
	createFrame,
} from "./chrome.ts";
import { highlightActivity } from "./toolActivity.ts";

const OVERLAY_MARGIN = 1;

/** Show the cancel overlay for the session's live run. Resolves when closed. */
export async function showCancelOverlay(ctx: ExtensionContext, session: CancelSession): Promise<void> {
	if (ctx.mode !== "tui") return;
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => new CancelOverlayComponent(tui, theme, session, done),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "70%",
				minWidth: 50,
				maxHeight: "70%",
				margin: OVERLAY_MARGIN,
			},
		},
	);
}

class CancelOverlayComponent implements Component {
	private sel = 0;
	private spinFrame = 0;
	private closed = false;
	private readonly timer: ReturnType<typeof setInterval>;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly session: CancelSession,
		private readonly done: (value: void) => void,
	) {
		this.timer = setInterval(() => {
			this.spinFrame = (this.spinFrame + 1) % BRAILLE_SPINNER_FRAMES.length;
			tui.requestRender();
		}, UI_TICK_MS);
		session.closeOverlay = () => this.finish();
	}

	private finish(): void {
		if (this.closed) return;
		this.closed = true;
		this.done(undefined);
	}

	/** Agent rows + the trailing "Cancel ALL" row. */
	private rowCount(): number {
		return (this.session.run?.agents.length ?? 0) + 1;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
			this.finish();
			return;
		}
		if (matchesKey(data, Key.up) || data === "k") {
			this.sel = Math.max(0, this.sel - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down) || data === "j") {
			this.sel = Math.min(this.rowCount() - 1, this.sel + 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const run = this.session.run;
			if (!run) {
				this.finish();
				return;
			}
			if (this.sel >= run.agents.length) {
				run.cancelAll();
				this.finish();
				return;
			}
			// No-op unless the agent is still running, so an Enter racing an
			// agent's completion is harmless. Stay open to cancel more.
			run.cancel(this.sel);
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		const run = this.session.run;
		const agents = run?.agents ?? [];
		this.sel = Math.max(0, Math.min(this.sel, agents.length));

		const innerWidth = Math.max(20, width - 4);
		const th = this.theme;
		const frame = createFrame(th, innerWidth, {
			glyphs: ROUNDED_SINGLE_BOX,
			horizontalPadding: 1,
			truncationMark: "…",
			padToWidth: true,
			minimumBodyWidth: 10,
		});
		const top = frame.top();
		const sep = frame.separator();
		const bottom = frame.bottom();
		const row = frame.row;
		const spin = th.fg("accent", BRAILLE_SPINNER_FRAMES[this.spinFrame % BRAILLE_SPINNER_FRAMES.length]!);

		const runningCount = agents.filter((a) => a.state === "running").length;
		const lines: string[] = [
			top,
			row(th.fg("accent", "Cancel agents?") + th.fg("dim", ` ${this.session.title} · ${runningCount} running`)),
			sep,
		];

		if (agents.length === 0) {
			lines.push(row(th.fg("dim", "No agents in flight.")));
		}

		for (let i = 0; i < agents.length; i++) {
			const agent = agents[i];
			const selected = i === this.sel;
			const marker = selected ? th.fg("accent", SELECTOR) : " ";
			const icon =
				agent.state === "done" ? th.fg("success", "✓")
				: agent.state === "error" || agent.state === "cancelled" ? th.fg("error", "✗")
				: spin;
			const stateText =
				agent.state === "running" ? "running"
				: agent.state === "cancelling" ? "cancelling…"
				: agent.state;
			const extras = this.session.getExtras?.(i);
			const bar = extras && (extras.contextTokens !== undefined || extras.contextWindow !== undefined)
				? `${usageBar(extras.contextTokens, extras.contextWindow, this.theme)} `
				: "";
			const label = selected ? th.fg("text", agent.label) : agent.label;
			lines.push(row(`${marker} ${icon} ${bar}${label}  ${th.fg("dim", stateText)}`));

			if (extras?.activity && (agent.state === "running" || agent.state === "cancelling")) {
				const loop = (extras.loopCount ?? 0) >= LOOP_THRESHOLD
					? th.fg("warning", `  (↻ ${extras.loopCount}×)`)
					: "";
				const gutter = th.fg("dim", "      ↳ ");
				const activity = highlightActivity(th, extras.activity);
				lines.push(row(`${gutter}${activity}${loop}`));
			}
		}

		lines.push(sep);
		const allSelected = this.sel === agents.length;
		const allMarker = allSelected ? th.fg("accent", SELECTOR) : " ";
		const allLabel = allSelected
			? th.fg("error", "Cancel ALL running agents")
			: "Cancel ALL running agents";
		lines.push(row(`${allMarker} ${allLabel}`));
		lines.push(sep);
		lines.push(row(th.fg("dim", "↑↓/jk select · enter cancel · esc close")));
		lines.push(bottom);
		return lines;
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.timer);
		if (this.session.closeOverlay) this.session.closeOverlay = undefined;
	}
}
