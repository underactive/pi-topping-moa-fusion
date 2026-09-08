/**
 * Shared renderer for one-line tool-activity labels (`formatToolActivity`
 * output), so the MoA progress table and the cancel overlay color a tool
 * name and its argument identically, following pi's own read/grep/edit/write
 * renderers (bold `toolTitle` name, `accent` argument).
 *
 * Splits only at the first run of whitespace — the boundary
 * `formatToolActivity` itself produces between a tool name and its argument
 * — and never rewrites the text on either side, so activity strings stay
 * byte-identical for the runtime's equality-based loop detection.
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";

/** The slice of pi's `Theme` this renderer needs. */
export interface ActivityTheme {
	fg(color: ThemeColor, text: string): string;
	bold(text: string): string;
}

const ACTIVITY_SPLIT = /^(\s*)(\S+)(\s*)([\s\S]*)$/;

/**
 * Highlight a plain activity string as a bold `toolTitle` tool name followed
 * by its `accent` argument, preserving every character — including leading
 * and repeated whitespace — exactly. Falls back to the raw string when no
 * tool token can be found at all (empty or whitespace-only input).
 */
export function highlightActivity(theme: ActivityTheme, activity: string): string {
	const match = activity.match(ACTIVITY_SPLIT);
	if (!match) return activity;
	const [, leading, tool, sep, detail] = match;
	const styledTool = theme.fg("toolTitle", theme.bold(tool));
	return detail ? `${leading}${styledTool}${sep}${theme.fg("accent", detail)}` : `${leading}${styledTool}${sep}`;
}
