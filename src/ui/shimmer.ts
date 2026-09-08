/**
 * Codex-style light-sweep text shimmer.
 *
 * Vendored from pi-topping-persona-audit (`src/shimmer.ts`) rather than
 * depended on, so the extensions stay independently installable. The sweep
 * geometry — band half-width, padding, speed scaling — is load-bearing for
 * visual parity, so port changes upstream rather than tuning them here.
 * test/shimmer.test.mjs mirrors the upstream tests to catch drift.
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";

const SHIMMER_SWEEP_S = 2.0;
const SHIMMER_BAND_HALF = 5.0;
const SHIMMER_PADDING = 10;

/** The slice of pi's `Theme` shimmerString needs. Structural so callers can supply a stub. */
export interface ShimmerTheme {
	getFgAnsi(color: ThemeColor): string;
	fg(color: ThemeColor, text: string): string;
}

/**
 * With `invert=true`, the text color is used at rest and the sweep moves toward
 * the theme's dim color.
 */
export function shimmerString(
	text: string,
	elapsedMs: number,
	theme: ShimmerTheme,
	direction: "ltr" | "rtl" = "ltr",
	speed: "slow" | "normal" | "fast" = "normal",
	invert = false,
): string {
	const chars = [...text];
	if (chars.length === 0) return "";
	const shimmerBase = ansiToRgb(theme.getFgAnsi(invert ? "text" : "dim"));
	const shimmerHighlight = ansiToRgb(theme.getFgAnsi(invert ? "dim" : "text"));
	if (!shimmerBase || !shimmerHighlight) return theme.fg("text", text);
	const period = chars.length + SHIMMER_PADDING * 2;
	const unitsPerS = period / SHIMMER_SWEEP_S;
	// The band crosses padding at either end while every character is still dim. Scaling only
	// the stretch where it actually overlaps the text keeps that dark pause identical at every
	// speed, so `speed` changes the sweep alone rather than the whole cycle.
	const litEnter = SHIMMER_PADDING - SHIMMER_BAND_HALF;
	const litExit = SHIMMER_PADDING + chars.length - 1 + SHIMMER_BAND_HALF;
	const enterS = litEnter / unitsPerS;
	const litS = (litExit - litEnter) / unitsPerS / (speed === "slow" ? 0.5 : speed === "fast" ? 2 : 1);
	const phase = (elapsedMs / 1000) % (enterS + litS + (period - litExit) / unitsPerS);
	const linear =
		phase < enterS
			? phase * unitsPerS
			: phase < enterS + litS
				? litEnter + ((phase - enterS) / litS) * (litExit - litEnter)
				: litExit + (phase - enterS - litS) * unitsPerS;
	const pos = direction === "rtl" ? period - linear : linear;

	let out = "";
	for (let i = 0; i < chars.length; i++) {
		const ch = chars[i]!;
		const dist = Math.abs(i + SHIMMER_PADDING - pos);
		const t = dist <= SHIMMER_BAND_HALF ? 0.5 * (1 + Math.cos((Math.PI * dist) / SHIMMER_BAND_HALF)) : 0;
		const alpha = t * 0.9;
		const r = Math.round(shimmerHighlight[0] * alpha + shimmerBase[0] * (1 - alpha));
		const g = Math.round(shimmerHighlight[1] * alpha + shimmerBase[1] * (1 - alpha));
		const b = Math.round(shimmerHighlight[2] * alpha + shimmerBase[2] * (1 - alpha));
		const bold = !invert && t > 0.2 ? "\x1b[1m" : "";
		out += `${bold}\x1b[38;2;${r};${g};${b}m${ch}\x1b[22m`;
	}
	return out + "\x1b[0m";
}

function ansiToRgb(ansi: string): [number, number, number] | null {
	const match = ansi.match(/^\x1b\[38;2;(\d+);(\d+);(\d+)m$/);
	if (!match) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}
