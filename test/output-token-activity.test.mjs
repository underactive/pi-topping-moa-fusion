import assert from "node:assert/strict";

const { OutputActivityTracker, PartialAssistantAssembler } = await import("../src/runtime/activityTracking.ts");
const { StderrBeaconReader, parseUsageBeacon, reconcileContextTokens } = await import("../src/runtime/wire.ts");

const assistant = (usage) => ({ role: "assistant", content: [], ...(usage ? { usage } : {}) });
const delta = (type, text, contentIndex = 0) => ({ type, delta: text, contentIndex });

// ── mid-turn output is estimated purely from streamed deltas ───────────────
// The JSON protocol carries no cumulative snapshot on message_update, so word
// counting is the only live signal. A regression here shows up as an activity
// meter frozen at IDLE.
{
	const t = new OutputActivityTracker();
	t.messageStart(assistant());
	t.messageUpdate(delta("text_delta", "one two "));
	assert.equal(t.snapshot().tokens, 2);
	// Split words are not double counted, and thinking counts alongside text.
	t.messageUpdate(delta("text_delta", "thr"));
	t.messageUpdate(delta("text_delta", "ee "));
	t.messageUpdate(delta("thinking_delta", "hmm ok "));
	assert.equal(t.snapshot().tokens, 5);

	// No usage on the final message: the estimate is what gets confirmed.
	t.messageEnd(assistant());
	assert.deepEqual(t.snapshot(), { tokens: 5, revision: 0 });

	// A second turn accumulates on top of the first.
	t.messageStart(assistant());
	t.messageUpdate(delta("text_delta", "next turn"));
	assert.equal(t.snapshot().tokens, 7);
}

// ── exact final usage correcting an estimate bumps the revision ───────────
{
	const t = new OutputActivityTracker();
	t.messageStart(assistant());
	t.messageUpdate(delta("text_delta", "a b c "));
	t.messageEnd(assistant({ output: 400 }));
	assert.deepEqual(t.snapshot(), { tokens: 400, revision: 1 }, "correction must be visible to rate trackers");

	t.messageStart(assistant());
	t.messageUpdate(delta("text_delta", "x y "));
	assert.deepEqual(t.snapshot(), { tokens: 402, revision: 1 });
	t.messageEnd(assistant({ output: 100 }));
	assert.deepEqual(t.snapshot(), { tokens: 500, revision: 2 });
}

// ── a final usage matching the estimate must not reset the meter ──────────
{
	const t = new OutputActivityTracker();
	t.messageStart(assistant());
	t.messageUpdate(delta("text_delta", "a b c "));
	t.messageEnd(assistant({ output: 3 }));
	assert.deepEqual(t.snapshot(), { tokens: 3, revision: 0 });
}

// ── non-assistant traffic is ignored, and turn state is scoped ─────────────
{
	const t = new OutputActivityTracker();
	t.messageStart({ role: "user", content: [] });
	t.messageUpdate(delta("text_delta", "a b "));
	assert.equal(t.snapshot().tokens, 2);
	// A tool result ending must not confirm or clear the in-flight estimate.
	t.messageEnd({ role: "toolResult", content: [] });
	assert.equal(t.snapshot().tokens, 2);
	// Non-delta events (tool call streaming) don't count toward output.
	t.messageUpdate(delta("toolcall_delta", "{\"a\": 1}"));
	assert.equal(t.snapshot().tokens, 2);
}

