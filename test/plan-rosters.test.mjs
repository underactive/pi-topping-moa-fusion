import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// MAX_PROPOSERS lives in moaModelPicker.ts, which uses TypeScript parameter
// properties — run under the TS transform.
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

const {
	MAX_ROSTER_COUNT,
	MAX_ROSTER_NAME_LENGTH,
	MAX_ROSTER_PROPOSERS,
	isRosterSlot,
	parseRosters,
	rosterNameError,
	rosterReadinessError,
	rosterSummary,
} = await import("../src/config/rosters.ts");
const { MAX_PROPOSERS } = await import("../src/ui/moaModelPicker.ts");
const { modelRefLabel } = await import("../src/shared/modelRefs.ts");

const ref = (id) => ({ provider: "test", id });
const slot = (id, thinking = "medium") => ({ ref: ref(id), thinking });
const completeRoster = (name) => ({
	name,
	proposers: [slot("p1"), slot("p2")],
	synthesizer: slot("s"),
	implementer: slot("i"),
	verifier: slot("v"),
});

// ── Constants ────────────────────────────────────────────────────────────
// The roster proposer cap and the picker's slot count must agree, or a loaded
// roster could overflow (or underuse) the overview's proposer rows.
assert.equal(MAX_ROSTER_PROPOSERS, MAX_PROPOSERS);
assert.equal(MAX_ROSTER_NAME_LENGTH, 24);
assert.equal(MAX_ROSTER_COUNT, 20);

// ── isRosterSlot ─────────────────────────────────────────────────────────
assert.equal(isRosterSlot(slot("p1")), true);
assert.equal(isRosterSlot({ ref: ref("p1"), thinking: "turbo" }), false);
assert.equal(isRosterSlot({ ref: "p1", thinking: "medium" }), false);
assert.equal(isRosterSlot({ ref: ref("p1") }), false);
assert.equal(isRosterSlot(undefined), false);

// ── parseRosters ─────────────────────────────────────────────────────────
assert.deepEqual(parseRosters(undefined), []);
assert.deepEqual(parseRosters("nope"), []);
assert.deepEqual(parseRosters([null, 3, "x"]), []);

// Bad names (non-alphanumeric, too long, blank after trim) are dropped.
assert.deepEqual(
	parseRosters([
		{ ...completeRoster("bad-name") },
		{ ...completeRoster("a".repeat(25)) },
		{ ...completeRoster("   ") },
	]),
	[],
);

// Case-insensitive duplicate names keep only the first.
const dupes = parseRosters([completeRoster("Team1"), completeRoster("tEAM1")]);
assert.equal(dupes.length, 1);
assert.equal(dupes[0].name, "Team1");

// More rosters than the cap keeps the first MAX_ROSTER_COUNT.
const many = parseRosters(Array.from({ length: MAX_ROSTER_COUNT + 5 }, (_v, i) => completeRoster(`r${i}`)));
assert.equal(many.length, MAX_ROSTER_COUNT);

// Fewer than 2 proposers, or a missing required role, drops the roster.
assert.deepEqual(
	parseRosters([{ ...completeRoster("solo"), proposers: [slot("p1")] }]),
	[],
);
assert.deepEqual(parseRosters([{ ...completeRoster("nosynth"), synthesizer: undefined }]), []);
assert.deepEqual(parseRosters([{ ...completeRoster("noimpl"), implementer: undefined }]), []);
assert.deepEqual(parseRosters([{ ...completeRoster("noverif"), verifier: undefined }]), []);
// Invalid slots are dropped silently; a roster falling below 2 proposers then fails too.
assert.deepEqual(
	parseRosters([{ ...completeRoster("mixed"), proposers: [{ ref: ref("p1"), thinking: "turbo" }, slot("p2")] }]),
	[],
);
assert.deepEqual(
	parseRosters([{ ...completeRoster("mixed"), proposers: [{ ref: ref("p1"), thinking: "turbo" }, slot("p2"), slot("p3")] }]).length,
	1,
);

// More than 5 proposers is truncated.
const six = parseRosters([{ ...completeRoster("six"), proposers: [slot("p1"), slot("p2"), slot("p3"), slot("p4"), slot("p5"), slot("p6")] }]);
assert.equal(six[0].proposers.length, 5);
assert.deepEqual(six[0].proposers[4], slot("p5"));

// Names are trimmed before validation.
const trimmed = parseRosters([{ ...completeRoster("  spaced  ") }]);
assert.equal(trimmed[0].name, "spaced");

// Unavailable providers never erase a definition — no registry consultation.
const unknownProvider = parseRosters([completeRoster("ghost")]);
assert.equal(unknownProvider[0].proposers[0].ref.provider, "test");

// ── rosterNameError ──────────────────────────────────────────────────────
const existing = [{ name: "Core5" }];
assert.match(rosterNameError("bad-name", existing) ?? "", /alphanumeric/);
assert.match(rosterNameError("a".repeat(25), existing) ?? "", /alphanumeric/);
assert.match(rosterNameError("core5", existing) ?? "", /already exists/);
assert.equal(rosterNameError("core5", existing, 0), undefined, "the roster's own index never collides");
assert.equal(rosterNameError("NewTeam", existing), undefined);

// ── rosterSummary ────────────────────────────────────────────────────────
const summary = rosterSummary({
	name: "t",
	proposers: [slot("claude-opus-4-6"), slot("claude-haiku-4-5")],
	synthesizer: slot("claude-opus-4-6"),
	implementer: slot("claude-opus-4-6"),
	verifier: slot("claude-haiku-4-5"),
});
assert.match(summary, /P: opus, haiku · S: opus · I: opus · V: haiku/);

// ── rosterReadinessError ─────────────────────────────────────────────────
assert.equal(rosterReadinessError(completeRoster("ok")), undefined);
const empty = { name: "draft", proposers: Array.from({ length: 5 }, () => undefined) };
const emptyError = rosterReadinessError(empty) ?? "";
assert.match(emptyError, /2 proposers/);
assert.match(emptyError, /synthesizer/);
assert.match(emptyError, /implementer/);
assert.match(emptyError, /verifier/);
const oneProposer = { ...empty, proposers: [slot("p1"), undefined, undefined, undefined, undefined], synthesizer: slot("s") };
assert.match(rosterReadinessError(oneProposer) ?? "", /1 more proposer/);
assert.match(rosterReadinessError(oneProposer) ?? "", /implementer/);
const twoProposers = { ...oneProposer, proposers: [slot("p1"), slot("p2")] };
assert.match(rosterReadinessError(twoProposers) ?? "", /implementer and a verifier/);

// modelRefLabel sanity for the roster slot shape used above.
assert.equal(modelRefLabel(ref("p1")), "test/p1");

console.log("Plan roster validation tests passed.");
