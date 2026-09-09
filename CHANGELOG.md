# Changelog

## [Unreleased]

### Added

- Added the `/mf-debate` read-only multi-round debate command.
- Added prompt-editor file-path and repository-search completion with regression coverage.
- Added an `F2` shortcut to toggle the inline/live preview of streamed agent output in the MoA Fusion table.

### Changed

- Updated plan, opinion, and debate request prompts to use the completion-enabled prompt editor.
- Highlighted tool-call activity rows in the MoA Fusion table and the cancel overlay with pi's theme colours: a bold `toolTitle` tool name followed by an `accent` argument.
- Completed npm package metadata (keywords, repository, bugs, homepage, engines, gallery image) for first publish.

### Fixed

- Fixed summarized plan names falling back to random slugs when the naming model returned no visible text.
- Fixed `/reload` failing when the extension tried to change active tools during extension loading.
- Fixed plan-only tools leaking into normal sessions, including implementation kickoff turns from `/mf-plan-implement` while plan mode was still enabled.
- Fixed two-pane model picker selection highlight to span the full pane width and appear only on the active pane.
