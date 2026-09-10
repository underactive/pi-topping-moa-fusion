/**
 * MoA progress surfaces.
 *
 * Fan-out, synthesis, implementation and verification render into ONE sticky
 * widget above the editor, under a single key: a full-width agent table
 * carrying elapsed time, turn count, tool-call count, model cost, context
 * usage and a pi-topping style generated-output activity meter per agent.
 * Rows are grouped under `── Plan / Synthesize / Implement / Verify` headings,
 * with a shimmering four-phase chevron band above the header tracing the
 * active phase. The table stays mounted across the whole run — orchestration
 * hands it to the plan-mode controller on approval, which keeps it alive
 * through in-session implementation and verification.
 *
 * Each row's MONITOR activity meter is tinted with the thinking level that row
 * runs under, using that level's native theme color (`thinkingOff` through
 * `thinkingMax`). The level is stored per row — not per model — so identical
 * models in different slots can carry different hues, and every activation
 * (retry, model swap, verifier fallback, resumed handoff) refreshes it. A row
 * whose level is unknown falls back to the neutral `accent`, and idle cells
 * plus settled traces keep their existing dimming under whichever hue applies.
 *
 * Widgets never take keyboard focus, so the default editor keeps it and pi
 * dispatches f2/f3/f4 through the extension shortcuts registered in index.ts.
 * ESC likewise stays with index.ts's raw terminal-input hook. Nothing here
 * handles input.
 */

import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { ACTIVITY_METER_WIDTH, ActivityMeter, rateToLevel, TokRateTracker } from "../activityMeter.ts";
import { modelRefLabel, shortModelName, type ModelRef, type ThinkingLevel } from "../shared/modelRefs.ts";
import { contextPercent, CTX_COL_WIDTH, formatCost, formatElapsed, formatTokens } from "./agentStatus.ts";
import { formatAgentPreview } from "./agentTranscript.ts";
import { QUADRANT_SPINNER_FRAMES, UI_TICK_MS, fitVisible, ratioViewport } from "./chrome.ts";
import { shimmerString, type ShimmerTheme } from "./shimmer.ts";
import { highlightActivity } from "./toolActivity.ts";

const WIDGET_KEY = "mf-plan-moa-status";

/** Visible phase groups, in render order. */
export const MOA_PHASES = ["Plan", "Synthesize", "Implement", "Verify"] as const;
export type MoaPhase = (typeof MOA_PHASES)[number];

/** The model (or, for the fan-out, models) assigned to each phase, for the band. */
export type PhaseModels = Partial<Record<MoaPhase, ModelRef | ModelRef[]>>;

export type ProposerState = "queued" | "working" | "done" | "error" | "cancelling" | "cancelled";

export interface ProposerStatus {
	ref: ModelRef;
	phase: MoaPhase;
	state: ProposerState;
	detail?: string;
	/**
	 * Thinking level the model runs this activation under, tinting the MONITOR
	 * meter. Per row, not per model: the same model can occupy different slots at
	 * different levels. Undefined when the level is unknown (meter falls to accent).
	 */
	thinking?: ThinkingLevel;
	/** Latest reported context size for this agent's most recent turn (usage.totalTokens). */
	contextTokens?: number;
	/** Live one-line description of the agent's most recent tool call. */
	activity?: string;
	/** Recent activity strings (bounded) for simple loop detection. */
	activityHistory?: string[];
	/** Cumulative generated-output tokens, driving the activity meter. */
	outputTokens?: number;
	/** Bumped when exact usage supersedes an estimate, so the meter can reset. */
	outputRevision?: number;
	/** Bounded completed and streaming output shown beneath a working row. */
	transcript?: { messages: Message[]; partial?: Message };
	/** Bumped on every transcript snapshot, including in-place stream updates. */
	transcriptRevision?: number;
	/** Assistant turns completed so far. */
	turns?: number;
	/** Tool calls started so far. */
	toolCalls?: number;
	/** Cumulative model cost in USD, calculated from registry rates. */
	costUsd?: number;
	startedAt?: number;
	/** Set once the agent settles, freezing its elapsed reading. */
	endedAt?: number;
}

type ContextWindowResolver = (ref: ModelRef) => number | undefined;

/** How many recent activity entries to retain per agent for loop detection. */
const ACTIVITY_WINDOW = 8;

const TABLE_TITLE = "MoA Fusion";
const TABLE_FOOTER = "esc cancel · f2 preview · f3 observe";
/** Shortest rule run allowed between the title and the plan name before the name is dropped. */
const MIN_TITLE_NAME_GAP = 2;
/**
 * Share of the terminal the table may claim. Lower than an overlay's would be:
 * this sits above the editor for the whole run and cannot be dismissed, so it
 * has to leave the transcript readable.
 */
