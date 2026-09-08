/**
 * Conflict-review overlay — confirms/overrides synthesizer-flagged tradeoffs.
 *
 * Between MoA synthesis and the plan-approval gate, the synthesizer emits
 * a `## Conflicts` section for every substantive disagreement between proposer
 * plans (see agents/moa-synthesizer.md). This overlay presents each conflict
 * as one tab: the synthesizer's recommendation (labeled
 * "(Recommended)"), the other proposers' alternatives (blinded `Proposer N`
 * attribution), and a trailing "Chat about this" option that opens an inline
 * `Editor` for free-form clarifying text. Modeled on the tab-bar + Editor
 * interaction from examples/extensions/questionnaire.ts, rendered inside the
 * bordered-box chrome from cancelOverlay.ts / planReviewOverlay.ts.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import { CHAT_VALUE, chatOption, type Conflict, type ConflictAnswer, type ConflictOption } from "../moa/conflicts.ts";
import { ROUNDED_SINGLE_BOX, createFrame, safeRenderWidth } from "./chrome.ts";

const OVERLAY_MARGIN = 1;

export interface ConflictReviewResult {
	cancelled: boolean;
	answers: Map<string, ConflictAnswer>;
}

/** Show the conflict-review overlay. Resolves when the user submits or cancels (Esc). */
export async function showConflictReview(
	ctx: ExtensionContext,
	conflicts: Conflict[],
): Promise<ConflictReviewResult> {
	if (ctx.mode !== "tui" || conflicts.length === 0) {
		return { cancelled: false, answers: new Map() };
	}
	const result = await ctx.ui.custom<ConflictReviewResult>(
		(tui, theme, _keybindings, done) => new ConflictReviewComponent(tui, theme, conflicts, done),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "80%",
				minWidth: 60,
				maxHeight: "85%",
				margin: OVERLAY_MARGIN,
			},
		},
	);
	return result ?? { cancelled: true, answers: new Map() };
}

/** Ensures every conflict's options end with a trailing chat option. */
function withChatOption(conflict: Conflict): Conflict {
	const hasChat = conflict.options.some((o) => o.value === CHAT_VALUE);
	return hasChat ? conflict : { ...conflict, options: [...conflict.options, chatOption()] };
}

