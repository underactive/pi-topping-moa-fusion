/**
 * Working overlay — a small "please wait" card for blocking, non-agent work
 * that has nowhere else to draw while it runs (e.g. summarizing a plan
 * prompt into a name between the prompt editor closing and the next picker
 * mounting). This is not the cancel-run surface: there is no agent table
 * and no subagents to cancel. Esc abandons the wait rather than the flow
 * that is waiting on it — the calling flow owns the overlay's lifetime
 * through a session bridge, mirroring `CancelSession.closeOverlay`.
 */

import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Key, matchesKey, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { formatElapsed } from "./agentStatus.ts";
import { BRAILLE_SPINNER_FRAMES, ROUNDED_SINGLE_BOX, UI_TICK_MS, createFrame } from "./chrome.ts";
import { shimmerString, type ShimmerTheme } from "./shimmer.ts";

const OVERLAY_MARGIN = 1;
/** Grace before mounting: work that settles inside this never flashes a card. */
const SHOW_DELAY_MS = 200;
/** Once shown, stay up at least this long so the card is readable, not a blink. */
const MIN_VISIBLE_MS = 500;

export interface WorkingOverlayOptions<T> {
	/** Accent title row, e.g. "Naming the plan". */
	title: string;
	/** Dim, shimmering body line naming the work. */
	detail: string;
	/** Footer hint. Defaults to a plain wait line when `skip` is omitted. */
	hint?: string;
	/** Value to resolve with when the user presses esc. Omit to make the wait un-skippable. */
	skip?: () => T;
}

/** Bridge an outside owner uses to close an overlay it does not render. Mirrors `CancelSession.closeOverlay`. */
export interface WorkingOverlaySession {
	closeOverlay?: () => void;
	/** Set when close was requested before the component mounted. */
	closeRequested?: boolean;
}

/** Ask a (possibly not-yet-mounted) overlay to close. Safe to call before `showWorkingOverlay`'s factory has run. */
export function requestWorkingOverlayClose(session: WorkingOverlaySession): void {
	session.closeRequested = true;
	session.closeOverlay?.();
}

interface WorkingOverlayRenderOptions {
	title: string;
	detail: string;
	hint?: string;
	onSkip?: () => void;
}

/** Show the working overlay. Resolves when closed. Outside TUI mode there is no overlay surface. */
export async function showWorkingOverlay(
	ctx: ExtensionContext,
	options: WorkingOverlayRenderOptions,
	session: WorkingOverlaySession,
): Promise<void> {
	if (ctx.mode !== "tui") return;
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => new WorkingOverlayComponent(tui, theme, options, session, done),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "50%",
				minWidth: 40,
				margin: OVERLAY_MARGIN,
			},
		},
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

function unwrap<T>(settled: Settled<T>): T {
	if (settled.ok) return settled.value;
	throw settled.error;
}

/**
 * Run `task` behind the working overlay. The overlay only mounts if `task`
 * is still pending after `SHOW_DELAY_MS`, and once mounted stays up at
 * least `MIN_VISIBLE_MS` so it never reads as a flicker. There is no
 * automatic cutoff: a task that never settles keeps the card up until the
 * user presses Esc (when `options.skip` is set) — deliberate, not an
 * oversight, since the hint row is what turns that into a user choice
 * rather than a hang.
 */
export async function withWorkingOverlay<T>(
	ctx: ExtensionContext,
	options: WorkingOverlayOptions<T>,
	task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	const work = task(controller.signal);
	// No terminal surface: the caller still waits, but there is nothing to draw on.
	if (ctx.mode !== "tui") return work;

	// Reflect instead of letting `work` reject on its own timeline: it is raced
	// against the grace timer and abandoned outright when the user skips, and an
	// abandoned rejecting promise would otherwise surface as an unhandled rejection.
	let pending = true;
	const settled: Promise<Settled<T>> = work.then(
		(value): Settled<T> => ({ ok: true, value }),
		(error): Settled<T> => ({ ok: false, error }),
	);
	void settled.then(() => {
		pending = false;
	});

	await Promise.race([settled, sleep(SHOW_DELAY_MS)]);
	if (!pending) return unwrap(await settled);

	const session: WorkingOverlaySession = {};
	const shownAt = Date.now();
	let skipped: { value: T } | undefined;
	void settled.then(async () => {
		if (skipped) return;
		await sleep(Math.max(0, MIN_VISIBLE_MS - (Date.now() - shownAt)));
		requestWorkingOverlayClose(session);
	});

	try {
		await showWorkingOverlay(
			ctx,
			{
				title: options.title,
				detail: options.detail,
				hint: options.hint,
				// Esc skips: abort what we can, then leave the rest behind. The flow
				// must move on even when a provider ignores the abort signal.
				onSkip: options.skip
					? () => {
						skipped = { value: options.skip!() };
						controller.abort();
					}
					: undefined,
			},
			session,
		);
	} catch {
		// A stale ctx (e.g. after /reload) must not break the flow that is waiting.
	}

	if (skipped) return skipped.value;
	return unwrap(await settled);
}