const TABLE_HEIGHT_RATIO = 0.65;
/** Border, header, separator, footer and bottom border — the rows a table always costs. */
const TABLE_CHROME_ROWS = 5;
/** Two band text lines plus their separator rule — the extra rows the phase/model band costs when shown. */
const PHASE_BAND_ROWS = 3;
/** Narrowest a band column may get before its centered label becomes unreadable; below this the band is dropped. */
const PHASE_BAND_MIN_COL = 12;
/**
 * The two halves of the tall right-chevron drawn between phase columns: a "\"
 * powerline diagonal (U+E0B9) on the name row stacked over a "/" (U+E0BB) on
 * the model row. Needs a Powerline/Nerd Font to render; plainer fonts show tofu.
 */
const PHASE_SEP_TOP = "\u{E0B9}";
const PHASE_SEP_BOTTOM = "\u{E0BB}";

const COLUMN_GAP = 2;
const STATUS_COL_WIDTH = 2;
const ELAPSED_COL_WIDTH = 6;
const TURNS_COL_WIDTH = 5;
const TOOLS_COL_WIDTH = 5;
const COST_COL_WIDTH = 8;
const AGENT_COL_MIN = 8;
/** Agent width below which a model ref stops being distinguishable from its siblings. */
const AGENT_COL_READABLE = 24;
const ACTIVITY_COL_MIN = 10;
const PREVIEW_LINES = 4;
const PREVIEW_INDENT = STATUS_COL_WIDTH + 2;
const PREVIEW_GUTTER = "│ ";
const PREVIEW_MIN_WIDTH = 16;
const TRANSCRIPT_MESSAGE_LIMIT = 40;

/**
 * MONITOR meter hue per selected thinking level: each row's activity meter is
 * tinted with its level's native theme color (`thinkingOff` … `thinkingMax`),
 * so the table reads the thinking effort at a glance. Rows whose level is
 * unknown fall back to `accent` (see `meterColorFor`). Exhaustive over
 * `ThinkingLevel` so a new level cannot silently render as accent.
 */
const THINKING_METER_COLORS: Record<ThinkingLevel, ThemeColor> = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};

/** Resolve a row's meter hue, defaulting an unknown level to the neutral accent. */
function meterColorFor(thinking: ThinkingLevel | undefined): ThemeColor {
	return thinking ? THINKING_METER_COLORS[thinking] : "accent";
}

/** Push an activity onto a bounded history buffer (most-recent-last). */
function pushActivity(history: string[], activity: string): void {
	history.push(activity);
	while (history.length > ACTIVITY_WINDOW) history.shift();
}

/** Working agents animate, render bright, and may carry a tool-activity sub-row. */
function isActive(state: ProposerState): boolean {
	return state === "working" || state === "cancelling";
}

/** One agent line in the fan-out/synthesis/implementation/verification table. */
export interface ProgressRow {
	phase: MoaPhase;
	label: string;
	state: ProposerState;
	statusText: string;
	contextTokens?: number;
	contextWindow?: number;
	activity?: string;
	elapsedMs: number;
	turns: number;
	toolCalls: number;
	costUsd?: number;
	outputTokens: number;
	outputRevision: number;
	transcript?: { messages: Message[]; partial?: Message };
	transcriptRevision: number;
	/** Thinking level of this activation, colouring the MONITOR meter. */
	thinking?: ThinkingLevel;
	/** First row of its phase group; used by the render-only phase heading. */
	firstOfPhase: boolean;
}

/** The slice of pi's `Theme` the table needs. Structural so tests can stub it without `getFgAnsi`. */
export interface ProgressTheme {
	fg(color: ThemeColor, text: string): string;
	bold(text: string): string;
	/** 24-bit ANSI escape for a color. Absent on test stubs, so the band falls back to flat text. */
	getFgAnsi?(color: ThemeColor): string;
}

/** What the table component reads from. */
export interface MoaProgressView {
	progressRows(): ProgressRow[];
	/** Title shown in the table's top border. */
	readonly title: string;
	/** Summarized plan name, shown right-aligned in the title bar. */
	readonly planName: string | undefined;
	/** Whether live transcript previews are currently shown beneath active rows. */
	readonly previewVisible: boolean;
	/** Display label for a phase without changing its internal identity. */
	phaseLabel(phase: MoaPhase): string;
	/** Model assigned to each phase, for the band above the table header. */
	phaseModels(): PhaseModels;
	/** The phase currently highlighted in the band; undefined highlights none. */
	activePhase(): MoaPhase | undefined;
}

export interface MoaProgressCallbacks {
	/**
	 * Close the cancel/observe overlays. Both describe the run this table is
	 * reporting on, so they must not outlive it.
	 */
	closeStacked?: () => void;
	/** Display-only overrides used by sibling fan-out flows. */
	title?: string;
	phaseLabels?: Partial<Record<MoaPhase, string>>;
	fanoutWorkingText?: string;
}

interface RowMeter {
	meter: ActivityMeter;
	tracker: TokRateTracker;
	revision: number;
}

/** A post-fan-out workload (synthesizer, implementer, verifier), keyed by phase. */
interface RoleRow {
	ref: ModelRef;
	status: ProposerStatus;
	workingText: string;
}

