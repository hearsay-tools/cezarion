# Task 1 Fix Report

Status: complete.

Changes:

- `classifyJsonLines` now consumes one JSON-encoded filename string per line and rejects array-shaped records.
- Root-level Markdown allowlisting now covers every valid root filename ending in `.md`, including `CHANGELOG.md`.
- Root-level license allowlisting now covers every valid root filename beginning with `LICENSE`.
- Focused tests pin the corrected formats and retain fail-closed cases.

Verification: `node --test .github/scripts/change-surface.test.cjs` passed (6 tests).

Concerns: none identified.
