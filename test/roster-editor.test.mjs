import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ViewportMenu and the picker components use TypeScript parameter properties —
// run under the TS transform.
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

const ENTER = "\r";
const ESCAPE = "\x1b";
const TAB = "\t";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const BACKSPACE = "\x7f";
const strip = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

const tempRoot = mkdtempSync(path.join(tmpdir(), "roster-editor-test-"));
const agentDir = path.join(tempRoot, "agent");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousStdoutRows = process.stdout.rows;

try {
	process.stdout.rows = 40;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	mkdirSync(agentDir, { recursive: true });
	const settingsPath = path.join(agentDir, "mf-plan", "settings.json");

	const { showRosterManager } = await import("../src/ui/rosterEditor.ts");
	const { initTheme } = await import("@earendil-works/pi-coding-agent");

	// The embedded SelectList reads pi's global theme; no watcher in tests.
	initTheme(undefined, false);

	const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };
	const tui = { requestRender() {} };
	const models = [
		{ provider: "test", id: "opus", reasoning: true },
		{ provider: "test", id: "haiku", reasoning: true },
	];

	class Harness {
		component;
		names = [];
		confirms = [];
		notifications = [];
		ctx;

		constructor() {
			this.ctx = {
				hasUI: true,
				mode: "tui",
				modelRegistry: { getAvailable: () => models },
				ui: {
					custom: (factory) => new Promise((resolve) => {
						this.component = factory(tui, theme, {}, resolve);
					}),
					input: async () => this.names.shift(),
					confirm: async () => this.confirms.shift() ?? false,
					notify: (message) => { this.notifications.push(message); },
				},
			};
		}

		send(...keys) {
			for (const key of keys) {
				// Plain text arrives one character per key event; escape sequences stay whole.
				if (key.length > 1 && !key.startsWith("\x1b")) {
					for (const ch of key) this.component.handleInput(ch);
				} else {
					this.component.handleInput(key);
				}
			}
		}

		render() {
			return (this.component?.render(80) ?? []).map(strip).join("\n");
		}

		async settle(ticks = 8) {
			for (let i = 0; i < ticks; i++) await new Promise((resolve) => setImmediate(resolve));
		}
	}

	const slotRow = (label) => {
		const lines = harness.render().split("\n");
		const line = lines.find((l) => l.includes(label));
		assert.ok(line, `no rendered row containing ${JSON.stringify(label)}`);
		return line;
	};
	let harness;

	// ---------------------------------------------------------------------
	// Journey 1: create a roster, assign two proposers and all three roles,
	// save — the list shows the complete roster and publishes the change.
	// ---------------------------------------------------------------------
	harness = new Harness();
	harness.names.push("Core5");
	const published = [];
	const result = showRosterManager(harness.ctx, [], {
		currentThinking: "medium",
		onChange: (rosters) => published.push(structuredClone(rosters)),
	});

	assert.match(harness.render(), /Create roster/);
	harness.send(ENTER); // Create roster
	await harness.settle();
	assert.match(harness.render(), /Agent roster: Core5/);
	for (const label of ["Proposer 1", "Proposer 2", "Proposer 3", "Proposer 4", "Proposer 5", "Synthesizer", "Implementer", "Verifier", "Save roster", "Rename", "Cancel"]) {
		assert.match(harness.render(), new RegExp(label), `${label} must render in the slot editor`);
	}
	assert.match(harness.render(), /\(none\)/);

	// Proposer 1 → pick opus (default highlight after filtering).
	harness.send(ENTER); // open Proposer 1 picker
	await harness.settle();
	assert.match(harness.render(), /Proposer 1 — choose a model and thinking level/);
	harness.send("op", ENTER);
	await harness.settle();
	assert.match(slotRow("Proposer 1"), /test\/opus \(thinking: medium\)/);

	// Proposer 2 → pick haiku with thinking high.
	harness.send(DOWN, ENTER); // move to Proposer 2, open picker
	await harness.settle();
	harness.send("ha", TAB, DOWN, ENTER); // filter haiku, thinking medium → high, confirm
	await harness.settle();
	assert.match(slotRow("Proposer 2"), /test\/haiku \(thinking: high\)/);

	// Roles: synthesizer, implementer, verifier (default picks).
	harness.send(DOWN, DOWN, DOWN, DOWN, ENTER); // cursor Proposer 2 → Synthesizer, open
	await harness.settle();
	harness.send(ENTER); // confirm default (haiku, medium)
	await harness.settle();
	harness.send(DOWN, ENTER); // Implementer
	await harness.settle();
	harness.send(ENTER);
	await harness.settle();
	harness.send(DOWN, ENTER); // Verifier
	await harness.settle();
	harness.send(ENTER);
	await harness.settle();

	// Save.
	harness.send(TAB, ENTER); // buttons pane, Save roster is primary
	await harness.settle();

	// Back at the staged list: the roster appears with its role count and summary.
	assert.match(harness.render(), /Core5/);
	assert.match(harness.render(), /5 roles assigned/);
	assert.match(harness.render(), /P: opus, haiku · S: haiku · I: haiku · V: haiku/);

	// Back leaves the manager with the staged roster.
	harness.send(ESCAPE);
	assert.deepEqual(await result, [{
		name: "Core5",
		proposers: [
			{ ref: { provider: "test", id: "opus" }, thinking: "medium" },
			{ ref: { provider: "test", id: "haiku" }, thinking: "high" },
		],
		synthesizer: { ref: { provider: "test", id: "haiku" }, thinking: "medium" },
		implementer: { ref: { provider: "test", id: "haiku" }, thinking: "medium" },
		verifier: { ref: { provider: "test", id: "haiku" }, thinking: "medium" },
	}]);
	assert.deepEqual(published, [[{
		name: "Core5",
		proposers: [
			{ ref: { provider: "test", id: "opus" }, thinking: "medium" },
			{ ref: { provider: "test", id: "haiku" }, thinking: "high" },
		],
		synthesizer: { ref: { provider: "test", id: "haiku" }, thinking: "medium" },
		implementer: { ref: { provider: "test", id: "haiku" }, thinking: "medium" },
		verifier: { ref: { provider: "test", id: "haiku" }, thinking: "medium" },
	}]], "Save roster must publish the completed roster immediately");
	assert.equal(existsSync(settingsPath), false, "persistence remains the caller's responsibility");

	// ---------------------------------------------------------------------
	// Journey 2: saving an incomplete roster is refused with a readiness
	// notify; cancelling discards the draft entirely.
	// ---------------------------------------------------------------------
	harness = new Harness();
	harness.names.push("Draft1");
	const refused = showRosterManager(harness.ctx, [], { currentThinking: "medium" });
	harness.send(ENTER); // Create roster
	await harness.settle();
	harness.send(ENTER); // open Proposer 1
	await harness.settle();
	harness.send(ENTER); // confirm default model
	await harness.settle();
	harness.send(TAB, ENTER); // try to save with one proposer and no roles
	await harness.settle();
	assert.match(
		harness.notifications.at(-1) ?? "",
		/A roster needs 1 more proposer, a synthesizer, an implementer and a verifier\./,
	);
	assert.match(harness.render(), /Agent roster: Draft1/, "a refused save must stay in the editor");
	harness.send(ESCAPE); // cancel → draft discarded
	await harness.settle();
	harness.send(ESCAPE); // Back from the list
	assert.deepEqual(await refused, []);

	// ---------------------------------------------------------------------
	// Journey 3: Backspace clears a slot in the editor.
	// ---------------------------------------------------------------------
	harness = new Harness();
	harness.names.push("Bksp1");
	const cleared = showRosterManager(harness.ctx, [], { currentThinking: "medium" });
	harness.send(ENTER); // Create roster
	await harness.settle();
	harness.send(ENTER); // open Proposer 1
	await harness.settle();
	harness.send(ENTER); // confirm the default highlight (haiku)
	await harness.settle();
	assert.match(slotRow("Proposer 1"), /test\/haiku/);
	harness.send(BACKSPACE); // clear the focused slot
	assert.match(slotRow("Proposer 1"), /\(none\)/, "backspace must clear the selected slot");
	harness.send(ESCAPE);
	await harness.settle();
	harness.send(ESCAPE);
	assert.deepEqual(await cleared, []);

	// ---------------------------------------------------------------------
	// Journey 4: rename is staged through the name prompt.
	// ---------------------------------------------------------------------
	harness = new Harness();
	harness.names.push("New1");
	const renamed = showRosterManager(harness.ctx, [], { currentThinking: "medium" });
	harness.send(ENTER); // Create roster
	await harness.settle();
	harness.send(TAB, RIGHT, ENTER); // buttons pane → Rename
	await harness.settle();
	assert.match(harness.render(), /Agent roster: New1/, "the editor title must show the renamed draft");
	harness.send(ESCAPE);
	await harness.settle();
	harness.send(ESCAPE);
	assert.deepEqual(await renamed, []);

	// ---------------------------------------------------------------------
	// Journey 5: editing an existing roster; deletion is staged behind a
	// confirm, and a declined confirm returns to the editor.
	// ---------------------------------------------------------------------
	harness = new Harness();
	harness.confirms.push(false, true);
	const existing = [{
		name: "Core5",
		proposers: [
			{ ref: { provider: "test", id: "opus" }, thinking: "medium" },
			{ ref: { provider: "test", id: "haiku" }, thinking: "low" },
		],
		synthesizer: { ref: { provider: "test", id: "opus" }, thinking: "high" },
		implementer: { ref: { provider: "test", id: "haiku" }, thinking: "medium" },
		verifier: { ref: { provider: "test", id: "opus" }, thinking: "off" },
	}];
	const deletedPublished = [];
	const deleted = showRosterManager(harness.ctx, existing, {
		currentThinking: "medium",
		onChange: (rosters) => deletedPublished.push(structuredClone(rosters)),
	});

	assert.match(harness.render(), /Core5/);
	assert.match(harness.render(), /5 roles assigned/);
	harness.send(ENTER); // edit Core5
	await harness.settle();
	// The editor restores the saved assignments, including per-slot thinking.
	assert.match(slotRow("Proposer 1"), /test\/opus \(thinking: medium\)/);
	assert.match(slotRow("Proposer 2"), /test\/haiku \(thinking: low\)/);
	assert.match(slotRow("Synthesizer"), /thinking: high/);
	assert.match(slotRow("Verifier"), /thinking: off/);
	assert.match(harness.render(), /Delete/, "existing rosters can be deleted");

	harness.send(TAB, RIGHT, RIGHT, ENTER); // buttons → Delete
	await harness.settle();
	assert.match(harness.render(), /Agent roster: Core5/, "a declined delete returns to the editor");
	harness.send(TAB, RIGHT, RIGHT, ENTER); // Delete again
	await harness.settle();
	assert.match(harness.render(), /Create roster/, "a confirmed delete returns to the staged list");
	harness.send(ESCAPE); // Back
	assert.deepEqual(await deleted, []);
	assert.deepEqual(deletedPublished, [[]], "confirmed deletion must publish immediately");
	assert.equal(existsSync(settingsPath), false);

	console.log("Roster editor tests passed.");
} finally {
	process.stdout.rows = previousStdoutRows;
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(tempRoot, { recursive: true, force: true });
}
