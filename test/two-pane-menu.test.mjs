import assert from "node:assert/strict";
import { TwoPaneMenuComponent } from "../src/ui/menu.ts";

const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };
const tui = { requestRender() {} };
let changed;
let applied = 0;
let cancelled = 0;
const menu = new TwoPaneMenuComponent({
	title: "WORKING DECORATOR: SETTINGS",
	categories: [
		{ id: "general", label: "General", options: [{ id: "glyph", label: "Glyph set", valueIndex: 0, values: ["Unicode", "ASCII"] }] },
		{ id: "rendering", label: "Rendering", options: [{ id: "depth", label: "Color depth", valueIndex: 0, values: ["256", "truecolor"], onChange: (_index, value) => { changed = value; } }] },
	],
	buttons: [{ id: "save", label: "Save and Close", primary: true, onSelect: () => { applied++; } }, { id: "cancel", label: "Cancel", onSelect: () => { cancelled++; } }],
}, theme, () => { cancelled++; }, tui);

let output = menu.render(72).join("\n");
assert.match(output, /Categories/);
assert.match(output, /General/);
assert.match(output, /Glyph set/);
assert.match(output, /\[ General · 1 opts \]/);
menu.handleInput("\u001b[B");
output = menu.render(72).join("\n");
assert.match(output, /Rendering/);
assert.match(output, /Color depth/);
menu.handleInput("\t");
menu.handleInput("\u001b[C");
assert.equal(changed, "truecolor");
menu.handleInput("\t");
menu.handleInput("\r");
assert.equal(applied, 1);
menu.handleInput("\u001b");
assert.equal(cancelled, 1);
menu.dispose();

console.log("Two-pane menu component tests passed.");
