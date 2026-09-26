# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

- Treated Pi's "nothing to compact" and "already compacted" outcomes as expected rather than failures, and marked the crossing satisfied so they are not retried every turn.
- Added a status state for a crossing that has nothing to compact, so `/auto-compact-status` no longer claims a compaction is coming when none is possible.
- Skipped the automatic compaction while Pi reports the session as busy, so a compaction Pi started itself is never overlapped by a second one.
- Added `/auto-compact-status` to report current context usage, the active threshold, the tier that produced it, and what the extension will do next.
- Added unit coverage for the status command and an end-to-end check that the command is registered by a real Pi host.

## [0.2.0] - 2026-09-25

- Replaced the global 30% threshold with context-window-aware percentage tiers.
- Added a 22K-token safety floor for small-context models.
- Documented prompt-cache behavior and long-context threshold rationale.

## [0.1.0] - 2026-09-25

- Added automatic session compaction after context usage exceeds 30% of the active model context window.
- Added duplicate-compaction protection and rearming after usage falls below the threshold.
- Added unit and Pi RPC end-to-end coverage.
