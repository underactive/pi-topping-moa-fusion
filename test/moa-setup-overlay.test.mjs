import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// MoaSetupComponent uses TypeScript parameter properties, which Node's
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
const TAB = "\t";
const ESCAPE = "\u001b";
const DOWN = "\u001b[B";
const SPACE = " ";

const tempRoot = mkdtempSync(path.join(tmpdir(), "moa-setup-overlay-test-"));
const agentDir = path.join(tempRoot, "agent");
const agentsDir = path.join(agentDir, "agents");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousStdoutRows = process.stdout.rows;

try {
	process.stdout.rows = 40;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(
		path.join(agentsDir, "moa-explore.md"),
		"---\nname: moa-explore\ndescription: recon\ntools: read\nmodel: claude-haiku-4-5\nthinking: off\n---\n\nBody.\n",
		"utf8",
	);
	writeFileSync(
		path.join(agentsDir, "mf-plan.md"),
		"---\nname: mf-plan\ndescription: planner\ntools: read\nmodel: claude-opus-4-6\n---\n\nBody.\n",
		"utf8",
	);

	const { showMoaSetup } = await import("../src/ui/moaSetupOverlay.ts");
	const { loadMoaConfig } = await import("../src/config/settings.ts");
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

	// The settings visit is staged: overview → roster list → reopened overview.
	// Each ctx.ui.custom call runs the next drive in the queue.
	const drive = (drives) => ({
		ui: {
			notify: () => {},
			custom: (factory) => {
				let settle;
				const closed = new Promise((resolve) => { settle = resolve; });
				const next = drives.shift();
				assert.ok(next, "unexpected extra overlay in the staged settings flow");
				const component = factory(tui, theme, {}, (value) => settle(value));
				next(component, settle);
				return closed;
			},
		},
	});

	// Journey 1: overview → explore slot round-trip → confirm → cheap/fast →
	// agent rosters (open the roster list, Back) → reopened overview keeps the
	// draft → toggle auto resolve → save.
	const renderedViews = [];
	const ctx = {
		hasUI: true,
		mode: "tui",
		model: models[1],
		modelRegistry: {
			getAll: () => models,
			getAvailable: () => models,
			find: () => undefined,
			getRegisteredProviderIds: () => [],
		},
		...drive([
			// Overlay 1: walk the slots, then open the rosters row.
			(component) => {
				const overview = component.render(WIDTH);
				renderedViews.push(overview.join("\n"));
				assertWithinWidth(overview);

				// Enter on the first row opens the explore agent's picker.
				component.handleInput(ENTER);
				const slot = component.render(WIDTH);
				renderedViews.push(slot.join("\n"));
				assertWithinWidth(slot);

				// Escape returns to the overview instead of cancelling the overlay.
				component.handleInput(ESCAPE);
				assert.match(component.render(WIDTH).join("\n"), /─ planning subagents ─/);

				// Reopen and confirm the highlighted model + thinking level.
				component.handleInput(ENTER);
				component.handleInput(ENTER);
				renderedViews.push(component.render(WIDTH).join("\n"));

				// cheap/fast agent: confirm the highlighted (active) model.
				component.handleInput(DOWN);
				component.handleInput(ENTER);
				component.handleInput(ENTER);

				// agent rosters row → hands off to the roster manager.
				component.handleInput(DOWN);
				component.handleInput(ENTER);
			},
			// Overlay 2: the roster manager's staged list; Back with no edits.
			(component) => {
				const rosterList = component.render(WIDTH);
				renderedViews.push(rosterList.join("\n"));
				assertWithinWidth(rosterList);
				assert.match(rosterList.join("\n"), /MoA Fusion: Agent rosters/);
				assert.match(rosterList.join("\n"), /Create roster/);
				component.handleInput(ESCAPE); // Back
			},
			// Overlay 3: the settings overview reopens with the draft intact;
			// toggle auto resolve, then save.
			(component, settle) => {
				const reopened = component.render(WIDTH).join("\n");
				renderedViews.push(reopened);
				assert.match(reopened, /─ planning subagents ─/, "the settings overlay must reopen after the roster manager");

				component.handleInput(DOWN);
				component.handleInput(DOWN);
				component.handleInput(DOWN); // cursor → auto resolve conflicts
				component.handleInput(SPACE); // toggle ON

				component.handleInput(TAB); // focus the button row (Save is primary)
				component.handleInput(ENTER);
				settle(undefined);
			},
		]),
	};

	const saved = await showMoaSetup({ ...ctx, ui: { ...ctx.ui } }, "medium");
	assert.equal(saved, true);

	const [overview, slotView, afterConfirm, rosterList, reopened] = renderedViews;

	// Overview: the rosters section sits between model roles and options.
	assert.match(overview, /─ planning subagents ─/);
	assert.match(overview, /explore agent/);
	// mf-plan follows the session model at runtime, so it has no settings slot.
	assert.doesNotMatch(overview, /plan agent/);
	assert.match(overview, /─ model roles ─/);
	assert.match(overview, /cheap\/fast agent/);
	assert.match(overview, /─ rosters ─/);
	assert.match(overview, /agent rosters\s+0 configured/);
	assert.match(overview, /─ options ─/);
	assert.ok(
		overview.indexOf("─ planning subagents ─") < overview.indexOf("─ model roles ─")
			&& overview.indexOf("─ model roles ─") < overview.indexOf("─ rosters ─")
			&& overview.indexOf("─ rosters ─") < overview.indexOf("─ options ─"),
		"sections must render in order: planning subagents, model roles, rosters, options",
	);
	// Per-role MoA slots are gone — rosters replaced them.
	assert.doesNotMatch(overview, /proposing agent/);
	assert.doesNotMatch(overview, /synthesizing agent/);
	assert.doesNotMatch(overview, /implementing agent/);
	assert.doesNotMatch(overview, /verifying agent/);
	// A bare frontmatter id resolves to the fully-qualified registry model.
	assert.match(overview, /anthropic\/claude-haiku-4-5 \(thinking: off\)/);

	// Slot view: title plus the guidance on what kind of model belongs here.
	assert.match(slotView, /Explore agent — fast codebase recon/);
	// Wrapped across rows, so assert on fragments rather than the whole sentence.
	assert.match(slotView, /Runs high-volume file reads and greps/);
	assert.match(slotView, /not deep reasoning/);
	assert.match(slotView, /Models/);
	assert.match(slotView, /Thinking/);
	assert.match(afterConfirm, /─ planning subagents ─/, "confirming a slot returns to the overview");

	// Roster list: staged, empty, with the create action and Back button.
	assert.match(rosterList, /Create roster/);
	assert.match(rosterList, /Back/);

	// After save, only the cheap/fast role key is written; the per-role fan-out
	// keys are left untouched (they stay load-bearing for resume and fallbacks).
	const savedRoles = loadMoaConfig();
	assert.deepEqual(savedRoles.cheap, { provider: "anthropic", id: "claude-opus-4-6" });
	assert.equal(savedRoles.synthesizer, undefined);
	assert.equal(savedRoles.implementer, undefined);
	assert.equal(savedRoles.verifier, undefined);
	assert.deepEqual(savedRoles.proposers, []);
	assert.deepEqual(savedRoles.rosters, []);
	assert.equal(savedRoles.autoResolveConflicts, true, "the toggle made before the roster round trip must persist");

	const explore = readFileSync(path.join(agentsDir, "moa-explore.md"), "utf8");
	assert.match(explore, /^model: anthropic\/claude-haiku-4-5$/m);
	assert.match(explore, /^thinking: off$/m);
	assert.match(explore, /^description: recon$/m);
	assert.equal(explore.endsWith("---\n\nBody.\n"), true, "prompt body must survive the rewrite");

	// mf-plan is no longer a settings slot, so saving must not rewrite it.
	const plan = readFileSync(path.join(agentsDir, "mf-plan.md"), "utf8");
	assert.equal(plan, "---\nname: mf-plan\ndescription: planner\ntools: read\nmodel: claude-opus-4-6\n---\n\nBody.\n");

	// Saving clears the first-run gate.
	assert.equal(loadMoaConfig().agentDefaultsConfigured, true);

	// Cancelling reports failure, and the first-run title explains why the
	// overlay appeared in place of the plan prompt.
	let firstRunTitle = "";
	const cancelCtx = { ...ctx, ui: { ...ctx.ui, custom: (factory) => {
		const component = factory(tui, theme, {}, () => {});
		firstRunTitle = component.render(WIDTH)[0];
		component.handleInput(ESCAPE);
		return Promise.resolve(undefined);
	} } };
	assert.equal(await showMoaSetup(cancelCtx, "medium", { firstRun: true }), false);
	assert.match(firstRunTitle, /set up agents and rosters before planning/);

	// Short terminals keep the overview actions visible inside the 70% viewport.
	const previousRows = process.stdout.rows;
	try {
		process.stdout.rows = 16;
		let compactOverview = [];
		let compactSlot = [];
		const compactCtx = { ...ctx, ui: { ...ctx.ui, custom: (factory) => {
			let settle;
			const closed = new Promise((resolve) => { settle = resolve; });
			const component = factory(tui, theme, {}, (value) => settle(value));
			compactOverview = component.render(WIDTH);
			component.handleInput(ENTER);
			compactSlot = component.render(WIDTH);
			component.handleInput(ESCAPE);
			component.handleInput(ESCAPE);
			return closed;
		} } };
		assert.equal(await showMoaSetup(compactCtx, "medium"), false);
		assert.ok(compactOverview.length <= Math.floor(16 * 0.7));
		assert.match(compactOverview.join("\n"), /Save and Close/);
		assert.match(compactOverview.join("\n"), /Cancel/);
		assert.ok(compactSlot.length <= Math.floor(16 * 0.7));
		assert.match(compactSlot.join("\n"), /Select/);
		assert.match(compactSlot.join("\n"), /Cancel/);
	} finally {
		process.stdout.rows = previousRows;
	}

	// Non-interactive callers must decline rather than block.
	assert.equal(await showMoaSetup({ ...ctx, mode: "json" }, "medium"), false);
} finally {
	process.stdout.rows = previousStdoutRows;
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(tempRoot, { recursive: true, force: true });
}

console.log("MoA setup overlay tests passed.");
