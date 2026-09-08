/**
 * Output-token activity meter.
 *
 * Vendored from pi-topping (`src/activity-meter.ts` for the meter/rate
 * tracker, `src/format.ts` for StreamingWordCounter) rather than depended on,
 * so the two extensions stay independently installable. Behavior is meant to
 * stay identical — glyph ramp, thresholds, EMA coefficient, direction and
 * colouring are all load-bearing for visual parity, so port changes upstream
 * rather than tuning them here. test/activity-meter.test.mjs mirrors
 * pi-topping's tests/activity-meter.test.ts to catch drift.
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";

export const ActivityMeterLevel = {
	IDLE: 0,
	LOW: 1,
	MEDIUM: 2,
	HIGH: 3,
	PEAK_1: 4,
	PEAK_2: 5,
	PEAK_3: 6,
	FULL: 7,
} as const;

export type ActivityMeterLevel = (typeof ActivityMeterLevel)[keyof typeof ActivityMeterLevel];

const EMA_ALPHA = 0.4;
const BRAILLE: Record<ActivityMeterLevel, string> = {
	[ActivityMeterLevel.IDLE]: "⢀",
	[ActivityMeterLevel.LOW]: "⣀",
	[ActivityMeterLevel.MEDIUM]: "⣠",
	[ActivityMeterLevel.HIGH]: "⣤",
	[ActivityMeterLevel.PEAK_1]: "⣴",
	[ActivityMeterLevel.PEAK_2]: "⣶",
	[ActivityMeterLevel.PEAK_3]: "⣾",
	[ActivityMeterLevel.FULL]: "⣿",
};
export const ACTIVITY_METER_WIDTH = 8;
type CellColorizer = (level: ActivityMeterLevel, char: string) => string;

/** Convert an estimated output-token rate to a display level. */
export function rateToLevel(tokensPerSecond: number): ActivityMeterLevel {
	const THRESHOLDS = [0, 5, 10, 15, 22, 30, 40];
	for (let i = THRESHOLDS.length - 1; i >= 0; i--) {
		if (tokensPerSecond > THRESHOLDS[i]) return (i + 1) as ActivityMeterLevel;
	}
	return 0;
}

/** EMA-smoothed rate tracker for a cumulative output-token estimate. */
export class TokRateTracker {
	#lastTotal = 0;
	#lastTime = 0;
	#rate = 0;
	#hasSample = false;
	#pendingTokens = 0;

	sample(totalTokens: number, now: number): number {
		if (!this.#hasSample) {
			this.#lastTotal = totalTokens;
			this.#hasSample = true;
			this.#lastTime = now;
			return this.#rate;
		}

		const elapsedSeconds = (now - this.#lastTime) / 1_000;
		if (elapsedSeconds <= 0) {
			this.#pendingTokens += Math.max(0, totalTokens - this.#lastTotal);
			this.#lastTotal = totalTokens;
			return this.#rate;
		}

		const totalDelta = this.#pendingTokens + Math.max(0, totalTokens - this.#lastTotal);
		const instantRate = totalDelta / elapsedSeconds;
		this.#rate = EMA_ALPHA * instantRate + (1 - EMA_ALPHA) * this.#rate;
		this.#lastTotal = totalTokens;
		this.#lastTime = now;
		this.#pendingTokens = 0;
		return this.#rate;
	}

	reset(): void {
		this.#lastTotal = 0;
		this.#lastTime = 0;
		this.#rate = 0;
		this.#hasSample = false;
		this.#pendingTokens = 0;
	}
}

/** Eight-column scrolling activity meter, scrolling either left-to-right or right-to-left. */
export class ActivityMeter {
	#levels: ActivityMeterLevel[] = Array<ActivityMeterLevel>(ACTIVITY_METER_WIDTH).fill(0);
	#direction: "ltr" | "rtl";

	constructor(direction: "ltr" | "rtl" = "ltr") {
		this.#direction = direction;
	}

	setDirection(direction: "ltr" | "rtl"): void {
		if (direction !== this.#direction) {
			this.#direction = direction;
			// Reverse the existing data so the visual flow instantly flips.
			this.#levels.reverse();
		}
	}

	push(level: ActivityMeterLevel): void {
		if (this.#direction === "rtl") {
			this.#levels.shift();
			this.#levels.push(level);
		} else {
			this.#levels.pop();
			this.#levels.unshift(level);
		}
	}

	render(colorize?: CellColorizer): string {
		return this.#levels
			.map((level) => {
				const char = BRAILLE[level];
				return colorize ? colorize(level, char) : char;
			})
			.join("");
	}

	reset(): void {
		this.#levels.fill(0);
	}

	/** Colorize a meter cell using the default theme mapping (dim at IDLE, `color` otherwise). */
	static colorizeCell(
		level: ActivityMeterLevel,
		char: string,
		theme: { fg: (style: ThemeColor, s: string) => string },
		color: ThemeColor = "accent",
		dimmed?: boolean,
	): string {
		if (level === ActivityMeterLevel.IDLE) return theme.fg("dim", char);
		const colored = theme.fg(color, char);
		// ANSI dim (SGR 2) reduces color brightness; SGR 22 resets dim/bold.
		// This is necessary because theme.fg("dim", ...) sets a gray color instead
		// of applying the ANSI dim attribute, so nesting would overwrite the accent color.
		return dimmed ? `\x1b[2m${colored}\x1b[22m` : colored;
	}
}

/**
 * Counts words across a split stream without re-scanning earlier chunks: each
 * stream remembers whether it ended mid-word, so a word broken across two
 * deltas is counted once. Used as the output-token estimate for providers that
 * never report usage.
 */
export class StreamingWordCounter {
	#inWordByStream = new Map<string, boolean>();

	count(text: string, stream = "default"): number {
		let inWord = this.#inWordByStream.get(stream) ?? false;
		let count = 0;
		for (let i = 0; i < text.length; i++) {
			const code = text.charCodeAt(i);
			if (isWhitespace(code)) {
				inWord = false;
			} else if (!inWord) {
				count++;
				inWord = true;
			}
		}
		this.#inWordByStream.set(stream, inWord);
		return count;
	}

	reset(): void {
		this.#inWordByStream.clear();
	}
}

function isWhitespace(code: number): boolean {
	return (
		code === 32 ||
		(code >= 9 && code <= 13) ||
		code === 160 ||
		code === 0x1680 ||
		(code >= 0x2000 && code <= 0x200a) ||
		code === 0x2028 ||
		code === 0x2029 ||
		code === 0x202f ||
		code === 0x205f ||
		code === 0x3000 ||
		code === 0xfeff
	);
}
