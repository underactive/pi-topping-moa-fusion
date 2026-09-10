import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// TwoPaneModelThinking uses TS constructor parameter-property syntax, which
// Node's strip-only type-stripping can't parse, so this asserts against
// source text (same pattern as model-picker-registry-visibility.test.mjs)
// rather than importing the module.
const root = path.resolve(import.meta.dirname, "..");
const picker = readFileSync(path.join(root, "src/ui/twoPaneModelThinking.ts"), "utf8");

const handleInputMatch = picker.match(
	/handleInput\(data: string\): "confirm" \| "back" \| undefined \{([\s\S]*?)\n\t\}/,
);
assert.ok(handleInputMatch, "TwoPaneModelThinking.handleInput must still be present");
const body = handleInputMatch[1];

const tabBranchMatch = body.match(/if \(matchesKey\(data, Key\.tab\)\) \{([\s\S]*?)\n\t\t\}/);
assert.ok(tabBranchMatch, "Tab branch must still be present");

// Tab must cycle through all three focus zones in order: model -> level -> buttons -> model.
assert.match(
	tabBranchMatch[1],
	/this\.activePane = this\.activePane === "model" \? "level" : this\.activePane === "level" \? "buttons" : "model";/,
);

// Left/right must still switch between Models and Thinking outside the action bar.
assert.match(body, /this\.activePane = this\.activePane === "model" \? "level" : "model";/);

// Left/right must still switch between the two action buttons when the action bar is focused.
assert.match(body, /this\.activeButton = this\.activeButton === 0 \? 1 : 0;/);

// rebuildModelList must wire the smart-truncation layout into the SelectList
// so long provider/id refs don't lose their model name to right-truncation.
assert.match(picker, /import \{ MODEL_LIST_LAYOUT \} from "\.\/modelLabel\.ts";/);
const rebuildMatch = picker.match(/private rebuildModelList\(\): SelectItem\[\] \{([\s\S]*?)\n\t\}/);
assert.ok(rebuildMatch, "rebuildModelList must still be present");
assert.match(rebuildMatch[1], /new SelectList\(\s*items,[\s\S]*?MODEL_LIST_LAYOUT,\s*\)/);

const modelLabelPath = path.join(root, "src/ui/modelLabel.ts");
const modelLabel = readFileSync(modelLabelPath, "utf8");
assert.match(modelLabel, /export function smartTruncateModelLabel\(/);

// The picker owns its asymmetric geometry: thinking gets only its content
// minimum while model labels retain the remaining width.
assert.match(picker, /function modelThinkingPaneWidths\(bodyWidth: number\)/);
assert.match(picker, /THINKING_LEVELS\.reduce/);
assert.match(picker, /visibleWidth\(`→ \$\{longestLevel\}`\) \+ 3/);
assert.match(picker, /modelThinkingPaneWidths\(bodyWidth\)/);

// Every pane row reserves a one-column inset before truncating to pane width.
assert.match(picker, /this\.modelList\.render\(Math\.max\(1, leftWidth - 1\)\)/);
assert.match(picker, /this\.levelList\.render\(Math\.max\(1, rightWidth - 1\)\)/);
assert.match(picker, /withPointer\(modelLine/);
assert.match(picker, /withPointer\(levelLine/);
assert.match(picker, /` filter: \$\{this\.filter\}`/);

// Selected rows retain base-theme foreground styling; render applies the
// background only to the active pane's already-padded cell.
assert.doesNotMatch(picker, /buildSelectListTheme/);
assert.doesNotMatch(picker, /new SelectList\([^)]*,\s*[^,)]*theme[^,)]*\)/);
assert.match(picker, /new SelectList\(\[\], 1, getSelectListTheme\(\)\)/);
assert.match(picker, /this\.activePane === "model" && modelLine\.includes\("→"\)/);
assert.match(picker, /this\.activePane === "level" && levelLine\.includes\("→"\)/);
assert.match(picker, /this\.theme\.bg\("selectedBg", leftCell\)/);
assert.match(picker, /this\.theme\.bg\("selectedBg", rightCell\)/);
assert.match(picker, /\{ wrapHints: true \}/);

console.log("Two-pane model picker Tab-cycle tests passed.");