export class MoaProgressWidget implements MoaProgressView {
	private readonly ctx: ExtensionContext;
	private readonly resolveContextWindow: ContextWindowResolver;
	/** Context window is immutable per model, so a resolved value is cached by ref label across ticks. */
	private readonly contextWindowCache = new Map<string, number | undefined>();
	private readonly callbacks: MoaProgressCallbacks;
	readonly title: string;
	readonly planName: string | undefined;

	private statuses: ProposerStatus[] = [];
	private roleRows = new Map<MoaPhase, RoleRow>();
	private models: PhaseModels = {};
	private active: MoaPhase | undefined;
	private tableMounted = false;
	private showPreview = true;
	private requestRender: (() => void) | undefined;

	constructor(
		ctx: ExtensionContext,
		resolveContextWindow: ContextWindowResolver = () => undefined,
		callbacks: MoaProgressCallbacks = {},
		planName?: string,
	) {
		this.ctx = ctx;
		this.resolveContextWindow = resolveContextWindow;
		this.callbacks = callbacks;
		this.title = callbacks.title ?? TABLE_TITLE;
		this.planName = planName;
	}

	private get ui(): ExtensionContext["ui"] {
		return this.ctx.ui;
	}

	get previewVisible(): boolean {
		return this.showPreview;
	}

	togglePreview(): boolean {
		this.showPreview = !this.showPreview;
		this.requestRender?.();
		return this.showPreview;
	}

	private mountTable(): void {
		if (this.tableMounted) return;
		this.tableMounted = true;
		this.ui.setWidget(WIDGET_KEY, (tui, theme) => {
			this.requestRender = () => tui.requestRender();
			return new MoaProgressTableComponent(tui, theme, this);
		});
	}

	private unmount(): void {
		if (this.tableMounted) {
			this.tableMounted = false;
			this.callbacks.closeStacked?.();
		}
		this.requestRender = undefined;
		this.ui.setWidget(WIDGET_KEY, undefined);
	}

	/**
	 * Start the fan-out phase with the initial (working) proposer statuses.
	 * `thinking[i]` tints proposer `i`'s meter; an absent entry falls to accent.
	 */
	startFanout(refs: ModelRef[], thinking: (ThinkingLevel | undefined)[] = []): void {
		const startedAt = Date.now();
		this.statuses = refs.map((ref, index) => ({ ref, phase: "Plan" as const, state: "working" as const, startedAt, thinking: thinking[index] }));
		this.active = "Plan";
		this.mountTable();
	}

	/** Assign the model shown in the phase/model band for each phase. */
	setPhaseModels(models: PhaseModels): void {
		this.models = models;
	}

	phaseModels(): PhaseModels {
		return this.models;
	}

	/** Mark which phase is highlighted in the band. Undefined highlights none. */
	setActivePhase(phase: MoaPhase | undefined): void {
		this.active = phase;
	}

	activePhase(): MoaPhase | undefined {
		return this.active;
	}

	phaseLabel(phase: MoaPhase): string {
		return this.callbacks.phaseLabels?.[phase] ?? phase;
	}

	/** Register a not-yet-started role row so its phase heading renders from the start. */
	queueRoleRow(phase: MoaPhase, ref: ModelRef, thinking?: ThinkingLevel): void {
		this.roleRows.set(phase, { ref, status: { ref, phase, state: "queued", thinking }, workingText: "" });
	}

	/** Update one proposer's status (by index, matching the order passed to startFanout). */
	update(index: number, state: ProposerState, detail?: string): void {
		const s = this.statuses[index];
		if (!s) return;
		const wasSettled = s.state === "done" || s.state === "error" || s.state === "cancelled";
		s.state = state;
		s.detail = detail;
		// Re-activation (a settled proposer being retried) un-freezes the clock
		// and must not show output from the failed attempt.
		if (state === "working" && wasSettled) {
			s.transcript = undefined;
			s.transcriptRevision = (s.transcriptRevision ?? 0) + 1;
		}
		if (!isActive(state)) s.endedAt ??= Date.now();
		else s.endedAt = undefined;
	}

	/** Update one proposer's live context, turn, tool-call, and cost readings (by index). */
	updateUsage(index: number, contextTokens: number | undefined, turns: number, toolCalls = 0, costUsd?: number): void {
		const s = this.statuses[index];
		if (!s) return;
		s.contextTokens = contextTokens;
		s.turns = turns;
		s.toolCalls = toolCalls;
		s.costUsd = costUsd;
	}

	/** Update one proposer's live tool-activity line (by index). */
	updateActivity(index: number, activity: string): void {
		const s = this.statuses[index];
		if (!s || !activity) return;
		s.activity = activity;
		s.activityHistory = s.activityHistory ?? [];
		pushActivity(s.activityHistory, activity);
	}

