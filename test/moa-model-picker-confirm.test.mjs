import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// MoaModelPickerComponent uses TypeScript parameter properties, which Node's
// strip-only type-stripping cannot parse — run under the TS transform.
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
const ESCAPE = "\u001b";
const UP = "\u001b[A";
const DOWN = "\u001b[B";
const POINTER = "\u25B8";

// Overview row indices — Load Roster, then proposers, the three required
// roles, and Start. The blank lines are visual separators only.
const ROW = { LOAD: 0, P1: 1, P2: 2, P3: 3, P4: 4, P5: 5, SYNTH: 6, IMPL: 7, VERIF: 8, START: 9 };

const tempRoot = mkdtempSync(path.join(tmpdir(), "moa-model-picker-confirm-test-"));
const agentDir = path.join(tempRoot, "agent");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousStdoutRows = process.stdout.rows;

try {
	process.stdout.rows = 40;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	mkdirSync(agentDir, { recursive: true });

	const { showMoaModelPicker } = await import("../src/ui/moaModelPicker.ts");
	const { initTheme } = await import("@earendil-works/pi-coding-agent");
	const { visibleWidth } = await import("@earendil-works/pi-tui");

	// The embedded SelectList reads pi's global theme; no watcher in tests.
	initTheme(undefined, false);

	const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };
	const tui = { requestRender() {} };
	// `reasoning` drives the registry-derived thinking levels the picker offers,
	// so these carry it the way real Anthropic registry entries do.
	const models = [
		{ provider: "anthropic", id: "claude-haiku-4-5", reasoning: true },
		{ provider: "anthropic", id: "claude-opus-4-6", reasoning: true },
	];

	const WIDTH = 96;
	const assertWithinWidth = (lines) => {
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= WIDTH, `rendered line exceeds ${WIDTH} columns: ${visibleWidth(line)}`);
		}
	};

	// Builds a ctx whose ui.custom captures the picker component so the drive
	// function can walk it through the screens synchronously; the returned
	// promise settles when the drive (or the component's done callback) settles.
	const makePickerCtx = (drive, _extra, notifications = []) => ({
		hasUI: true,
		mode: "tui",
		model: models[1], // opus is the active model → the empty-slot highlight
		modelRegistry: {
			getAll: () => models,
			getAvailable: () => models,
			find: () => undefined,
			getRegisteredProviderIds: () => [],
		},
		ui: {
			notify: (message) => { notifications.push(message); },
			custom: (factory) => {
				let settle;
				const closed = new Promise((resolve) => { settle = resolve; });
				const component = factory(tui, theme, {}, (value) => settle(value));
				drive(component, (value) => settle(value));
				return closed;
			},
		},
	});

	// Drive helpers bound to a captured component.
	const makeViews = (component) => ({
		text: () => component.render(WIDTH).join("\n"),
		lines: () => component.render(WIDTH),
		rowFor: (label) => {
			const line = component.render(WIDTH).find((l) => l.includes(label));
			assert.ok(line, `no rendered row containing ${JSON.stringify(label)}`);
			return line;
		},
	});

	// Overview navigation helper. Tracks the cursor locally: it starts at 0 on
	// entering the overview, and stays put across a slot commit or cancel.
	const overview = (component) => {
		let cursor = 0;
		const move = (to) => {
			while (cursor < to) { component.handleInput(DOWN); cursor++; }
			while (cursor > to) { component.handleInput(UP); cursor--; }
		};
		return {
			move,
			// Open the slot at `row`, optionally filter and/or pick a thinking level
			// ("high" = one step below the medium default, "low" = one step above),
			// then confirm. `opts` may be a bare filter string for the common case.
			assign: (row, opts) => {
				const { filter, thinking } = typeof opts === "string" ? { filter: opts } : (opts ?? {});
				move(row);
				component.handleInput(ENTER); // open the slot picker
				if (filter) for (const ch of filter) component.handleInput(ch);
				if (thinking) {
					component.handleInput("\t"); // model → thinking pane
					component.handleInput(thinking === "high" ? DOWN : UP); // medium → high/low
				}
				component.handleInput(ENTER); // confirm → back to overview, cursor unchanged
			},
			// Open the slot at `row`, then cancel without committing.
			openCancel: (row) => {
				move(row);
				component.handleInput(ENTER);
				component.handleInput(ESCAPE); // cancel → back to overview
			},
			// Move onto the Start action and activate it.
			start: () => {
				move(ROW.START);
				component.handleInput(ENTER);
			},
		};
	};

	// ---------------------------------------------------------------------
	// Journey 1: overview opens with every slot `(none)`, Start disabled; a
	// mix of slot assignments (out of order, nonadjacent, repeated model),
	// edit and cancel round-trips, Esc navigation, then a successful start.
	// ---------------------------------------------------------------------
	let result;
	result = await showMoaModelPicker(makePickerCtx((component) => {
		const { text, lines, rowFor } = makeViews(component);

		// Mode screen → MoA opens the overview directly (no sequential screens).
		assert.match(text(), /Mixture of Agents/);
		component.handleInput(ENTER);

		// Overview: Load Roster is first, followed by a blank line and the eight
		// unassigned slots; Start remains last.
		const initial = text();
		assert.match(initial, /MoA Fusion Pre-flight/);
		const order = ["Load Roster", "Proposer 1", "Proposer 2", "Proposer 3", "Proposer 4", "Proposer 5", "Synthesizer", "Implementer", "Verifier", "Start fan-out"];
		let previousPosition = -1;
		for (const label of order) {
			const position = initial.indexOf(label);
			assert.ok(position > previousPosition, `${label} must follow the preceding overview row`);
			previousPosition = position;
		}
		const initialLines = lines();
		const loadLine = initialLines.findIndex((line) => line.includes("Load Roster"));
		assert.ok(loadLine >= 0);
		assert.ok(initialLines[loadLine + 1] && !/[A-Za-z]/.test(initialLines[loadLine + 1]), "Load Roster must be followed by a blank line");
		assert.match(rowFor("Proposer 1"), /\(none\)/);
		assert.match(rowFor("Verifier"), /\(none\)/);
		assert.doesNotMatch(initial, /thinking:/, "unset slots must not show a thinking suffix");
		assert.match(rowFor("Load Roster"), new RegExp(POINTER));
		assert.doesNotMatch(rowFor("Proposer 1"), new RegExp(POINTER));
		// Load Roster is disabled and explains where rosters come from.
		assert.match(rowFor("Load Roster"), /no rosters saved — add one in \/mf-plan-settings/);
		// Start is disabled and explains what it still needs.
		assert.match(rowFor("Start fan-out"), /needs 2 more proposers, synthesizer, implementer, verifier/);

		const nav = overview(component);

		// Disabled Start is a no-op with nothing assigned.
		nav.start();
		assert.match(text(), /MoA Fusion Pre-flight/, "activating a disabled Start must not leave the overview");
		assert.match(rowFor("Start fan-out"), /needs 2 more proposers/);

		// The disabled Load Roster row swallows Enter too.
		nav.move(ROW.LOAD);
		component.handleInput(ENTER);
		assert.match(text(), /MoA Fusion Pre-flight/, "Enter on an empty Load Roster must be a no-op");
		nav.move(ROW.P1);

		// Assign Proposer 1 (default highlight = opus) and confirm.
		nav.assign(ROW.P1);
		assert.match(text(), /MoA Fusion Pre-flight/, "confirming a slot returns to the overview");
		assert.match(rowFor("Proposer 1"), /anthropic\/claude-opus-4-6 · thinking: medium/);
		assert.match(rowFor("Proposer 1"), new RegExp(POINTER), "cursor stays on the just-edited row");

		// Nonadjacent second proposer: skip Proposer 2, assign Proposer 3 (haiku).
		nav.assign(ROW.P3, "haiku");
		assert.match(rowFor("Proposer 3"), /anthropic\/claude-haiku-4-5 · thinking: medium/);
		assert.match(rowFor("Proposer 2"), /\(none\)/, "Proposer 2 stays empty");

		// Required roles: synthesizer + implementer (repeat opus) + verifier.
		nav.assign(ROW.SYNTH);
		nav.assign(ROW.IMPL);
		nav.assign(ROW.VERIF, "haiku");
		assert.match(rowFor("Synthesizer"), /anthropic\/claude-opus-4-6/);
		assert.match(rowFor("Implementer"), /anthropic\/claude-opus-4-6/);
		assert.match(rowFor("Verifier"), /anthropic\/claude-haiku-4-5/);

		// Two proposers + all roles → ready: Start no longer shows a "needs" hint.
		assert.doesNotMatch(rowFor("Start fan-out"), /needs/, "Start must be enabled once requirements are met");

		// Edit round-trip: re-open Proposer 1, change to haiku, confirm returns to
		// the overview without touching siblings.
		nav.assign(ROW.P1, "haiku");
		assert.match(rowFor("Proposer 1"), /anthropic\/claude-haiku-4-5/);
		assert.match(rowFor("Proposer 3"), /anthropic\/claude-haiku-4-5/, "sibling slots stay put");
		assert.match(rowFor("Proposer 1"), new RegExp(POINTER));

		// Cancel a committed edit: re-open Proposer 1, Esc, value is unchanged.
		nav.openCancel(ROW.P1);
		assert.match(text(), /MoA Fusion Pre-flight/);
		assert.match(rowFor("Proposer 1"), /anthropic\/claude-haiku-4-5/, "cancelling an edit keeps the committed pick");

		// Cancel opening an empty slot: Proposer 4 stays `(none)`.
		nav.openCancel(ROW.P4);
		assert.match(rowFor("Proposer 4"), /\(none\)/, "cancelling an empty slot leaves it unassigned");

		// Esc from the overview returns to the mode chooser; assignments persist.
		component.handleInput(ESCAPE);
		assert.match(text(), /Single model/);
		assert.doesNotMatch(text(), /MoA Fusion Pre-flight/);
		component.handleInput(ENTER); // MoA again
		assert.match(text(), /MoA Fusion Pre-flight/);
		assert.match(rowFor("Proposer 1"), /anthropic\/claude-haiku-4-5/, "assignments survive a trip to the mode chooser");
		assert.match(rowFor("Proposer 3"), /anthropic\/claude-haiku-4-5/);

		// Start the run. (Cursor is back at Proposer 1 after re-entering.)
		overview(component).start();
	}), "medium");

	assert.equal(result.mode, "moa");
	// Dense, slot-ordered proposers: Proposer 1 then Proposer 3, no empty slots.
	assert.deepEqual(result.proposers, [
		{ provider: "anthropic", id: "claude-haiku-4-5" },
		{ provider: "anthropic", id: "claude-haiku-4-5" },
	]);
	assert.deepEqual(result.proposerThinking, ["medium", "medium"]);
	assert.deepEqual(result.synthesizer, { provider: "anthropic", id: "claude-opus-4-6" });
	assert.deepEqual(result.implementer, { provider: "anthropic", id: "claude-opus-4-6" });
	assert.deepEqual(result.verifier, { provider: "anthropic", id: "claude-haiku-4-5" });
	assert.equal(result.synthesizerThinking, "medium");
	assert.equal(result.implementerThinking, "medium");
	assert.equal(result.verifierThinking, "medium");
	assert.equal(result.thinkingSelections["anthropic/claude-haiku-4-5"], "medium");
	assert.equal(result.thinkingSelections["anthropic/claude-opus-4-6"], "medium");

	// ---------------------------------------------------------------------
	// Journey 2: readiness gating. One proposer plus all roles is not enough;
	// two proposers with any single required role missing is not enough.
	// ---------------------------------------------------------------------
	const assertNotReady = (assignRows, expectMissing) =>
		showMoaModelPicker(makePickerCtx((component, done) => {
			const { text, rowFor } = makeViews(component);
			component.handleInput(ENTER); // MoA → overview
			const nav = overview(component);
			for (const row of assignRows) nav.assign(row);
			assert.match(rowFor("Start fan-out"), expectMissing, `expected Start to report ${expectMissing}`);
			nav.start(); // disabled → no-op
			assert.match(text(), /MoA Fusion Pre-flight/, "disabled Start must not finish the picker");
			done(undefined);
		}), "medium");

	// One proposer + all three roles: still needs a second proposer.
	assert.equal(await assertNotReady([ROW.P1, ROW.SYNTH, ROW.IMPL, ROW.VERIF], /needs 1 more proposer\b/), undefined);
	// Two proposers, each required role missing in turn.
	assert.equal(await assertNotReady([ROW.P1, ROW.P2, ROW.IMPL, ROW.VERIF], /needs synthesizer/), undefined);
	assert.equal(await assertNotReady([ROW.P1, ROW.P2, ROW.SYNTH, ROW.VERIF], /needs implementer/), undefined);
	assert.equal(await assertNotReady([ROW.P1, ROW.P2, ROW.SYNTH, ROW.IMPL], /needs verifier/), undefined);

	// ---------------------------------------------------------------------
	// Journey 3: exactly two proposers + all roles starts; optional proposer
	// slots stay empty and never reach the result.
	// ---------------------------------------------------------------------
	const minimal = await showMoaModelPicker(makePickerCtx((component) => {
		component.handleInput(ENTER); // MoA → overview
		const nav = overview(component);
		nav.assign(ROW.P1);
		nav.assign(ROW.P2);
		nav.assign(ROW.SYNTH);
		nav.assign(ROW.IMPL);
		nav.assign(ROW.VERIF);
		nav.start();
	}), "medium");
	assert.equal(minimal.mode, "moa");
	assert.equal(minimal.proposers.length, 2, "only assigned proposer slots reach the result");
	assert.equal(minimal.proposerThinking.length, 2);

	// ---------------------------------------------------------------------
	// Journey 3b: arbitrary assignment order + nonadjacent proposer slots +
	// repeated models, with a distinguishable model/thinking pair per slot, must
	// compact into dense arrays in SLOT order (not assignment order), keeping
	// each model aligned with its own thinking level.
	// ---------------------------------------------------------------------
	const sparse = await showMoaModelPicker(makePickerCtx((component) => {
		const { rowFor } = makeViews(component);
		component.handleInput(ENTER); // MoA → overview
		const nav = overview(component);

		// Assign Proposer 3 BEFORE Proposer 1, leaving Proposer 2 empty between
		// them. Give each a distinct model and a distinct thinking level.
		nav.assign(ROW.P3, { filter: "haiku", thinking: "high" });
		nav.assign(ROW.P1, { filter: "opus", thinking: "low" });

		// Overview reflects each slot's own pair; the gap slot stays empty.
		assert.match(rowFor("Proposer 1"), /anthropic\/claude-opus-4-6 · thinking: low/);
		assert.match(rowFor("Proposer 3"), /anthropic\/claude-haiku-4-5 · thinking: high/);
		assert.match(rowFor("Proposer 2"), /\(none\)/, "the skipped slot stays unassigned");

		// Repeated model selections across the required roles.
		nav.assign(ROW.SYNTH); // opus (default highlight), medium
		nav.assign(ROW.IMPL, "haiku"); // repeat haiku
		nav.assign(ROW.VERIF, "opus"); // repeat opus
		nav.start();
	}), "medium");
	assert.equal(sparse.mode, "moa");
	// Dense output preserves SLOT order (P1 then P3) even though P3 was chosen
	// first, and each thinking level stays paired with its own slot's model.
	assert.deepEqual(sparse.proposers, [
		{ provider: "anthropic", id: "claude-opus-4-6" },
		{ provider: "anthropic", id: "claude-haiku-4-5" },
	]);
	assert.deepEqual(sparse.proposerThinking, ["low", "high"]);
	assert.deepEqual(sparse.implementer, { provider: "anthropic", id: "claude-haiku-4-5" });
	assert.deepEqual(sparse.verifier, { provider: "anthropic", id: "claude-opus-4-6" });

	// ---------------------------------------------------------------------
	// Journey 4: saved configuration only seeds highlights — the overview still
	// opens with every slot `(none)`, and Start stays disabled until confirmed.
	// ---------------------------------------------------------------------
	mkdirSync(path.join(agentDir, "mf-plan"), { recursive: true });
	writeFileSync(
		path.join(agentDir, "mf-plan", "settings.json"),
		JSON.stringify({
			mode: "moa",
			proposers: [
				{ provider: "anthropic", id: "claude-haiku-4-5" },
				{ provider: "anthropic", id: "claude-opus-4-6" },
			],
			synthesizer: { provider: "anthropic", id: "claude-opus-4-6" },
			implementer: { provider: "anthropic", id: "claude-opus-4-6" },
			verifier: { provider: "anthropic", id: "claude-opus-4-6" },
			thinkingOverrides: {},
		}),
		"utf-8",
	);

	const savedResult = await showMoaModelPicker(makePickerCtx((component) => {
		const { text, rowFor } = makeViews(component);
		component.handleInput(ENTER); // MoA → overview
		// Saved config must NOT pre-assign anything: all eight slots read `(none)`.
		for (const label of ["Proposer 1", "Proposer 2", "Proposer 3", "Proposer 4", "Proposer 5", "Synthesizer", "Implementer", "Verifier"]) {
			assert.match(rowFor(label), /\(none\)/, `saved config must leave ${label} unassigned`);
		}
		assert.doesNotMatch(text(), /thinking:/, "no slot shows a thinking suffix before any assignment");
		assert.match(rowFor("Start fan-out"), /needs 2 more proposers, synthesizer, implementer, verifier/, "saved config must not satisfy readiness");

		const nav = overview(component);
		// Opening the empty Proposer 1 highlights the saved slot-1 model (haiku);
		// confirming without filtering commits that highlight.
		nav.assign(ROW.P1);
		assert.match(rowFor("Proposer 1"), /anthropic\/claude-haiku-4-5/, "empty-slot highlight comes from the saved slot");
		// Remaining slots highlight the active model (opus) as before.
		nav.assign(ROW.P2);
		assert.match(rowFor("Proposer 2"), /anthropic\/claude-opus-4-6/);
		nav.assign(ROW.SYNTH);
		nav.assign(ROW.IMPL);
		nav.assign(ROW.VERIF);
		nav.start();
	}), "medium");
	assert.equal(savedResult.mode, "moa");
	assert.deepEqual(savedResult.proposers[0], { provider: "anthropic", id: "claude-haiku-4-5" });

	rmSync(path.join(agentDir, "mf-plan"), { recursive: true, force: true });

	// ---------------------------------------------------------------------
	// Journey 5: single-model path resolves immediately, no overview.
	// ---------------------------------------------------------------------
	const singleResult = await showMoaModelPicker(makePickerCtx((component) => {
		const overviewText = component.render(WIDTH).join("\n");
		assert.match(overviewText, /Mixture of Agents/);
		assert.doesNotMatch(overviewText, /MoA Fusion Pre-flight/);
		component.handleInput(DOWN); // highlight Single model
		component.handleInput(ENTER); // resolves with no overview
	}), "medium");
	assert.deepEqual(singleResult, { mode: "single" });

	// ---------------------------------------------------------------------
	// Journey 5b: Load Roster. A saved roster applies every slot wholesale.
	// ---------------------------------------------------------------------
	const seedSettings = (rosters) => {
		mkdirSync(path.join(agentDir, "mf-plan"), { recursive: true });
		writeFileSync(
			path.join(agentDir, "mf-plan", "settings.json"),
			JSON.stringify({ mode: "moa", proposers: [], thinkingOverrides: {}, rosters }),
			"utf-8",
		); 
	};
	const haikuRef = { provider: "anthropic", id: "claude-haiku-4-5" };
	const opusRef = { provider: "anthropic", id: "claude-opus-4-6" };
	seedSettings([{
		name: "team1",
		proposers: [
			{ ref: haikuRef, thinking: "high" },
			{ ref: opusRef, thinking: "low" },
		],
		synthesizer: { ref: opusRef, thinking: "high" },
		implementer: { ref: opusRef, thinking: "medium" },
		verifier: { ref: haikuRef, thinking: "off" },
	}]);

	// (A) A complete roster populates every slot and Start enables.
	const rosterResult = await showMoaModelPicker(makePickerCtx((component) => {
		const { text, rowFor } = makeViews(component);
		component.handleInput(ENTER); // MoA → overview

		assert.match(rowFor("Load Roster"), /1 saved/);
		const nav = overview(component);
		nav.move(ROW.LOAD);
		component.handleInput(ENTER); // open the roster screen

		const rosterList = text();
		assert.match(rosterList, /team1/);
		assert.match(rosterList, /P: haiku, opus \u00b7 S: opus \u00b7 I: opus \u00b7 V: haiku/);
		assert.match(rosterList, /enter load/);

		component.handleInput(ENTER); // load team1 → back to the overview
		assert.match(text(), /MoA Fusion Pre-flight/, "loading a roster returns to the overview");
		assert.match(rowFor("Proposer 1"), /claude-haiku-4-5 \u00b7 thinking: high/);
		assert.match(rowFor("Proposer 2"), /claude-opus-4-6 \u00b7 thinking: low/);
		assert.match(rowFor("Proposer 3"), /\(none\)/, "the roster's two proposers leave slots 3-5 empty");
		assert.match(rowFor("Synthesizer"), /claude-opus-4-6 \u00b7 thinking: high/);
		assert.match(rowFor("Implementer"), /claude-opus-4-6 \u00b7 thinking: medium/);
		assert.match(rowFor("Verifier"), /claude-haiku-4-5 \u00b7 thinking: off/);
		assert.doesNotMatch(rowFor("Start fan-out"), /needs/, "a loaded roster must satisfy readiness");

		nav.start();
	}), "medium");
	assert.equal(rosterResult.mode, "moa");
	assert.deepEqual(rosterResult.proposers, [haikuRef, opusRef]);
	assert.deepEqual(rosterResult.proposerThinking, ["high", "low"]);
	assert.deepEqual(rosterResult.synthesizer, opusRef);
	assert.deepEqual(rosterResult.implementer, opusRef);
	assert.deepEqual(rosterResult.verifier, haikuRef);
	assert.equal(rosterResult.synthesizerThinking, "high");
	assert.equal(rosterResult.implementerThinking, "medium");
	assert.equal(rosterResult.verifierThinking, "off");
	// thinkingSelections is keyed per model with last applied slot winning:
	// haiku's last slot is the verifier (off), opus's is the implementer (medium).
	assert.equal(rosterResult.thinkingSelections["anthropic/claude-haiku-4-5"], "off");
	assert.equal(rosterResult.thinkingSelections["anthropic/claude-opus-4-6"], "medium");

	// (B) A roster whose verifier model is no longer callable: the slot stays
	// empty with a skipped warning, and Start reads its remaining need.
	seedSettings([{
		name: "ghost",
		proposers: [
			{ ref: haikuRef, thinking: "medium" },
			{ ref: opusRef, thinking: "medium" },
		],
		synthesizer: { ref: opusRef, thinking: "medium" },
		implementer: { ref: opusRef, thinking: "medium" },
		verifier: { ref: { provider: "openai", id: "gpt-gone" }, thinking: "off" },
	}]);

	const notifications = [];
	await showMoaModelPicker(makePickerCtx((component, done) => {
		const { rowFor } = makeViews(component);
		component.handleInput(ENTER); // MoA → overview
		const nav = overview(component);
		nav.move(ROW.LOAD);
		component.handleInput(ENTER); // open the roster screen
		component.handleInput(ENTER); // load ghost
		assert.match(rowFor("Verifier"), /\(none\)/, "an unavailable roster model must leave its slot empty");
		assert.match(rowFor("Proposer 1"), /claude-haiku-4-5/);
		assert.match(rowFor("Synthesizer"), /claude-opus-4-6/);
		assert.match(rowFor("Start fan-out"), /needs verifier/);
		// The cursor lands on the first still-empty required row.
		assert.ok(rowFor("Verifier").includes(POINTER), "the cursor must rest on the unassigned required slot");
		done(undefined);
	}, undefined, notifications), "medium");
	assert.equal(notifications.filter((n) => n.includes("Roster ghost: skipped Verifier — model not available")).length, 1);

	// (C) Esc from the roster screen returns to the overview with manual
	// assignments intact, and a zero-availability roster cannot be loaded.
	seedSettings([
		{
			name: "alive",
			proposers: [
				{ ref: opusRef, thinking: "medium" },
				{ ref: opusRef, thinking: "medium" },
			],
			synthesizer: { ref: opusRef, thinking: "medium" },
			implementer: { ref: opusRef, thinking: "medium" },
			verifier: { ref: opusRef, thinking: "medium" },
		},
		{
			name: "unavailable",
			proposers: [
				{ ref: { provider: "openai", id: "gpt-gone" }, thinking: "off" },
				{ ref: { provider: "openai", id: "gpt-gone" }, thinking: "off" },
			],
			synthesizer: { ref: { provider: "openai", id: "gpt-gone" }, thinking: "off" },
			implementer: { ref: { provider: "openai", id: "gpt-gone" }, thinking: "off" },
			verifier: { ref: { provider: "openai", id: "gpt-gone" }, thinking: "off" },
		},
	]);

	await showMoaModelPicker(makePickerCtx((component, done) => {
		const { text, rowFor } = makeViews(component);
		component.handleInput(ENTER); // MoA → overview
		const nav = overview(component);
		nav.assign(ROW.P1, "haiku");
		nav.move(ROW.LOAD);
		component.handleInput(ENTER); // open the roster screen

		const rosterList = text();
		// Sorted by name; both rosters render, the zero-availability one included.
		assert.ok(rosterList.indexOf("alive") >= 0 && rosterList.indexOf("unavailable") > rosterList.indexOf("alive"));

		component.handleInput(ESCAPE); // back to the overview
		assert.match(text(), /MoA Fusion Pre-flight/, "Esc must return to the overview");
		assert.match(rowFor("Proposer 1"), /claude-haiku-4-5/, "manual assignments survive the roster-screen round trip");
		assert.match(rowFor("Proposer 2"), /\(none\)/);

		// Loading the all-unavailable roster is refused: the overview is untouched.
		nav.move(ROW.LOAD);
		component.handleInput(ENTER);
		component.handleInput(DOWN); // cursor onto the dimmed roster
		component.handleInput(ENTER); // swallowed — zero available slots
		component.handleInput(ESCAPE); // back to the overview
		assert.match(rowFor("Proposer 2"), /\(none\)/, "a dimmed roster must not load");
		done(undefined);
	}), "medium");

	rmSync(path.join(agentDir, "mf-plan"), { recursive: true, force: true });

	// ---------------------------------------------------------------------
	// Journey 6: compact viewports. The full overview fits at viewport 16; at
	// viewport 7 the slot rows window around the pointer so it stays visible.
	// ---------------------------------------------------------------------
	process.stdout.rows = 24; // viewport 16: the full overview fits
	await showMoaModelPicker(makePickerCtx((component, done) => {
		const { lines, rowFor } = makeViews(component);
		component.handleInput(ENTER); // MoA → overview

		let rendered = lines();
		assert.match(rendered.join("\n"), /MoA Fusion Pre-flight/);
		assert.match(rendered.join("\n"), /Start fan-out/);
		assertWithinWidth(rendered);

		process.stdout.rows = 10; // viewport 7: windowing kicks in (3 slot rows)
		rendered = lines();
		assert.ok(rendered.length <= 7, `rows=10: expected <= 7 lines, got ${rendered.length}`);
		assert.ok(rowFor("Load Roster").includes(POINTER), "pointer row must stay visible at the top of the window");
		assert.ok(rowFor("Proposer 1").includes("Proposer 1"), "the first proposer must remain visible below the separator");

		// Walk to the Start row; the window must follow the pointer (9 focusable
		// rows down: Load, P1-P5, Synth, Impl, Verif, Start).
		for (let i = 0; i < 9; i++) component.handleInput(DOWN);
		rendered = lines();
		assert.ok(rendered.length <= 7);
		assert.ok(rowFor("Start fan-out").includes(POINTER), "window must follow the pointer to the action row");
		done(undefined);
	}), "medium");
	process.stdout.rows = 40;

	// ---------------------------------------------------------------------
	// Journey 7: narrow overview width keeps a long provider/id ref's model
	// name visible instead of losing it to right-truncation.
	// ---------------------------------------------------------------------
	const longModels = [
		{ provider: "some-very-long-provider-name", id: "claude-opus-4-6", reasoning: true },
		{ provider: "anthropic", id: "claude-haiku-4-5", reasoning: true },
	];
	const NARROW_WIDTH = 64;
	const makeNarrowCtx = (drive) => ({
		hasUI: true,
		mode: "tui",
		model: longModels[1],
		modelRegistry: {
			getAll: () => longModels,
			getAvailable: () => longModels,
			find: () => undefined,
			getRegisteredProviderIds: () => [],
		},
		ui: {
			notify: () => {},
			custom: (factory) => {
				let settle;
				const closed = new Promise((resolve) => { settle = resolve; });
				const component = factory(tui, theme, {}, (value) => settle(value));
				drive(component, (value) => settle(value));
				return closed;
			},
		},
	});

	await showMoaModelPicker(makeNarrowCtx((component, done) => {
		component.handleInput(ENTER); // MoA → overview
		const nav = overview(component);
		nav.move(ROW.P1);
		component.handleInput(ENTER);
		const footerLines = component.render(NARROW_WIDTH);
		const filterHintRow = footerLines.findIndex((line) => line.includes("type filters models"));
		const escapeHintRow = footerLines.findIndex((line) => line.includes("esc"));
		const backHintRow = footerLines.findIndex((line) => line.includes("back"));
		assert.ok(filterHintRow >= 0 && escapeHintRow > filterHintRow && backHintRow >= escapeHintRow, "narrow footer must retain filters and esc/back hints across wrapped rows");
		component.handleInput(ESCAPE);
		nav.assign(ROW.P1, "opus"); // long-provider model into Proposer 1

		const renderedLines = component.render(NARROW_WIDTH);
		const row = renderedLines.find((l) => l.includes("Proposer 1"));
		assert.ok(row, "expected a Proposer 1 row at narrow width");
		assert.match(row, /claude-opus-4-6/, "model-name tail must survive narrow-width truncation");
		assert.match(row, /\u00b7 thinking:/, "thinking suffix must survive narrow-width truncation");
		for (const line of renderedLines) {
			assert.ok(visibleWidth(line) <= NARROW_WIDTH, `rendered line exceeds ${NARROW_WIDTH} columns: ${visibleWidth(line)}`);
		}
		done(undefined);
	}), "medium");

	console.log("MoA model picker confirmation tests passed.");
} finally {
	process.stdout.rows = previousStdoutRows;
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(tempRoot, { recursive: true, force: true });
}
