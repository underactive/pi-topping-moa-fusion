import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const { buildPanelDependenceNote, proposerDiversityWarning, duplicateModelSlotCount } = await import(
	"../src/moa/panelDependence.ts"
);
const { modelRefLabel, shortModelName } = await import("../src/shared/modelRefs.ts");

const ref = (provider, id) => ({ provider, id });
const fed = (entries) => entries.map(([originalIndex, provider, id]) => ({ originalIndex, ref: ref(provider, id) }));

// ── buildPanelDependenceNote ────────────────────────────────────────────────
{
	const note = buildPanelDependenceNote(fed([[0, "anthropic", "claude-opus-4-6"]]));
	assert.match(note, /^Panel dependence: 1 proposal from 1 distinct model across 1 provider\./);
	assert.ok(!note.includes("share one model"), "single proposal has no cluster sentence");
	assert.ok(note.includes("same prompt template"), "shared-prompt caveat present");
}

{
	const note = buildPanelDependenceNote(fed([
		[0, "anthropic", "claude-opus-4-6"],
		[1, "openai", "gpt-5"],
		[2, "google", "gemini-2.5-pro"],
	]));
	assert.match(note, /3 proposals from 3 distinct models across 3 providers/);
	assert.ok(!note.includes("share one model"), "all-distinct roster has no cluster sentence");
}

{
	const note = buildPanelDependenceNote(fed([
		[0, "anthropic", "claude-opus-4-6"],
		[1, "openai", "gpt-5"],
		[2, "anthropic", "claude-opus-4-6"],
	]));
	assert.match(note, /3 proposals from 2 distinct models/);
	assert.match(note, /Proposers 1 and 3 share one model/);
}

{
	const note = buildPanelDependenceNote(fed([
		[0, "anthropic", "claude-opus-4-6"],
		[1, "anthropic", "claude-opus-4-6"],
		[2, "anthropic", "claude-opus-4-6"],
	]));
	assert.match(note, /Proposers 1, 2, and 3 share one model/);
}

{
	const note = buildPanelDependenceNote(fed([
		[0, "anthropic", "claude-opus-4-6"],
		[1, "anthropic", "claude-opus-4-6"],
		[2, "openai", "gpt-5"],
		[3, "openai", "gpt-5"],
	]));
	assert.match(note, /Proposers 1 and 2 share one model/);
	assert.match(note, /Proposers 3 and 4 share one model/);
}

{
	const note = buildPanelDependenceNote(fed([
		[0, "anthropic", "claude-opus-4-6"],
		[1, "openrouter", "claude-opus-4-6"],
	]));
	assert.match(note, /2 proposals from 2 distinct models/);
	assert.ok(!note.includes("share one model"), "same id under two providers is not a cluster");
}

{
	const note = buildPanelDependenceNote(fed([
		[0, "anthropic", "claude-opus-4-6"],
		[1, "anthropic", "claude-opus-4-5"],
	]));
	assert.match(note, /2 proposals from 2 distinct models/);
	assert.ok(!note.includes("share one model"), "same family different ids is not a cluster");
	assert.ok(!note.includes("opus"), "family name never appears in the note");
}

{
	const note = buildPanelDependenceNote(fed([
		[0, "anthropic", "claude-opus-4-6"],
		[2, "anthropic", "claude-opus-4-6"],
	]));
	assert.match(note, /Proposers 1 and 3 share one model/, "noncontiguous originalIndex labels by slot number");
}

// ── blinding assertion ──────────────────────────────────────────────────────
{
	const roster = fed([
		[0, "anthropic", "claude-opus-4-6"],
		[1, "anthropic", "claude-opus-4-6"],
		[2, "openai", "gpt-5"],
		[3, "google", "gemini-2.5-pro"],
	]);
	const note = buildPanelDependenceNote(roster).toLowerCase();
	for (const { ref: entryRef } of roster) {
		assert.ok(!note.includes(entryRef.provider.toLowerCase()), "provider must not leak");
		assert.ok(!note.includes(entryRef.id.toLowerCase()), "id must not leak");
		assert.ok(!note.includes(modelRefLabel(entryRef).toLowerCase()), "modelRefLabel must not leak");
		assert.ok(!note.includes(shortModelName(entryRef).toLowerCase()), "shortModelName must not leak");
	}
	assert.doesNotMatch(note, /share (one|a) provider|same provider/i, "no provider-level cluster phrasing");
}

// ── proposerDiversityWarning ────────────────────────────────────────────────
assert.equal(
	proposerDiversityWarning([
		ref("anthropic", "claude-opus-4-6"),
		ref("anthropic", "claude-opus-4-6"),
		ref("openai", "gpt-5"),
		ref("openai", "gpt-5"),
	]),
	"4 proposer slots share a model; agreement between them is not independent evidence.",
);

assert.equal(
	proposerDiversityWarning([
		ref("anthropic", "claude-opus-4-6"),
		ref("anthropic", "claude-opus-4-6"),
		ref("openai", "gpt-5"),
	]),
	"2 proposer slots share a model; agreement between them is not independent evidence.",
);

assert.equal(
	proposerDiversityWarning([
		ref("anthropic", "claude-opus-4-6"),
		ref("anthropic", "claude-haiku-4-5"),
	]),
	"All 2 proposer slots share one provider; agreement between them is not independent evidence.",
);

assert.equal(
	proposerDiversityWarning([
		ref("anthropic", "claude-opus-4-6"),
		ref("openai", "gpt-5"),
	]),
	undefined,
);

assert.equal(proposerDiversityWarning([ref("anthropic", "claude-opus-4-6")]), undefined);

// ── duplicateModelSlotCount ─────────────────────────────────────────────────
assert.equal(
	duplicateModelSlotCount([
		ref("anthropic", "claude-opus-4-6"),
		ref("anthropic", "claude-haiku-4-5"),
		ref("anthropic", "claude-opus-4-6"),
	], ref("anthropic", "claude-opus-4-6")),
	2,
);

// ── source contracts ────────────────────────────────────────────────────────
const root = path.resolve(import.meta.dirname, "..");
const synthesis = readFileSync(path.join(root, "src/moa/synthesis.ts"), "utf8");
const picker = readFileSync(path.join(root, "src/ui/moaModelPicker.ts"), "utf8");
const fanout = readFileSync(path.join(root, "src/moa/fanout.ts"), "utf8");
const synthesizerAgent = readFileSync(path.join(root, "agents/moa-synthesizer.md"), "utf8");

assert.match(synthesis, /\$\{dependenceNote\}\\n\\nIndependent proposer plans:/);
assert.match(synthesis, /Original user request:/);
assert.match(
	synthesis,
	/\$\{buildVerdictContract\(fedLabels\)\}\\n\\n---\\n\\n\$\{buildContextSubsectionsContract\(\)\}\\n\\n---\\n\\n\$\{buildConflictContract\(fedLabels\)\}/,
);
assert.match(picker, /from "\.\.\/moa\/panelDependence\.ts"/);
assert.match(fanout, /from "\.\/panelDependence\.ts"/);
assert.ok(synthesizerAgent.includes("Panel dependence"));
assert.ok(synthesizerAgent.includes("evidence-backed"));
assert.ok(synthesizerAgent.includes("asserted"));
assert.ok(synthesizerAgent.includes("backed by K of N proposals (M distinct models)"));

console.log("synthesis-input tests passed");
