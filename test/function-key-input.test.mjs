import assert from "node:assert/strict";

import { isKeyRelease, isKeyRepeat, Key } from "@earendil-works/pi-tui";
import { matchesFunctionKeyPress } from "../src/shared/functionKeys.ts";

const sequences = [
	["\x1bOQ", Key.f2, true],
	["\x1b[12~", Key.f2, true],
	["\x1b[[B", Key.f2, true],
	["\x1b[1Q", Key.f2, true],
	["\x1b[1;1Q", Key.f2, true],
	["\x1b[1;1:3Q", Key.f2, false],
	["\x1b[1;1:2Q", Key.f2, false],
	["\x1b[1;2Q", Key.f2, false],
	["\x1b[12;1:3~", Key.f2, false],
	["\x1b[27;1:3u", Key.f2, false],
	["\x1b[A", Key.f2, false],
	["\x1b[[A", Key.f2, false],
	["a", Key.f2, false],
	["\x1b[1Q", Key.f1, false],
];

for (const [data, key, expected] of sequences) {
	assert.equal(matchesFunctionKeyPress(data, key), expected, `${JSON.stringify(data)} must match ${key} as ${expected}`);
}

assert.equal(isKeyRelease("\x1b[1;1:3Q"), false, "Kitty F2 release alias needs the explicit suffix guard");
assert.equal(isKeyRepeat("\x1b[1;1:2Q"), false, "Kitty F2 repeat alias needs the explicit suffix guard");
assert.equal(isKeyRelease("\x1b[12;1:3~"), true, "legacy F2 release must be rejected");
assert.equal(isKeyRelease("\x1b[27;1:3u"), true, "Kitty release must be rejected");

console.log("Function-key input tests passed.");
