import assert from "node:assert/strict";

const { getFinalOutput, statusDetail } = await import("../src/runtime/results.ts");

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

// ── statusDetail bounds a failure message without cutting a readable one ──
{
	const providerError = '400: {"message":"Provider returned error","code":400,"metadata":{"raw":"{\\"error\\":{\\"code\\":500}}","provider_name":"Minimax"}}';
	assert.equal(statusDetail(providerError), providerError, "a provider error survives whole — the progress table wraps it, so it must not arrive pre-cut");
	assert.equal(statusDetail("  spawn failed  "), "spawn failed", "surrounding whitespace is trimmed");
	assert.equal(
		statusDetail("connection reset\n  by peer\n\nretrying"),
		"connection reset by peer retrying",
		"newlines and runs of whitespace collapse, so the message lays out as one line",
	);

	const huge = statusDetail("E".repeat(4000));
	assert.equal(huge.length, 500, "a multi-KB dump is bounded so it cannot crowd out the table it renders in");
	assert.ok(huge.endsWith("…"), "and the cut is marked, so a clipped message never reads as the whole one");
	assert.equal(statusDetail("E".repeat(500)), "E".repeat(500), "a message exactly at the bound is kept intact and unmarked");
}

console.log("final-output tests passed");