	/** Update one proposer's generated-output reading (by index). */
	updateOutput(index: number, tokens: number, revision: number): void {
		const s = this.statuses[index];
		if (!s) return;
		s.outputTokens = tokens;
		s.outputRevision = revision;
	}

	/** Update one proposer's bounded completed and streaming transcript snapshot. */
	updateTranscript(index: number, messages: Message[], partial?: Message): void {
		if (!this.showPreview) return;
		const s = this.statuses[index];
		if (!s) return;
		s.transcript = { messages: messages.slice(-TRANSCRIPT_MESSAGE_LIMIT), partial };
		s.transcriptRevision = (s.transcriptRevision ?? 0) + 1;
	}

	/**
	 * Move a role row into `working`, starting (or keeping) its elapsed clock.
	 * Each activation replaces the row's thinking level (with `undefined` when the
	 * caller cannot supply one), so a stale hue never outlives a model/level swap.
	 */
	private setRoleWorking(phase: MoaPhase, ref: ModelRef, workingText: string, thinking?: ThinkingLevel): void {
		const existing = this.roleRows.get(phase);
		const status: ProposerStatus = existing?.status ?? { ref, phase, state: "queued", activityHistory: [] };
		const wasWorking = status.state === "working";
		const wasSettled = status.state === "done" || status.state === "error" || status.state === "cancelled";
		status.ref = ref;
		status.phase = phase;
		status.state = "working";
		status.detail = undefined;
		status.thinking = thinking;
		if (wasSettled) {
			status.startedAt = Date.now();
			status.contextTokens = undefined;
			status.activity = undefined;
			status.activityHistory = [];
			status.outputTokens = undefined;
			status.outputRevision = undefined;
			status.turns = undefined;
			status.toolCalls = undefined;
			status.costUsd = undefined;
			status.transcript = undefined;
			status.transcriptRevision = (status.transcriptRevision ?? 0) + 1;
		} else {
			status.startedAt ??= Date.now();
		}
		status.endedAt = undefined;
		this.roleRows.set(phase, { ref, status, workingText });
	}

	/**
	 * Switch to the synthesis phase, appending the synthesizer row below the
	 * (now frozen) proposer rows. Reuses the table when it is still up;
	 * remounts when a user prompt or conflict review stopped it in between.
	 */
	switchToSynthesizing(synthesizerRef: ModelRef, status: string, thinking?: ThinkingLevel): void {
		this.setRoleWorking("Synthesize", synthesizerRef, status, thinking);
		this.active = "Synthesize";
		this.mountTable();
	}

	/** Activate the in-session implementer row. */
	switchToImplementing(implementerRef: ModelRef, status: string, thinking?: ThinkingLevel): void {
		this.setRoleWorking("Implement", implementerRef, status, thinking);
		this.active = "Implement";
		this.mountTable();
	}

	/** Activate the verifier row. */
	switchToVerifying(verifierRef: ModelRef, status: string, thinking?: ThinkingLevel): void {
		this.setRoleWorking("Verify", verifierRef, status, thinking);
		this.active = "Verify";
		this.mountTable();
	}

	/** Settle a role row, freezing its elapsed reading. */
	settleRoleRow(phase: MoaPhase, state: "done" | "error" | "cancelled", status?: string): void {
		const existing = this.roleRows.get(phase);
		if (!existing) return;
		const s = existing.status;
		s.state = state;
		s.detail = status;
		s.activity = undefined;
		s.endedAt ??= Date.now();
	}

	/** Update a role row's live context, turn, tool-call, and cost readings. */
	updateRoleUsage(phase: MoaPhase, contextTokens: number | undefined, turns: number, toolCalls = 0, costUsd?: number): void {
		const s = this.roleRows.get(phase)?.status;
		if (!s) return;
		s.contextTokens = contextTokens;
		s.turns = turns;
		s.toolCalls = toolCalls;
		s.costUsd = costUsd;
	}

	/** Update a role row's live tool-activity line. */
	updateRoleActivity(phase: MoaPhase, activity: string): void {
		const s = this.roleRows.get(phase)?.status;
		if (!s || !activity) return;
		s.activity = activity;
		s.activityHistory = s.activityHistory ?? [];
		pushActivity(s.activityHistory, activity);
	}

	/** Update a role row's generated-output reading. */
	updateRoleOutput(phase: MoaPhase, tokens: number, revision: number): void {
		const s = this.roleRows.get(phase)?.status;
		if (!s) return;
		s.outputTokens = tokens;
		s.outputRevision = revision;
	}

	/** Update a role row's bounded completed and streaming transcript snapshot. */
	updateRoleTranscript(phase: MoaPhase, messages: Message[], partial?: Message): void {
		if (!this.showPreview) return;
		const s = this.roleRows.get(phase)?.status;
		if (!s) return;
		s.transcript = { messages: messages.slice(-TRANSCRIPT_MESSAGE_LIMIT), partial };
		s.transcriptRevision = (s.transcriptRevision ?? 0) + 1;
	}

