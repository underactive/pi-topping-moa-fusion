import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// moaModelPicker.ts's classes use TS constructor parameter-property syntax,
// which Node's strip-only type-stripping can't parse, so this asserts
// against source text (same pattern as moa-authoritative-agents.test.mjs)
// rather than importing the module.
const root = path.resolve(import.meta.dirname, "..");
const picker = readFileSync(path.join(root, "src/ui/moaModelPicker.ts"), "utf8");
const catalogue = readFileSync(path.join(root, "src/config/modelCatalogue.ts"), "utf8");

// getAvailableModelRefs must surface every model pi reports as available —
// including ones registered by third-party provider-bridge extensions (e.g.
// claude-bridge) under an `api` value this extension has never heard of.
// Whether a model actually answers is decided when it runs, not by a locally
// maintained API allowlist here.
assert.doesNotMatch(picker, /isCallableApi/);
assert.doesNotMatch(picker, /modelApi\.ts/);

// Registry reads go through the catalogue, so the picker's model list and its
// thinking levels cannot come from two different views of the registry.
const getAvailableModelRefsBody = picker.match(
	/export function getAvailableModelRefs\(ctx: ExtensionContext\): ModelRef\[\] \{([\s\S]*?)\n\}/,
);
assert.ok(getAvailableModelRefsBody, "getAvailableModelRefs must still be exported");
assert.match(getAvailableModelRefsBody[1], /getModelCatalogue\(ctx\.modelRegistry\)\.availableRefs\(\)/);
assert.doesNotMatch(picker, /modelRegistry\s*\n?\s*\.get(All|Available)\(\)/);
assert.doesNotMatch(picker, /getSupportedThinkingLevels/);

// Selectability is getAvailable() and nothing else — no allowlist, and no
// intersection with another registry view that could hide a usable model.
assert.match(catalogue, /for \(const model of registry\.getAvailable\(\)\)/);
assert.doesNotMatch(catalogue, /getAll\(\)/);

console.log("Model picker registry-visibility tests passed.");
