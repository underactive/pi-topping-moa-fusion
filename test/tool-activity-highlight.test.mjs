import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// cancelOverlay.ts uses TS parameter properties, which Node's default
// strip-only TS support rejects; re-exec under the fuller transform, mirroring
// test/overlay-chrome-parity.test.mjs.
if (!process.execArgv.includes("--experimental-transform-types")) {
	try {
		execFileSync(process.execPath, ["--experimental-transform-types", fileURLToPath(import.meta.url)], { stdio: "inherit" });
	} catch (error) {
		process.exit(error.status ?? 1);
	}
	process.exit(0);
}

const { visibleWidth } = await import("@earendil-works/pi-tui");
const { highlightActivity } = await import("../src/ui/toolActivity.ts");
const { showCancelOverlay } = await import("../src/ui/cancelOverlay.ts");
const { LOOP_THRESHOLD } = await import("../src/ui/agentStatus.ts");

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A theme stub with a distinct SGR code per color the formatter and the
 * cancellation popup exercise, plus a bold wrapper distinguishable from every
 * fg code (all fg codes are 3-digit; bold uses the real 1/22 SGR pair).
 */
const CODES = { text: 101, dim: 102, accent: 103, warning: 104, toolTitle: 105, success: 106, error: 107, border: 108 };
const THEME = {
	fg: (color, text) => `\x1b[${CODES[color] ?? 199}m${text}\x1b[0m`,
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
};
const TOOL_TITLE = (tool) => new RegExp(`\\x1b\\[105m\\x1b\\[1m${escapeRegExp(tool)}\\x1b\\[22m\\x1b\\[0m`);
const ACCENT = (detail) => new RegExp(`\\x1b\\[103m${escapeRegExp(detail)}\\x1b\\[0m`);

// ── highlightActivity: tool name gets bold toolTitle, argument gets accent ─
{
	const cases = [
		{ label: "single space", activity: "read src/app.ts", tool: "read", detail: "src/app.ts" },
		{ label: "repeated space", activity: 'grep  "handleRequest"', tool: "grep", detail: '"handleRequest"' },
		{ label: "path containing spaces", activity: "read /Users/me/My Documents/notes.txt", tool: "read", detail: "/Users/me/My Documents/notes.txt" },
		{ label: "regex punctuation and backslashes", activity: "grep  (foo|bar)\\d+\\.ts$", tool: "grep", detail: "(foo|bar)\\d+\\.ts$" },
		{ label: "custom tool name", activity: "mf_plan_subagent  explore the auth flow", tool: "mf_plan_subagent", detail: "explore the auth flow" },
		{ label: "leading whitespace", activity: "  read src/app.ts", tool: "read", detail: "src/app.ts" },
	];
	for (const { label, activity, tool, detail } of cases) {
		const out = highlightActivity(THEME, activity);
		assert.equal(strip(out), activity, `${label}: stripped output preserves the original activity exactly`);
		assert.equal(visibleWidth(out), visibleWidth(activity), `${label}: visible width is unchanged`);
		assert.match(out, TOOL_TITLE(tool), `${label}: the tool name is bold and toolTitle-colored`);
		assert.match(out, ACCENT(detail), `${label}: the argument is accent-colored`);
	}
}

// ── highlightActivity: leading whitespace is preserved ahead of the styled tool token ─
{
	const out = highlightActivity(THEME, "  read src/app.ts");
	assert.equal(strip(out), "  read src/app.ts", "leading whitespace survives unchanged");
	assert.ok(out.startsWith(`  ${THEME.fg("toolTitle", THEME.bold("read"))}`), "the tool token is still identified and styled after leading whitespace");
}

// ── highlightActivity: a tool-name-only label carries no accent segment ───
{
	const out = highlightActivity(THEME, "read");
	assert.equal(strip(out), "read");
	assert.match(out, new RegExp(`^\\x1b\\[105m\\x1b\\[1mread\\x1b\\[22m\\x1b\\[0m$`), "a bare tool name is fully styled with nothing left over");
}

// ── highlightActivity: empty and whitespace-only input pass through safely ─
{
	assert.equal(highlightActivity(THEME, ""), "", "empty input renders as empty output");
	assert.equal(highlightActivity(THEME, "   "), "   ", "whitespace-only input passes through unstyled and unchanged");
}

// ── cancellation popup: agent activity rows use the same segment colors ───
{
	const tui = { requestRender: () => {} };
	const extras = {
		0: { activity: "read  src/app.ts", loopCount: 1 },
		1: { activity: 'grep  "handleRequest"', loopCount: LOOP_THRESHOLD + 1 },
	};
	const session = {
		title: "MoA fan-out — running proposers",
		run: {
			agents: [
				{ label: "anthropic/claude-opus-4", state: "running" },
				{ label: "openai/gpt-5", state: "cancelling" },
			],
			cancelAll: () => {},
			cancel: () => {},
		},
		overlayOpen: false,
		getExtras: (index) => extras[index],
	};

	let component;
	await showCancelOverlay(
		{ mode: "tui", ui: { custom: async (factory) => { component = factory(tui, THEME, {}, () => {}); } } },
		session,
	);
	assert.ok(component, "the overlay component is constructed from the factory");

	const lines = component.render(80);
	const readLine = lines.find((l) => strip(l).includes("↳ read  src/app.ts"));
	const grepLine = lines.find((l) => strip(l).includes('↳ grep  "handleRequest"'));
	assert.ok(readLine, "the first agent's activity row renders");
	assert.ok(grepLine, "the second agent's activity row renders");

	assert.match(readLine, /\x1b\[102m {6}↳ \x1b\[0m/, "the indented gutter arrow is its own dim segment");
	assert.match(readLine, TOOL_TITLE("read"), "the tool name is bold and toolTitle-colored");
	assert.match(readLine, ACCENT("src/app.ts"), "the argument is accent-colored");
	assert.doesNotMatch(readLine, /\x1b\[104m/, "an agent under the loop threshold carries no warning badge");

	assert.match(grepLine, /\x1b\[102m {6}↳ \x1b\[0m/, "the second row's gutter is styled identically");
	assert.match(grepLine, TOOL_TITLE("grep"), "the second agent's tool name is styled identically");
	assert.match(grepLine, ACCENT('"handleRequest"'), "the second agent's argument is styled identically");
	assert.match(grepLine, /\x1b\[104m {2}\(↻ 4×\)\x1b\[0m/, "the looping agent keeps its warning badge, unchanged and outside the highlighted activity");

	component.dispose();
}

console.log("Tool-activity highlight tests passed.");