class ConflictReviewComponent implements Component {
	private readonly conflicts: Conflict[];
	private currentTab = 0; // 0..conflicts.length-1 = conflict tabs, conflicts.length = Submit
	private optionIndex = 0;
	private inputMode = false;
	private chatConflictId: string | null = null;
	private readonly answers = new Map<string, ConflictAnswer>();
	private readonly editor: Editor;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		conflicts: Conflict[],
		private readonly done: (result: ConflictReviewResult) => void,
	) {
		this.conflicts = conflicts.map(withChatOption);

		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		this.editor = new Editor(tui, editorTheme);
		this.editor.onSubmit = (value) => {
			if (!this.chatConflictId) return;
			const trimmed = value.trim() || "(no response)";
			this.saveAnswer(this.chatConflictId, CHAT_VALUE, "chat", trimmed);
			this.inputMode = false;
			this.chatConflictId = null;
			this.editor.setText("");
			this.advanceAfterAnswer();
		};
	}

	private totalTabs(): number {
		return this.conflicts.length + 1;
	}

	private currentConflict(): Conflict | undefined {
		return this.conflicts[this.currentTab];
	}

	private allAnswered(): boolean {
		return this.conflicts.every((c) => this.answers.has(c.id));
	}

	private answeredCount(): number {
		return this.conflicts.filter((c) => this.answers.has(c.id)).length;
	}

	private saveAnswer(
		conflictId: string,
		optionValue: string,
		kind: ConflictAnswer["kind"],
		chatText?: string,
	): void {
		this.answers.set(conflictId, { optionValue, kind, chatText });
	}

	private advanceAfterAnswer(): void {
		if (this.currentTab < this.conflicts.length - 1) {
			this.currentTab++;
		} else {
			this.currentTab = this.conflicts.length; // Submit tab
		}
		this.optionIndex = 0;
		this.tui.requestRender();
	}

	private finish(cancelled: boolean): void {
		this.done({ cancelled, answers: this.answers });
	}

	handleInput(data: string): void {
		if (this.inputMode) {
			if (matchesKey(data, Key.escape)) {
				this.inputMode = false;
				this.chatConflictId = null;
				this.editor.setText("");
				this.tui.requestRender();
				return;
			}
			this.editor.handleInput(data);
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
			this.currentTab = (this.currentTab + 1) % this.totalTabs();
			this.optionIndex = 0;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
			this.currentTab = (this.currentTab - 1 + this.totalTabs()) % this.totalTabs();
			this.optionIndex = 0;
			this.tui.requestRender();
			return;
		}

		// Submit tab
		if (this.currentTab === this.conflicts.length) {
			if (matchesKey(data, Key.enter) && this.allAnswered()) {
				this.finish(false);
			} else if (matchesKey(data, Key.escape)) {
				this.finish(true);
			}
			return;
		}

		const conflict = this.currentConflict();
		if (!conflict) return;

		if (matchesKey(data, Key.up)) {
			this.optionIndex = Math.max(0, this.optionIndex - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.optionIndex = Math.min(conflict.options.length - 1, this.optionIndex + 1);
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.enter)) {
			const opt = conflict.options[this.optionIndex];
			if (!opt) return;
			if (opt.value === CHAT_VALUE) {
				this.inputMode = true;
				this.chatConflictId = conflict.id;
				this.editor.setText("");
				this.tui.requestRender();
				return;
			}
			const kind: ConflictAnswer["kind"] = opt.recommended ? "recommended" : "alternative";
			this.saveAnswer(conflict.id, opt.value, kind);
			this.advanceAfterAnswer();
			return;
		}

		if (matchesKey(data, Key.escape)) {
			this.finish(true);
		}
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

		const th = this.theme;
		const top = frame.top();
		const sep = frame.separator();
		const bottom = frame.bottom();
		const row = frame.row;

		const lines: string[] = [];
		lines.push(top);
		lines.push(
			row(
				th.fg("accent", "Resolve conflicts") +
					th.fg("dim", ` Review choices · ${this.answeredCount()}/${this.conflicts.length} answered`),
			),
		);
		lines.push(sep);

		// Tab bar
		const maxTabLabelLen = this.conflicts.length > 8 ? 3 : 12;
		const tabParts: string[] = [];
		for (let i = 0; i < this.conflicts.length; i++) {
			const conflict = this.conflicts[i];
			const isActive = i === this.currentTab;
			const isAnswered = this.answers.has(conflict.id);
			const box = isAnswered ? "■" : "□";
			const color = isAnswered ? "success" : "muted";
			const lbl = truncateToWidth(conflict.label, maxTabLabelLen, "…", false);
			const text = ` ${box} ${lbl} `;
			tabParts.push(isActive ? th.bg("selectedBg", th.fg("text", text)) : th.fg(color, text));
		}
		const canSubmit = this.allAnswered();
		const isSubmitTab = this.currentTab === this.conflicts.length;
		const submitText = " ✓ Submit ";
		tabParts.push(
			isSubmitTab
				? th.bg("selectedBg", th.fg("text", submitText))
				: th.fg(canSubmit ? "success" : "dim", submitText),
		);
		for (const tabLine of wrapTextWithAnsi(tabParts.join(""), bodyWidth)) {
			lines.push(row(tabLine));
		}
		lines.push(sep);

		if (this.inputMode && this.chatConflictId) {
			const conflict = this.conflicts.find((c) => c.id === this.chatConflictId);
			if (conflict) {
				lines.push(row(th.fg("accent", "What you're deciding")));
				for (const l of wrapTextWithAnsi(th.fg("text", conflict.prompt), bodyWidth)) lines.push(row(l));
				lines.push(row(th.fg("muted", "Select the option that best matches your preference.")));
				lines.push(row(""));
				this.renderOptions(conflict, lines, row, bodyWidth, th, true);
				lines.push(row(""));
				lines.push(row(th.fg("muted", "Your message:")));
				for (const l of this.editor.render(Math.max(1, bodyWidth - 2))) lines.push(row(l));
			}
		} else if (isSubmitTab) {
			lines.push(row(th.fg("accent", "Ready to submit")));
			lines.push(row(""));
			for (const conflict of this.conflicts) {
				const answer = this.answers.get(conflict.id);
				if (!answer) continue;
				let summary: string;
				if (answer.kind === "chat") {
					summary = `from chat: ${answer.chatText}`;
				} else {
					const opt = conflict.options.find((o) => o.value === answer.optionValue);
					summary = opt?.label ?? answer.optionValue;
				}
				for (const l of wrapTextWithAnsi(
					`${th.fg("muted", `${conflict.label}: `)}${th.fg("text", summary)}`,
					bodyWidth,
				)) {
					lines.push(row(l));
				}
			}
			lines.push(row(""));
			if (this.allAnswered()) {
				lines.push(row(th.fg("success", "Press Enter to submit")));
			} else {
				const missing = this.conflicts
					.filter((c) => !this.answers.has(c.id))
					.map((c) => c.label)
					.join(", ");
				lines.push(row(th.fg("warning", `Unanswered: ${missing}`)));
			}
		} else {
			const conflict = this.currentConflict();
			if (conflict) {
				lines.push(row(th.fg("accent", "What you're deciding")));
				for (const l of wrapTextWithAnsi(th.fg("text", conflict.prompt), bodyWidth)) lines.push(row(l));
				lines.push(row(th.fg("muted", "Select the option that best matches your preference.")));
				lines.push(row(""));
				this.renderOptions(conflict, lines, row, bodyWidth, th, false);
			}
		}

		lines.push(sep);
		lines.push(row(th.fg("dim", "Tab/←→ tabs · ↑↓ select · Enter confirm · Esc cancel")));
		lines.push(bottom);
		return lines;
	}

	private renderOptions(
		conflict: Conflict,
		lines: string[],
		row: (s: string) => string,
		bodyWidth: number,
		th: Theme,
		greyed: boolean,
	): void {
		for (let i = 0; i < conflict.options.length; i++) {
			const opt = conflict.options[i];
			const selected = !greyed && i === this.optionIndex;
			const marker = selected ? "> " : "  ";
			const label = `${marker}${i + 1}. ${opt.label}`;
			const color = greyed ? "muted" : selected ? "accent" : "text";
			for (const l of wrapTextWithAnsi(th.fg(color, label), bodyWidth)) lines.push(row(l));
			const desc = opt.description;
			if (desc) {
				const indent = "     ";
				const descWidth = Math.max(1, bodyWidth - indent.length);
				for (const l of wrapTextWithAnsi(th.fg("muted", desc), descWidth)) lines.push(row(indent + l));
			}
		}
	}

	invalidate(): void {}

	dispose(): void {}
}