// ── partial assistant messages are reassembled from deltas ────────────────
{
	const a = new PartialAssistantAssembler();
	assert.equal(a.snapshot(), undefined, "no partial before a message starts");

	a.start({ role: "assistant", content: [], model: "m" });
	assert.equal(a.snapshot(), undefined, "no partial until content arrives");

	// Deltas at the same contentIndex concatenate.
	a.apply(delta("text_delta", "Hel"));
	a.apply(delta("text_delta", "lo"));
	assert.deepEqual(a.snapshot().content, [{ type: "text", text: "Hello" }]);

	// contentIndex preserves ordering across interleaved kinds, and the
	// message_start metadata is carried through.
	a.start({ role: "assistant", content: [], model: "m" });
	a.apply(delta("thinking_delta", "why", 0));
	a.apply(delta("text_delta", "because", 1));
	a.apply({ type: "toolcall_end", contentIndex: 2, toolCall: { type: "toolCall", id: "1", name: "read", arguments: { path: "a.ts" } } });
	const snapshot = a.snapshot();
	assert.equal(snapshot.model, "m");
	assert.deepEqual(snapshot.content, [
		{ type: "thinking", thinking: "why" },
		{ type: "text", text: "because" },
		{ type: "toolCall", id: "1", name: "read", arguments: { path: "a.ts" } },
	]);

	// Gaps left by unhandled content kinds must not surface as holes.
	a.start({ role: "assistant", content: [], model: "m" });
	a.apply(delta("text_delta", "tail", 3));
	assert.deepEqual(a.snapshot().content, [{ type: "text", text: "tail" }]);

	// A user message_start yields no partial, and clear() drops the in-flight one.
	a.start({ role: "user", content: [] });
	a.apply(delta("text_delta", "ignored"));
	assert.equal(a.snapshot(), undefined);

	a.start({ role: "assistant", content: [], model: "m" });
	a.apply(delta("text_delta", "x"));
	a.clear();
	assert.equal(a.snapshot(), undefined);
}

// ── stderr beacons are strict, framed, and never pollute diagnostics ──────
{
	assert.equal(parseUsageBeacon('pi-usage-beacon/1 {"totalTokens":12345}'), 12345);
	assert.equal(parseUsageBeacon('pi-usage-beacon/1 {"totalTokens":0}\r'), 0, "CRLF is accepted");
	assert.equal(parseUsageBeacon('pi-usage-beacon/1 {"totalTokens":-1}'), undefined);
	assert.equal(parseUsageBeacon('pi-usage-beacon/1 {"totalTokens":null}'), undefined);
	assert.equal(parseUsageBeacon('pi-usage-beacon/1 {"totalTokens":1.5}'), 1.5, "consumer accepts finite non-negative values");
	assert.equal(parseUsageBeacon('pi-usage-beacon/1 {"totalTokens":1,"extra":true}'), 1);
	assert.equal(parseUsageBeacon('pi-usage-beacon/1 []'), undefined);
	assert.equal(parseUsageBeacon('pi-usage-beacon/2 {"totalTokens":10}'), undefined);

	const reader = new StderrBeaconReader();
	assert.deepEqual(reader.push('pi-usage-beacon/2 {"totalTokens":9}\n'), { beacons: [], diagnostics: "" }, "unknown beacon versions are silently dropped");
	const first = reader.push("diagnostic one\npi-usage-beacon/1 {\"total");
	assert.deepEqual(first, { beacons: [], diagnostics: "diagnostic one\n" }, "incomplete beacon stays buffered");
	const second = reader.push("Tokens\":25}\nfinal diagnostic");
	assert.deepEqual(second, { beacons: [25], diagnostics: "" });
	const final = reader.push("", true);
	assert.deepEqual(final, { beacons: [], diagnostics: "final diagnostic" }, "beacons are filtered while diagnostics survive close flush");
	assert.ok(!`${first.diagnostics}${second.diagnostics}${final.diagnostics}`.includes("pi-usage-beacon"));
}

// ── live estimates never regress and terminal usage becomes authoritative ─
{
	let state = reconcileContextTokens(undefined, false, 100, "beacon");
	assert.deepEqual(state, { contextTokens: 100, authoritative: false, changed: true });
	state = reconcileContextTokens(state.contextTokens, state.authoritative, 90, "beacon");
	assert.deepEqual(state, { contextTokens: 100, authoritative: false, changed: false });
	state = reconcileContextTokens(state.contextTokens, state.authoritative, 120, "message_end");
	assert.deepEqual(state, { contextTokens: 120, authoritative: true, changed: true });
	state = reconcileContextTokens(state.contextTokens, state.authoritative, 130, "beacon");
	assert.deepEqual(state, { contextTokens: 120, authoritative: true, changed: false });
	state = reconcileContextTokens(150, false, 120, "message_end");
	assert.deepEqual(state, { contextTokens: 150, authoritative: true, changed: false }, "terminal reconciliation never regresses");
}

console.log("Output token activity tests passed.");
