import type { Theme } from "@earendil-works/pi-coding-agent";

const CONTEXT_BAR_WIDTH = 10;
const PERCENT_PAD_WIDTH = 6;
export const CTX_COL_WIDTH = 14;
const EIGHTH_BLOCKS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;
/** Badge an agent as looping once its current activity has recurred at least this many times in the window. */
export const LOOP_THRESHOLD = 3;

/**
 * How many times the current activity recurs in the recent history window.
 * At or above LOOP_THRESHOLD the agent is likely stuck looping on the same
 * tool call. Read by the cancel overlay, which badges the looping agent.
 */
export function activityLoopCount(activity: string | undefined, history: string[] | undefined): number {
	if (!activity) return 0;
	return (history ?? []).filter((a) => a === activity).length;
}

/**
 * Render a live context-usage bar: how much of the model's context window the
 * agent's latest turn is consuming (`contextTokens / contextWindow`). Shows a
 * tenths-precision percentage padded to 6 chars, followed by a 10-cell bar
 * using 1/8-precision Unicode block fill. Unknown window keeps the bracket
 * aligned with a leading 6-space placeholder.
 *
 * When a `theme` is provided, fills use the accent color and unfilled cells
 * use a dim foreground to visually distinguish the unfilled region.
 */
export function usageBar(contextTokens: number | undefined, contextWindow: number | undefined, theme?: Theme): string {
	if (contextTokens === undefined || !contextWindow || contextWindow <= 0) {
		const bar = `${" ".repeat(PERCENT_PAD_WIDTH)}[${"?".repeat(CONTEXT_BAR_WIDTH)}]`;
		return theme ? theme.fg("dim", bar) : bar;
	}
	const used = contextTokens && contextTokens > 0 ? contextTokens : 0;
	const ratio = Math.max(0, Math.min(1, used / contextWindow));
	const pctStr = `${(ratio * 100).toFixed(1)}%`;
	const paddedPct = pctStr.padStart(PERCENT_PAD_WIDTH);
	const filledEighths = Math.round(ratio * CONTEXT_BAR_WIDTH * 8);
	const fullChars = Math.floor(filledEighths / 8);
	const remainder = filledEighths % 8;
	const empty = CONTEXT_BAR_WIDTH - fullChars - (remainder > 0 ? 1 : 0);
	const filled = `${"█".repeat(fullChars)}${EIGHTH_BLOCKS[remainder]}`;
	const unfilled = `${"░".repeat(empty)}`;
	if (theme) {
		return `${theme.fg("text", paddedPct)} [${theme.fg("accent", filled)}${theme.fg("dim", unfilled)}]`;
	}
	return `${paddedPct} [${filled}${unfilled}]`;
}

/** Format a token count compactly, using lowercase `k` and `m` suffixes. */
export function formatTokens(tokens: number): string {
	const count = Number.isFinite(tokens) ? Math.max(0, Math.round(tokens)) : 0;
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}m`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
	return String(count);
}

/** Format a context window in tokens as `X.XM` or `X.XK`, or raw if tiny. */
function formatWindowLabel(window: number): string {
	if (window >= 1_000_000) return `${(window / 1_000_000).toFixed(1)}M`;
	if (window >= 1_000) return `${(window / 1_000).toFixed(1)}K`;
	return String(window);
}

/** Context usage as a right-aligned `${pct}/${windowLabel}`, or dashes when the window is unknown. */
export function contextPercent(contextTokens: number | undefined, contextWindow: number | undefined): string {
	if (contextTokens === undefined || !contextWindow || contextWindow <= 0) return "—".padStart(CTX_COL_WIDTH);
	const used = contextTokens && contextTokens > 0 ? contextTokens : 0;
	const ratio = Math.max(0, Math.min(1, used / contextWindow));
	return `${(ratio * 100).toFixed(1)}%/${formatWindowLabel(contextWindow)}`.padStart(CTX_COL_WIDTH);
}

/** Format cumulative model cost in the same precision as pi's usage footer. */
export function formatCost(costUsd: number | undefined): string {
	if (costUsd === undefined || !Number.isFinite(costUsd)) return "—";
	return `$${Math.max(0, costUsd).toFixed(3)}`;
}

/** Elapsed time as `M:SS`. Minutes keep counting past 60 rather than rolling into an hours field. */
export function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}
