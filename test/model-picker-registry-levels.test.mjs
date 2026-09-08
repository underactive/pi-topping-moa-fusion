import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// TwoPaneModelThinking uses TS constructor parameter properties, which Node's
// strip-only type-stripping cannot parse — run under the TS transform so this
// can drive the real component instead of asserting against source text.
if (!process.execArgv.includes("--experimental-transform-types")) {
	try {
		execFileSync(process.execPath, ["--experimental-transform-types", fileURLToPath(import.meta.url)], {
			stdio: "inherit",
		});
	} catch (err) {
		process.exit(err.status ?? 1);
	}
	process.exit(0);
}

const { TwoPaneModelThinking } = await import("../src/ui/twoPaneModelThinking.ts");
const { initTheme } = await import("@earendil-works/pi-coding-agent");

// The embedded SelectList reads pi's global theme; no watcher in tests.
initTheme(undefined, false);

const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };
const tui = { requestRender() {} };
const WIDTH = 80;

// A registry model that reasons but exposes neither xhigh nor max.
const bounded = { provider: "anthropic", id: "claude-opus-4-6", reasoning: true };
// A registry model that does expose both extended levels.
const extended = {
	provider: "openai",
	id: "o5",
	reasoning: true,
	thinkingLevelMap: { xhigh: "xhigh", max: "max" },
};

const ctx = { modelRegistry: { getAvailable: () => [bounded, extended] } };
const refs = [
	{ provider: bounded.provider, id: bounded.id },
	{ provider: extended.provider, id: extended.id },
];

// Both models carry a saved level of `max`, which only one of them supports —
// the stale state a settings file written against an older catalogue leaves.
const staleConfig = {
	mode: "moa",
	proposers: [],
	thinkingOverrides: { "anthropic/claude-opus-4-6": "max", "openai/o5": "max" },
};

const paneText = (twoPane) => twoPane.render(WIDTH).join("\n");

const twoPane = new TwoPaneModelThinking(tui, theme, refs, staleConfig, "medium", ctx);

// ── The bounded model must be held to the registry's range ───────────
twoPane.reset(refs[0]);
const bounded_ = paneText(twoPane);
assert.match(bounded_, /\bmedium\b/, "registry levels must be offered");
assert.doesNotMatch(bounded_, /\bmax\b/, "a level the registry does not list must not be offered");
assert.doesNotMatch(bounded_, /\bxhigh\b/, "nor may an unmapped extended level appear");
// …and the stale saved level must not be preselected either.
assert.deepEqual(twoPane.getSelected(), {
	ref: refs[0],
	thinking: "medium",
});

// ── A model that really does expose xhigh/max keeps both ─────────────
twoPane.reset(refs[1]);
const extended_ = paneText(twoPane);
assert.match(extended_, /\bxhigh\b/);
assert.match(extended_, /\bmax\b/, "max survives as a level of its own, not folded into xhigh");
assert.match(extended_, /\bminimal\b/, "the right pane must preserve its longest thinking label");
const modelRow = extended_.split("\n").find((line) => line.includes("openai/o5"));
assert.ok(modelRow?.startsWith(" "), "model rows must keep a one-column left inset");
// Here the saved override IS supported, so it is honored.
assert.deepEqual(twoPane.getSelected(), {
	ref: refs[1],
	thinking: "max",
});

// ── A non-reasoning model offers exactly one level ─────────────────
const plain = { provider: "local", id: "tinyllama" };
const plainRef = { provider: plain.provider, id: plain.id };
const plainPane = new TwoPaneModelThinking(
	tui,
	theme,
	[plainRef],
	{ mode: "moa", proposers: [], thinkingOverrides: { "local/tinyllama": "high" } },
	"medium",
	{ modelRegistry: { getAvailable: () => [plain] } },
);
plainPane.reset(plainRef);
assert.doesNotMatch(paneText(plainPane), /\bhigh\b/, "a model that cannot reason offers no reasoning levels");
assert.deepEqual(plainPane.getSelected(), { ref: plainRef, thinking: "off" });

console.log("Model picker registry-level tests passed.");
