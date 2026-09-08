import assert from "node:assert/strict";
import { MenuComponent, renderMenuFooterContents } from "../src/ui/menu.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

const theme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};
const tui = { requestRender() {} };

let toggleValue;
let actionCalls = 0;
let result;
const menu = new MenuComponent({
	title: "Test menu",
	sections: [{
		title: "settings",
		items: [
			{ id: "enabled", label: "enabled", value: false, onChange: (value) => { toggleValue = value; } },
			{ id: "role", label: "role", displayValue: "Not set", onSelect: () => { actionCalls++; } },
		],
	}],
}, theme, (value) => { result = value; }, tui);

assert.match(menu.render(60).join("\n"), /\[ 1\/2 \]/);
menu.handleInput(" ");
assert.equal(toggleValue, true);
menu.handleInput("\u001b[B");
menu.handleInput(" ");
assert.equal(toggleValue, true, "space must not activate an action row");
menu.handleInput("\r");
assert.equal(actionCalls, 1);
assert.equal(result, undefined, "an action row must not apply the standalone menu");
menu.setItemValue("role", "provider/very-long-model");
assert.match(menu.render(60).join("\n"), /provider\/very-long-model/);
menu.handleInput("\u001b");
assert.deepEqual(result, { applied: false, values: { enabled: false } });
menu.dispose();

let choiceValue;
let saved = 0;
let cancelled = 0;
const settingsMenu = new MenuComponent({
	title: "Settings",
	sections: [{
		title: "rendering",
		items: [
			{ id: "format", label: "auto format", value: false },
			{ id: "glyph", label: "Glyph set", values: ["ascii", "Unicode", "heavy"], valueIndex: 1, onChange: (_index, value) => { choiceValue = value; } },
		],
	}],
	buttons: [
		{ id: "save", label: "Save and Close", primary: true, onSelect: () => { saved++; } },
		{ id: "cancel", label: "Cancel", onSelect: () => { cancelled++; } },
	],
}, theme, () => { cancelled++; }, tui);

assert.match(settingsMenu.render(76).join("\n"), /‹Unicode›/);
settingsMenu.handleInput(" ");
assert.match(settingsMenu.render(76).join("\n"), /\[ 1 changed \]/);
settingsMenu.handleInput("\u001b[B");
settingsMenu.handleInput("\u001b[C");
assert.equal(choiceValue, "heavy");
settingsMenu.handleInput("\t");
settingsMenu.handleInput("\r");
assert.equal(saved, 1);
settingsMenu.handleInput("\u001b[C");
settingsMenu.handleInput("\r");
assert.equal(cancelled, 1);
settingsMenu.dispose();

const compactMenu = new MenuComponent({
	title: "Compact settings",
	sections: [{
		title: "many",
		items: Array.from({ length: 12 }, (_unused, index) => ({
			id: `item-${index + 1}`,
			label: `item ${index + 1}`,
			displayValue: "configured",
			onSelect: () => {},
		})),
	}],
	buttons: [
		{ id: "save", label: "Save and Close", primary: true, onSelect: () => {} },
		{ id: "cancel", label: "Cancel", onSelect: () => {} },
	],
}, theme, () => {}, tui);
compactMenu.setViewport(11);
let compactLines = compactMenu.render(76);
assert.ok(compactLines.length <= 11);
assert.match(compactLines.join("\n"), /Save and Close/);
assert.match(compactLines.join("\n"), /Cancel/);
compactMenu.handleInput("\u001b[6~");
compactLines = compactMenu.render(76);
assert.match(compactLines.join("\n"), /item 6/);
compactMenu.handleInput("\u001b[H");
compactLines = compactMenu.render(76);
assert.match(compactLines.join("\n"), /item 1/);
compactMenu.handleInput("\u001b[F");
compactLines = compactMenu.render(76);
assert.match(compactLines.join("\n"), /item 12/);
compactMenu.handleInput("\u001b[5~");
compactLines = compactMenu.render(76);
assert.match(compactLines.join("\n"), /item 7/);
compactMenu.handleInput("\u001b[6~");
compactLines = compactMenu.render(76);
assert.match(compactLines.join("\n"), /item 12/);
assert.ok(compactLines.length <= 11);
assert.match(compactLines.join("\n"), /Save and Close/);
compactMenu.dispose();

// Nested pickers splice these rows directly between borders, so every row
// returned by this helper must already be exactly the requested width.
const footerWidth = 30;
const footerRows = renderMenuFooterContents(
	theme,
	footerWidth,
	"[ A deliberately overlong action label ]",
	"type filters models • ↑↓ navigate pane • tab panes/buttons • ←→ switch/select • enter select • esc back",
);
assert.deepEqual(
	footerRows.map((row) => visibleWidth(row)),
	[footerWidth, footerWidth, footerWidth, footerWidth],
	"footer contents must be frame-safe even without renderMenuContentRow",
);

