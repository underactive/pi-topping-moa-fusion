import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	ROUNDED_SINGLE_BOX,
	SQUARE_SINGLE_BOX,
	createFrame,
	fitVisible,
	ratioViewport,
	safeRenderWidth,
	wrapWords,
} from "../src/ui/chrome.ts";

const theme = { fg: (_color, text) => text };
const strip = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

const rounded = createFrame(theme, 20, {
	glyphs: ROUNDED_SINGLE_BOX,
	horizontalPadding: 1,
	truncationMark: "…",
	padToWidth: true,
	minimumBodyWidth: 10,
});
assert.equal(rounded.bodyWidth, 16);
assert.equal(rounded.top(), `╭${"─".repeat(18)}╮`);
assert.equal(rounded.separator(), `├${"─".repeat(18)}┤`);
assert.equal(rounded.bottom(), `╰${"─".repeat(18)}╯`);
assert.equal(visibleWidth(rounded.row("body")), 20);

const square = createFrame(theme, 20, {
	glyphs: SQUARE_SINGLE_BOX,
	horizontalPadding: 0,
	truncationMark: "...",
	padToWidth: true,
	minimumBodyWidth: 10,
});
assert.equal(square.bodyWidth, 18);
assert.equal(square.top(), `┌${"─".repeat(18)}┐`);
assert.equal(square.separator(), `├${"─".repeat(18)}┤`);
assert.equal(square.bottom(), `└${"─".repeat(18)}┘`);
assert.equal(visibleWidth(square.row(" body")), 20);

assert.equal(strip(fitVisible("abcdefgh", 6, { truncationMark: "…", padToWidth: false })), "abcde…");
assert.equal(strip(fitVisible("abcdefgh", 6, { truncationMark: "...", padToWidth: false })), "abc...");
assert.equal(strip(fitVisible("abcdefgh", 6, { truncationMark: "", padToWidth: false })), "abcdef");
assert.equal(visibleWidth(fitVisible("x", 6, { truncationMark: "", padToWidth: true })), 6);

assert.equal(safeRenderWidth(42.9, 80), 42);
assert.equal(safeRenderWidth(200, 80), 80);
assert.equal(safeRenderWidth(5, 80), 20);
assert.equal(safeRenderWidth(Number.POSITIVE_INFINITY, 80), 80);
assert.equal(safeRenderWidth(Number.NaN, 80), 80);

assert.deepEqual(wrapWords("one  two three", 7), ["one two", "three"]);
assert.deepEqual(wrapWords("extraordinary", 6).map(strip), ["extra…"]);
assert.equal(ratioViewport(24, { fallbackRows: 24, ratio: 0.9, minimum: 4, chromeRows: 6 }), 15);
assert.equal(ratioViewport(24, { fallbackRows: 24, ratio: 0.9, minimum: 6, margin: 1, chromeRows: 5 }), 16);
assert.equal(ratioViewport(undefined, { fallbackRows: 24, ratio: 0.7, minimum: 6 }), 16);
assert.equal(ratioViewport(40, { fallbackRows: 24, ratio: 0.5, minimum: 5 }), 20);

console.log("UI chrome tests passed.");
