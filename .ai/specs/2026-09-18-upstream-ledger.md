# Upstream ledger

Status: accepted · Date: 2026-09-18 · Relates: `.ai/upstream/`, `.github/scripts/upstream-ledger.cjs`, `.github/scripts/upstream-targets.cjs`, `.github/scripts/upstream-reachability.cjs`, `.github/workflows/upstream-scan.yml`

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
   squash subject), title, date, and a conflict hint from `git apply --check --3way --cached` of
   that commit's patch against a private index holding the committed `HEAD`, built once per scan
   in a temp directory and removed afterwards, so nothing uncommitted in the checkout changes the
   count. Append as `pending`. Existing rows are never touched.
4. Append a `scans` row and write `scans/<date>.md`. Print a JSON summary on stdout.

No new commits means no file changes and `added: 0`.

### Port start check

A scan's `note` and `hint` describe the fork when the scan ran. Port issue
hearsay-tools/cezarion#438 was planned from such a note. By the time the port started, the
component it named was reachable only from tests, and nine fork commits had touched it. Nothing
re-checked the targets when the port began (hearsay-tools/cezarion#1002).

`node .github/scripts/upstream-scan.cjs targets <sha>… [--no-fetch]` does that check. Each argument
is a ledger sha prefix that must match exactly one row. A commit missing locally is fetched into
`refs/cez-upstream/main` with the scan's own fetch, never through a remote. The command prints a
Markdown report with one section per commit, in the order given, and exits 0 whenever the report
printed. It exits 1 with one line on stderr for no arguments, an unknown or ambiguous prefix, an
invalid ledger, or a git failure. A first argument that is not `validate`, `render` or `targets`
exits 2 with a one-line usage message before git or the filesystem is touched; only no argument
at all runs the scan, which fetches and rewrites the ledger.

The fork side is the checkout's committed `HEAD`, resolved to one commit sha when the command
starts, and every verdict describes that commit, even if another commit lands mid-run. Existence
and drift read it directly. The dry run and reachability read a snapshot of it built in a temp
directory outside the repository: a private `GIT_INDEX_FILE` loaded with `git read-tree <sha>`, which
`git apply --check --3way --cached` reads, and the files reachability needs, checked out of that
index with `git checkout-index`. Uncommitted changes, staged or not, are ignored, the real index
and work tree are never written, and the temp directory is removed whether the run succeeds or
fails. Only `ledger.yaml` is read from the work tree, so a local, uncommitted row still works.

The baseline is the first parent of the commit that added the row's full sha to `ledger.yaml`
(`git log --reverse -S<sha> HEAD -- .ai/upstream/ledger.yaml`). The ledger schema does not change. A row `HEAD` never committed has no baseline, and its drift
reads `unknown`, never "no change".

The file list comes from the upstream commit's own diff. A rename is judged by its old path,
because that is where the fork's code would be. Each file gets four columns: whether the path
exists at `HEAD` (and, when it does not, the last fork commit that touched it), reachability,
drift since the baseline (non-merge commits and line churn), and a per-file 3-way dry run against
`HEAD`. Churn comes from the whole `baseline..HEAD` diff, so it shows even beside `0 commits`: a
merge commit can change a file no non-merge commit touched. Three flags summarise them:

- `test-only`: reachability is `test-only`.
- `missing`: upstream modifies, deletes or renames a path that does not exist at `HEAD`.
- `drifted`: at least one fork commit touched the path since the baseline.

Reachability is one in-memory esbuild bundle (`write: false`, `metafile: true`); its inputs are
the production-reachable files. The roots are each `packages/*/index.html` module script (the
cockpit's `src/main.tsx`) and the `bin` and `exports` of every published manifest, mapped from
`dist/*.js` to `src/*.ts`. Repo scripts (root `scripts/*.mjs` and `packages/*/scripts/*.{mjs,cjs,js}`,
tests excluded) that load a package's built `dist/x.js`, by static import or `new URL(…,
import.meta.url)`, make its `src/x.ts` a root too; the scripts themselves are not bundled.
The private `contract` and `api-client` packages are not roots: they
count only when web or the CLI imports them, and they bundle from source. Files the CLI starts by
path through `new URL(…, import.meta.url)` become further roots until the set stops growing.
Each TypeScript file also keeps its type-only imports, which esbuild would otherwise erase,
so a module used only for its types still counts as reachable. Every other bare specifier stays
external, and CSS, assets and Vite `?query` data imports load as empty modules. Only non-test
source files under `packages/*/src/` are judged; everything else reads `n/a`.

A broken check must not produce false flags. When esbuild is missing, finds no entry points, or
fails, every judged file reads `unknown`, never `test-only`, and the report's first lines say why.
When the `HEAD` snapshot cannot be built, reachability and the dry run read `unknown` the same
way, with the reason.

The pure half (the per-file dry-run parser, path classification, `new URL` extraction, flags and
the renderer) lives in `.github/scripts/upstream-targets.cjs`; the bundle in
`upstream-reachability.cjs`; git in `upstream-scan.cjs`. `upstream-targets.test.cjs` covers each
part, runs the bundle on the real tree, and drives the command against a fixture repository.

### Workflow

`.github/workflows/upstream-scan.yml` runs weekly and on dispatch, from the default branch only,
with the trusted-checkout shape the other scheduled workflows use. It runs the scan, and when
`added > 0` commits the ledger and report to `upstream-scan/<date>` and opens a PR against `main`.
Any existing open scan PR is left untouched, never duplicated or overwritten, so reviewer
edits survive reruns. PR creation uses the repository's configured release App token to start
native CI; git pushes and PR lookup keep `GITHUB_TOKEN`. Only generated ledger files qualify
for the docs-only matrix skip, and the unconditional build/package job still validates the
ledger and rendered view. Legacy bot-created PRs need a maintainer close/reopen once after the
fix reaches `main`; diagnostic dispatch does not satisfy required PR checks (hearsay-tools/cezarion#579).
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