	/** Tear down the progress surface. Safe to call multiple times. */
	stopWidget(): void {
		this.unmount();
	}

	/** Live status snapshot for one proposer row (read by the cancel overlay). */
	getStatus(index: number): ProposerStatus | undefined {
		return this.statuses[index];
	}

	/** Live status snapshot for a role row (read by the cancel overlay). */
	getRoleStatus(phase: MoaPhase): { ref: ModelRef | undefined; contextTokens: number | undefined; activity: string | undefined; activityHistory: string[] } {
		const entry = this.roleRows.get(phase);
		return {
			ref: entry?.ref,
			contextTokens: entry?.status.contextTokens,
			activity: entry?.status.activity,
			activityHistory: entry?.status.activityHistory ?? [],
		};
	}

	/** Table rows: every proposer, plus role rows in phase order. */
	progressRows(): ProgressRow[] {
		const now = Date.now();
		const ordered: { phase: MoaPhase; status: ProposerStatus; workingText: string }[] = [
			...this.statuses.map((status) => ({
				phase: "Plan" as MoaPhase,
				status,
				workingText: this.callbacks.fanoutWorkingText ?? "exploring & planning",
			})),
			...[...this.roleRows.entries()].map(([phase, role]) => ({ phase, status: role.status, workingText: role.workingText })),
		].sort((a, b) => MOA_PHASES.indexOf(a.phase) - MOA_PHASES.indexOf(b.phase));
		return ordered.map((entry, index) =>
			this.toRow(entry.status, entry.phase, entry.workingText, now, ordered[index - 1]?.phase !== entry.phase),
		);
	}

	private cachedContextWindow(ref: ModelRef): number | undefined {
		const key = modelRefLabel(ref);
		if (this.contextWindowCache.has(key)) return this.contextWindowCache.get(key);
		const value = this.resolveContextWindow(ref);
		this.contextWindowCache.set(key, value);
		return value;
	}

	private toRow(s: ProposerStatus, phase: MoaPhase, workingText: string, now: number, firstOfPhase: boolean): ProgressRow {
		const statusText =
			s.state === "working" ? (s.detail ?? workingText)
			: s.state === "cancelling" ? "cancelling…"
			: s.state === "cancelled" ? "cancelled"
			: s.state === "error" ? s.detail ?? "error"
			: s.state === "queued" ? "queued"
			: `done (${formatTokens(s.outputTokens ?? 0)} tokens)`;
		return {
			phase,
			label: modelRefLabel(s.ref),
			state: s.state,
			statusText,
			contextTokens: s.contextTokens,
			contextWindow: this.cachedContextWindow(s.ref),
			activity: s.activity,
			elapsedMs: s.startedAt === undefined ? 0 : (s.endedAt ?? now) - s.startedAt,
			turns: s.turns ?? 0,
			toolCalls: s.toolCalls ?? 0,
			costUsd: s.costUsd,
			outputTokens: s.outputTokens ?? 0,
			outputRevision: s.outputRevision ?? 0,
			transcript: s.transcript,
			transcriptRevision: s.transcriptRevision ?? 0,
			thinking: s.thinking,
			firstOfPhase,
		};
	}
}

/** Column widths for the agent table, shedding columns as the terminal narrows. */
export function tableColumns(bodyWidth: number, labels: string[]): { agent: number; activity: number; stats: boolean } {
	const fixed = STATUS_COL_WIDTH + COLUMN_GAP + CTX_COL_WIDTH + COLUMN_GAP + ACTIVITY_METER_WIDTH + COLUMN_GAP;
	const statsWidth = ELAPSED_COL_WIDTH + COLUMN_GAP + COST_COL_WIDTH + COLUMN_GAP + TOOLS_COL_WIDTH + COLUMN_GAP + TURNS_COL_WIDTH + COLUMN_GAP;
	// Elapsed, turns, tool calls, and cost go first on a narrow terminal: they are ambient readings,
	// and are not worth truncating the agent name down to an unreadable stub.
	const stats = bodyWidth - fixed - statsWidth >= AGENT_COL_READABLE + ACTIVITY_COL_MIN;
	const available = bodyWidth - fixed - (stats ? statsWidth : 0);
	if (available < AGENT_COL_MIN) return { agent: Math.max(1, available), activity: 0, stats };

	const widest = labels.reduce((max, label) => Math.max(max, visibleWidth(label)), 0);
	const agent = Math.min(Math.max(AGENT_COL_MIN, widest), Math.max(AGENT_COL_MIN, available - ACTIVITY_COL_MIN));
	return { agent, activity: available - agent, stats };
}

/** Pad or truncate a possibly-ANSI-colored cell to exactly `width` columns. */
function cell(text: string, width: number, align: "left" | "right" | "center" = "left"): string {
	if (width <= 0) return "";
	const shown = visibleWidth(text) > width
		? fitVisible(text, width, { truncationMark: "…", padToWidth: false })
		: text;
	const padding = Math.max(0, width - visibleWidth(shown));
	if (align === "right") return " ".repeat(padding) + shown;
	if (align === "center") {
		const left = Math.floor(padding / 2);
		return " ".repeat(left) + shown + " ".repeat(padding - left);
	}
	return shown + " ".repeat(padding);
}

