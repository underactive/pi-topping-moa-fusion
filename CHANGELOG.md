# Changelog

## [Unreleased]

### Added

- Configurable `maxConcurrentAgents` setting (1–8, default 1) for MoA, opinion, debate, and plan subagent fan-outs. The effective default drops from the previous hard-coded limit of 5 to 1.
- Configurable `maxVerificationRepairs` setting (0–5, default 2) for verifier-driven implementation repairs. When repairs are exhausted or disabled, a `.pi/mf-plan/<slug>__verification-handoff.md` file is written with every criterion's status, the full frozen checklist, gaps, failing checks, and guidance to continue verification manually — and its path is named in the exhaustion notification.

### Fixed

- Show concurrency-limited fan-out agents as queued until they acquire a process-pool slot.

## [0.1.0]

- Initial commit
