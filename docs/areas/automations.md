# Automations (GitHub polls and schedules)

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`packages/cezar/src/automations/`, then `packages/contract/src/automations.ts`, `packages/contract/src/automation-schedule.ts`, the automations family in `packages/cezar/src/server/server.ts`, `packages/web/src/routes/automations/`, and `.ai/specs/2026-10-02-scheduled-automations.md`

## Rules

On by default; only exact `HSQ_AUTOMATIONS=0` (`CEZ_AUTOMATIONS` fallback) opts out, and the gate middleware then answers `409`. Restart after changing the flag. New definitions remain paused; existing enabled definitions resume unless opted out. Two kinds: `github` polls, `schedule` fires on the clock and needs no remote. A schedule fire takes the hearsay-tools/cezarion#651 store lease, reserves one receipt per occurrence (`<id>:schedule:<iso>`), launches an ordinary task, and never advances `nextRunAt` on a lost lease. At most one catch-up inside 24 h, auto-pause after 3 consecutive launch failures. `setState` is a read-modify-write against a fresh disk read. No `task.dispatch`. Stage 2 (hearsay-tools/cezarion#774): `hsq automation` (`automations/automation-cli.ts`) reaches the cockpit through `HSQ_COCKPIT_URL` (`CEZ_COCKPIT_URL` fallback)/`HSQ_PROJECT_ID` (`CEZ_PROJECT_ID` fallback), which the boot manager receives at construction (`serve` binds its listener before it recovers, so recovered runs carry it) and every other project's manager receives from `startServer` via `RunManager.setCockpitAddress`; it never starts a server or probes ports on its own. The prompt part and the built-in `create-cezarion-automation` skill share ONE gate (the effective `HSQ_AUTOMATIONS` value, with `CEZ_AUTOMATIONS` fallback, is not `0` AND an address): add any new skill lookup through `RunManager.builtinSkills()` and any new session construction site through `automationsPart()`. Templates, calendars and stats are stage 3.

## Repository name and failing polls

A GitHub poll reads under the canonical `owner/name` from `gh repo view`
(`automations/github-repository.ts`), not the `origin` URL text, because the
issue search answers `422` for a renamed repository's old name. The name is
memoized per project (`server/forge/github-repo-handle.ts`). A `404` or `422`
forgets it, resolves again, and retries once when the name changed. Issue
receipts dedupe by node ID, so a rename does not relaunch an old issue.

A failed check stores `lastError` and `lastErrorAt`; a success or a re-arm clears
them, and a backed-off skip keeps the last real error. From
`AUTOMATION_FAILURE_NOTICE_AFTER` (3) consecutive failures, `automationFailureNotice`
gives the cockpit card's alert and the `failing` key of `hsq automation list`.

## Project directory log reads

Both log sources and both receipt sources merge through `mergeAppendOnly`
(`merged-streams.ts`): a duplicate key (automation and sequence for log rows;
receipt, status and update time for receipts) keeps the legacy row, then the
survivors replay in recorded time (`ts`, `updatedAt`), so the latest receipt and
the newest log row are the newest events whichever directory holds them. With
both log sources present, a page read numbers the merged rows 1..n in that order
and uses that number as the positive cursor; a later append (newest time, highest
raw sequence) only extends it, so existing cursors stay stable. Compaction that
drops the oldest legacy rows can shift merged cursors down, which repeats rows on
an open page but never skips one. Legacy-only pages keep their stored sequences.
The projection is read-only: appends and compaction retain original positive
legacy sequences. Compaction rewrites legacy receipts and logs only. Fallback
records remain readable from their source and are never copied by compaction.

Log compaction retains the newest 10,000 legacy rows plus durable retry rows.
`AutomationStoreOptions.logRetentionCount` is a test-only override so paging
regressions can cross the compaction boundary with small fixtures.

## Project moves at startup

The boot context resolves its automation store when used. It must not retain a
store opened before automatic project preparation. The coordinator compares each
cached store's directory with `projectPaths(root).write`, both during refresh and
at lookup, and replaces a handle whose directory changed. Initial discovery and
late registration prepare projects before braking idle polls and arming schedules.
A busy project keeps its legacy write root and its existing automation state.
Baselines, cursors, schedule state, receipts and logs follow the same write root.
