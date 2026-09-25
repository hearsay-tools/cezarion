# Upstream ledger

Status: accepted · Date: 2026-09-18 · Relates: `.ai/upstream/`, `.github/scripts/upstream-ledger.cjs`, `.github/workflows/upstream-scan.yml`

## TLDR

cezarion is a fork of open-mercato/cezar that never merges upstream: every upstream change is
re-implemented, rejected, or found to be solved differently here. Git cannot tell those apart
(`git cherry` sees nothing), so the record of what was ported, what was declined and why lived in
scattered "port of upstream #N" strings. This spec adds a ledger keyed by upstream commit, a scan
script that appends new upstream commits as `pending`, and a weekly workflow that opens a PR with
the new rows. The human decides by editing statuses in that PR.

## Problem

The 2026-09-16 review of upstream drift took a full session of git archaeology: find the fork
point, list 32 upstream commits, grep the changelog and PR bodies for port markers, probe the
source for each feature, and dry-run each patch for conflicts. None of that was recorded in a
form the next scan could start from, and the "we looked at this and chose not to" decisions had
no home at all.

## Design

### Files

```
.ai/upstream/
  README.md          how to run a scan, how to decide an entry
  ledger.yaml        the source of truth: one entry per upstream commit
  scans/<date>.md    one report per scan: upstream head, range, added rows, conflict hints
```

`ledger.yaml`:

```yaml
upstream: { repo: open-mercato/cezar, branch: main }
fork: { repo: hearsay-tools/cezarion }
origin: { mergeBase: feb85666…, date: 2026-08-31 }   # fork point; earlier history is out of scope
scans:
  - { date: 2026-09-18, upstreamHead: 4763447f…, since: feb85666…, added: 44, report: scans/2026-09-18.md }
entries:
  - sha: 9ea303eb…
    pr: 967
    title: "fix(runs): make the autonomous auto-continue nudge reachable on both turn-end paths"
    date: 2026-09-12
    status: planned
    fork: { issue: 350 }
    decided: 2026-09-18
    reason: "bug present here: runContinuation never sets autonomous, runAgentStep has no nudge"
    hint: { conflicts: 1 }        # files the 3-way dry run could not apply, at scan time
```

### Statuses

| Status | Meaning | Required fields |
| --- | --- | --- |
| `pending` | seen by a scan, not decided | none |
| `planned` | will be ported | `fork.issue`, `decided` |
| `ported` | re-implemented here | one of `fork.pr` / `fork.commits`, `decided` |
| `partial` | some of it landed, rest open | `fork.pr` or `fork.issue`, `reason`, `decided` |
| `diverged` | same problem, different solution here | `fork.pr` or `fork.commits`, `reason`, `decided` |
| `rejected` | will not be ported | `reason`, `decided` |
| `n/a` | nothing to port (release bumps, upstream-only docs) | `reason`, `decided` |

A `node:test` guard in `.github/scripts/upstream-ledger.test.cjs` validates the committed ledger
against these rules on every `npm run test:unit`, so a `ported` row without a fork link or a
`rejected` row without a reason fails the unit gate.

### Scan

`node .github/scripts/upstream-scan.cjs [--date YYYY-MM-DD] [--no-fetch]`:

1. Fetches upstream `main` into `refs/cez-upstream/main`. **Never a remote**: `gh` prefers a remote
   named `upstream` over `origin`, so adding one silently repoints cezar's own GitHub tab at
   open-mercato/cezar (observed 2026-09-16).
2. Range is `<last scan's upstreamHead>..refs/cez-upstream/main`, or `<origin.mergeBase>..` on the
   first scan.
3. For every commit in the range not already in the ledger: record sha, PR number (from the
   squash subject), title, date, and a conflict hint from `git apply --check --3way` of that
   commit's patch against `HEAD`. Append as `pending`. Existing rows are never touched.
4. Append a `scans` row and write `scans/<date>.md`. Print a JSON summary on stdout.

No new commits means no file changes and `added: 0`.

### Workflow

`.github/workflows/upstream-scan.yml` runs weekly and on dispatch, from the default branch only,
with the trusted-checkout shape the other scheduled workflows use. It runs the scan, and when
`added > 0` commits the ledger and report to `upstream-scan/<date>` and opens a PR against `main`.
Any existing open scan PR is left untouched, never duplicated or overwritten, so reviewer
edits survive reruns. PR creation uses the repository's configured release App token to start
native CI; git pushes and PR lookup keep `GITHUB_TOKEN`. Only generated ledger files qualify
for the docs-only matrix skip, and the unconditional build/package job still validates the
ledger and rendered view. Legacy bot-created PRs need a maintainer close/reopen once after the
fix reaches `main`; diagnostic dispatch does not satisfy required PR checks (#579).
The PR body lists the new rows
with upstream links so the reviewer can decide each one by editing `status`, `fork`, `reason` and
`decided` in the ledger before merging.

### Seed

The first ledger is seeded from the 2026-09-16 review: the 32 commits from the fork point through
upstream 0.11.0 carry decided statuses (all of the 0.10.1 batch is `ported`; the rest are
`planned`, `diverged`, `rejected` or `n/a` with reasons), and the 12 commits that landed since are
`pending` from a real run of the script.

## Resolved assumptions

- Ledger format is YAML, not JSON: humans edit statuses and reasons in it. `yaml` is already a
  dependency of `packages/cezar` and hoisted to the root, which is why the workflow runs `npm ci`.
- Upstream PR numbers are read from the squash-merge subject `(#N)`. A commit without one keeps
  `pr` unset and is still keyed by sha.
- Conflict hints are advisory and dated: the fork moves, so the number is only meaningful for the
  scan that recorded it.
- Pre-divergence history is out of scope. The ledger starts at the merge base.

## Out of scope

Automatic detection of a port from fork PR bodies, cross-linking from fork PRs back to the
ledger, and any cockpit surface. The ledger is a repo file with a test, nothing more.
