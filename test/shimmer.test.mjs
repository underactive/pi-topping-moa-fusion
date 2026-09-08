import assert from "node:assert/strict";
import { test } from "node:test";

const { shimmerString } = await import("../src/ui/shimmer.ts");

// src/ui/shimmer.ts is vendored from pi-topping-persona-audit, so these
// assertions are the drift alarm: if they need updating, check whether upstream
// changed too rather than retuning the sweep geometry locally.

test("shimmerString falls back to the flat text tone for non-truecolor themes", () => {
	const theme = {
		getFgAnsi: () => "\x1b[38;5;42m",
		fg: (color, text) => `<${color}>${text}</${color}>`,
	};

	assert.equal(shimmerString("text", 0, theme), "<text>text</text>");
});

test("shimmerString returns empty output for empty text", () => {
	const theme = {
		getFgAnsi: (color) => (color === "dim" ? "\x1b[38;2;20;30;40m" : "\x1b[38;2;120;130;140m"),
		fg: (_color, text) => text,
	};

	assert.equal(shimmerString("", 0, theme), "");
});

test("shimmerString interpolates a continuous dim-to-text gradient", () => {
	const theme = {
		getFgAnsi: (color) => (color === "dim" ? "\x1b[38;2;20;30;40m" : "\x1b[38;2;120;130;140m"),
		fg: (_color, text) => text,
	};
	const text = "abcdefghijklm";
	const elapsedMs = (2000 * 16) / (text.length + 20);
	const result = shimmerString(text, elapsedMs, theme);
	const colors = [...result.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)].map((match) => match.slice(1).join(","));

	assert.equal(colors[0], "20,30,40");
	assert.equal(colors[6], "110,120,130");
	assert.ok(new Set(colors).size > 3, "expected colors between the base and highlight");
	assert.match(result, /\x1b\[1m\x1b\[38;2;110;120;130mg\x1b\[22m/);
	assert.ok(result.endsWith("\x1b[0m"));
});

test("inverted shimmer keeps the text color at rest and dims with a gradient", () => {
	const theme = {
		getFgAnsi: (color) => (color === "dim" ? "\x1b[38;2;20;30;40m" : "\x1b[38;2;120;130;140m"),
		fg: (_color, text) => text,
	};
	const text = "abcdefghijklm";
	const elapsedMs = (2000 * 16) / (text.length + 20);
	const result = shimmerString(text, elapsedMs, theme, "ltr", "normal", true);
	const colors = [...result.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)].map((match) => match.slice(1).join(","));

	assert.equal(colors[0], "120,130,140");
	assert.equal(colors[6], "30,40,50");
	assert.ok(new Set(colors).size > 3, "expected colors between the base and dimmed band");
	assert.doesNotMatch(result, /\x1b\[1m/);
	assert.ok(result.endsWith("\x1b[0m"));
});

console.log("shimmer tests passed.");
