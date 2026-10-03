# Changelog

## [Unreleased]

## [0.4.2]

### Changed

- Verified compatibility with pi 1.0.0: no pi export this extension imports was removed or changed, and typecheck and the full test suite pass against 1.0.0.
- Updated all four pi development dependencies from 0.99.2 to 1.0.0.

### Fixed

- The MoA progress footer now keeps one cumulative elapsed time across fan-out, synthesis, implementation, verification, and verifier-driven repair rounds, while excluding time spent waiting for user input.
- Other sessions no longer run `moa-verifier` as a general-purpose subagent. Earlier versions installed `moa-proposer`, `moa-synthesizer`, and `moa-verifier` into `~/.pi/agent/agents/`, which subagent tools such as pi-subagents' `Agent` scan in every session, so a session outside `/mf-plan` could hand the verifier unrelated work. These three agents are no longer installed, and copies left by earlier versions are removed at session start. MoA runs already loaded them from the extension package, so edits to those copies never took effect.
- The `mf_plan_subagent` tool description now states its structured result shape, including the fields of each `results` entry. pi 1.0.0 codemode shortens each tool's declared output to one line of top-level field names, which left `results` as a bare name; the tool description is the one part of that summary kept verbatim, so script authors see the nested shape without calling `describeTool()`. The structured result itself is unchanged.

## [0.4.1]

### Added

- `write_plan`, `enter_plan_mode`, `exit_plan_mode`, and `mf_plan_subagent` now declare a pi 0.99 `outputSchema` and return matching `structuredContent` for RPC/JSON consumers, `tool_result` handlers, and codemode scripts: per-agent status, exit code, stop reason, usage, and capped output for subagent runs, and the approval outcome and kickoff route for plan exit. Model-facing text is unchanged.
- The same four tools now declare MCP-style `annotations`, so permission extensions see accurate destructive and idempotent hints. None claims to be read-only.

### Changed

- Updated all four pi development dependencies from 0.87.0 to 0.99.2.
- Plan-only tools stay out of normal mode by being removed from the active tool set, not through pi 0.99's `prepareLoadout`, which leaves hidden tools active and callable.

### Fixed

- Plan-only tools are now also removed on the first turn after leaving plan mode. Previously the exit-reminder turn skipped the leak repair, so a leaked `write_plan`, `exit_plan_mode`, or `mf_plan_subagent` stayed declared for that turn.

## [0.3.0]

### Added

- Added `/mf-spec`, an in-process requirements-clarification flow that asks up to five focused questions, reviews and saves approved `__spec.md` planning briefs, and prepares a `/mf-plan` handoff without exposing specs to `/mf-plan-implement`.
- A hidden `mf-plan-verification-pending` session marker now records when an approved implementation is expected to enter independent verification. Resuming before a verifier result is recorded warns that the implementation is still unverified.

### Changed

- Updated all four pi development dependencies from 0.86.0 to 0.87.0.
- The pi 0.87 settle-boundary context-edit and verification-marker integrations are capability-gated and remain inert on older hosts, which retain the existing request-time filtering and verification dispatch behavior.

### Fixed

- An assigned slot in the MoA Fusion Pre-flight overview can now be cleared back to `(none)` with Backspace or Delete. Previously a slot could only be reassigned to another model, never emptied.
- Reusable `[PLAN MODE ACTIVE]` and `[PLAN MODE RE-ENTRY]` instruction entries are now durably omitted with settle-boundary null context edits after plan-mode exit, preventing later compaction from carrying stale plan instructions into implementation.
- Custom OpenAI-compatible endpoints used by proposers and verifiers now benefit from pi 0.87's upstream strict-schema capability fix: unknown endpoints no longer receive strict tool schemas unless they explicitly advertise support.
- Saving or deleting an agent roster now takes effect immediately, without requiring a second save from the main settings overlay.
- A failed agent's error is now readable in full without widening the terminal. Provider failures were cut to 80 characters before reaching the progress table and then truncated again at the ACTIVITY column edge, hiding the part naming the cause. The message is now kept whole and word-wrapped beneath its row — breaking the JSON payload mid-token when it has no spaces to break on — while a short error stays inline as before.

## [0.2.0]

### Added

- A `Naming the plan`/`Naming the opinion`/`Naming the debate` working overlay while the cheap/fast model summarizes a submitted prompt into its slug, so the TUI no longer sits unresponsive during that call. Press **Esc** to skip naming and fall back to a name derived from the prompt.
- Panel dependence note in the synthesizer input: a blinded summary of proposal count, distinct models, and same-model clusters so agreement is weighted by dependence, not vote count alone.
- Pre-flight and replacement-time diversity warning when proposer slots share a model or provider, reminding that agreement between them is not independent evidence.
- Evidence-backed vs asserted tags in synthesizer `### Proposer alignment`, plus distinct-model support counts on conflict recommendation Details lines.
- Configurable `maxConcurrentAgents` setting (1–8, default 1) for MoA, opinion, debate, and plan subagent fan-outs.
- Configurable `maxVerificationRepairs` setting (0–5, default 2) for verifier-driven implementation repairs. When repairs are exhausted or disabled, a `.pi/mf-plan/<slug>__verification-handoff.md` file is written with every criterion's status, the full frozen checklist, gaps, and guidance to continue verification manually — and its path is named in the exhaustion notification.
- Cancelling a single proposer from the MoA cancel overlay now prompts, once the fan-out settles, to replace that slot with a different model or continue without it, instead of silently dropping the proposal and proceeding with the survivors. **Cancel ALL** (including during a replacement run) still aborts the run.

### Fixed

- Resuming, forking, or `--continue`-ing a session saved mid-plan no longer leaves the implementer with a read-only tool loadout after approval. The pre-plan-mode loadout is now persisted with the plan state.
- Subagent runs no longer log two spurious `event parse error: invalid session event` lines per run. pi 0.86.0's `system` wire messages are accepted instead of leading every failure report.
- Typechecking against pi 0.84.3 and newer declarations.
- Remove trailing ellipses from status labels.
- Correct progress timing and running counts for agents waiting in the concurrency queue.
- Show concurrency-limited fan-out agents as queued until they acquire a process-pool slot.
- Use success colors for positive verification notices instead of warning colors.

### Changed

- Child-agent concurrency default drops from the previous hard-coded limit of 5 to **1** via the new `maxConcurrentAgents` setting.
- Plan naming now uses `ctx.modelRegistry.streamSimple()` instead of the temporary `pi-ai/compat` entry, so proxy and OAuth base-URL overrides are honored.
- The subagent `CTX` column can now advance mid-turn from `message_update` usage, so one-long-turn provider bridges that report streaming usage are no longer forced to sit at `0.0%` until the run ends. A malformed usage reading is ignored without discarding the subagent's output.

### Removed

- The unfiled `docs/upstream-issue-live-usage.md` draft for a change that has shipped upstream.

## [0.1.0]

- Initial commit
