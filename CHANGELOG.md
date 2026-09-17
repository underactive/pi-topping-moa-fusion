# Changelog

## [Unreleased]

### Added

- A `Naming the plan`/`Naming the opinion`/`Naming the debate` working overlay while the cheap/fast model summarizes a submitted prompt into its slug, so the TUI no longer sits unresponsive during that call. Press **Esc** to skip naming and fall back to a name derived from the prompt.

## [0.1.1]

### Added

- Panel dependence note in the synthesizer input: a blinded summary of proposal count, distinct models, and same-model clusters so agreement is weighted by dependence, not vote count alone.
- Pre-flight and replacement-time diversity warning when proposer slots share a model or provider, reminding that agreement between them is not independent evidence.
- Evidence-backed vs asserted tags in synthesizer `### Proposer alignment`, plus distinct-model support counts on conflict recommendation Details lines.
- Configurable `maxConcurrentAgents` setting (1–8, default 1) for MoA, opinion, debate, and plan subagent fan-outs. The effective default drops from the previous hard-coded limit of 5 to 1.
- Configurable `maxVerificationRepairs` setting (0–5, default 2) for verifier-driven implementation repairs. When repairs are exhausted or disabled, a `.pi/mf-plan/<slug>__verification-handoff.md` file is written with every criterion's status, the full frozen checklist, gaps, and guidance to continue verification manually — and its path is named in the exhaustion notification.
- Cancelling a single proposer from the MoA cancel overlay now prompts, once the fan-out settles, to replace that slot with a different model or continue without it, instead of silently dropping the proposal and proceeding with the survivors. **Cancel ALL** (including during a replacement run) still aborts the run.

### Fixed

- Remove trailing ellipses from status labels.
- Correct progress timing and running counts for agents waiting in the concurrency queue.
- Show concurrency-limited fan-out agents as queued until they acquire a process-pool slot.

## [0.1.0]

- Initial commit