/** Count the render-only heading and blank separator rows needed for the phase groups in `rows`. */
function phaseSectionRows(rows: ProgressRow[]): number {
	const headingCount = rows.reduce(
		(count, row, index) => count + (index === 0 || rows[index - 1]?.phase !== row.phase ? 1 : 0),
		0,
	);
	return headingCount + Math.max(0, headingCount - 1);
}

export class MoaProgressTableComponent implements Component {
	private readonly tui: TUI;
	private readonly theme: ProgressTheme;
	private readonly view: MoaProgressView;
	private readonly timer: ReturnType<typeof setInterval>;
	private readonly meters: RowMeter[] = [];
	private readonly previewCache = new Map<number, { revision: number; width: number; lines: string[] }>();
	private readonly createdAt = Date.now();
	private spinFrame = 0;

	constructor(tui: TUI, theme: ProgressTheme, view: MoaProgressView) {
		this.tui = tui;
		this.theme = theme;
		this.view = view;
		// One timer drives spinner animation, meter sampling and repaint, so the
		// meter's 100ms cadence matches pi-topping's.
		this.timer = setInterval(() => {
			this.spinFrame = (this.spinFrame + 1) % QUADRANT_SPINNER_FRAMES.length;
			this.sampleMeters(Date.now());
			this.tui.requestRender();
		}, UI_TICK_MS);
	}

