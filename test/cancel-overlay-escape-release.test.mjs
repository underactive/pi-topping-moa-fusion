import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui";

// Regression: ESC closed the cancel overlay and it reopened on the same keypress.
// pi-tui runs extension terminal-input listeners BEFORE it filters key releases
// for the focused component, so under the Kitty keyboard protocol the ESC release
// reaches our listener a tick after the press already closed the overlay and its
// `.finally` cleared `overlayOpen` — so the listener reopened it immediately.

const ESC_PRESSES = ["\u001b", "\u001b[27u", "\u001b[27;1u"];
const ESC_RELEASES = ["\u001b[27;1:3u", "\u001b[27:3u"];

for (const data of [...ESC_PRESSES, ...ESC_RELEASES]) {
	assert.equal(matchesKey(data, Key.escape), true, `${JSON.stringify(data)} must read as ESC`);
}
for (const data of ESC_PRESSES) {
	assert.equal(isKeyRelease(data), false, `${JSON.stringify(data)} must still open the overlay`);
}
for (const data of ESC_RELEASES) {
	assert.equal(isKeyRelease(data), true, `${JSON.stringify(data)} must be ignored by the ESC listener`);
}

const indexSource = readFileSync(path.join(path.resolve(import.meta.dirname, ".."), "src", "planning", "tools", "enterPlanMode.ts"), "utf8");
assert.match(indexSource, /import \{[^}]*\bisKeyRelease\b[^}]*\} from "@earendil-works\/pi-tui";/);
assert.match(
	indexSource,
	/onTerminalInput\(\(data\) => \{(?:\s*\/\/[^\n]*\n)*\s*if \(isKeyRelease\(data\) \|\| !matchesKey\(data, Key\.escape\)\) return undefined;/,
	"the ESC listener must reject key releases before it can reopen the cancel overlay",
);

console.log("Cancel overlay ESC-release tests passed.");
