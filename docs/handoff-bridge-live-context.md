# Handoff: live context reading lost for one-long-turn providers (pi 0.84)

**Status:** open, blocked on an upstream pi change
**Scope:** the `CTX` column / context bar in the MoA progress widget
**Severity:** cosmetic but misleading — reads as a stuck UI, which is how the
sibling activity-meter bug was originally reported

---

## What you're picking up

While fixing the activity meter after the pi 0.84 wire-protocol change, one
behavior was deliberately **removed rather than ported**, because the data it
depended on no longer crosses the process boundary. This document is the
evidence trail so you don't have to re-derive it.

The short version: for providers that run an entire task as **one long turn**,
the subagent context bar now sits at `0.0%` for the whole run and then jumps
straight to its final value. Nothing is broken locally; the number genuinely
isn't available anymore.

## Background: what changed upstream

pi 0.84.0 shipped this breaking change:

> Changed JSON and RPC `message_update` events to emit only
> `assistantMessageEvent` deltas, removing the cumulative `message` and
> `assistantMessageEvent.partial` fields that caused quadratic output growth.
> Clients that need partial messages must assemble deltas between
> `message_start` and `message_end`; the latter remains authoritative.
> ([#7290](https://github.com/earendil-works/pi/issues/7290))

The transform is `toJsonEvent()` in
`@earendil-works/pi-coding-agent/dist/modes/json-event.d.ts`. It applies to
**both** the JSON and RPC stdout protocols, so switching transport does not
recover the field.

`src/runtime/runner.ts` spawns `pi --mode json -p --no-session` and parses that
stdout, so it is squarely on the wire side of this transform.

## What was removed, exactly

This block used to live in the `message_update` handler now owned by
`src/runtime/runner.ts`:

```ts
// Live context reading: some providers (e.g. agentic bridges like
// cursor-bridge) stream usage on the in-flight partial message and run
// the whole task as ONE long turn — without harvesting here, the
// context bar would sit at 0% until message_end.
const liveTotal = partial.role === "assistant"
  ? (partial as { usage?: { totalTokens?: number } }).usage?.totalTokens
  : undefined;
if (liveTotal && liveTotal > currentResult.usage.contextTokens) {
  currentResult.usage.contextTokens = liveTotal;
}
```

`partial` was `event.message`, which no longer exists on `message_update`.

`currentResult.usage.contextTokens` receives its authoritative value in the
`message_end` handler at `src/runtime/runner.ts:273-281`, from
`usage.totalTokens`. Provider extensions can also supply interim readings via
the stderr usage-beacon path at `src/runtime/runner.ts:307-318`; providers that
emit neither still have no mid-turn context reading.

## Why this only hurts *some* providers

Normal providers emit a `message_end` per turn, and an agentic task is many
turns, so `contextTokens` updates several times a second and the bar animates
fine. **This regression is invisible for them.**

The affected shape is a provider that runs the whole task as a single turn.
The known example is `cursor-bridge`; `claude-bridge` is likely the same
shape. Both are recognised by this repo as agentic provider bridges — see
`READ_ONLY_SUBAGENT_ENV` at `src/runtime/runner.ts:43`:

```ts
export const READ_ONLY_SUBAGENT_ENV = Object.freeze({
  PI_CURSOR_FORCE_MODE: "plan",
  PI_CLAUDE_BRIDGE_FORCE_MODE: "read",
});
```

For those, there is one `message_end` at the very end of the run. Until it
arrives (or an interim usage beacon is emitted), `contextPercent()`
(`src/ui/agentStatus.ts:67`) is called with `contextTokens = 0` and renders
`0.0%/<window>`, and `usageBar()` (`src/ui/agentStatus.ts:30`) renders a
fully-empty bar.

Note this is *not* the same as the unknown-window case, which deliberately
renders `—` / `[??????????]`. A known window with zero tokens renders a
confident, precise, wrong-looking `0.0%`.

## Evidence that local recovery is impossible

Three things were checked. Please re-verify rather than trusting this doc if
you are working against a newer pi.

**1. `message_update` no longer carries a message.** Capture a run and inspect
the keys:

```bash
pi --mode json -p --no-session --no-extensions --tools read \
  'Reply with exactly: hello' > /tmp/ev.jsonl

python3 -c "
import json
for line in open('/tmp/ev.jsonl'):
    line=line.strip()
    if not line: continue
    e=json.loads(line)
    print(e.get('type'), sorted(e.keys()))
" | sort -u
```

Observed on 0.84.1: `message_update ['assistantMessageEvent', 'type']`.

**2. `message_start` usage is all zeros**, so it cannot substitute:

```
message_start -> {"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,...}
message_end   -> {"input":1689,"output":44,...,"totalTokens":1733,...}
```

**3. No other wire event carries mid-turn usage.** The full event inventory
from a tool-using run was `agent_start`, `agent_end`, `agent_settled`,
`session`, `turn_start`, `turn_end`, `message_start`, `message_update`,
`message_end`, `tool_execution_start`, `tool_execution_end`. Of these only
`message_end` and `turn_end` carry a message with populated usage, and for a
one-long-turn provider both fire once, at the end.

## The upstream ask

The strongest framing for an upstream issue: **the fix for quadratic growth
over-corrected.** The cost problem was re-sending the *entire accumulated
message* on every delta — that's O(n²) in output length. `Usage` is a flat,
fixed-size record of ~10 numbers. Re-sending *that* per delta is O(n), which
is the same order as the deltas themselves.

So the requested change is to restore a small usage signal without restoring
the snapshot. In rough order of preference:

1. **Add an optional `usage` field to the wire `message_update` event.**
   Smallest diff, directly reverses the regression, no new event type.
   Ideally emitted only when the value changes, or throttled.
2. **Add a dedicated `message_usage_update` event.** Cleaner separation and
   easy for clients to ignore, at the cost of a new protocol member.
3. **Have agentic bridges emit intermediate turn boundaries.** Arguably more
   correct anyway, since a multi-hour single "turn" defeats every per-turn UI
   in pi, not just this one. Bigger behavioral change and lives in the bridge
   extensions rather than core.

Worth confirming before filing: whether the in-process extension API (the
`AgentSessionEvent` union in `core/extensions/types.d.ts`, which still carries
`message` on `message_update`) already exposes live usage. If it does, the
regression is purely in the wire projection, which strengthens the case that
this was collateral damage rather than an intentional capability removal.

## Rejected local workarounds

- **Read the child's session JSONL.** Subagents run with `--no-session`, so
  there is no file. Enabling sessions to tail a file the child is writing
  would trade a cosmetic bug for I/O coupling and cleanup obligations.
- **Switch to `--mode rpc`.** `toJsonEvent()` is documented as applying to the
  JSON *and* RPC stdout protocols. No gain.
- **Estimate context from the output-token activity meter.** The meter counts
  *generated* words (`OutputActivityTracker`,
  `src/runtime/activityTracking.ts:53`). Context size is dominated by *input* —
  prompt, tool results, file reads — so this would be wrong by an order of
  magnitude and worse than showing nothing.

## Interim mitigation worth considering

Independent of upstream: distinguish "no reading yet" from "genuinely 0%".
Today a pre-first-`message_end` agent is indistinguishable from an idle one.
Rendering the placeholder `—` / `[??????????]` until the first usage arrives
would stop the widget from asserting a precise number it does not have.

This is a self-contained change in `src/ui/agentStatus.ts` — `usageBar()` and
`contextPercent()` already have a placeholder path for an unknown window; it
needs an equivalent for unknown *usage*. Doing this does not block or conflict
with the upstream fix.

## Acceptance criteria

- With a one-long-turn bridge model selected, the `CTX` column advances during
  a `/mf-plan` fan-out rather than jumping from `0.0%` to final at the end.
- Normal per-turn providers are unchanged (they are the regression-risk here,
  since they already work).
- `npm run check` and `npm test` stay clean.
- If the interim mitigation lands instead, an agent with no usage reading yet
  is visually distinct from one genuinely at 0%.

## Related context in this repo

- `src/runtime/runner.ts:234` — `processLine`, the wire-event parser. It
  consumes the typed result of `parseSessionEvent`, so a future protocol change
  of this kind becomes a compile error instead of a silently skipped branch.
  **Keep it typed.**
- `src/runtime/wire.ts:5` — `WireAssistantMessageEvent`, derived from the
  protocol union rather than pi-ai's `AssistantMessageEvent`. This is load
  bearing: the in-process type still has the `partial` field the wire lacks,
  so naming it directly would re-hide exactly this class of bug.
- `test/output-token-activity.test.mjs` — covers the sibling meter fix and
  pins the delta-only contract.