/** Copy for the plan/opinion/debate naming wait. No trailing ellipses — see CHANGELOG 0.1.1. */
export function planNamingOverlay(subject: "plan" | "opinion" | "debate", skip: () => string): WorkingOverlayOptions<string> {
	return {
		title: `Naming the ${subject}`,
		detail: `summarizing your prompt into a short ${subject} name`,
		hint: "esc skip naming · a name from your prompt is used instead",
		skip,
	};
}

/** The slice of pi's `Theme` this overlay needs. Structural so tests can stub it without `getFgAnsi`. */
interface WorkingOverlayTheme {
	fg(color: ThemeColor, text: string): string;
	bg(color: Parameters<Theme["bg"]>[0], text: string): string;
	/** 24-bit ANSI escape for a color. Absent on test stubs, so the detail line falls back to flat text. */
	getFgAnsi?(color: ThemeColor): string;
}

class WorkingOverlayComponent implements Component {
	private readonly tui: TUI;
	private readonly theme: WorkingOverlayTheme;
	private readonly options: WorkingOverlayRenderOptions;
	private readonly session: WorkingOverlaySession;
	private readonly done: (value: void) => void;
	private readonly startedAt: number;
	private readonly timer: ReturnType<typeof setInterval>;
	private spinFrame = 0;
	private closed = false;

	constructor(
		tui: TUI,
		theme: WorkingOverlayTheme,
		options: WorkingOverlayRenderOptions,
		session: WorkingOverlaySession,
		done: (value: void) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.options = options;
		this.session = session;
		this.done = done;
		this.startedAt = Date.now();
		this.timer = setInterval(() => {
			this.spinFrame = (this.spinFrame + 1) % BRAILLE_SPINNER_FRAMES.length;
			tui.requestRender();
		}, UI_TICK_MS);
		this.timer.unref();

		session.closeOverlay = () => this.finish();
		// The task can settle before `ctx.ui.custom` invokes this factory (only
		// mounting triggers the factory). Defer so `done` is never called
		// synchronously from inside the factory that constructs this component.
		if (session.closeRequested) setTimeout(() => this.finish(), 0);
	}

	private finish(): void {
		if (this.closed) return;
		this.closed = true;
		this.done(undefined);
	}

	handleInput(data: string): void {
		// Under the Kitty keyboard protocol, the *release* of the key that
		// closed the previous surface (e.g. Enter submitting the prompt editor)
		// can land on this freshly mounted overlay a tick later. Only a press
		// may skip. Same bug class as test/cancel-overlay-escape-release.test.mjs.
		if (isKeyRelease(data)) return;
		if (matchesKey(data, Key.escape)) {
			if (this.options.onSkip) {
				this.options.onSkip();
				this.finish();
			}
			return;
		}
		// Everything else is swallowed: this is a blocking wait, not an
		// interactive list, and stray keystrokes must not queue into whatever
		// mounts next.
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerWidth = Math.max(20, width - 4);
		const frame = createFrame(th, innerWidth, {
			glyphs: ROUNDED_SINGLE_BOX,
			horizontalPadding: 1,
			truncationMark: "…",
			padToWidth: true,
			minimumBodyWidth: 10,
		});

		const elapsed = formatElapsed(Date.now() - this.startedAt);
		const titlePad = Math.max(1, frame.bodyWidth - visibleWidth(this.options.title) - visibleWidth(elapsed));
		const titleRow = frame.row(`${th.fg("accent", this.options.title)}${" ".repeat(titlePad)}${th.fg("dim", elapsed)}`);

		const spin = th.fg("accent", BRAILLE_SPINNER_FRAMES[this.spinFrame % BRAILLE_SPINNER_FRAMES.length]!);
		const detailText = th.getFgAnsi
			? shimmerString(this.options.detail, Date.now() - this.startedAt, th as ShimmerTheme, "ltr", "normal")
			: th.fg("dim", this.options.detail);
		const detailRow = frame.row(`${spin} ${detailText}`);

		const hint = this.options.hint ?? (this.options.onSkip ? "esc skip" : "please wait");
		const hintRow = frame.row(th.fg("dim", hint));

		return [frame.top(), titleRow, frame.separator(), detailRow, frame.separator(), hintRow, frame.bottom()];
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.timer);
		if (this.session.closeOverlay) this.session.closeOverlay = undefined;
	}
}
