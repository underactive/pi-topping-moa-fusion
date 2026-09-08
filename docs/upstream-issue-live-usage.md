# DRAFT upstream issue — not filed

Target: `earendil-works/pi`. Review before posting. Everything below was
verified against **pi 0.84.1**, which is the latest published version at time
of writing (`npm view @earendil-works/pi-coding-agent version` → `0.84.1`).

---

## Title

`message_update` delta-only change also removed live `usage`, leaving one-long-turn providers with no mid-run context signal

## Summary

The 0.84.0 fix for quadratic output growth removed the cumulative `message`
snapshot from wire `message_update` events. That was correct. But it also
removed the only mid-run carrier of `usage`, which was collateral rather than
intended — the in-process extension API still exposes it.

For providers that run an entire task as **one long turn**, the result is that
no consumer of the JSON/RPC stdout protocol can observe context growth until
the run ends. Any live context gauge sits at `0.0%` for the whole run and then
jumps to its final value.

## What changed

From the 0.84.0 changelog:

> Changed JSON and RPC `message_update` events to emit only
> `assistantMessageEvent` deltas, removing the cumulative `message` and
> `assistantMessageEvent.partial` fields that caused quadratic output growth.
> ([#7290](https://github.com/earendil-works/pi/issues/7290))

The transform is `toJsonEvent()` in `dist/modes/json-event.d.ts`:

```ts
type WithoutPartial<T> = T extends { partial: unknown } ? Omit<T, "partial"> : T;
type ToJsonEvent<T> = T extends {
    type: "message_update";
    assistantMessageEvent: infer TAssistantMessageEvent;
} ? {
    type: "message_update";
    assistantMessageEvent: WithoutPartial<TAssistantMessageEvent>;
} : T;
```

Two removals happen here, and only the first was the stated goal:

1. `partial` is stripped from `assistantMessageEvent` — the O(n²) fix.
2. The outer `message: AgentMessage` field is dropped, because the mapped
   type's output object literal lists only `type` and `assistantMessageEvent`.

`usage` lived on both. After the change it survives on neither.

## Why this only affects some providers

Normal providers emit a `message_end` per turn, and an agentic task is many
turns, so a consumer sees usage update several times a second. **This
regression is invisible for them.**

The affected shape is a provider that runs a whole task as a single turn —
agentic bridges that wrap another agent's internal tool loop. Concrete
example: `cursor-bridge` wrapping Cursor's agent. For those, there is exactly
one `message_end`, at the very end of the run.

## Evidence (verified on 0.84.1)

**Full wire event inventory** from a tool-using run: `agent_start`,
`agent_end`, `agent_settled`, `session`, `turn_start`, `turn_end`,
`message_start`, `message_update`, `message_end`, `tool_execution_start`,
`tool_execution_end`.

| event | usage |
| --- | --- |
| `message_start` | present but **all zeroes** |
| `message_update` | **no usage field at all** |
| `message_end` | populated, final, per-turn |
| `turn_end` | populated (same message) |
| `agent_end` | populated for completed messages |
| all others | none |

**`message_start` is all zeroes**, so it cannot substitute:

```json
{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0}
```

**A terminal `message_update` does not exist.** Worth stating explicitly,
because the type union suggests otherwise. `AssistantMessageEvent` includes:

```ts
{ type: "done";  reason; message: AssistantMessage }
{ type: "error"; reason; error:   AssistantMessage }
```

Neither key is named `partial`, so `WithoutPartial<T>` would *not* strip them,
and a reader of the types reasonably concludes a full `AssistantMessage` still
reaches the wire on `done`. It does not: the agent loop consumes `done`/`error`
and emits `message_end` instead, then returns. A terminal `message_update` is
never constructed. Captures across two runs found zero such events.

So the type union is broader than the producer, and the wire genuinely carries
no mid-run usage.

## The over-correction argument

The cost problem in #7290 was re-sending the **entire accumulated message** on
every delta — O(n) bytes per delta, O(n²) over a response.

`Usage` is a flat, fixed-size record of about ten numbers. Re-sending *that*
per delta is O(1) per delta and O(n) overall — the same order as the deltas
themselves, which are already being sent. It is not part of the quadratic
term.

The two were removed together because they travelled in the same field, not
because both were expensive.

## Supporting evidence that this was collateral

The in-process extension API still carries the cumulative message:

```ts
// dist/core/extensions/types.d.ts
export interface MessageUpdateEvent {
    type: "message_update";
    message: AgentMessage;              // still here
    assistantMessageEvent: AssistantMessageEvent;
}
```

So the capability was never intentionally retired — it is still exposed to
in-process consumers and was only lost in the wire projection.

This is observable in practice. `cursor-bridge` already maintains a live,
throttled (500 ms) token estimate on the in-flight partial message
specifically so that context gauges animate, with a code comment naming this
exact failure mode. That work is computed correctly inside the child process
and then discarded at the process boundary.

## Requested change

In rough order of preference:

1. **Add an optional `usage` field to the wire `message_update` event.**
   Smallest diff, directly reverses the regression, no new protocol member.
   Ideally emitted only when the value changes, or throttled.
2. **Add a dedicated `message_usage_update` event.** Cleaner separation and
   trivial for clients to ignore, at the cost of a new protocol member.
3. **Emit `usage` on an existing periodic event.** Any event that already
   fires mid-turn would do.

Option 1 restores the prior capability at O(n) cost while keeping the O(n²)
fix intact.

## Workarounds considered and rejected

- **Read the child's session JSONL** — subagents run `--no-session`, so no
  file exists. Enabling sessions to tail a file the child is writing trades a
  cosmetic bug for I/O coupling and cleanup obligations.
- **Switch to `--mode rpc`** — `toJsonEvent()` applies to the JSON *and* RPC
  stdout protocols. No gain.
- **Estimate context from output-token counts** — context size is dominated by
  *input* (prompt, tool results, file reads). Wrong by an order of magnitude.
- **Have bridges emit intermediate turn boundaries** — investigated in
  `cursor-bridge`; not implementable. The only resumable pause point is a
  pending bridged tool result, and forcing a boundary anywhere else requires
  cancelling the underlying run and losing its internal loop state, which
  would replay the whole task.
