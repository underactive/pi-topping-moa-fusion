import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.execArgv.includes("--experimental-transform-types")) {
	try {
		execFileSync(process.execPath, ["--experimental-transform-types", fileURLToPath(import.meta.url)], { stdio: "inherit" });
	} catch (error) {
		process.exit(error.status ?? 1);
	}
	process.exit(0);
}

const {
	THINKING_LEVELS,
	isThinkingLevel,
} = await import("../src/shared/modelRefs.ts");
const {
	defaultThinkingForModel,
	thinkingOptionsForModel,
} = await import("../src/config/settings.ts");

const baseConfig = { mode: "single", proposers: [], thinkingOverrides: {} };

// `max` is a distinct level, ordered after `xhigh`, not an alias for it.
assert.deepEqual(THINKING_LEVELS, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
assert.equal(isThinkingLevel("max"), true);
assert.equal(isThinkingLevel("turbo"), false);

// ── Registry levels are the whole answer ─────────────────────────────
// Returned in pi's canonical order regardless of the order given, and never
// widened: a level the registry omits is one the backend would refuse.
assert.deepEqual(thinkingOptionsForModel(["off", "xhigh"]), ["off", "xhigh"]);
assert.deepEqual(thinkingOptionsForModel(["max", "off", "high"]), ["off", "high", "max"]);
assert.deepEqual(thinkingOptionsForModel([]), []);

// ── Default selection ────────────────────────────────────────────────
const levels = ["off", "low", "medium", "high"];

// A saved choice wins when the registry still supports it.
assert.equal(
	defaultThinkingForModel("test/saved", { ...baseConfig, thinkingOverrides: { "test/saved": "high" } }, "low", levels),
	"high",
);
// …and is ignored when it does not, rather than selecting an unusable level.
const stale = { ...baseConfig, thinkingOverrides: { "test/saved": "max" } };
assert.equal(defaultThinkingForModel("test/saved", stale, "low", levels), "low");
// With no usable saved or current level, fall back to medium, then to whatever exists.
assert.equal(defaultThinkingForModel("test/saved", stale, "xhigh", levels), "medium");
assert.equal(defaultThinkingForModel("test/unseen", baseConfig, "xhigh", ["off", "max"]), "off");

// Runtime selections remain slot-specific even when two proposer slots use the same model.
const tempRoot = mkdtempSync(path.join(tmpdir(), "moa-thinking-picker-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousStdoutRows = process.stdout.rows;
try {
	process.stdout.rows = 16;
	process.env.PI_CODING_AGENT_DIR = tempRoot;
	const { showImplementingModelPicker, showMoaModelPicker } = await import("../src/ui/moaModelPicker.ts");
	const { initTheme } = await import("@earendil-works/pi-coding-agent");
	initTheme(undefined, false);
	const model = { provider: "test", id: "same-model", reasoning: true };
	const tui = { requestRender() {} };
	const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };
	const ENTER = "\r";
	const ESCAPE = "\u001b";
	const UP = "\u001b[A";
	const DOWN = "\u001b[B";
	// Overview rows: Load Roster, then five proposers, synthesizer/implementer/
	// verifier, then Start. Blank separators are visual only.
	const ROW = { P1: 1, P2: 2, SYNTH: 6, IMPL: 7, VERIF: 8, START: 9 };
	const ctx = {
		hasUI: true,
		mode: "tui",
		model,
		modelRegistry: { getAvailable: () => [model] },
		ui: { custom: (factory) => {
			let settle;
			const closed = new Promise((resolve) => { settle = resolve; });
			const component = factory(tui, theme, {}, (value) => settle(value));
			const viewport = Math.floor(16 * 0.7);
			const rowFor = (label) => {
				const line = component.render(96).find((l) => l.includes(label));
				assert.ok(line, `no rendered row containing ${JSON.stringify(label)}`);
				return line;
			};
			// Overview cursor tracking: starts at 0, unchanged across commit/cancel.
			let cursor = 0;
			const move = (to) => {
				while (cursor < to) { component.handleInput(DOWN); cursor++; }
				while (cursor > to) { component.handleInput(UP); cursor--; }
			};
			const openSlot = (row) => { move(row); component.handleInput(ENTER); };

			const modeLines = component.render(96);
			assert.ok(modeLines.length <= viewport);
			assert.match(modeLines.join("\n"), /Mixture of Agents/);
			assert.match(modeLines.join("\n"), /Single model/);
			component.handleInput(ENTER); // choose MoA → overview

			// Proposer 1 → thinking high. The filter/action bar lives in the slot
			// picker, which the model list still owns for text input.
			openSlot(ROW.P1);
			component.handleInput("t");
			const filteredLines = component.render(96);
			assert.ok(filteredLines.length <= viewport);
			assert.match(filteredLines.join("\n"), /filter: t/);
			assert.match(filteredLines.join("\n"), /Select/);
			assert.match(filteredLines.join("\n"), /Cancel/);
			component.handleInput("\x7f"); // backspace clears the filter
			component.handleInput("\t"); // → thinking pane
			component.handleInput(DOWN); // medium → high
			component.handleInput(ENTER); // confirm → overview

			// Proposer 2 (same model) → thinking low.
			openSlot(ROW.P2);
			component.handleInput("\t"); // → thinking pane
			component.handleInput(UP); // medium → low
			component.handleInput(ENTER); // confirm → overview

			// Slot-specific thinking survives even though both slots share a model.
			assert.match(rowFor("Proposer 1"), /thinking: high/);
			assert.match(rowFor("Proposer 2"), /thinking: low/);

			// Re-opening a committed slot restores its own thinking; cancelling keeps it.
			openSlot(ROW.P1);
			assert.match(component.render(96).join("\n"), /Thinking/, "the slot picker re-opens");
			component.handleInput(ESCAPE); // cancel → overview
			assert.match(rowFor("Proposer 1"), /thinking: high/, "cancelling preserves the slot's thinking");

			// Synthesizer → thinking high; implementer/verifier keep their defaults.
			openSlot(ROW.SYNTH);
			component.handleInput("\t");
			component.handleInput(DOWN); // medium → high
			component.handleInput(ENTER);
			openSlot(ROW.IMPL); component.handleInput(ENTER);
			openSlot(ROW.VERIF); component.handleInput(ENTER);

			// Park the cursor on the synthesizer so it stays inside the compact window.
			move(ROW.SYNTH);
			const confirmLines = component.render(96);
			assert.ok(confirmLines.length <= viewport);
			assert.match(confirmLines.join("\n"), /MoA Fusion Pre-flight/);
			assert.match(rowFor("Synthesizer"), /thinking: high/);

			move(ROW.START);
			component.handleInput(ENTER); // Start fan-out
			return closed;
		} },
	};
	const result = await showMoaModelPicker(ctx, "medium");
	assert.equal(result.mode, "moa");
	assert.deepEqual(result.proposerThinking, ["high", "low"]);
	assert.equal(result.proposers[0].id, "same-model");
	assert.equal(result.proposers[1].id, "same-model");
	assert.equal(result.synthesizerThinking, "high");

	let implementingLines = [];
	const implementingCtx = {
		...ctx,
		ui: { custom: (factory) => {
			const component = factory(tui, theme, {}, () => {});
			component.handleInput("t");
			implementingLines = component.render(96);
			component.handleInput("\u001b");
			return Promise.resolve(undefined);
		} },
	};
	assert.equal(await showImplementingModelPicker(implementingCtx, "medium"), undefined);
	assert.ok(implementingLines.length <= Math.floor(16 * 0.7));
	assert.match(implementingLines.join("\n"), /filter: t/);
	assert.match(implementingLines.join("\n"), /Select/);
	assert.match(implementingLines.join("\n"), /Cancel/);
} finally {
	process.stdout.rows = previousStdoutRows;
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(tempRoot, { recursive: true, force: true });
}

console.log("MoA thinking preference tests passed.");
