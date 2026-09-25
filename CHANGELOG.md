# Changelog

All notable changes to this project are documented in this file.

## [0.2.0] - 2026-09-25

- Replaced the global 30% threshold with context-window-aware percentage tiers.
- Added a 22K-token safety floor for small-context models.
- Documented prompt-cache behavior and long-context threshold rationale.

## [0.1.0] - 2026-09-25

- Added automatic session compaction after context usage exceeds 30% of the active model context window.
- Added duplicate-compaction protection and rearming after usage falls below the threshold.
- Added unit and Pi RPC end-to-end coverage.