const wrappedFooterRows = renderMenuFooterContents(
	theme,
	footerWidth,
	"[ Select ]",
	"type filters models • ↑↓ navigate pane • tab panes/buttons • ←→ switch/select • enter select • esc back",
	{ wrapHints: true },
);
assert.ok(wrappedFooterRows.length > 4, "wrapped hints must produce multiple rows");
assert.ok(wrappedFooterRows.slice(3).every((row) => visibleWidth(row) === footerWidth), "every wrapped hint row must remain frame-safe");
const wrappedHints = wrappedFooterRows.slice(3).join("\n");
assert.match(wrappedHints, /type filters models/);
assert.match(wrappedHints, /esc back/);

// ── Item descriptions ──────────────────────────────────────────────────
let describedCalls = 0;
const describedMenu = new MenuComponent({
	title: "Described menu",
	sections: [{
		title: "rosters",
		items: [
			{ id: "a", label: "first", displayValue: "2 roles assigned", description: "wraps helper text across several rendered rows when the line budget is small enough to force it", onSelect: () => { describedCalls++; } },
			{ id: "b", label: "second", displayValue: "configured" },
		],
	}],
}, theme, () => {}, tui);
const describedLines = describedMenu.render(60).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
const firstIndex = describedLines.findIndex((line) => line.includes("first"));
const secondIndex = describedLines.findIndex((line) => line.includes("second"));
assert.ok(firstIndex >= 0 && secondIndex > firstIndex, "described item must render before its sibling");
assert.ok(
	describedLines.slice(firstIndex + 1, secondIndex).some((line) => line.includes("wraps helper text")),
	"the description must render under its item",
);
assert.ok(
	describedLines.slice(firstIndex + 1, secondIndex).some((line) => line.replace(/\s/g, "") === "║║"),
	"a blank row must separate described items within a section",
);
describedMenu.handleInput("\r");
assert.equal(describedCalls, 1);
describedMenu.dispose();

// ── initialItemId ──────────────────────────────────────────────────────
let initialPicked = "";
const initialMenu = new MenuComponent({
	title: "Initial focus",
	initialItemId: "target",
	sections: [{ title: "items", items: [
		{ id: "first", label: "first", onSelect: () => { initialPicked = "first"; } },
		{ id: "target", label: "target", onSelect: () => { initialPicked = "target"; } },
	] }],
}, theme, () => {}, tui);
initialMenu.handleInput("\r");
assert.equal(initialPicked, "target", "initialItemId must place the cursor on the matching item");
initialMenu.dispose();

// ── onItemKey ──────────────────────────────────────────────────────────
let interceptItem = "";
let interceptKey = "";
const interceptMenu = new MenuComponent({
	title: "Intercept",
	sections: [{ title: "items", items: [
		{ id: "slot", label: "slot", displayValue: "x", onSelect: () => {} },
	] }],
	onItemKey: (item, data) => {
		if (data !== "\x7f") return false;
		interceptItem = item.id;
		interceptKey = data;
		return true;
	},
}, theme, () => {}, tui);
interceptMenu.handleInput("\x7f");
assert.equal(interceptItem, "slot", "onItemKey must see the selected item");
assert.equal(interceptKey, "\x7f");
assert.match(interceptMenu.render(60).join("\n"), /\[ 1\/1 \]/, "an intercepted key must not move the cursor");
interceptMenu.handleInput("\u001b[B");
assert.match(interceptMenu.render(60).join("\n"), /\[ 1\/1 \]/, "unhandled keys fall through to navigation");
interceptMenu.dispose();

// ── maxItemsPerSection ─────────────────────────────────────────────────
const windowedMenu = new MenuComponent({
	title: "Windowed",
	maxItemsPerSection: 4,
	sections: [{ title: "many", items: Array.from({ length: 8 }, (_v, i) => ({
		id: `item-${i + 1}`,
		label: `item ${i + 1}`,
		onSelect: () => {},
	})) }],
}, theme, () => {}, tui);
const windowedLines = () => windowedMenu.render(76).join("\n");
assert.match(windowedLines(), /item 1/);
assert.match(windowedLines(), /↓ 4 more/);
assert.doesNotMatch(windowedLines(), /item 5/);
windowedMenu.handleInput("\u001b[B");
windowedMenu.handleInput("\u001b[B");
windowedMenu.handleInput("\u001b[B"); // cursor on item 4 — the window centres on it
assert.match(windowedLines(), /item 4/);
assert.match(windowedLines(), /↑ 2 more/);
assert.match(windowedLines(), /↓ 2 more/);
windowedMenu.handleInput("\u001b[B"); // cursor on item 5 — the window follows
assert.match(windowedLines(), /item 5/);
assert.match(windowedLines(), /↑ 3 more/);
assert.match(windowedLines(), /↓ 1 more/);
windowedMenu.handleInput("\u001b[F"); // end — the window shows the last items
assert.match(windowedLines(), /item 8/);
assert.match(windowedLines(), /↑ 4 more/);
assert.doesNotMatch(windowedLines(), /↓ \d+ more/);
windowedMenu.dispose();

console.log("Menu component tests passed.");
