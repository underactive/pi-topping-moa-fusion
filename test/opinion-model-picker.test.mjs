import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

const ENTER = "\r";
const ESCAPE = "\u001b";
const UP = "\u001b[A";
const DOWN = "\u001b[B";
const POINTER = "▸";
const WIDTH = 96;

const tempRoot = mkdtempSync(path.join(tmpdir(), "opinion-picker-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousRows = process.stdout.rows;
try {
	process.env.PI_CODING_AGENT_DIR = path.join(tempRoot, "agent");
	mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	process.stdout.rows = 40;

	const { showOpinionModelPicker } = await import("../src/ui/opinionModelPicker.ts");
	const { initTheme } = await import("@earendil-works/pi-coding-agent");
	const { visibleWidth } = await import("@earendil-works/pi-tui");
	initTheme(undefined, false);

	const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };
	const tui = { requestRender() {} };
	const models = [
		{ provider: "anthropic", id: "claude-haiku-4-5", reasoning: true },
		{ provider: "anthropic", id: "claude-opus-4-6", reasoning: true },
	];
	const makeCtx = (drive) => ({
		hasUI: true,
		mode: "tui",
		model: models[1],
		modelRegistry: {
			getAll: () => models,
			getAvailable: () => models,
			find: () => undefined,
			getRegisteredProviderIds: () => [],
		},
		ui: {
			custom: (factory) => {
				let settle;
				const closed = new Promise((resolve) => { settle = resolve; });
				const component = factory(tui, theme, {}, settle);
				drive(component, settle);
				return closed;
			},
		},
	});
	const views = (component, width = WIDTH) => ({
		lines: () => component.render(width),
		text: () => component.render(width).join("\n"),
		row: (label) => {
			const found = component.render(width).find((line) => line.includes(label));
			assert.ok(found, `missing row ${label}`);
			return found;
		},
	});

	const result = await showOpinionModelPicker(makeCtx((component) => {
		const view = views(component);
		const initial = view.text();
		assert.match(initial, /Select Opinion Models/);
		assert.doesNotMatch(initial, /Mixture of Agents|Synthesizer|Implementer|Verifier/);
		for (let index = 1; index <= 5; index++) assert.match(view.row(`Opinion ${index}`), /\(none\)/);
		assert.match(view.row("Opinion 1"), new RegExp(POINTER));
		assert.match(view.row("Get opinions"), /needs 1 opinion model/);

		let cursor = 0;
		const move = (target) => {
			while (cursor < target) { component.handleInput(DOWN); cursor++; }
			while (cursor > target) { component.handleInput(UP); cursor--; }
		};
		const assign = (slot, filter, thinkingDirection) => {
			move(slot);
			component.handleInput(ENTER);
			for (const char of filter) component.handleInput(char);
			if (thinkingDirection) {
				component.handleInput("\t");
				component.handleInput(thinkingDirection);
			}
			component.handleInput(ENTER);
		};

		// Assign sparse slots out of order. The final result must remain slot-ordered.
		assign(2, "haiku", DOWN); // Opinion 3, high
		assert.doesNotMatch(view.row("Get opinions"), /needs/, "one assignment enables the action");
		assign(0, "opus", UP); // Opinion 1, low
		assert.match(view.row("Opinion 1"), /opus.*thinking: low/);
		assert.match(view.row("Opinion 3"), /haiku.*thinking: high/);
		assert.match(view.row("Opinion 2"), /\(none\)/);
		move(5);
		component.handleInput(ENTER);
	}), "medium");

	assert.deepEqual(result.models, [
		{ provider: "anthropic", id: "claude-opus-4-6" },
		{ provider: "anthropic", id: "claude-haiku-4-5" },
	]);
	assert.deepEqual(result.thinking, ["low", "high"]);
	assert.equal(result.thinkingSelections["anthropic/claude-opus-4-6"], "low");
	assert.equal(result.thinkingSelections["anthropic/claude-haiku-4-5"], "high");

	const cancelled = await showOpinionModelPicker(makeCtx((component) => component.handleInput(ESCAPE)), "medium");
	assert.equal(cancelled, undefined, "Esc from the overview cancels the picker");

	process.stdout.rows = 10;
	await showOpinionModelPicker(makeCtx((component, done) => {
		const view = views(component);
		let lines = view.lines();
		assert.ok(lines.length <= 7);
		assert.match(view.row("Opinion 1"), new RegExp(POINTER));
		for (let index = 0; index < 5; index++) component.handleInput(DOWN);
		lines = view.lines();
		assert.ok(lines.length <= 7);
		assert.match(view.row("Get opinions"), new RegExp(POINTER), "the compact window follows the action row");
		for (const line of lines) assert.ok(visibleWidth(line) <= WIDTH);
		done(undefined);
	}), "medium");

	console.log("Opinion model picker tests passed.");
} finally {
	process.stdout.rows = previousRows;
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(tempRoot, { recursive: true, force: true });
}
