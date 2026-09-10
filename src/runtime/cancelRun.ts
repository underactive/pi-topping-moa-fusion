import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui";

/**
 * Cancellation registry for in-flight subagent processes.
 *
 * One CancelRun is created per orchestration phase (MoA fan-out, synthesis
 * round, tool-call parallel run). Each agent slot gets its own
 * AbortController; the combined signal handed to runSingleAgent also folds in
 * a run-wide "cancel all" controller and any upstream signal (e.g. pi's
 * turn-abort signal in the mf_plan_subagent tool path).
 *
 * Slot indices are positional and shared by construction with the arrays the
 * orchestrators build from the same source list: proposers[i] ↔ widget
 * statuses[i] ↔ run.agents[i].
 */

export type AgentCancelState = "running" | "cancelling" | "done" | "error" | "cancelled";

export interface TrackedAgent {
	/** Display label, e.g. "openai/gpt-5.2" or "explore #1". */
	label: string;
	state: AgentCancelState;
	controller: AbortController;
}

export class CancelRun {
	readonly agents: TrackedAgent[] = [];
	cancelAllRequested = false;
	private readonly allController = new AbortController();
	private readonly listeners = new Set<() => void>();

	/** Register one agent slot; returns its index and the combined abort signal. */
	add(label: string, upstream?: AbortSignal): { index: number; signal: AbortSignal } {
		const controller = new AbortController();
		this.agents.push({ label, state: "running", controller });
		const signals = [controller.signal, this.allController.signal];
		if (upstream) signals.push(upstream);
		return { index: this.agents.length - 1, signal: AbortSignal.any(signals) };
	}

	/** Cancel one agent. No-op unless it is still running (race-safe: an agent may settle while the overlay is open). */
	cancel(index: number): void {
		const agent = this.agents[index];
		if (!agent || agent.state !== "running") return;
		agent.state = "cancelling";
		agent.controller.abort();
		this.notify();
	}

	/** Cancel every running agent and mark the whole run as user-cancelled. */
	cancelAll(): void {
		if (this.cancelAllRequested) return;
		this.cancelAllRequested = true;
		for (const agent of this.agents) {
			if (agent.state === "running") agent.state = "cancelling";
		}
		this.allController.abort();
		this.notify();
	}

	/** Record an agent's final state once its subprocess result arrives. */
	settle(index: number, state: "done" | "error" | "cancelled"): void {
		const agent = this.agents[index];
		if (!agent) return;
		agent.state = state;
		this.notify();
	}

	/** Subscribe to state changes (for live overlay re-renders). Returns an unsubscribe function. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}
}

/** Extra per-row display data echoed from the progress widget / tool progress. */
export interface CancelRowExtras {
	contextTokens?: number;
	contextWindow?: number;
	activity?: string;
	loopCount?: number;
}

/**
 * Published by an orchestrator while agents are in flight so the input
 * triggers (ESC listener, F4 shortcut) can find the live run and
 * open the cancel overlay against it.
 */
export interface CancelSession {
	/** Overlay title, e.g. "MoA fan-out — running proposers". */
	title: string;
	/** The live run, or undefined when nothing is in flight (ESC passes through). */
	run: CancelRun | undefined;
	/** Optional per-row display extras (context bar, tool activity, loop badge). */
	getExtras?: (index: number) => CancelRowExtras | undefined;
	/** True while the cancel overlay is mounted; guards double-open races. */
	overlayOpen: boolean;
	/** Registered by the overlay while open so orchestrators can force-close it before competing UIs. */
	closeOverlay?: () => void;
}

export interface CancelOverlayEscHost {
	getActiveObserveSession(): { overlayOpen: boolean } | undefined;
	openCancelOverlayIfActive(ctx: ExtensionContext): boolean;
}

/**
 * Subscribes ESC to open the cancel overlay while `session.run` is in
 * flight, passing ESC through otherwise so the editor, model pickers, and
 * observe overlay keep their own ESC handling. Terminal input listeners run
 * ahead of pi's key-release filter, so under the Kitty keyboard protocol the
 * ESC *release* arrives here a tick after the press closed an overlay and
 * cleared `overlayOpen` — reopening it instantly. Only a key press may open
 * the overlay. Returns undefined outside the TUI.
 */
export function subscribeCancelOverlayOnEsc(
	ctx: ExtensionContext,
	host: CancelOverlayEscHost,
	session: CancelSession,
): (() => void) | undefined {
	if (ctx.mode !== "tui") return undefined;
	return ctx.ui.onTerminalInput((data) => {
		if (isKeyRelease(data) || !matchesKey(data, Key.escape)) return undefined;
		if (host.getActiveObserveSession()?.overlayOpen) return undefined;
		if (session.overlayOpen) return undefined;
		if (!session.run) return undefined;
		return host.openCancelOverlayIfActive(ctx) ? { consume: true } : undefined;
	});
}