	private sampleMeters(now: number): void {
		const rows = this.view.progressRows();
		this.meters.length = rows.length;
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i];
			let entry = this.meters[i];
			if (!entry) {
				entry = { meter: new ActivityMeter("rtl"), tracker: new TokRateTracker(), revision: row.outputRevision };
				this.meters[i] = entry;
			}
			if (entry.revision !== row.outputRevision) {
				entry.revision = row.outputRevision;
				entry.tracker.reset();
			}
			// Settled agents keep their final trace instead of decaying to idle.
			if (!isActive(row.state)) continue;
			entry.meter.push(rateToLevel(entry.tracker.sample(row.outputTokens, now)));
		}
	}

	private renderMeter(index: number, active: boolean, thinking: ThinkingLevel | undefined): string {
		const meter = this.meters[index]?.meter;
		if (!meter) return this.theme.fg("dim", "⢀".repeat(ACTIVITY_METER_WIDTH));
		// Each row's meter carries its selected thinking level's native theme hue;
		// an unknown level falls back to accent. IDLE cells and settled traces keep
		// their existing dimming inside colorizeCell regardless of the hue.
		const color = meterColorFor(thinking);
		return meter.render((level, char) =>
			ActivityMeter.colorizeCell(level, char, this.theme, color, !active),
		);
	}

	/** How many lines the table may use, so it never crowds out the editor below it. */
	private rowBudget(): number {
		const rows = this.tui?.terminal?.rows ?? 0;
		if (rows <= 0) return Number.POSITIVE_INFINITY;
		return ratioViewport(rows, {
			fallbackRows: rows,
			ratio: TABLE_HEIGHT_RATIO,
			minimum: TABLE_CHROME_ROWS,
		});
	}

	/** Compact band label for one phase's model(s), truncated by the Plan cell's width budget. */
	private bandLabel(models: ModelRef | ModelRef[] | undefined, colWidth: number): string {
		if (!models) return "—";
		if (Array.isArray(models)) {
			const names = models.map(shortModelName).join(" · ");
			return visibleWidth(names) <= colWidth ? names : `${models.length} proposers`;
		}
		return shortModelName(models);
	}

	/**
	 * Two centered rows — phase names, then their assigned model ids — shown
	 * above the table header, with a two-row powerline chevron standing between
	 * adjacent columns to trace the phase flow. Self-suppresses when no phase has
	 * a model, or the terminal is too narrow to keep each column readable. The
	 * active phase (and the chevrons touching it) shimmers in place of its flat
	 * highlighted tone when the theme can supply truecolor ANSI.
	 */
	private phaseModelBand(bodyWidth: number, now: number): string[] {
		const models = this.view.phaseModels();
		if (!MOA_PHASES.some((phase) => models[phase])) return [];
		const sepCount = MOA_PHASES.length - 1;
		const colWidth = Math.floor((bodyWidth - sepCount) / MOA_PHASES.length);
		if (colWidth < PHASE_BAND_MIN_COL) return [];

		const th = this.theme;
		const active = this.view.activePhase();
		const paint = (lit: boolean, text: string): string => {
			if (!lit) return th.fg("dim", text);
			return th.getFgAnsi
				? shimmerString(text, now - this.createdAt, th as ShimmerTheme, "ltr", "normal", true)
				: th.fg("text", text);
		};
		// Each boundary carries a two-row powerline chevron: the "\" half on the name
		// row stacks over the "/" half on the model row. Both rows share one column
		// layout, so the halves land in the same terminal column and read as a
		// single tall chevron. A separator lights with either phase it divides, so
		// the active highlight flows along the pipeline.
		const bandRow = (sep: string, textFor: (phase: MoaPhase) => string): string => {
			const parts: string[] = [];
			MOA_PHASES.forEach((phase, i) => {
				parts.push(paint(phase === active, cell(textFor(phase), colWidth, "center")));
				const next = MOA_PHASES[i + 1];
				if (next !== undefined) parts.push(paint(phase === active || next === active, sep));
			});
			return parts.join("");
		};
		const nameRow = bandRow(PHASE_SEP_TOP, (phase) => this.view.phaseLabel(phase));
		const modelRow = bandRow(PHASE_SEP_BOTTOM, (phase) => this.bandLabel(models[phase], colWidth));
		return [nameRow, modelRow];
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerWidth = Math.max(20, width);
		const bodyWidth = Math.max(10, innerWidth - 4);
		const border = (s: string) => th.fg("border", s);
		const row = (s: string) => `  ${fitVisible(s, bodyWidth, { truncationMark: "…", padToWidth: true })}  `;
		const now = Date.now();
		const band = this.phaseModelBand(bodyWidth, now);
		const rows = this.view.progressRows();
		const cols = tableColumns(bodyWidth, rows.map((r) => r.label));
		// Transcript previews stop after ACTIVITY, leaving the right-aligned stats
		// columns (TURNS, TOOLS, COST, TIME) visually clear.
		const leftTableWidth = Math.min(bodyWidth,
			STATUS_COL_WIDTH + cols.agent
			+ COLUMN_GAP + CTX_COL_WIDTH
			+ COLUMN_GAP + ACTIVITY_METER_WIDTH
			+ (cols.activity > 0 ? COLUMN_GAP + cols.activity : 0),
		);
		const spin = QUADRANT_SPINNER_FRAMES[this.spinFrame % QUADRANT_SPINNER_FRAMES.length]!;

		const gap = " ".repeat(COLUMN_GAP);
		// Turns, tool calls, cost, and elapsed are pinned to the right edge so the
		// activity column, whose values are by far the longest, keeps every other column from squeezing it.
		const line = (icon: string, label: string, ctx: string, meter: string, activity: string, turns: string, toolCalls: string, cost: string, elapsed: string) => {
			const parts = [`${cell(icon, STATUS_COL_WIDTH)}${cell(label, cols.agent)}`, cell(ctx, CTX_COL_WIDTH, "right"), meter];
			if (cols.activity > 0) parts.push(cell(activity, cols.activity));
			if (cols.stats) parts.push(
				cell(turns, TURNS_COL_WIDTH, "right"),
				cell(toolCalls, TOOLS_COL_WIDTH, "right"),
				cell(cost, COST_COL_WIDTH, "right"),
				cell(elapsed, ELAPSED_COL_WIDTH, "right"),
			);
			return row(parts.join(gap));
		};

		const dim = (s: string) => th.fg("dim", s);
		const lines: string[] = [this.topBorder(innerWidth, border)];
		for (const bandLine of band) lines.push(row(bandLine));
		if (band.length > 0) lines.push(border("─".repeat(innerWidth)));
		lines.push(line("", dim("MODEL"), dim("CTX"), dim(cell("MONITOR", ACTIVITY_METER_WIDTH)), dim("ACTIVITY"), dim("TURNS"), dim("TOOLS"), dim("COST"), dim("TIME")));

		const free = Math.max(
			0,
			this.rowBudget() - TABLE_CHROME_ROWS - rows.length - phaseSectionRows(rows) - (band.length > 0 ? PHASE_BAND_ROWS : 0),
		);
		const activeIndices = rows.flatMap((r, index) => isActive(r.state) ? [index] : []);
		const activityIndices = activeIndices.filter((index) => rows[index]?.activity);
		const renderedActivityIndices = new Set(activityIndices.slice(0, free));
		let remaining = Math.max(0, free - renderedActivityIndices.size);

		const previewWidth = Math.max(0, leftTableWidth - PREVIEW_INDENT - visibleWidth(PREVIEW_GUTTER));
		const previewIndices = this.view.previewVisible && previewWidth >= PREVIEW_MIN_WIDTH
			? activeIndices.filter((index) => rows[index]?.transcript)
			: [];
		const previewAllocations = new Map<number, number>();
		while (remaining > 0) {
			let allocated = false;
			for (const index of previewIndices) {
				const count = previewAllocations.get(index) ?? 0;
				if (count >= PREVIEW_LINES || remaining <= 0) continue;
				previewAllocations.set(index, count + 1);
				remaining--;
				allocated = true;
			}
			if (!allocated) break;
		}
		// A blank separator is cosmetic: allocate it only after transcript content,
		// so short terminals shed the blank before they shed the preview itself.
		const previewSeparators = new Set<number>();
		for (const index of previewIndices) {
			if (remaining <= 0) break;
			if ((previewAllocations.get(index) ?? 0) > 0) {
				previewSeparators.add(index);
				remaining--;
			}
		}
		// Preserve the old empty activity reservation only after actual activity and
		// transcript previews have claimed their higher-priority rows.
		const reservedActivityIndices = new Set<number>();
		for (const index of activeIndices) {
			if (remaining <= 0) break;
			if (!rows[index]?.activity && !previewSeparators.has(index)) {
				reservedActivityIndices.add(index);
				remaining--;
			}
		}
		let renderedPhase = false;

		for (let i = 0; i < rows.length; i++) {
			const r = rows[i];
			const active = isActive(r.state);
			if (r.firstOfPhase) {
				if (renderedPhase) lines.push(row(""));
				const heading = `── ${this.view.phaseLabel(r.phase)} `;
				lines.push(row(dim(heading + "─".repeat(Math.max(0, bodyWidth - visibleWidth(heading))))));
				renderedPhase = true;
			}
			const icon =
				r.state === "done" ? th.fg("success", "✓")
				: r.state === "error" || r.state === "cancelled" ? th.fg("error", "✗")
				: r.state === "queued" ? th.fg("dim", "○")
				: th.fg("accent", spin);
			const label = active ? th.fg("text", r.label) : th.fg("dim", r.label);
			const status =
				r.state === "error" ? th.fg("error", r.statusText)
				: isActive(r.state) ? th.fg("text", r.statusText)
				: th.fg("dim", r.statusText);
			lines.push(
				line(
					icon,
					label,
					contextPercent(r.contextTokens, r.contextWindow),
					this.renderMeter(i, active, r.thinking),
					status,
					String(r.turns),
					String(r.toolCalls),
					formatCost(r.costUsd),
					formatElapsed(r.elapsedMs),
				),
			);

			if (renderedActivityIndices.has(i)) lines.push(row(this.activitySubRow(r, bodyWidth)));
			else if (reservedActivityIndices.has(i)) lines.push(row(""));

			const previewLineCount = previewAllocations.get(i) ?? 0;
			if (previewLineCount > 0) {
				for (const text of this.previewLines(i, r, previewWidth).slice(-previewLineCount)) {
					lines.push(row(this.previewRow(text, leftTableWidth)));
				}
				if (previewSeparators.has(i)) lines.push(row(""));
			}
		}

		lines.push(border("─".repeat(innerWidth)));
		lines.push(row(th.fg("dim", TABLE_FOOTER)));
		lines.push(border("═".repeat(innerWidth)));
		return lines;
	}

	private previewLines(index: number, row: ProgressRow, width: number): string[] {
		const cached = this.previewCache.get(index);
		if (cached && cached.revision === row.transcriptRevision && cached.width === width) return cached.lines;
		const transcript = row.transcript;
		const lines = transcript ? formatAgentPreview(transcript.messages, transcript.partial, width, PREVIEW_LINES) : [];
		this.previewCache.set(index, { revision: row.transcriptRevision, width, lines });
		return lines;
	}

	private previewRow(text: string, leftTableWidth: number): string {
		const contentWidth = Math.max(0, leftTableWidth - PREVIEW_INDENT - visibleWidth(PREVIEW_GUTTER));
		return `${" ".repeat(PREVIEW_INDENT)}${this.theme.fg("muted", `${PREVIEW_GUTTER}${cell(text, contentWidth)}`)}`;
	}

	/** Merged-cell tool activity line, spanning everything right of the status icon. */
	private activitySubRow(r: ProgressRow, bodyWidth: number): string {
		const room = Math.max(0, bodyWidth - STATUS_COL_WIDTH);
		const gutter = this.theme.fg("dim", "↳ ");
		const activity = highlightActivity(this.theme, r.activity ?? "");
		return `${" ".repeat(STATUS_COL_WIDTH)}${cell(`${gutter}${activity}`, room)}`;
	}

	private topBorder(innerWidth: number, border: (s: string) => string): string {
		const title = ` ${this.view.title} `;
		const head = `${border("══")}${this.theme.fg("accent", title)}`;
		const name = this.view.planName ? ` ${this.view.planName} ` : "";
		const nameFill = innerWidth - 4 - visibleWidth(title) - visibleWidth(name);
		// A narrow terminal drops the plan name rather than truncating it: a cut-off
		// slug reads as a different plan, and the full name is on the review overlay.
		if (name && nameFill >= MIN_TITLE_NAME_GAP) {
			return `${head}${border("═".repeat(nameFill))}${this.theme.fg("dim", name)}${border("══")}`;
		}
		const fill = innerWidth - 2 - visibleWidth(title);
		if (fill < 0) return border("═".repeat(innerWidth));
		return `${head}${border("═".repeat(fill))}`;
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.timer);
		this.previewCache.clear();
	}
}
