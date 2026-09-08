import assert from "node:assert/strict";

const { getFinalOutput } = await import("../src/runtime/results.ts");

const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (parts) => ({ role: "assistant", content: parts });
const text = (t) => ({ type: "text", text: t });
const toolUse = () => ({ type: "toolCall", id: "t1", name: "read", arguments: {} });

// ── the last assistant message's text is the final output ─────────────────
assert.equal(getFinalOutput([user("hi"), assistant([text("the answer")])]), "the answer");

// ── non-text parts are skipped, not returned ──────────────────────────────
assert.equal(
	getFinalOutput([assistant([text("prose"), toolUse()])]),
	"prose",
	"a message with text plus tool-use returns the text",
);
assert.equal(getFinalOutput([assistant([toolUse()]), assistant([text("later")])]), "later");

// ── multiple text parts in one message are joined ─────────────────────────
assert.equal(
	getFinalOutput([assistant([text("first half"), toolUse(), text("second half")])]),
	"first half\n\nsecond half",
	"non-empty text parts of one message are joined with a blank line",
);

// ── empty text parts are skipped ──────────────────────────────────────────
assert.equal(
	getFinalOutput([assistant([text(""), text("real output")])]),
	"real output",
	"an empty leading text part does not blank the output",
);
assert.equal(getFinalOutput([assistant([text("done"), text("")])]), "done", "an empty trailing text part is skipped");

// ── an all-empty last message falls back to an earlier assistant message ──
assert.equal(
	getFinalOutput([assistant([text("the real answer")]), user("ok"), assistant([text(""), text("")])]),
	"the real answer",
	"a trailing assistant message with only empty text falls back to the previous one",
);
assert.equal(
	getFinalOutput([assistant([text("kept")]), assistant([toolUse()])]),
	"kept",
	"a trailing assistant message with no text parts falls back to the previous one",
);

// ── no assistant content means no output ──────────────────────────────────
assert.equal(getFinalOutput([]), "");
assert.equal(getFinalOutput([user("question only")]), "");
assert.equal(getFinalOutput([assistant([text("")])]), "");

console.log("final-output tests passed");
