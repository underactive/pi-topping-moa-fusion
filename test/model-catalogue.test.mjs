import assert from "node:assert/strict";

const { getModelCatalogue } = await import("../src/config/modelCatalogue.ts");

const ref = (provider, id) => ({ provider, id });

// Mirrors the shapes pi's registry hands back: `reasoning` gates thinking at
// all, and `thinkingLevelMap` decides whether the extended levels exist.
const opus = { provider: "anthropic", id: "claude-opus-4-6", reasoning: true };
const deep = {
	provider: "openai",
	id: "o5",
	reasoning: true,
	thinkingLevelMap: { minimal: null, xhigh: "xhigh", max: "max" },
};
const plain = { provider: "local", id: "tinyllama" };

const makeRegistry = (available) => {
	const calls = { available: 0 };
	return { calls, getAvailable: () => { calls.available++; return available; } };
};

const registry = makeRegistry([deep, plain, opus]);
const catalogue = getModelCatalogue(registry);

// ── Selectable models, sorted, straight from getAvailable() ──────────
assert.deepEqual(
	catalogue.availableRefs(),
	[ref("anthropic", "claude-opus-4-6"), ref("local", "tinyllama"), ref("openai", "o5")],
	"available refs must be the getAvailable() set, sorted by provider/id",
);

// ── Thinking levels come from the registry, in pi's canonical order ──
assert.deepEqual(
	catalogue.thinkingLevelsFor(ref("anthropic", "claude-opus-4-6")),
	["off", "minimal", "low", "medium", "high"],
	"xhigh/max are absent unless the model maps them",
);
assert.deepEqual(
	catalogue.thinkingLevelsFor(ref("openai", "o5")),
	["off", "low", "medium", "high", "xhigh", "max"],
	"a null map entry removes a level; xhigh and max survive as separate levels",
);
assert.deepEqual(
	catalogue.thinkingLevelsFor(ref("local", "tinyllama")),
	["off"],
	"a non-reasoning model supports off only",
);
assert.deepEqual(
	catalogue.thinkingLevelsFor(ref("nope", "missing")),
	[],
	"a model pi does not offer has no levels to offer either",
);

// Callers must not be able to mutate the cached list.
catalogue.availableRefs().push(ref("bogus", "bogus"));
assert.equal(catalogue.availableRefs().length, 3);

// ── One build per registry object, for that object's lifetime ────────
assert.equal(registry.calls.available, 1);
getModelCatalogue(registry);
getModelCatalogue(registry);
assert.equal(registry.calls.available, 1, "the catalogue is built once per registry object");

const other = makeRegistry([plain]);
assert.notEqual(getModelCatalogue(other), catalogue);
assert.equal(other.calls.available, 1);

console.log("Model catalogue tests passed.");
