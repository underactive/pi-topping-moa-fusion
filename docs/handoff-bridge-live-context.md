# Live context usage on wire `message_update` events

**Status:** resolved in pi 0.84.2 and verified against pi 0.86.0 ([#7982](https://github.com/earendil-works/pi/issues/7982))

pi 0.84.0 changed JSON and RPC `message_update` events to carry deltas instead of a cumulative assistant-message snapshot. That removed quadratic wire growth, but it also removed the only mid-turn usage signal available to subprocess consumers. Providers that run a task as one long turn therefore left the MoA `CTX` column at `0.0%` until the final `message_end`.

pi 0.84.2 restored the fixed-size signal as `message_update.usage`. `src/runtime/runner.ts` now validates `usage.totalTokens` at the read site and reconciles it as an interim beacon. The authoritative `message_end` reading still wins, and malformed or missing usage is ignored without discarding the event's text delta. The stderr usage beacon remains a compatible fallback for provider extensions.

The system-message and live-usage wire behavior is covered by `test/subagent-trust-boundary.test.mjs`: pi 0.86.0 system messages do not enter the LLM transcript or produce parse diagnostics, valid update usage appears in progress before the turn ends, malformed usage does not drop output, and final usage becomes authoritative.

`WireAssistantMessageEvent` in `src/runtime/wire.ts` is intentionally retained as the wire-side type anchor even though `PartialAssistantAssembler.apply()` no longer names it. The JSON-protocol delta union differs from pi-ai's in-process update union; keeping the derived alias documents that boundary and makes future protocol changes visible at the source that parses them.
