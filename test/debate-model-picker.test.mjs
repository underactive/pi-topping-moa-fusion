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
const LEFT = "\u001b[D";
const RIGHT = "\u001b[C";
const POINTER = ">";
const WIDTH = 96;

const tempRoot = mkdtempSync(path.join(tmpdir(), "debate-picker-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousRows = process.stdout.rows;
try {
	process.env.PI_CODING_AGENT_DIR = path.join(tempRoot, "agent");
	mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	process.stdout.rows = 40;

	const { showDebateModelPicker } = await import("../src/ui/debateModelPicker.ts");
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

	const result = await showDebateModelPicker(makeCtx((component) => {
		const view = views(component);
		const initial = view.text();
		assert.match(initial, /Select Debating Models/);
		assert.doesNotMatch(initial, /Mixture of Agents|Synthesizer|Implementer|Verifier|Opinion/);
		for (let index = 1; index <= 5; index++) assert.match(view.row(`Debater ${index}`), /\(none\)/);
		assert.match(view.row("Debater 1"), new RegExp(POINTER));
		assert.match(view.row("Rounds"), /3/);
		assert.match(view.row("Start debate"), /needs 2 more debating models/);

		let cursor = 0;
		const move = (target) => {
			while (cursor < target) { component.handleInput(DOWN); cursor++; }
			while (cursor > target) { component.handleInput(UP); cursor--; }
		};

		// Rounds row: ←/→ adjust and clamp to 2–5.
		move(5);
		assert.match(view.row("Rounds"), new RegExp(POINTER));
		for (let i = 0; i < 4; i++) component.handleInput(RIGHT);
		assert.match(view.row("Rounds"), /5/, "rounds clamp at the maximum");
		component.handleInput(LEFT);
		assert.match(view.row("Rounds"), /4/);
		for (let i = 0; i < 10; i++) component.handleInput(LEFT);
		assert.match(view.row("Rounds"), /2/, "rounds clamp at the minimum");
		component.handleInput(RIGHT);
		component.handleInput(RIGHT);
		assert.match(view.row("Rounds"), /4/);
		move(0);

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

		// One assignment is not enough for a debate.
		assign(0, "haiku", DOWN);
		assert.match(view.row("Start debate"), /needs 1 more debating model/);
		assign(2, "opus", UP); // Debater 3
		assert.doesNotMatch(view.row("Start debate"), /needs/, "two assignments enable the action");
		assert.match(view.row("Debater 1"), /haiku.*thinking: high/);
		assert.match(view.row("Debater 3"), /opus.*thinking: low/);
		move(6);
		component.handleInput(ENTER);
	}), "medium");

	assert.deepEqual(result.models, [
		{ provider: "anthropic", id: "claude-haiku-4-5" },
		{ provider: "anthropic", id: "claude-opus-4-6" },
	]);
	assert.deepEqual(result.thinking, ["high", "low"]);
	assert.equal(result.rounds, 4, "the adjusted rounds value rides on the result");
	assert.equal(result.thinkingSelections["anthropic/claude-haiku-4-5"], "high");
	assert.equal(result.thinkingSelections["anthropic/claude-opus-4-6"], "low");

	const cancelled = await showDebateModelPicker(makeCtx((component) => component.handleInput(ESCAPE)), "medium");
	assert.equal(cancelled, undefined, "Esc from the overview cancels the picker");

	// Enter on the Rounds row is a no-op: it must not open a slot or start the debate.
	await showDebateModelPicker(makeCtx((component, done) => {
		const view = views(component);
		for (let i = 0; i < 5; i++) component.handleInput(DOWN);
		component.handleInput(ENTER);
		assert.match(view.text(), /Select Debating Models/, "still on the overview");
		done(undefined);
	}), "medium");

	process.stdout.rows = 10;
	await showDebateModelPicker(makeCtx((component, done) => {
		const view = views(component);
		let lines = view.lines();
		assert.ok(lines.length <= 7);
		assert.match(view.row("Debater 1"), new RegExp(POINTER));
		for (let index = 0; index < 6; index++) component.handleInput(DOWN);
		lines = view.lines();
		assert.ok(lines.length <= 7);
		assert.match(view.row("Start debate"), new RegExp(POINTER), "the compact window follows the action row");
		for (const line of lines) assert.ok(visibleWidth(line) <= WIDTH);
		done(undefined);
	}), "medium");

	console.log("Debate model picker tests passed.");
} finally {
	process.stdout.rows = previousRows;
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(tempRoot, { recursive: true, force: true });
}
