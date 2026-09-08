import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

const { smartTruncateModelLabel } = await import("../src/ui/modelLabel.ts");

test("smartTruncateModelLabel keeps last segment, first segment, and collapses skipped runs", () => {
	const result = smartTruncateModelLabel("openai/accounts/org-1/models/gpt-4o-mini", 20);
	assert.ok(result.endsWith("gpt-4o-mini"), `last segment should survive, got: ${result}`);
	assert.ok(result.startsWith("openai/"), `first segment should be kept, got: ${result}`);
	const ellipsisCount = (result.match(/\u2026/g) ?? []).length;
	assert.equal(ellipsisCount, 1, `expected exactly 1 ellipsis, got ${ellipsisCount}: ${result}`);
	assert.ok(visibleWidth(result) <= 20, `expected width <= 20, got ${visibleWidth(result)}: ${result}`);
});

test("smartTruncateModelLabel falls back to skeleton when even minimal segments don't fit", () => {
	const result = smartTruncateModelLabel("openai/accounts/org-1/models/gpt-4o-mini", 10);
	assert.ok(result.startsWith("\u2026/"), `expected skeleton prefix, got: ${result}`);
	const suffix = result.slice("\u2026/".length);
	assert.ok(suffix.length < "gpt-4o-mini".length, `expected model name truncated, got suffix: ${suffix}`);
	assert.ok(visibleWidth(result) <= 10, `expected width <= 10, got ${visibleWidth(result)}: ${result}`);
});

test("smartTruncateModelLabel returns already-fitting input unchanged", () => {
	const input = "anthropic/claude-opus-4-6";
	assert.equal(smartTruncateModelLabel(input, 40), input);
});

test("smartTruncateModelLabel returns exact-fit input unchanged with no ellipsis", () => {
	const input = "anthropic/claude-opus-4-6";
	const result = smartTruncateModelLabel(input, visibleWidth(input));
	assert.equal(result, input);
	assert.ok(!result.includes("\u2026"));
});

test("smartTruncateModelLabel falls back to plain end-truncation for single-segment labels", () => {
	const result = smartTruncateModelLabel("tinyllama-extremely-long-model-name", 10);
	assert.ok(result.endsWith("\u2026"), `expected end-truncation ellipsis, got: ${result}`);
	assert.ok(visibleWidth(result) <= 10, `expected width <= 10, got ${visibleWidth(result)}: ${result}`);
});

test("smartTruncateModelLabel strips ANSI codes on hard-truncation paths", () => {
	const ansiName = "\x1b[31mgpt-4o-mini\x1b[39m";
	const input = `openai/accounts/org-1/models/${ansiName}`;
	const result = smartTruncateModelLabel(input, 10);
	assert.doesNotMatch(result, /\x1b\[[0-9;]*m/);
	assert.ok(visibleWidth(result) <= 10, `expected width <= 10, got ${visibleWidth(result)}: ${result}`);
});
