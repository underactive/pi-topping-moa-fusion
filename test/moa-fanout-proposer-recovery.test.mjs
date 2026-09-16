import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const fanout = readFileSync(path.join(root, "src/moa/fanout.ts"), "utf8");

// The recovery pass must sit after the cancel-all check and before the
// planless-retry pass, so a replacement that returns no plan inherits the
// existing retry for free rather than needing a parallel path.
const cancelAllAt = fanout.indexOf('return { status: "cancelled", observe, previousObserveSession };');
const cancelledSlotsAt = fanout.indexOf("const cancelledSlots = results.flatMap");
const retryIndicesAt = fanout.indexOf("const retryIndices: number[] = [];");
assert.ok(cancelAllAt > 0, "the run-wide cancel-all check exists");
assert.ok(cancelledSlotsAt > cancelAllAt, "the recovery pass starts after the cancel-all check");
assert.ok(retryIndicesAt > cancelledSlotsAt, "the recovery pass ends before the planless-retry pass begins");

// Exactly two options, worded as approved — no third "Retry" row.
assert.match(
	fanout,
	/ctx\.ui\.select\(\s*`Proposer \$\{index \+ 1\} \(\$\{label\}\) was cancelled — what next\?`,\s*\["Select a different model", "Continue without this proposer"\],\s*\)/,
	"the prompt offers exactly the two approved option strings",
);
assert.ok(!fanout.includes('"Retry"'), "no separate Retry option is offered");

// The whole pass is skipped headless, preserving today's silent behavior.
assert.match(
	fanout,
	/if \(cancelledSlots\.length > 0 && ctx\.hasUI\) \{/,
	"the pass is skipped entirely when the run is headless",
);

// The picker defaults to the slot's current model/thinking, so re-picking the
// same model is how a user retries without a separate option.
assert.match(
	fanout,
	/showModelThinkingPicker\(\s*ctx,\s*host\.currentThinkingLevel\(\),\s*`Replacement for Proposer \$\{index \+ 1\}`,\s*proposers\[index\],\s*proposerThinking\[index\],\s*\)/,
	"the picker is shown with the slot's current ref and thinking as defaults",
);
assert.match(fanout, /if \(!picked\) continue;/, "a cancelled picker re-asks rather than dropping the slot");

// The shared proposers/proposerThinking arrays are mutated in place so the
// widget band, cost resolution, synthesis, and persisted state all update
// from one write, then persisted.
const proposersWriteAt = fanout.indexOf("proposers[index] = picked.ref;");
const thinkingWriteAt = fanout.indexOf("proposerThinking[index] = picked.thinking;");
const persistAt = fanout.indexOf("host.persistState();");
assert.ok(proposersWriteAt > 0, "the slot's proposer ref is mutated in place");
assert.ok(thinkingWriteAt > proposersWriteAt, "the slot's thinking level is mutated in place next");
assert.ok(persistAt > thinkingWriteAt, "host.persistState() follows the in-place mutation");

// Replacement-time diversity warning fires after persistState and is gated on
// duplicateModelSlotCount so the user sees it only when the pick joins a cluster.
assert.match(
	fanout,
	/host\.persistState\(\);\s*if \(duplicateModelSlotCount\(proposers, picked\.ref\) >= 2\) \{/,
	"the diversity warning follows persistState and gates on duplicateModelSlotCount",
);
assert.match(fanout, /proposerDiversityWarning\(proposers\)/, "the warning uses the shared roster-wide message");

// The observe row's identity is rewritten, not just its messages, so F3 shows
// the replacement and not the cancelled agent's corpse.
assert.match(
	fanout,
	/observed\.label = picked\.ref\.id;\s*observed\.model = picked\.ref\.id;\s*observed\.task = proposerTask;/,
	"the observe row's label/model/task are rewritten onto the replacement",
);

// The replacement reruns through a fresh CancelRun, the same proposer task,
// and the slot's model extension options.
assert.match(fanout, /const replaceRun = new CancelRun\(\);/, "the replacement gets its own CancelRun");
assert.match(
	fanout,
	/const \[replacement\] = await runFanout\(\s*\[\s*\{\s*agent: "moa-proposer",\s*task: proposerTask,\s*model: modelRefLabel\(picked\.ref\),\s*thinking: picked\.thinking,\s*\.\.\.modelExtensionOptions\(ctx, picked\.ref\),\s*signal: replaceRun\.add\(modelRefLabel\(picked\.ref\)\)\.signal,\s*\},\s*\],\s*\(\) => index,\s*replaceRun,\s*\);/,
	"the replacement reruns the fresh proposer task pinned to its slot via a fresh CancelRun",
);
assert.match(fanout, /results\[index\] = replacement;/, "the replacement result is written back to its original slot index");

// Cancel ALL during a replacement ends the whole run, reusing the existing exit.
const cancelAllExits = [...fanout.matchAll(/return \{ status: "cancelled", observe, previousObserveSession \};/g)];
assert.ok(cancelAllExits.length >= 2, "cancel-all during a replacement reuses the run's cancelled exit");
assert.match(
	fanout,
	/if \(replaceRun\.cancelAllRequested\) \{\s*widget\.stopWidget\(\);\s*ctx\.ui\.notify\("MoA run cancelled\."\);\s*return \{ status: "cancelled", observe, previousObserveSession \};\s*\}/,
	"cancel-all during a replacement stops the widget, notifies, and ends the run",
);

// A cancelled or planless replacement re-asks the same two options rather
// than silently breaking out of the loop.
assert.match(
	fanout,
	/if \(replacement\.cancelled \|\| isFailedResult\(replacement\)\) \{[\s\S]*?continue;\s*\}/,
	"a cancelled or failed replacement continues the loop instead of breaking",
);

// The table, stopped before the first prompt, is remounted once after every
// cancelled slot is resolved — covering the drop-then-sibling-retry hole.
const resumeTableAt = fanout.indexOf("widget.resumeTable();");
assert.ok(resumeTableAt > cancelledSlotsAt && resumeTableAt < retryIndicesAt, "widget.resumeTable() runs once after the per-slot loop, before the planless-retry pass");

console.log("MoA fan-out proposer recovery pass contract passed.");
