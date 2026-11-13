# Continuous integration

`.github/workflows/ci.yml` uses only `pull_request_target` for PR verification on
`main` and `release/**` maintenance branches. Pushes to `main` and manual
dispatch still run CI.
The trusted base defines classification and the required checks; PR code runs
with read-only repository permissions and no publishing credentials. Each PR
has one concurrency group, so a new head cancels its predecessor without a
competing same-head `pull_request` run. Failed or cancelled verification never
satisfies the required aggregate.

The PR-shape classifier checks out only one commit. Fetching every branch and
tag can consume its five-minute job budget before classification. Only the PR
baseline and patch checks read history; § CI verification says what each gate fetches.
For pull requests, the PR-shape check requires GitHub to return a patch for every file, except binary files and files with no content change, and rejects incomplete file lists.

<a id="github-patch-limits"></a>

**GitHub patch limits.** GitHub returns no API patch for a file in three cases. The check
reads the PR's local `git diff` to name the case for each file, and prints the PR's total
changed lines:

- **Per-file size.** The file's diff is over `GITHUB_PATCH_LIMITS.fileBytes` in
  [`.github/scripts/missing-patches.cjs`](../../.github/scripts/missing-patches.cjs), the
  one place the number is kept. It counts bytes, not lines: a one-line file over the bound
  gets no patch either. The value lies between the largest local diff that got a patch
  and the smallest that did not, on this repository's PRs.
- **NUL byte.** The diff contains a NUL byte. Git reads only the start of a file to find
  binary content, so a later NUL leaves the file text to Git but not to GitHub.
- **Total size.** A file under both limits that still has no patch. GitHub may drop
  patches for a very large PR, but no measured PR shows a line bound, so `npm run prepr`
  does not refuse on total size.

`npm run prepr` (§ Before the PR) refuses the first two cases on the committed branch, so
a split happens before the push. Split a file's change across PRs, or generate large data
at test time.

Main PRs start heavy verification (unit tests, build/package, Vitest and browser shards)
as soon as their queue proof, change classification and immutable PR inputs are ready.
**Unit tests (package)** and **Unit tests (scripts)** run the two groups of
`npm run test:unit` in parallel. The root command still runs both in sequence.
**Build and package** runs the build,
packaged test typecheck, packaged CLI tests and release-package checks. All three jobs install
dependencies and run in parallel, including on merge groups and dispatches. A main push
with valid queue proof skips all three; otherwise all three must pass, even for docs-only changes.
Heavy jobs run beside typecheck and cheap deterministic preflight; native review
admission still waits for successful preflight. Review findings no longer hold heavy work back; they block merge
through the aggregate. `verify` (**Unit, build, E2E, and package**) requires
successful preflight, a successful **Automated Code Review** and every heavy
job, so a blocked review fails it even when every suite passes. Both protected
checks remain required. hearsay-tools/cezarion#2211 put review before heavy
work to save paid suite runs; hearsay-tools/cezarion#2727 removed that order
once CodeRabbit and the hosted runners became free for this repository.

CodeRabbit starts automatic draft and incremental reviews on PR changes without
a label filter or custom round cap. Its external review can start before
preflight finishes. Heavy verification does not wait for typecheck or preflight;
the aggregate requires both and current-head review admission. A type error or cheap-gate
failure still fails the required aggregate even though heavy jobs run. The owner accepted automatic review because
CodeRabbit is free for this open-source repository. Both required checks still
gate merge.

Local typechecking starts with `pnpm install --frozen-lockfile` in the checkout being verified,
including nested task worktrees. `npm run typecheck` checks all four workspaces without
writing build output. The web config resolves the server route types from local source,
so missing or stale declarations cannot select an older parent checkout. The
nested-worktree regression runs with `npm run test:unit`. Packaged CLI tests import
built modules; the build/package job checks them with `npm run typecheck:package`
after the application build. The root typecheck also compares tracked and untracked
TypeScript files with the files reached by those invoked compiler configs. It fails
when executable TypeScript falls outside both phases; it does not build or run the
post-build package check.

### Before the PR

<a id="before-the-pr"></a>

`npm run prepr` is the one local gate before a PR opens. It prints one verdict and the
evidence block for the PR body. It reads Squeal's results for the changed files and for
lint, and runs typecheck (not for a docs-only change), citations, clones and the
[GitHub patch limits](#github-patch-limits). Run it on the committed head. Its exit code
is non-zero on a failing test, a lint finding, a type error, a bare citation, a new clone,
or a committed file diff over the per-file patch limit or with a NUL byte.

- The Squeal wait is bounded at 2 minutes (`--wait-ms`). When it ends with no failure,
  the command names the files with no result and passes. CI runs them.
- With no Squeal daemon for the worktree, the command says so and runs
  `npm run test:changed` (unless its selection is the full suite, which is left to CI) and
  `npm run lint`.
- Local `npm run test:parity`, local browser specs and coverage runs are not duties
  before a PR. CI runs them. Run one only to debug a failure.
- The changed-function quality check ([`check-code-quality`](../../.ai/skills/check-code-quality/SKILL.md))
  runs beside the push, not before it, and reuses Squeal's stored results.
- Regression proof ([regression-proof.md](regression-proof.md)) stays: it is part of
  writing the test.

### Local iteration versus final verification

Before adding a YAML, shell or Markdown reader, read [Script readers](script-readers.md).

When Squeal is installed and validating the worktree, use its results during
implementation. It covers unit Vitest, both fast node:test groups, and cockpit
browser E2E in the slow tier. It does not run packaged CLI E2E
(`npm run test:package -- <files>`): run those tests by hand, with or without
Squeal. Pass repo-root paths; the command builds missing or stale outputs. Otherwise use affected tests and
focused browser specs. `npm test` and `npm run test:watch` select only the four
unit projects; Squeal also discovers the browser project from the root config.

The final six-command gate and full-suite runs belong in CI. Do not run the
complete local gate just to commit, open a PR, or complete a review. Record
revision/diff, commands or Squeal status, results, and subsequent changes in the
handoff, and rerun affected checks after later code edits. For an explicitly
requested full local browser run or CI failure investigation, use
`npm run test:e2e:local`: four isolated lanes, about 8 GiB of free RAM.

`test:changed` uses the merge-base against local `origin/main` (falling back to
`main`), plus staged, unstaged and untracked files; it never fetches. Override with
`npm run test:changed -- --base=<ref>`. `--plan` prints the selection and command
without executing it. Ordinary TS/JS source changes use Vitest's import graph.
Contract/configuration/unknown input, removed paths, missing base or failed Git
inspection run full Vitest. Clean changes, and changes confined to CI's docs-only
list (`isDocsPath` in `.github/scripts/change-surface.cjs`, which includes Markdown
under `packages/` outside fixture directories but not the Markdown a test reads),
explicitly skip.
Inspect `--plan` before running it; if it selects the full suite, choose focused
checks and leave full verification to CI. No matching tests fails rather than
reporting a pass; select test files explicitly and report any coverage gap.
This does not cover all runtime dependencies, Node tests, or browser tests and is
not a final gate. `.ai/agentic.config.json` records CI's complete final command list.

#### Squeal wait bound

<a id="squeal-wait-bound"></a>

**A wait for a verdict has a bound.** Squeal's skill says to wait again when
`squeal status --wait` returns on timeout. In this repo, do not wait again. `npm run prepr`
waits at most 2 minutes for the changed files and for lint, then names the files
with no result (the first ten and a count when more) and passes when none failed.

Record the named files and their Squeal state in the PR's Verification. A missing verdict
is covered by CI's shards, which give the full verdict; a failing verdict is never
covered, and the PR does not merge until the shards pass. To check one test file by hand,
run `npm test -- <file> -t '<name>'` and confirm it reports passed tests, not only skipped
ones. This also covers a file Squeal re-runs only because the change edited a document it
reads, for example `AGENT_PROTOCOL.md` prose, which re-runs
`packages/cezar/src/core/harness-parity.test.ts`.

### Clone comparison

`node .github/scripts/check-clones.cjs --base origin/main --head HEAD` scans
committed Git trees: the merge-base and the selected head. Working-tree edits
are outside the measurement. Both trees use trusted installed jscpd tooling,
fixed detection options, and the same source scope and test/fixture exclusions;
candidate config, gitignore files and scripts cannot change those options.

Within a package, each unordered pair of different file paths has a ceiling:
the sum of jscpd's reported duplicated tokens at the merge-base. An equal or
smaller head total passes even when fragments split or change fingerprints.
A larger total or a new reported pair fails; reductions in other pairs cannot
offset it. Removed pairs pass. Renamed files form new pairs. Reported line
counts are diagnostic only: splitting a clone can count a boundary line twice.
This uses jscpd's detected pairs, not an exhaustive comparison of all file pairs.
Moving duplication within one pair can pass within its token ceiling.

Cross-package clones always fail, including inherited copies, except for the
named file pair in the checker's exception list. Within one file, the sum of
reported same-file clone tokens has its own merge-base ceiling. Equal or smaller
totals pass, including re-cut fragments; an increase or a new same-file total
fails. A file cannot borrow allowance from another file or cross-file pair.
Scan/report errors fail the gate. The comparison saves a temporary fingerprint baseline during the
first scan and removes all temporary inputs and reports on exit; it adds no
persistent baseline file or migration.

### Runner regression coverage

A runner lifecycle, input-delivery or attention fix adds shared regression
coverage in the same PR, as [the runner rules](../areas/runners.md#runner-regressions-ship-with-shared-coverage) require.
`packages/cezar/src/core/harness-parity.test.ts` and
`packages/cezar/src/workflows/worker-parent-attention.testkit.ts` run every
`RUNNER_IDS` backend through its own offline wire. Their coverage guards reject
unaddressed new runners; unsupported wire cases carry named executable exemptions.
A focused backend test or injected normalized event supplements this coverage,
but does not replace it. Record the failing mutation and restored passing test
in the PR. These tests run in the existing `npm test` gate, with no new CI job.

### Local worker-count measurement

A local comparison on a 16-CPU host ran the unchanged 444-file / 9,283-test
Vitest inventory twice, sequentially (default first, then `--maxWorkers=4`):

| Invocation | Wall time | User + system CPU time | Result |
| --- | ---: | ---: | --- |
| `npm test` | 188.80 s | 1,360.37 s | 9,283 passed |
| `npm test -- --maxWorkers=4` | 418.22 s | 1,142.88 s | 9,283 passed |

Measured with `/usr/bin/time -p` after installing dependencies and typechecking.
These are single samples with normal host activity, not controlled repeated
benchmarks. They do not establish a universal optimum. Four workers reduced total
CPU time by about 16% but more than doubled wall time here; CI's per-VM four-worker
limit should not be assumed to improve local latency. Use `--maxWorkers=4` when
intentionally trading single-run latency for lower concurrency on a shared host.

### Selected PR tests

On `pull_request_target`, all eight jobs remain present, with the same required
check names and coverage artifacts. Each job resolves the complete selection
before Vitest assigns files to its shard. A small selection can leave some shards
empty; `--passWithNoTests=true` permits those empty partitions only after a
nonempty global selection. An empty global selection runs the full suite.

The unit jobs call `scripts/test-changed.mjs --ci --base=<PR base SHA>` and keep
`--coverage.enabled`. The CI mode uses the existing source classifier, then
Vitest's unsharded `list --changed` inventory to resolve the files. Shared inputs,
configuration, unknown paths, missing history, failed inventory and no matched
file all run full Vitest on eight shards. A failing selected test fails its job;
it never triggers a full-suite retry. The base fetch is bounded to 100 commits.
A missing merge-base costs a full run instead of silently skipping tests.

Browser jobs call `scripts/e2e-affected.mjs --ci`. The selector reads the newest
successful `e2e-spec-map.yml` map on `main`, compares against the map's own commit,
and keeps its existing conservative selection rules. A missing map, failed
selector or empty selection runs every spec on eight shards. Selected browser
runs still require `TEST_E2E_STATUS=passed`; missing browsers fail verification.
The token used to download the map has read-only Actions and repository scopes.

Docs-only, infra-only and verified release-stamp skips remain as before. Merge
groups and manual dispatches run full suites. Main pushes reuse eligible exact-SHA
queue proof or run full CI as a fallback. Merge groups retain the whole-shard
rerun, trusted flake reports and Squeal recording. The local selectors
without `--ci` retain their iteration behavior, including an error on unmatched
unit changes and a skip when no browser spec reaches a change.

### CI verification

The path-filtered `Windows test environment lease` workflow also runs the worker test-app
cleanup regression on native Windows when its cleanup code changes. It checks the pre-fix
failure and the fixed result, including lease and checkout isolation.

Required verification includes the unit groups, build/package and shard jobs,
plus the complexity and clone gates. Typecheck, workflow lint, citations, classification and policy ratchets
feed the `Review preflight` gate. Heavy jobs wait only for their skip inputs:
unit tests and build/package need queue proof and immutable PR inputs; Vitest and browser shards
also need change-surface and PR-shape classification. They run beside typecheck and
preflight. Native review admission follows preflight; `verify` requires all of them. Other events keep their existing test inventory. The eight Vitest shards use the exact Node version in
`.node-version`, the eight cockpit browser shards the current Node LTS; typecheck, unit tests and build/package use
exactly the `engines.node` minimum (Node 24.21.0):

- Eight Vitest shards on `ubuntu-24.04` each install dependencies and run `npm test -- --shard=N/8 --maxWorkers=4` for N=1..8. In merge groups the same command runs under `squeal ci record` (§ Squeal shared results), and in a Squeal gate trial dispatch without `--coverage.enabled` (§ Squeal quality gate trial).
- The required typecheck job uses `blacksmith-2vcpu-ubuntu-2404` (2 vCPU, 8 GB) for PRs and manual dispatches, and `ubuntu-24.04` for pushes and merge groups. It runs pinned workflow lint, issue-citation checking and `npm run typecheck` for all change surfaces, including docs, infrastructure and release bumps. It keeps the minimum-Node setup and its bounded retry.
- Two unit jobs on `ubuntu-24.04` run package unit tests and repository script tests from source on exactly Node 24.21.0. Each installs dependencies and runs beside build/package.
- The build/package job on `ubuntu-24.04` runs on exactly Node 24.21.0. It runs the full application build, packaged CLI E2E typecheck and tests, and release-package dry-run packing. Only the packaged tests and their typecheck read build output. The packaged tests install the tarball, start the CLI and exercise the SQLite run store on the minimum supported Node version.
- Eight cockpit browser E2E shards on GitHub-hosted `ubuntu-latest` each provision the `agent-browser` provider, build and start their own test environment, and run `npm run test:e2e -- --allow-skip --shard=N/8`. Every shard rejects skipped or failed `TEST_E2E_STATUS` logs.

The separate typecheck uses Blacksmith's 3,000 monthly x64 2-vCPU equivalent
minutes. A seven-day sample projects about 2,833 PR/dispatch typecheck jobs per
30 days. One hosted Blacksmith typecheck job passed in 54 seconds; at that
runtime, the projection is about 2,629 equivalent minutes including existing
release verification. If every job took that long and billing rounded each job
up to a minute, the estimate would be 2,921 minutes including releases. Typecheck
itself took 30 seconds on Blacksmith versus 22 seconds on the same-head GitHub
control, so no execution-speed gain is claimed. Rounding and other organization
usage are unknown; this is an allocation estimate, not a guaranteed free bill. See the [allocation report](../benchmarks/ci-runner-allocation-2026-10.md).

On merge groups and manual dispatches, the full Vitest suite runs once across the eight LTS shards. Main pushes reuse eligible exact-SHA queue proof or run full CI as a fallback. PRs select tests as described above. There is no second full-suite floor matrix. The build/package job checks compatibility at the minimum version; it does not claim full Vitest coverage there once current LTS moves on. Its Node setup retains a three-minute step timeout and one retry for stalled downloads (hearsay-tools/cezarion#1214). The LTS sequencer keeps its measured weights, upper-quartile fallback for new files and complete test inventory. Individual test timeouts remain unchanged.

The [four-shard measurement](../benchmarks/vitest-four-shards.md) records the fixed-source
comparison, runner cost, failures and coverage investigation. Four workers per shard,
coverage settings, duration weights and all required gates remain unchanged. Manual
review context still recognizes exact skipped three-shard names from older native
base workflows. Exact-SHA queue-to-main proof requires the complete current eight-shard roster; old
three- and four-shard proof falls back to full verification.

Since hearsay-tools/cezarion#3292 the Vitest and browser suites run on eight shards each,
where four ran before. The setup of a shard (install, build, server start) does not shrink,
so a queue run gets shorter and its runner-minutes rise. `node .github/scripts/queue-metrics.cjs`
reports both. The pull request for that issue records the queue run time before and after.

The legacy floor config, sequencer, reporter and duration manifest remain for PR compatibility. PR CI loads `ci.yml` from the target branch, whose old floor jobs still read these files from the PR checkout. The new workflow has no floor jobs and does not use these helpers. Remove the helpers only after the new workflow reaches the target branch.

The required check keeps its name, **Unit, build, E2E, and package**. It requires
typecheck, both unit groups and build/package on every change surface. Full-matrix changes also
require all eight Vitest shards and all eight cockpit browser shards. Pull requests
and merge groups require the complexity and clone gates. Packaged CLI E2E and
cockpit browser E2E stay separate named checks. The aggregate and snapshot jobs
remain on GitHub-hosted Ubuntu. Develop snapshot publishing still waits for this aggregate. Same-repository
PRs instead run `prepare-pr-snapshot` after verification, packing snapshot
archives without publishing credentials. `publish-pr-snapshot.yml` listens for
completed CI, validates the current open PR head, authoritative run/attempt,
successful verification and preparation, and exact artifact identity. Its trusted
publisher validates package names, snapshot versions, configuration and sibling
pins, repacks validated files into canonical tarballs, then publishes with lifecycle scripts disabled from a clean
directory. Fork PRs cannot publish; no PR code executes with `NPM_TOKEN` or OIDC.
Missing `NPM_TOKEN` produces an explicit dry run. The publisher serializes each
PR's snapshots without cancelling an active publish and rechecks eligibility
after waiting.

Cockpit shards run on separate VMs, each owning its server, `CEZ_HOME`, test-env descriptor and browser namespace. The browser sequencer uses measured durations in `.github/cockpit-test-durations.json` to select each slice; `fileParallelism: false` keeps tests sequential within each shard. The matrix uses `fail-fast: false` so a failure does not cancel evidence from the other shards. The aggregate waits on the entire matrix and requires its result to be `success`.

Local `npm run test:e2e:local` builds once and runs four duration-weighted shards
concurrently, with separate worktrees, app ports, `CEZ_HOME` directories, descriptors,
and browser namespaces. It is the final local full-suite gate and retains lane logs
under `.ai/qa/local-runs/`. A skipped browser exits nonzero there, since it did not
verify the full suite. CI keeps eight separate serial shards on its matrix.
`npm run test:e2e` without arguments still runs the full sequential suite,
with the existing environment reuse. A missing browser exits 3 unless the caller
passes `--allow-skip` to permit exit 0. For iteration use
`npm run test:e2e -- smoke.e2e.ts -t 'test name'`. Optional `--force` and
`--force-rebuild` go only to environment bootstrap; other arguments (including
`--shard=N/M`, spec paths and test-name filters) go to Vitest with quoting preserved.
A literal `--` ends wrapper option parsing. A filtered pass is selection-only
verification, not evidence that the complete browser gate passed.

Runs in the same checkout share one test environment. The wrapper and direct
Vitest/Squeal browser runs hold an exclusive lease through bootstrap, specs and
registry restoration. Another run, standalone bootstrap or shutdown waits up to
300 seconds, then fails without changing the active environment. `--force` does
not bypass a holder. Exited holders are reclaimed using PID and process-start
identity. A surviving build or clone child keeps its command group protected;
a changing or unreadable process list stays protected. The cached server runs
outside that group. On Windows, a named Job Object owns the command and its
children; closing it kills the mutators, while the cached app explicitly breaks
away. Recovery checks the named job before reclaiming its holder. Native Windows
CI verifies shell identity, arguments, overlap, crash cleanup and cache survival.
The disposable lease records
live in `.ai/qa/test-env-lease.sqlite`. Do not delete them while tests run.
Use the isolated local lanes above when parallel browser execution is needed.

The E2E bootstrap builds into the ignored `.ai/qa/build/cezar` mirror
(`.ai/scripts/build-e2e.sh`) and never writes `packages/cezar/dist` or
`packages/cezar/web/dist`, so a production `npm run build` and a browser run no
longer overwrite each other. Local E2E reuse still requires the `.cez-e2e-build`
marker emitted by the same Vite build as the cockpit bundle, which keeps the
browser suite's E2E-only scroll and idle seams present (hearsay-tools/cezarion#649).

The [sequential baseline](https://github.com/hearsay-tools/cezarion/actions/runs/34973823399/job/104396396906) took 13m16s: browser provision took about 6s, dependency install/build 15s, server startup 1s, and Vitest 764.16s (757.50s of tests across 43 files). The first four-shard CI run reduced the longest job to 6m22s; actual wall time depends on file balance and runner queueing.


The [first four-shard run](https://github.com/hearsay-tools/cezarion/actions/runs/34990192576) passed on commit `078ec9e0`:

| Shard | Files | Job wall time | Vitest time |
| --- | ---: | ---: | ---: |
| [1](https://github.com/hearsay-tools/cezarion/actions/runs/34990192576/job/104452542164) | 11 | 6m22s | 349.96s |
| [2](https://github.com/hearsay-tools/cezarion/actions/runs/34990192576/job/104452542189) | 11 | 2m49s | 142.23s |
| [3](https://github.com/hearsay-tools/cezarion/actions/runs/34990192576/job/104452542384) | 11 | 3m49s | 198.56s |
| [4](https://github.com/hearsay-tools/cezarion/actions/runs/34990192576/job/104452542407) | 10 | 2m41s | 132.75s |

Job wall time is GitHub's `startedAt` to `completedAt`, excluding queue time. The longest job fell 52% from the 13m16s sequential baseline; summed browser job time rose from 13m16s to 15m41s (18%). Each shard spent about 17–20s provisioning, building, and starting the server. Shard 1 contains both `github.e2e.ts` (164.24s) and `touch-targets.e2e.ts` (100.57s), so file imbalance limits the gain. These timings describe the initial file-hash split, before duration balancing. This is one successful CI comparison, not a repeated benchmark; a local comparison was abandoned after disposable-clone setup failures.

The balanced GitHub-hosted [run 34995104039](https://github.com/hearsay-tools/cezarion/actions/runs/34995104039) passed with browser job times of 3m51s, 3m45s, 4m00s and 3m45s. The subsequent [Blacksmith 4-vCPU run 35002322591](https://github.com/hearsay-tools/cezarion/actions/runs/35002322591) passed in 3m11s, 3m42s, 2m51s and 3m33s. The owner chose GitHub-hosted runners for browser shards because the 18-second reduction in the longest job did not justify the additional cost. These are single-run measurements with different Node versions and intervening test fixes, not a controlled hardware-only comparison. Duration balancing, current-LTS selection and the test fixes remain in place. Browser setup uses `check-latest: true` with `lts/*` so an older matching version in a runner image cannot silently replace the current LTS patch. The first Blacksmith attempt selected cached Node 24.13.0 instead of the GitHub run's 24.20.0 and failed on all four shards with socket errors; it is retained as a failed comparison, not timing evidence.

Browser sharding now reuses the unit sequencer's longest-first allocator with a separate duration manifest. It assigns each next file to the lightest shard, resolves ties deterministically, and gives new specs the upper-quartile known duration. The manifest never controls discovery, so removed specs are ignored and new specs remain included. The initial browser weights come from the successful run above and predict 203.48–204.95s of tests per shard, before setup; this is an allocation estimate, not a measured balanced CI result. The sequencer only overrides shard allocation, preserving Vitest's normal execution order for local full runs and within each shard.

`refresh-test-durations.yml` refreshes both manifests daily at 04:25 UTC. It reads
up to 100 recent successful `ci.yml` runs and takes the three newest measured
full eight-shard runs for each suite, from `main` pushes or `main` merge groups,
within 14 days. PR selections, skipped shards and exact-SHA proof reuse are not
samples. It reads passed per-file suite summaries, including skipped-test
annotations, and takes each current file's median available duration. Browser
keys are relative to `packages/web/e2e`; unit keys are repository-relative.
`_provenance.runs` records run IDs, commits and job IDs. A new file without a
measurement gets the measured upper quartile and appears in `estimatedFiles`.
Deleted files leave the manifest through the bounded batches below. Fewer than three measured runs leave that
suite's manifest unchanged and appear in the run summary.

The workflow opens one ready PR when the file inventory changes, or when any
median changes by at least **25% and 5 seconds**. Each manifest batch changes
at most 100 entries. It measures the actual Git patch and halves the batch until
the patch fits **40,000 bytes**, well below GitHub's omitted-patch boundary.
Inventory changes go first. Each batch records `baselineCommit`, `updatedFiles`,
its three source runs and `remainingChanges`; weights outside that batch retain
the baseline manifest's measurements. A later run proposes the next batch after
the current PR lands. An entry that cannot fit leaves that manifest unchanged
and appears in the summary. The initial unit backlog therefore converges through
normal reviewed PRs; this browser fix leaves the unit data unchanged.
It leaves an existing refresh
PR for normal CI and review instead of pushing over it. The existing release
App creates the PR so native PR CI and CodeRabbit run. It does not merge the PR.
A manual dispatch defaults to `dry_run: true`; branch dispatches and PR proofs
cannot publish. Use `gh workflow run refresh-test-durations.yml --ref <branch>`
for a read-only proof, and cite the run summary. Required checks never depend
on this maintenance workflow.
The Vitest sequencer assigns discovered tests to shards by measured duration using `.github/test-durations.json`. New files receive the upper-quartile known duration and are always included; deleted files are ignored. The manifest affects balancing only, never discovery. Refreshing its durations can improve balance as the suite changes. Ordinary `npm test` still runs every suite without sharding.

When a PR adds or splits a Vitest unit test file taking longer than about one
minute on CI, add or update its repository-relative path and measured duration
in milliseconds under `durationsMs` in `.github/test-durations.json`. Use the
passed per-file Vitest suite-summary line in the CI log, not an individual test
timing or total job duration; record the source run and commit in provenance.
For split files, measure each resulting file separately. Keep browser E2E weights
in their separate manifest. The paragraph above gives the
sequencer's balancing-only role and upper-quartile fallback for unlisted files.

The push-only `.github/workflows/ci-benchmark.yml` workflow runs controlled experiments on `bench/156-*` branches. It uses a fixed application baseline, records failures and resource usage, and performs publication experiments only as dry runs. Reproduction instructions and retained results are in [the issue 156 benchmark report](../benchmarks/ci-performance-156.md). Automated review remains enabled throughout.

CodeRabbit starts automatic reviews on push, including drafts and incremental changes. `.coderabbit.yaml` clears label filtering and sets `auto_pause_after_reviewed_commits: 0`. The used keys were checked against the live [v2 schema](https://www.coderabbit.ai/integrations/schema.v2.json) on 2026-11-02. The owner removed the custom round/spend cap because this open-source integration is free. Automatic provider execution now starts before preflight; the native admission gate still follows cheap preflight. No review model keys, commands, provider output artifacts, posting schema or PAT fallback remain. Issue intake keeps its independent model integration.

The all-path `reviews.path_instructions` in `.coderabbit.yaml` asks CodeRabbit to
name each finding's concrete defect class, search all changed files, and group all
evidenced file/line locations for that root cause in the same review. For guards,
scanners and parsers whose established validation or safety contract requires it,
the instruction prefers one general fail-closed recommendation with representative
regression cases over separate findings for each unsupported syntax form. It
preserves intentional acceptance of unknown forms where the contract permits it.
These are reviewer instructions, not proof of complete coverage or a guarantee of
fewer review rounds.

The native gate requires trusted classification and applicable baseline, complexity and
clone checks, plus typecheck, workflow lint and citations. Typecheck reads local
source without building. The build/package job checks packaged test types after
the application build.

The classifier, complexity and clone jobs check out one commit. A full-depth
checkout fetches every branch and tag, about six times the size of `main`'s own
history, and took up to 5.4 minutes in queue runs. A merge group fetches only its
head, whose parent is the group base, so its gates read no other history. Pull
requests and dispatches then fetch the full history of the checked-out commit and
`main` (the classifier fetches the workflow commit), because their merge base can
be older. No gate fetches other branches or tags.

The protected **Automated Code Review** check retains its name and native Actions provenance. `review-result` runs trusted base scripts after successful preflight. It requires the newest `CodeRabbit` execution from App `347564` / slug `coderabbitai` on the exact live PR head to be completed/success, or completed/skipped with exact authenticated `output.title` **No files to review**, plus zero unresolved review threads of any author. The named skip is the provider's no-files decision; it does not prove model execution and needs no prior successful check. Outdated threads still block. All other skipped/neutral, missing/pending, failed/spoofed/stale checks and malformed/truncated/changing API pages fail closed. An empty provider `pull_requests` array is allowed; formal review objects never prove execution. The reader rechecks the provider (including its title) and live head before admitting. Requests have 10-second limits within a 60-second read deadline; it does not poll a pending provider forever.

The native review job keeps an unfinished review pending for up to 20 minutes,
with at most 40 fresh admission reads spaced 30 seconds apart. A missing trusted
current-head check gets a 3-minute grace from gate entry, then returns
`provider-missing-timeout` (an in-flight snapshot can add at most 60 seconds).
Queued or running checks retain the 20-minute overall bound, including a running
review that already has open findings. Completed provider results and completed reviews with open threads
return immediately. A snapshot that changes during its read is discarded and
read again; other API/schema/head errors before the overall deadline remain errors. Each snapshot keeps the
60-second read and 10-second request limits, clipped to the overall wait deadline.
The shared reader enforces request cancellation through an abort signal; the
numeric timeout option alone is ignored by github-script v9. The job has a
25-minute limit for checkout, waiting and reporting. This holds an
Actions runner during the wait. Readiness, queue admission and reconciliation
still use the immediate reader. See [the pending-review plan](../../.ai/specs/2026-11-03-coderabbit-pending-plan.md).

Settled blocked admission or an expired provider wait logs a notice and exits unsuccessfully. Existing reconciliation can retry after a late review finishes. Broken API/schema evidence is an error. Findings must not become error annotations because the CI sweep groups identical errors across PRs. Heavy unit, build/package, Vitest and browser jobs do not depend on this gate; they start once their skip inputs are ready and run beside typecheck, preflight and review admission. A blocked gate fails `verify`, which reads the gate and every heavy result. Docs-only and infra-only retain their suite skips but still require review admission. Cancellation never releases heavy work. Both protected checks remain required; branch protections are unchanged.

Readiness is the board half of **Reconcile CodeRabbit admission** (`coderabbit-reconcile.yml`), which absorbed the former **PR Readiness** workflow. Its one per-PR job reads the live PR, the required checks on its head, the native proof and fresh CodeRabbit admission once, then decides both the targeted rerun and the board status. In review needs the latest native `ci.yml` run/attempt with successful protected jobs, and fresh CodeRabbit admission. Until a run of the native **Automated Code Review** check on the head has completed, neither a rerun nor In review can follow, so the job skips the native proof and admission reads. Admission is read only when the native review job has completed or the board could move to In review. Trusted discovery emits PR numbers before scheduling. Every trigger uses the same per-PR job lock, and every surviving job reads the live head and proof after acquiring it. Automatic CI/provider/signal discovery selects only the event's bounded PR targets, with independent jobs and budgets. A check run from any app other than CodeRabbit starts no job: the discovery job's `if:` drops it before a runner starts. Readiness never changes draft state (hearsay-tools/cezarion#3288): agents open PRs ready, and a human's draft stays a draft. The job's only repository write is the targeted native rerun. Under the same lock it syncs the PR and closing-linked issue cards: In review when the PR is ready and its live head is verified, In progress otherwise, a draft included. The board sync runs before the rerun attempt, so a rejected or ambiguous rerun request cannot leave a card In review. The board sync has its own 15-second budget, so a stalled project request delays the rerun by at most that long. Done cards remain protected. An unverified new head moves the cards to In progress; a late synchronize event cannot override current green proof. Human ready/draft events request the same reevaluation. On the next trigger, a new pending same-head execution or reopened thread moves a same-repository PR's cards back to In progress. GitHub Actions has no review-thread event for manual reopening or resolution; dispatch **Reconcile CodeRabbit admission** with `pr_number` after either change, which refreshes both native admission and the board. Fork PRs get no board sync. Reads use a release App installation token, so they spend the App's API budget instead of the repository's `GITHUB_TOKEN` budget. The token asks for read permissions only (Actions, Checks, Contents, Pull requests, Commit statuses; discovery asks for Actions, Checks and Pull requests). Without `RELEASE_APP_CLIENT_ID`, or when the App lacks one of these permissions, the token step fails quietly and reads use `GITHUB_TOKEN`. The App has no Actions write, so the targeted rerun always uses `GITHUB_TOKEN`. Native proof requires an official matching main-target PR association; an empty association fails closed. If it appears, inspect the native run and start fresh native CI rather than substituting a dispatch or unrelated same-head run. Queue admission reads the same fresh provider/thread evidence in addition to its existing native proof, rules and membership checks. Queue suites always run on full-matrix entries. Exact-push reuse keeps its existing proof and snapshot publication rules. `fetch-ci-results.cjs` remains for snapshot consumers.

Bot-authored `release/v*` version-bump PRs skip Vitest, cockpit browser E2E, and automated code review only when all of these hold: PR author is `github-actions[bot]` or the exact bot configured in `RELEASE_APP_BOT_LOGIN`, head is `release/v*`, the live file list matches the release-finalization allowlist (`packages/*/package.json`, `alias-cezarion/package.json`, `pnpm-lock.yaml`), the event head SHA still matches the live PR head, the file-list fetch succeeded in full, and base→head manifests differ only by one shared old→new semver pair (optional caret; same keys/structure — no added scripts, deps, or arbitrary retargets), and the pnpm lockfile stays byte-identical except matching local workspace specifiers (including its pnpm package-manager document).

 The shared check lives in `.github/scripts/release-bump-pr.cjs` (loaded from the trusted base checkout) and feeds CI `classify-pr`; the shared CodeRabbit reader applies the same classifier to complete live files and exact base/head content. The required CI aggregate still runs `typecheck`, `unit-tests` and `build-and-package` and accepts `skipped` for Vitest/cockpit only on that verified shape. The named **Automated Code Review** gate bypasses provider evidence only on that verified shape, and still requires every review thread resolved. A human-authored `release/v*` PR still runs the full matrix and review. Reconciliation never calls a reviewer.

Release finalization creates bump PRs with a repository-scoped GitHub App token,
which emits native `pull_request_target` CI. It waits for that run and never
starts a competing dispatch. The App client only creates the PR; verification
keeps read-only permissions and the required aggregate name stays unchanged.
CI and review recognize the configured `RELEASE_APP_BOT_LOGIN`
as well as legacy `github-actions[bot]` bumps, with the same file and version
checks. See [release App setup](../publishing.md#release-app-setup).

### Pinned actions

Workflows pin each action to a full commit SHA, most with the release tag in a comment
(`uses: owner/action@<commit> # v<version>`). Dependabot (`.github/dependabot.yml`) checks
these actions weekly and opens one pull request that moves every outdated pin, and its
version comment, to a newer release. That includes Squeal's action, which it follows through
Squeal's `v<version>` tags (§ Squeal shared results).

### Checking issue citations

The build/package job's `Check issue citations` step runs
`.github/scripts/check-citations.cjs`. It fails a change that adds a bare `#N`
citation in a comment, a test title or Markdown prose, as
[AGENTS.md § Issue and PR citations](../../AGENTS.md#issue-and-pr-citations) says.
Run it before a PR, from the repository root:

```bash
node .github/scripts/check-citations.cjs               # HEAD against its merge-base with origin/main
node .github/scripts/check-citations.cjs --base <ref>  # against another base
```

Each failure names the file, the line and the qualified forms to use. The check
counts each number's bare citations in the changed files before and after the
change, so rewording or moving a legacy citation passes. It never reads string
literals, code, JSX text, backtick spans, a `#` joined to a word or path,
generated upstream scan files, test-data directories, or a file the change adds
with a historical source note. A change that removes an archive's source note
fails every bare citation left in it. On a PR, the step checks the merge commit
against its first parent (`--base HEAD^1`). A push to `main` skips the step,
because every change reaches `main` through a PR that the step already checked.

### Checking function complexity and file length

Two gates stop long functions and long files from growing (hearsay-tools/cezarion#1800). Neither
changes behavior at shipped defaults.

**Function complexity.** The `complexity-gate` job runs
`.ai/skills/check-code-quality/scripts/complexity-gate.mjs` on the functions a pull request
changes. It fails when a changed function has classic complexity above 20 and is new or more
complex than at the merge base. A pull request can lower a function's complexity, and it never
fails because a function it does not touch is long. A changed function that is lowered but stays
over 20 passes; the job lists it as a notice, and the pre-PR check (`check-code-quality`) still
reports it. A moved or renamed function is compared with
the function it came from: first one with an identical body, then the one same-named function that
shares the most of its body lines, at least half of them. A copy of a long function is still new, and
so is a function that only shares a name with a removed one or has two equally close origins. When
one file holds several same-named functions that the gate cannot tell apart by their place, a changed one
is compared with the one closest by body, or with the least complex when none is closest, so an unclear
origin never hides growth. The job runs the workflow commit's own scripts and reads the pull
request head from Git objects, so no head code runs and a pull request cannot change its own gate.
It uses `github.sha`, not the event's `base.sha`, which stays at the tip from when the PR opened.
`verify` requires it on every pull request and on every merge group.

A merge group runs the same gate on the combined commit, against the base SHA it will land on, so two
pull requests that each stay at or under 20 cannot add up to growth. The scripts come from the group's
base SHA, because `github.sha` there is the combined commit and holds the pull request's own copy. The
`baseline-growth` label is read live from the one pull request that the group's ref
(`refs/heads/gh-readonly-queue/main/pr-<N>-<sha>`) names. The merge count is 1, so each group holds one
pull request at build concurrency 1 or 2. Any other ref reads no label, so growth then fails. The job's name is in the queue proof roster (`REQUIRED_QUEUE_JOBS`).

A failure names each function, both complexity values, the `metrics.mjs` commands that print them
and the decision points (`--breakdown`). Reproduce a run from the repository root:

```bash
node .ai/skills/check-code-quality/scripts/complexity-gate.mjs --base origin/main --head HEAD
```

For an owner-approved increase, the owner adds the `baseline-growth` label, then re-runs the failed
`complexity-gate` job. An agent never adds the label. Auto-merge has no complexity check. CI now
publishes Vitest coverage (§ Vitest coverage artifact); adding CRAP to the gate is a separate change.

**File length.** `npm run lint` pins every non-test source file over 1,000 lines in
`packages/cezar/src/file-length.baseline.json`. The lint bridge lets Squeal re-run the budget
when any counted source file changes. It fails when a pinned file grows, when another file passes 1,000 lines, and when a pin is
stale. After you cut a file, lower its pin:

```bash
FILE_LENGTH_UPDATE=1 npm run lint
```

The update only lowers pins and drops entries. The `Reject baseline growth` step refuses a raised pin
or a new entry, and the same `baseline-growth` label approves one.

A PR that edits `ci.yml` does not run its own definition (see § Proving a `ci.yml` change). A bare
`workflow_dispatch` runs `complexity-gate` on the dispatched branch against `main`, so the
dispatch proves the job too.

### Vitest coverage artifact

Eligible pull request runs and manual dispatches collect V8 coverage in the eight required
`Vitest shard N/8` jobs (hearsay-tools/cezarion#1958). A Squeal gate trial dispatch collects
Squeal's coverage instead and has no V8 artifact (§ Squeal quality gate trial). Each shard runs its tests once, with
`--coverage.enabled`; there is no separate coverage test matrix. Main pushes and merge groups
keep the command without coverage. Docs-only, infra-only, verified queue-proof and bump-PR
runs keep their existing skips.

The optional `Merge Vitest coverage` job uploads `vitest-coverage-<head SHA>`, holding
`coverage-final.json` (Istanbul, paths relative to the repository root, test files included)
and `provenance.json` (tested ref, head and base SHA, run ID and attempt), kept 14 days.
The legacy statistics collector can use this artifact; see
`.ai/skills/check-code-quality/references/tool.md`. The local pre-PR gate runs
Squeal's one-shot check and requires its complete report. It does not reuse this
CI artifact yet; see `.ai/skills/check-code-quality/references/pre-pr.md`.

Test failures, unhandled errors, coverage startup failures and worker failures still fail the
required shard. The coverage-only reporter catches errors from report conversion and writing
on GitHub Actions, emits a warning and removes an incomplete report. It never resets a test
exit code or reruns tests. Local coverage failures remain fatal. Upload and merge steps use
`continue-on-error`; missing reports produce warning annotations and job-summary lines.
The merge job stays outside `verify.needs` and the merge-queue roster.

Coverage now adds time to the required test jobs. PR and dispatch shards have a 25-minute
hang bound, matching the former separate coverage jobs; main has a 20-minute bound, and
merge groups have 40 minutes for a rerun (§ Rerun of a failed queue shard). Removing the duplicate matrix saves three dependency installs, server builds
and test executions. It does not promise a shorter time to the required test verdict.

`.github/scripts/ci-coverage.workflow.test.cjs` pins the event selection, single test run,
optional publication and artifact shape. `.github/scripts/vitest-coverage-tests.test.cjs`
checks real Vitest exit codes when report generation or writing fails, with passing and
failing tests. Coverage remains opt-in locally and keeps test files in the report.
Like any `ci.yml` edit, prove the final workflow with a dispatch (§ Proving a `ci.yml` change).

### Squeal shared results

Merge groups publish their Vitest results for Squeal, so a new worktree at a main commit
can import those passes instead of running the same test files again
(hearsay-tools/squeal spec 018, D8, D9, D13 and D17).

- Every job that runs Squeal sets it up with Squeal's GitHub Action after its Node setup:
  `uses: hearsay-tools/squeal/ci@<commit> # v<version>`, pinned to a full commit SHA like
  every other action, with the release tag in the comment. The action puts `squeal` on the
  `PATH` and runs it with that Node. It never fails the job: when Squeal cannot run, it
  warns, `squeal ci record` runs the command alone with its exit code, and `squeal ci export`
  and `squeal ci publish` warn and exit 0. Only a usage error fails the step
  (hearsay-tools/squeal spec 018 D20).
- In a merge group, each `Vitest shard N/8` job runs its unchanged `npm test` command under
  `squeal ci record --out "$RUNNER_TEMP/squeal-parts" --`. The command's output and exit code
  are the shard's own. The part files upload as `squeal-parts-shard-N`, kept 3 days. When
  Squeal cannot run, the shard runs the plain command with a warning and uploads no parts.
  Other events run the command exactly as before.
- A shard that reruns after a failed first run (§ Rerun of a failed queue shard) records
  the rerun into `$RUNNER_TEMP/squeal-parts-rerun`, and only those parts upload. Each shard
  so has one complete part, which `squeal ci export` needs: it refuses two parts for one
  shard or one file.
- The `Export Squeal results` job (`squeal-export`) runs after all eight shards pass in a
  merge group, with `contents: read` and no stored credentials. It checks out
  `merge_group.head_sha`, installs dependencies, downloads the parts, runs
  `squeal ci export` and uploads `squeal-results.json.gz` as the `squeal-results` artifact,
  kept 3 days. It runs the queued code, so it never holds write access.
- The `Publish Squeal shared results` job (`squeal-publish`) is the only job with
  `contents: write`, and it runs no repository code: no install, build or package script. It
  checks out the same commit with full history and no stored credentials, sets up Node and
  Squeal's action, downloads the export and runs `squeal ci publish --keep 100`.
  That pushes `refs/squeal/<sha>` and deletes refs beyond the newest 100 main commits; it
  runs only git and reads `squeal.config.json`. The token reaches only that step, as a git
  extra header in its environment.
- The `Check the Squeal shared results ref` job (`squeal-ref-check`) runs only in the push
  run for `main`, with `contents: read`. It reads `refs/squeal/<sha>` for the pushed commit
  through the Git API. A missing ref shows a warning annotation and a warning in the run
  summary; a present ref shows a one-line note. An unreadable ref also warns. The job never
  fails, and it is outside `verify.needs`.
- Neither job is in `verify.needs` or the merge-queue roster: their failure never blocks a
  merge. With `shared.ref` in `squeal.config.json`, developers' Squeal daemons fetch the
  nearest published ref.
- The shards and both Squeal jobs read Node from `.node-version` (one exact version), so the
  published results carry the environment developers run. Recording assumes nothing changes
  the tests' input files while the command runs.

`.github/scripts/ci-squeal-results.workflow.test.cjs` pins the event selection, the
unchanged command and exit code, the action's pin and its place after Node in each job, both
jobs' permissions, the publish job's token handling and their absence from required checks.
`.github/scripts/main-ci-escalation.test.cjs` pins the ref check.
Dependabot's weekly actions pull request moves the Squeal pin to a newer `v<version>` tag
(§ Pinned actions). To move it by hand, change the commit and the `# v<version>` comment on
every `Set up Squeal` step in `ci.yml` together; the workflow test requires one pin.

### Squeal quality gate trial

A manual trial measures Squeal's one-shot quality gate on the shards' own evidence, before
any check depends on it (hearsay-tools/squeal spec 020 D13, row 020-08c;
hearsay-tools/cezarion#3096). It runs only on request:

```bash
gh workflow run ci.yml --ref <branch> -f squeal_gate_trial=true
```

- Only a dispatch with `squeal_gate_trial` and no `pr_number` takes the trial. Every other
  dispatch, including the bare proof of a `ci.yml` change (§ Proving a `ci.yml` change) and
  its V8 coverage artifact, is unchanged. Dispatches of one branch share a concurrency group
  and cancel each other, so start the trial after the bare proof ends.
- Each `Vitest shard N/8` runs `npm test -- --shard=N/8 --maxWorkers=4` under
  `squeal ci record`, as in a merge group, but without `--coverage.enabled`: Squeal's coverage
  provider yields to a project's own coverage, so only then does it write coverage records
  into the parts. The shard's output and exit code stay its own. The parts upload as
  `squeal-parts-shard-N`; the run collects and merges no V8 coverage.
- The `Squeal quality gate trial` job (`squeal-gate-trial`) runs after the shards pass or
  fail. It checks out the dispatched commit with the history of main, installs dependencies,
  sets up Squeal's action, downloads the parts and runs
  `squeal code --base origin/main --json --parts <shard directories>`. A selected test file
  whose part certifies its inputs here comes from the parts; the gate runs the others itself,
  for up to 600 seconds.
- Its job summary gives the verdict and exit code, the changed functions by state, how many
  selected test files came from the parts, from the stores and from the gate's own runs, and
  for each shard the recording cost Squeal writes into its parts: Squeal's own time, its share
  of the test time and its time after the command. The `squeal-gate-trial` artifact holds
  `report.json` (`squeal-code-gate/1`), the gate's stderr, exit code and time, kept 14 days.
- Nothing depends on it. The job is outside `verify.needs` and the merge-queue roster, only a
  manual dispatch runs it, every step continues on error and the job sets
  `continue-on-error`. The verdict is reported, not enforced.

`.github/scripts/ci-squeal-gate-trial.workflow.test.cjs` pins the trigger, the job's
permissions, its gate command and its summary.

### Squeal coverage proof

A manual proof checks that Squeal can record its per-test-file coverage beside the project's
own V8 report in one run, without changing that report or adding cost above run-to-run noise
(hearsay-tools/squeal spec 020 D19, row 020-26c; hearsay-tools/squeal#189). It runs only on
request:

```bash
gh workflow run ci.yml --ref <branch> -f squeal_coverage_proof=true
```

- Only a dispatch with `squeal_coverage_proof` and no `pr_number` takes the proof. The rest of
  that dispatch runs as a bare dispatch does, V8 coverage artifact included. Dispatches of one
  branch share a concurrency group and cancel each other, so start the proof after the bare
  proof of a `ci.yml` change ends (§ Proving a `ci.yml` change).
- The `Squeal coverage proof <run>` jobs (`squeal-coverage-proof`) run Vitest shard 1/8, the
  first of the eight shards, three times in parallel on the dispatched commit, each with
  `npm test -- --shard=1/8 --maxWorkers=4 --coverage.enabled`, the shard command of a dispatch.
  `squeal` runs it under `squeal ci record` after Squeal's action, so Squeal reads the V8
  provider's payloads into its parts. `v8` and `v8-control` run it alone; `v8-control` is the
  run-to-run control. Each keeps its exit code, its wall and CPU (user + sys) time, the runner's
  CPU count, CPU model and load, and `coverage-final.json`, and uploads them as
  `squeal-coverage-proof-<run>` with the parts for `squeal`, kept 14 days.
- The `Compare the Squeal coverage proof` job (`squeal-coverage-proof-compare`) runs after the
  three end in any way but skipped. It downloads them and runs
  `.github/scripts/squeal-coverage-proof.cjs`, which writes the job summary and uploads
  `comparison.json` as `squeal-coverage-comparison`, kept 14 days.
- The summary compares covered statements of `squeal` against `v8`, and of `v8` against
  `v8-control`, by source location: statements whose covered state differs and the files they
  are in. A difference between `squeal` and `v8` reads as Squeal's only when it is well above
  the control's. Then it gives the parts' test files with and without a record and why, the
  part header's collector (`v8` expected) and the test files that loaded `node:inspector`;
  then each run's time, the two differences against `v8`, and Squeal's own time from the parts.
- Nothing depends on it. Both jobs are outside `verify.needs` and the merge-queue roster, only a
  manual dispatch runs them, every step continues on error and both jobs set
  `continue-on-error`. The proof never runs on a pull request, in a merge group or on a push.

`.github/scripts/ci-squeal-coverage-proof.workflow.test.cjs` pins the trigger, the three runs,
their artifacts and the steps' scripts; `.github/scripts/squeal-coverage-proof.test.cjs` pins the
comparison.

### Squeal packaged test trial

A manual trial checks whether Squeal's one-shot quality gate can measure code that only the
packaged tests load, with configuration Squeal already supports: a node:test entry with a
`prepare` command, and child-process coverage (hearsay-tools/squeal spec 020 D12 and D15, row
020-32; hearsay-tools/squeal#194). Today `squeal code --base origin/main` reads such functions
as `no-loader`, because no runner lists `packages/cezar/test/e2e`. The trial runs only on request.
To replay the change that hearsay-tools/squeal#194 reports, hearsay-tools/cezarion#3297:

```bash
gh workflow run ci.yml --ref <branch> -f squeal_package_trial=true \
  -f squeal_package_trial_commit=b12aed82bd9e3f7d96d8fd868fd641c9d874b307
```

- Only a dispatch with `squeal_package_trial` and no `pr_number` takes the trial. Every other
  dispatch, including the bare proof of a `ci.yml` change (§ Proving a `ci.yml` change), is
  unchanged. Dispatches of one branch share a concurrency group and cancel each other, so start
  the trial after the bare proof ends.
- Without `squeal_package_trial_commit`, the trial measures the dispatched commit against
  `origin/main`. With a full commit SHA, it measures that commit against its first parent.
- `squeal.config.json` in the repository does not change. The gate reads `prepare` and
  `coverage.children` at the merge base, so the `Squeal packaged test trial` job
  (`squeal-package-trial`) builds two local commits: the merge base, and the measured commit's
  tree on top of it, each with two keys added to its `squeal.config.json`. The keys are a
  node:test entry `test:package` (`npm run test:package` without its wrapper: the `cwd` and
  `argv` of `test:unit`, `include: ["test/e2e/*.test.ts"]`, and `prepare`
  `npm --prefix ../.. run build`, 600 seconds) and `coverage.children: true`.
- The job checks out the local head, installs its dependencies, sets up Squeal's action and runs
  `squeal code --base squeal-package-trial-base --json --timeout 1200`. The gate runs the
  `prepare` build before the first selected packaged test file; its output goes to the log.
- Its job summary gives the measured commit, the verdict and exit code, the changed functions by
  state, each runner's run with its `prepare` result and child coverage files, and a table of the
  changed functions that the packaged tests load or that are not `pass`. The
  `squeal-package-trial` artifact holds `report.json` (`squeal-code-gate/1`), the gate's stderr,
  exit code and time, the two `squeal.config.json` files the gate read and `commits.json`, kept
  14 days.
- Nothing depends on it. The job is outside `verify.needs` and the merge-queue roster, only a
  manual dispatch runs it, every step continues on error and the job sets `continue-on-error`.

`.github/scripts/ci-squeal-package-trial.workflow.test.cjs` pins the trigger, the trial keys
against `scripts/test-package.mjs` and `test:unit`, the local commits, the gate command and the
summary.

### Upstream scan PRs

The weekly upstream scan also creates PRs with the repository's existing release
App token. `GITHUB_TOKEN` still pushes the branch and lists open PRs; the App has
only Pull requests write permission and starts native `pull_request_target` CI
through PR creation. Missing App settings stop creation rather than falling back
to a token that suppresses CI. Existing scan PRs are never overwritten.

The change-surface classifier treats only `.ai/upstream/ledger.yaml`,
`.ai/upstream/LEDGER.md`, and `.ai/upstream/scans/YYYY-MM-DD.md` (including numeric
same-day suffixes starting at `-2`) as scan data eligible for `docs-only`. A complete allowlisted diff skips Vitest and cockpit
browser shards; mixed code changes, unsafe renames, and incomplete API results
keep the full matrix. `unit-tests` stays unconditional, so malformed ledger
entries, missing reports, and an out-of-date render fail the repository script tests and
the required **Unit, build, E2E, and package** check.

A maintainer must close/reopen legacy `GITHUB_TOKEN`-created scan PRs once after
this change reaches `main`, including PR #577. This starts native CI without
changing ledger decisions or branch protection. Confirm the required check on
the current head before merging; a scan rerun will not reopen an existing PR.

### Diagnostic dispatch

Manual dispatch remains diagnostic verification. When `pr_number` is supplied,
both classification jobs resolve the live PR before checkout: its head must match
`github.sha`, use a same-repository `release/v*` branch, target `main` or `develop`,
and be authored by one of those trusted bots. The classifier comes from the
API-reported base SHA. Only a complete manifest-only file list with valid version
stamps allows the bump skip; dispatch never takes the docs-only shortcut.
Missing input, API errors, or mismatches keep the full matrix.

Valid PR-aware dispatch verifies `refs/pull/<N>/merge`; rejected metadata or bare
dispatch verifies `github.sha`. Dispatch shares the PR-event concurrency group,
but its job checks **do not satisfy PR required checks**, even when green on the
right SHA. The legacy helper reports those results as `verified-only` with
`mergeEligible: false`. Use native PR CI to unblock merging; see
[version-bump CI recovery](../publishing.md#recovering-missing-version-bump-ci).

The worker-wait tests are split into three scenario suites with a shared fixture, so the longest indivisible suite no longer constrains shard balance. Case-preservation evidence, the refreshed duration weights and comparative benchmark results are in the [shard-balance report](../benchmarks/shard-balance.md).

The runner selection and three updated split-suite weights were measured together against the same application revision. Three successful matched pairs reduced median queue-inclusive CI verification workflow time from 208 to 178 seconds; weights alone did not improve the GitHub median. The [Blacksmith comparison](../benchmarks/blacksmith.md) retains all runs, cache conditions and failures. These manual-dispatch measurements exclude npm publication, which keeps its GitHub-hosted runner and existing gate.

The release workflow's verification job also uses `blacksmith-4vcpu-ubuntu-2404`, with its existing commands and default Vitest worker policy. Two successful matched release-verification pairs reduced median queue-inclusive job time from 438 to 354.5 seconds; one failure on each provider is retained in the report. Stable and snapshot npm publishing remain on GitHub-hosted runners.

### Proving a `ci.yml` change

A PR that edits `ci.yml`, or a workflow it calls, does not run its own definition.
CI triggers on `pull_request_target`, which loads the workflow from the base branch,
so every check on the PR can pass while a new step never ran. To prove a `ci.yml`
change before merge, push the branch and run `gh workflow run ci.yml --ref <branch>`
without `-f pr_number`, which only bot release PRs take. The dispatched run uses the
branch's `ci.yml` on the pushed head, with the full matrix. It skips both publishing
jobs, so it publishes nothing: `publish-snapshot` runs only on a push to `main`, and
`prepare-pr-snapshot` only on `pull_request_target`. It also skips `review-result` and `queue-review-result`, so it does not exercise provider admission or native reconciliation. The dispatched run does not satisfy the PR's required checks (see
§ Diagnostic dispatch), so cite its run ID in the PR's
Verification section. Run `38979957113` proved the new `Lint workflows` step of
hearsay-tools/cezarion#1199.

Dispatch again after each later edit to `ci.yml` or a workflow it calls. Cite
only a successful run whose head carries the final workflow files. From the
final pushed PR head, compare the cited run's workflow files with `HEAD`:

```bash
sha=$(gh run view <run-id> --repo hearsay-tools/squawk --json headSha --jq .headSha)
git diff --quiet "$sha" HEAD -- .github/workflows/ && echo current || echo stale
```

The lookup must succeed and the run's commit must be available locally; resolve
any lookup or Git error before using the result. `current` means the workflow
files match, not that the run passed or exercised the skipped jobs above.
`stale` requires a fresh dispatch and an updated citation. This directory-wide
comparison also treats edits to unrelated workflows as stale; later commits
that leave the workflow files unchanged do not invalidate the proof.

### Re-running a review

CodeRabbit owns review execution and finding discussion. CI never requests a model review or resolves findings. Push fixes or discuss a finding with its reviewer. A flaky verification failure uses **Re-run failed jobs**, which retains successful review and heavy jobs. **Re-run failed jobs** reruns every failed job: when only the review failed, it reruns the review and `verify`; when a suite also failed, it reruns that suite too. A targeted rerun of the review job alone, as the reconciler does, never reruns a suite.

`coderabbit-reconcile.yml` uses default-branch code and no PR checkout. Its only secret is the optional release App key for the read and board tokens (see readiness under [CI verification](#ci-verification)), and its only write permission is the Actions write needed for targeted retries. It reacts to genuine CodeRabbit check `created`/`completed`, native CI completion, completion of **CodeRabbit review signal**, and the pull-request events the board follows (opened, reopened, synchronize, ready for review, converted to draft). Review/comment events run that no-permission, no-checkout signal in PR merge-ref context. The trusted consumer validates official workflow identity, native event and same-repository signal association. The association selects a stable PR number; queued proof validates the exact live PR head. Signal success, artifacts and comment bodies grant no authority. Missing signal associations fail closed; use manual recovery.

Independent automatic discovery uses official PR associations from the verified native CI run or provider check, or the validated review signal PR number. CI run or signal merge SHAs never filter the live PR head. An empty provider association alone permits the bounded two-page open-main listing, which selects only eligible current heads equal to the verified provider head. Old associated events still wake their PR and read its newest proof. An unassociated stale head with no current match is a no-op. At most four association rows or matching targets are accepted per event; duplicates are removed. Missing/malformed CI/check associations, target overflow and incomplete inventory fail closed with explicit `pr_number` dispatch recovery. Trusted discovery emits only these eligible PR numbers in its matrix. Unrelated PRs receive no native/provider proof work. This bounds target work per event, not the repository-wide hourly token budget; four-way parallelism only bounds concurrency. Each job has its own 120-second deadline and PR-number concurrency lock, with at most four jobs running and fail-fast disabled. The admitted event is a wake hint. Only the trusted PR number enters the queue; each job reads the live head and proves its newest native run at its lock head. Manual dispatch scopes its requested PR. It validates the latest native CI workflow/run/attempt and successful preflight, then reruns only the completed `review-result` job if live admission differs from its result. Equal outcomes are no-ops. Both completion orders work: CI completion catches an earlier provider finish, and provider completion catches an earlier CI finish. On the next admission read, reopened threads and new pending same-head reviews revoke historical green results. For same-repository PRs, provider check completion automatically wakes reconciliation; manual thread reopening or resolution needs a **Reconcile CodeRabbit admission** dispatch with `pr_number`. Fork PRs receive no automated reruns, including from this dispatch. For fork PRs, a maintainer must rerun the native **Automated Code Review** job in Actions after provider completion or a manual thread change. Existing queue fork verification remains supported.

Writes are serialized per discovered PR. The reconciler rechecks admission and native identity before the write, then observes the accepted attempt under a bounded deadline before releasing serialization. It observes both successful and ambiguous POST responses without retrying the write. This is a bounded observation barrier, not a durable cross-execution reservation; unresolved acceptance needs manual inspection before further retries. Inspect the native run if acceptance is not visible. GitHub can coalesce pending jobs for one PR; each surviving job reads live evidence. A and B have independent event discovery and separate PR locks; neither discovery job shares a cross-PR pending slot. Manual `pr_number` dispatch recovers dropped or eventless changes. An old valid event cannot select historical proof; its job independently proves the newest native run. Delivery and scheduling still depend on GitHub, so this is not a lossless-delivery claim. GitHub Actions has no review-thread event for manual reopening or resolution, so neither change triggers readiness or the review signal. After either manual change, dispatch **Reconcile CodeRabbit admission** with `pr_number` to refresh native admission and the board. It cannot restart a disabled workflow, a run at least 30 days old or one at the 50-attempt limit. Promotion requires the step marker **Require fresh CodeRabbit admission and resolved threads**. A green historical **Require fresh CodeRabbit execution and resolved threads** job can only be revoked after fresh validated admission rejects it under both policies, such as a reopened thread, pending provider, latest failure or generic skip. An admitted decision, including no-files, leaves that old green job unchanged. A failed historical job always requires a fresh native run; it cannot be promoted by a retry. This prevents a no-files retry loop after revocation. Admission read errors alone cannot authorize a historical retry. Reusable `automated-code-review.yml` model jobs remain refused in every direction. Reruns keep their original definition and immutable source checkout; push a new head or start a new native run after rollout when promotion needs the new policy. No whole-CI dispatch or model fallback occurs.

### Native review recovery

| Evidence | Recovery |
| --- | --- |
| `provider-missing-timeout`: no trusted check appeared during the 3-minute grace | Post `@coderabbitai full review` on the PR. After the provider completes, let reconciliation retry the native gate. If the event is missed, dispatch **Reconcile CodeRabbit admission** with `pr_number`. The reconciler never requests a provider review. |
| Current-head check queued or running | Let the native gate wait within its 20-minute overall bound. After a late completion, reconciliation can retry it; dispatch with `pr_number` if the event is missed. |
| Current-policy native gate failed, fresh admission now passes | Dispatch **Reconcile CodeRabbit admission** with `pr_number`; it reruns the native gate after fresh preflight, head, run and attempt checks. Equal outcomes are no-ops. |
| `legacy-workflow`: failed historical execution-only or reusable model gate | A targeted rerun keeps the historical workflow definition. Push a new head or start a fresh native PR run using the rolled-out policy. Dispatch does not upgrade historical policy. |
| GitHub API timeout, malformed evidence or changed head | Inspect the failed step and live head. Repair the evidence or transient API failure, then dispatch reconciliation or rerun the failed native job. An API error is not proof of an unsuccessful provider review. Inspect ambiguous rerun acceptance before any retry. |
| Fork PR | A maintainer reruns the native **Automated Code Review** job after provider completion or a thread change; dispatch does not rerun fork jobs. |

The first attempt of [fork PR 2658](https://github.com/hearsay-tools/cezarion/actions/runs/41809519155/attempts/1) failed on an API timeout. [Fork PR 2607's dispatch](https://github.com/hearsay-tools/cezarion/actions/runs/41708168109) refused its historical execution-only gate. These are distinct from a queued/running provider, which the native wait already handles.

GitHub's targeted rerun also reruns the jobs that depend on the review job: `verify` and the jobs after it. No heavy job depends on the review job, so a reconciled review keeps the existing suite results and does not run the suites again. Do not use a review retry to rerun failed tests; use **Re-run failed jobs**.

**Validation limit:** native `pull_request_target` CI uses main's definition until merge. A final-head bare dispatch proves changed verification workflow files but skips admission. The parent must dispatch the final branch before merge. After rollout, use a disposable same-repository draft PR to confirm provider events, finding settlement, both completion orders, revocation, targeted reruns, and manual recovery. Record run, attempt and job IDs and close without merging. Local fixtures do not prove live postmerge provider events, GitHub rerun scheduling or queue semantics.

### Stable release recovery

New GitHub Releases include a commit changelog from the highest preceding stable
ancestor tag to the published source commit, alongside package versions and the
install command. The first release covers all reachable history; oversized lists
show an omitted count and a full-history link. Notes record
the comparison range and are regenerated against it on retry; matching releases
are reused without appending notes or overwriting edits. Legacy metadata-only
releases remain reusable. See [release changelog](../publishing.md#release-changelog).

Stable releases keep the explicitly selected bump. When npm rejects publication,
`scripts/release.mjs` accepts an existing version only if its registry `gitHead`
matches the checkout commit. Missing or different source metadata stops the run
before GitHub finalization. Same-source retries can finish a partially published
set; a new source must wait for the original bump PR to merge before the next bump.
The workflow never overwrites an existing branch or tag. See
[release recovery](../publishing.md#retrying-an-interrupted-release) for the
organization/repository PR permission settings and historical recovery steps.

### Release and Nightly failure reporting

`report-workflow-failure.yml` listens for completed Release and Nightly failures, and for CI runs from pushes to `main` ([main CI repair](main-ci-repair.md)), and files `area-ci` issues with failed-job/step metadata and bounded sanitized diagnostics. It reads the exact failed attempt, so a later retry does not erase the original failure. A job stopped at its `timeout-minutes` is reported as a timeout: Actions records it as `cancelled`, so the listener reads cancelled runs and checks each cancelled job's check-run annotation. Success, cancellation by a person or a concurrency group, intentional skips, and unrelated workflows do not create reports. In a cancelled run, a failed job that starts after the cancellation, such as the `always()` verification gate, does not create a report either. Verification, publishing, finalization, and setup remain distinct in occurrence context. `main-ci-escalation.yml` mentions the repository's admins once on a `main-ci-failure` summary still open after 60 minutes ([main CI repair](main-ci-repair.md#escalation-after-60-minutes)).

A recognized test and its error diagnostic can match across both workflows. Existing open reports receive deduplicated occurrence comments; failures recurring after closure create linked issues. A shared queued concurrency group serializes all issue writes, and durable issue/comment markers support retry after partial API writes. Missing logs still produce metadata reports; reporter failures surface in its own Actions job and summary without changing or retrying the source workflow.

The listener executes trusted default-branch code with Actions-read, checks-read, contents-read, and issue-write permissions. It does not use publishing credentials or depend on issue-intake being triggered. See [failure reporting](../failure-reporting.md) for matching examples, redaction, limits, marker maintenance, and manual recovery. The daily cross-CI sweep described below reuses these reporting conventions.

**Validation limit:** GitHub activates this completion listener only after merge to the default branch. Local fixtures execute the reporting helper and workflow entrypoint, including the original Release incident, Nightly failures, deduplication, partial writes, and concurrent queued deliveries. Observe the first genuine eligible failure after merge and confirm its report; do not deliberately break or rerun a publishing workflow for this check.


### Recurring CI failure sweeps

`sweep-ci-failures.yml` runs daily at 04:23 UTC and supports bounded manual replays
on the default branch. It scans all workflow runs created in a 14-day window,
including historical failed attempts hidden by later successes. Conservative
thresholds require unrelated change contexts; passing retries indicate possible
flakiness, never proof. Reports share the immediate reporter's writer, markers
and queued concurrency group, and reconcile matching remediation issues.

The sweep bounds API calls, logs, writes and runtime. Incomplete coverage fails
visibly and uploads a safe coverage/replay artifact. Overlapping scans rebuild
from GitHub and durable issue markers; missing state does not block startup.
See [failure reporting](../failure-reporting.md#daily-sweep-across-ci-workflows)
for exact thresholds, creation-window limitations, permissions, retention,
positive/negative examples and manual recovery.

Node-side browser-test API requests send `Connection: close`. The synchronous agent-browser commands can block the test process long enough for a fixture server to expire an idle connection before Node handles its close event. CI diagnostics captured reused sockets after 6–23 seconds without an event-loop tick, followed by `UND_ERR_SOCKET`. Fresh connections avoid that stale pool; the real browser and application server keep their normal connection policies. No request retries are added.
Wed Sep 16 13:50:51 CEST 2026

### Merge-queue pilot metrics

The owner reads the parallel queue-build pilot by hand, once a week
(spec `.ai/specs/2026-11-03-speculative-merge-queue.md`, from
hearsay-tools/cezarion#2622, § Rollout step 4).
This command prints its metrics and both rollback verdicts (§ Owner decisions Q3):

```bash
node .github/scripts/queue-metrics.cjs                    # the 7 days before now
node .github/scripts/queue-metrics.cjs --from 2026-11-01 --to 2026-11-03 --json
```

It only reads, through authenticated `gh api` GET and GraphQL query calls, and needs
no configuration. Without `--repo`, it reads the repository name with `gh repo view`.
A date covers its whole UTC day. A `YYYY-MM-DDTHH:MM:SSZ` time is an exact bound.
Run-list and GraphQL search queries cover at most one UTC day each, because
GitHub returns at most 1,000 results per query.

- **Runner-minutes**: the jobs of completed `merge_group` runs of `ci.yml`, each
  rounded up to a whole minute. An `ubicloud-*` label is Ubicloud. A GitHub image
  label (`ubuntu-*`, `windows-*`, `macos-*`) is hosted.
- **Per merge**: divided by the PRs merged in the window that entered the queue.
- **Queue failure rate**: the spec's counting rule. Over completed `merge_group`
  runs, `failure`, `cancelled` and `timed_out` runs divided by all runs. Excluded
  runs count in neither term:
  - **invalidated**: GitHub started a later run for the same PR on another base,
    from the `gh-readonly-queue/main/pr-<N>-<base>` ref, with no queue removal of
    that PR between the two runs;
  - **removed for another cause**: the first queue removal of the run's PR after GitHub
    created the run has a reason other than `failed_checks`, a timeout or `merged`, for
    example `manual` or `merge_conflict`.
- **Invalidated runs**: the runner-minutes of the invalidated runs above are waste.
- **Re-run attempts**: runner-minutes count every attempt. A re-run run's outcome is the
  attempt that ran when its entry ended. A fallback reason uses the attempt the proof read.
- **Main-push proof fallback**: a `main` push run whose Typecheck job ran. The API
  does not return the proof's job summary, so the command rebuilds the reason from
  the evidence `queue-ci-proof.cjs` reads. It prints the URL of each run it cannot
  explain.

### Investigating a CI or load failure

A full local Vitest run (or one shard) that fails only under host load can still
back a PR. Record the load average (`uptime`) and the failed files, rerun those
files (`npm test -- <files>`) until they pass, state both in the PR's
Verification, and let CI's Vitest shards decide. Squeal reports and
`squeal why <check>` output are the same evidence. The rerun is not a full pass;
green CI shards are. A failure in a file the branch touches never qualifies: fix it.

Count a test file's observed CI failure annotations across rerun attempts with:

```bash
node .github/scripts/count-test-ci-failures.cjs live-preview.e2e.ts --repo hearsay-tools/squawk --runs 20
# Or select runs by creation time (inclusive UTC timestamps):

node .github/scripts/count-test-ci-failures.cjs live-preview.e2e.ts --repo hearsay-tools/squawk --since 2026-10-22T00:00:00Z --until 2026-10-23T00:00:00Z
```

The command uses authenticated `gh` reads and defaults to the current repository's
latest 20 `ci.yml` runs. It scans every attempt, including runs whose latest
conclusion is success. Use a literal file name or path; matching uses annotation
paths and titles, not stack references in messages. It prints each matching
failure and separate totals for failing runs, failing attempts and runs scanned.
These are observed annotated failures: no matching annotation does not prove a
test ran or passed, and the count is not a pass rate. Missing data, unfinished
attempts, changed run metadata, GitHub's date-query cap, or the 1,500-request /
12-minute limits produce an incomplete report and exit 1. Narrow the range and
repeat an incomplete scan. This evidence does not replace the reproduction or
before/after verification required for a changed wait.

**Cite a CI failure by run, attempt and job ID**, for example
`run 39253390769 attempt 1, job 118062500873`. "Re-run failed jobs" adds an
attempt to the same run, so a run ID alone can lead a reader to a passing
rerun. `count-test-ci-failures.cjs` prints each failure in this form.

`gh run view <run-id> --log` and `--log-failed` read the latest attempt unless
you pass `--attempt <n>`. `--job <job-id>` does not select that job's attempt:
`gh` reads the latest attempt and takes the job with the same name, so after a
rerun it can show the passing log. Read a failed attempt that a rerun replaced
by its job ID:

```bash
gh api --allow-escape-sequences repos/hearsay-tools/squawk/actions/jobs/<job-id>/logs > job.log
# List the job IDs of one attempt of a run:
gh api repos/hearsay-tools/squawk/actions/runs/<run-id>/attempts/<n>/jobs --jq '.jobs[] | {id, name, conclusion}'
```

Without `--allow-escape-sequences`, `gh api` exits 1 and writes no log.
`gh run view <run-id> --attempt <n> --log-failed` also reads the failed attempt.

**When filing a load-dependent test failure, preserve the diagnostic evidence.**
Quote the full error line verbatim, with nothing cut, including any list after
its `;`. Name the stack frame that throws the error, rather than an operation
named in the message. Give the full log location: the originating repo's
`.ai/cezar/runs/<runId>.ndjson` (or `.ndjson.br`), `squeal why <check>`
with the check identifier and its worktree path, or the CI run, attempt and
job IDs.

Plain text searches do not read Brotli-compressed `.ndjson.br` logs. To read one,
replace `<file.ndjson.br>` with its path:

```bash
node -e "process.stdout.write(require('node:zlib').brotliDecompressSync(require('node:fs').readFileSync(process.argv[1])))" '<file.ndjson.br>'
```

#### One-CPU load reproduction

For a failure that appears under CPU contention, use this optional diagnostic
from the repo root. It needs **Linux**, Bash, `taskset` (util-linux), and GNU
`timeout` (coreutils). Choose a focused test file and name; replace both
placeholders below. This is a controlled reproduction, not a routine test rerun
or a replacement for the failure bundle. With Squeal validating, read its failure
report first and follow its installed skill: use this command only when the
controlled-load result is needed and unknown, not to duplicate background checks.

```bash
# Select the first CPU allowed to this shell, including inside a cpuset.

cpu=$(awk '/^Cpus_allowed_list:/ { split($2, cpus, /[,-]/); print cpus[1] }' /proc/self/status)
LOOPS=2 timeout --kill-after=5s 120s taskset -c "$cpu" bash <<'BASH'
set -eu
pids=()
cleanup() {
  if ((${#pids[@]})); then
    kill "${pids[@]}" 2>/dev/null || true
    wait "${pids[@]}" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
for ((i = 0; i < LOOPS; i++)); do
  sh -c 'while :; do :; done' &
  pids+=("$!")
done
npm test -- <test-file> -t '<test-name>'
BASH
```

The shell, busy loops, test command and its children inherit the same logical
CPU affinity unless a child explicitly changes it. Together they can consume
one logical CPU, not the whole host; other sessions using that CPU still compete
with them. Start with `LOOPS=2`, then increase in small steps only as needed.
For CPU-bound work, the failing host's load average divided by its available
logical CPU count gives a rough starting point for runnable work per CPU.
Each busy loop adds one runnable competitor, and the test adds its own work.
For example, load 48 over 24 CPUs suggests roughly two runnable tasks per CPU,
not an exact prescription of two loops. Load average includes I/O waits; CPU
quotas, priorities and test parallelism also change the result. Record the CPU,
loop count, command, revision and observed outcome. Eight loops reproduced the
reported R24/R25 failures in hearsay-tools/cezarion#1392; it is no universal
threshold or guarantee of reproduction.

Normal completion or test failure runs the EXIT cleanup, which stops and reaps
only the recorded loop PIDs. Ctrl-C uses the same cleanup. The 120-second limit
sends SIGTERM to the command group, including test descendants. If Bash remains
alive five seconds later, GNU `timeout` sends SIGKILL. If Bash exits first,
`timeout` exits too: a descendant that ignores SIGTERM can survive. This bounds
the reproduction command, not every possible descendant. After an interrupted
or timed-out test, check for remaining test processes and stop those you own
before another attempt. A timeout normally returns 124 (or 137 after SIGKILL),
not a test assertion result. Do not add `--foreground`: it would exclude children
from the timeout's group handling. Increase the limit only for a known longer
focused test, and keep it finite. Traps cannot run after SIGKILL of the shell
itself; do not kill the outer timeout to stop the reproduction.

## Single-trigger migration (#371)

The introducing PR removes `pull_request` from its own workflow while the
already-installed `pull_request_target` definition on `main` provides its CI.
The archive publisher becomes active after landing on the default branch; old
CI attempts without prepared archives cannot publish through it. Live evidence
for the introducing PR demonstrates event routing, not execution of its new
target workflow definition. Local regression tests cover both supported base
names, push/manual routing, classification, cancellation and snapshot
eligibility. There was no remote `develop` at migration time; live validation
there is deferred. Create any future `develop` from a revision containing the
target workflow before opening PRs against it.

## Merge queue and exact-commit reuse

CI accepts `merge_group: checks_requested` for `main`. It verifies the immutable
combined commit before merge. Typecheck, citations, complexity, clones, build,
Node tests and packaged CLI tests always run on that commit. The eight Vitest
and eight browser jobs execute the full suites on every full-matrix queue entry.
A selected PR run never serves as full-suite proof for the queue.
Queue runs have no model keys, npm credentials, publishing jobs or OIDC permission.

Before enqueueing, and again in queue admission, use the newest trusted
CodeRabbit check on the current PR head. If it started after the PR's
**first-ever** `ready_for_review` event, it must complete successfully; pending
or failed execution blocks admission. If no execution started after that event,
refuse admission for the shared helper's `POST_READY_SETTLE_MS` (three-minute)
window, then use existing current-head admission. CodeRabbit restarted after
33–40 seconds in two observed cases but did not restart in another, and provides
no signal that it will not re-review. A later ready transition does not reset
the window. The shared reader is `.github/scripts/queue-coderabbit-admission.cjs`;
`land-pr` uses the same order. A non-draft PR with no ready event was opened
ready and uses current-head admission without a cutoff. Agents open PRs ready,
so their PRs take this path and wait for no settle window; a PR opened as a
draft and later marked ready keeps the window. Malformed or unreadable
timeline proof blocks actual-review admission. Existing trusted no-files,
release-stamps and upstream-ledger exceptions remain unchanged.
A new same-head review that is pending blocks admission; the reconciler moves the
PR's cards to In progress and leaves its draft state alone.
See `.ai/specs/2026-11-09-post-first-ready-queue-review.md` and
hearsay-tools/cezarion#3046 for the observed first-ready race.

### Rerun of a failed queue shard

In a merge group, a `Vitest shard N/8` or `Cockpit browser E2E shard N/8` job whose
first test run fails runs the whole shard once more, in the same job and in the same
order. The shard passes only when the rerun passes. Most failed queue entries were
flakes: 34 of 42 passed again with no new commit
(`.ai/specs/2026-11-11-one-full-run-delivery-pipeline.md` § Queue;
hearsay-tools/cezarion#3290).

- The first test step (id `record` in the Vitest job, `e2e` in the browser job)
  continues on error only in a merge group. Pull request runs, `main` pushes and
  dispatches fail on it, as before.
- When it fails, `Reset Vitest's results cache for the rerun` runs
  `.github/scripts/vitest-rerun-reset.cjs`. It writes the test files that failed in the
  first run to `$RUNNER_TEMP/failed-test-files.txt`, one repository-relative path per
  line, and deletes Vitest's results cache under the config root
  (`node_modules/.vite/vitest/`, or `packages/web/e2e/node_modules/.vite/vitest/` for the
  browser config). Vitest's sequencer runs cached failures first and orders the other
  files by cached duration, so without the cache the rerun keeps the first run's order.
- The rerun step (id `rerun`, `Rerun server and cockpit unit suites with Squeal
  recording`; id `e2e-rerun`, `Rerun cockpit browser E2E`) runs the first step's script
  again: the whole shard, not only the failed files, because a failure can depend on
  the state another file leaves. A failed rerun, or a failed reset, fails the entry, as
  a failure does today.
- Before the rerun, the job uploads the list as `failed-test-files-vitest-shard-N` or
  `failed-test-files-cockpit-browser-shard-N`, kept 7 days, only when the first run
  failed. The upload comes first so that a rerun that reaches the job's time limit,
  which cancels every later step, cannot lose it. A run that failed before any test
  file finished leaves the list empty. The browser job also uploads the first run's
  failure bundles as
  `cockpit-failures-first-run-shard-N`, because each spec clears its old bundles when it
  runs again.
- The rerun step's conclusion in the Actions API tells the cases apart: `skipped` when
  the first run passed, `success` when the first run failed and the rerun passed (a
  flake), and `failure` when both failed. The first step's own conclusion cannot: the
  API reports a failed `continue-on-error` step as `success`. The flake reporter reads
  the rerun step (§ Flake reports from the merge queue).
- In a merge group both jobs have a 40-minute limit, room for two runs inside the queue's
  45-minute check timeout. In merge-group runs of 2026-11-11, a Vitest shard's tests took
  up to 16 minutes and a browser shard's up to 13.
- A Vitest rerun records its own Squeal parts (§ Squeal shared results).

`.github/scripts/ci-queue-rerun.workflow.test.cjs` pins the events, the conditions, the
step order, the rerun's Squeal parts, the artifacts and the time limits.
`.github/scripts/vitest-rerun-reset.test.cjs` runs Vitest on a fixture to pin the cache's
place and format and the order the reset gives back.

### Flake reports from the merge queue

A shard that passes only on its rerun lets its entry merge, so nobody would hear about
the flake. `report-queue-flakes.yml` (`Report Merge Queue Flakes`) files a report for it
(`.ai/specs/2026-11-11-one-full-run-delivery-pipeline.md` § Queue, item 6;
hearsay-tools/cezarion#3291).

- **Trusted job.** It starts on every completed `CI` run whose event is `merge_group`,
  after the entry's verdict is settled, and changes nothing in that run. It checks out
  the default branch's head (`github.sha`), never the queued commit, and runs only
  `.github/scripts/report-queue-flakes.cjs` in `actions/github-script`. Its token has
  `actions: read`, `contents: read` and `issues: write`. The shard cannot write the
  report itself: it runs queued code with a read-only token, and a queued PR could forge
  test names.
- **The signal.** It reads the run attempt's jobs through the Actions API. A
  `Vitest shard N/8` or `Cockpit browser E2E shard N/8` job is a flake when its rerun
  step concluded `success`: the rerun runs only after a failed first run (§ Rerun of a
  failed queue shard). A shard whose rerun failed is a failure, not a flake.
- **The names.** It downloads the shard's `failed-test-files-*-shard-N` artifact through
  the Actions API, into memory, with a 64 KiB limit, and never writes it to disk. Every
  attempt of a run uploads under the same name and overwrites the last, and the API
  names no attempt, so it takes only an artifact created while the flaked job ran. It
  reads the archive as untrusted bytes: exactly one `failed-test-files.txt`, stored or
  deflated, valid UTF-8. It keeps only paths with safe characters and a `.test.*`,
  `.spec.*` or `.e2e.*` suffix that are regular files in the merge group's tree, read through the
  Git API (`git/trees/<sha>?recursive=1`). A report quotes each name as code and names
  at most 50.
- **No names.** With no artifact from the attempt, an expired or malformed one, a list emptied by the
  tree check, or a tree too large for one API read, the report says so and names no
  file.
- **One issue per merge group, keyed by test file.** The body carries
  `<!-- cez-flake-file:v1:<path> -->` per file. A file that an open report from
  `github-actions[bot]` already names gets one comment there per run attempt. Every
  other file, and every flaked shard without a name, goes into one new issue with the
  label `flake-report`. The occurrence marker
  `<!-- cez-flake-occurrence:v1:<owner>/<repo>:<run-id>:<attempt> -->` makes a rerun
  of the job write nothing twice: before any write it reads the reports and comments
  of that attempt, on open and closed reports alike. A comment also marks its files
  and shards, so a replay that lost the artifact files no report without names for a
  shard the attempt already reported. The concurrency group `queue-flake-reports` is the
  write lock.
- **Labels.** `flake-report` and `flaky-test` must exist. When a flaked shard needs a
  report and either label is missing, the job fails before any write and names the
  label.
- **What a report starts.** Nothing. A maintainer who confirms the flake adds
  `flaky-test`, and a Squawk automation starts a task to fix or quarantine the test
  ([main CI repair](main-ci-repair.md#flake-reports-from-the-merge-queue)). A report never
  gets `main-ci-failure`, so the main CI repair automation does not take it.
- **Activation order.** Enable the flake automation before anyone adds `flaky-test`. A
  label added before it was enabled starts no task: remove the label and add it again, or
  turn on the automation's **Include existing items** with a lookback that covers it.

`.github/scripts/report-queue-flakes.workflow.test.cjs` pins the trigger, the token, the
trusted checkout, the absence of queued code, and that the jobs, steps and artifacts the
reporter reads are the ones `ci.yml` runs. `.github/scripts/report-queue-flakes.test.cjs`
and `.github/scripts/queue-flake-artifact.test.cjs` cover the reports, repeats, retries,
dropped names and malformed archives.

**Validation limit:** GitHub runs a `workflow_run` listener only from the default branch.
Confirm the first real flake report after the merge; do not force a flake for this check.

### Docs-only queue entries

A merge group classifies its own diff, as native PR CI classifies a PR.
`Classify pull request change surface` checks out the group's `base_sha`, fetches
`head_sha` as Git data, and passes `git diff --name-only --no-renames` between them to
the base's `change-surface.cjs`. A `docs-only` or `infra-only` entry skips the eight
Vitest and eight browser jobs, and the aggregate accepts those skips. Typecheck,
workflow lint, citations, complexity, clones, build, Node tests (including
`agents-md-budget.test.cjs` and the ledger checks) and packaged CLI tests still run
on the combined commit. The bump-PR skip stays off in the queue.

A malformed SHA, a base checkout that is not `base_sha`, a failed fetch or diff, an
empty diff, a classifier failure or an unknown verdict classifies the entry
`full-matrix`.

Native PR test matrices resolve their input once to an immutable merge commit.
For a same-repository PR that contains the trusted workflow's base and whose
head and merge trees match, they test the immutable head instead. A missing or
moved merge input fails input resolution. An unavailable optional ancestry check
keeps the immutable merge checkout.

PR matrices use the selectors described in § Selected PR tests. The queue always
runs both applicable full suites. There is no PR-suite attestation, reuse probe or
reuse receipt. This preserves full-suite proof on the combined commit when a PR
selection misses a runtime dependency.

The required `Automated Code Review` check verifies existing PR-head review
admission. It does not call a model to review combined code. The helper comes
from the group's immutable base SHA. It reads the first two live queue entries,
the build window, and requires exactly one entry whose head and base equal the
group SHAs, at position 1 or 2. At position 2, the position-1 entry's head must
equal the group base, so the build sits on the chain GitHub reports. An entry
that moves from position 2 to 1 during its build, because entry 1 merged, passes
the final reread. It also requires the reviewed queue rules (build concurrency 1
or 2, every other setting exact), an unchanged open non-draft main PR, successful current native `pull_request_target` CI/review from this
repository's `ci.yml`, fresh exact-head CodeRabbit admission, and no unresolved review threads. Dispatches and unrelated
same-name checks cannot supply review admission. Missing or changing evidence
fails closed. GitHub owns queue persistence; no cockpit session is required.

A main push probes official Actions metadata for at most 60 seconds (each request
at most 10 seconds; at most seven pending reads; complete lists limited to 200
records). It reuses only the newest same-repository queue run's latest successful
attempt for the **exact pushed SHA**, after every classifier, verification leaf,
aggregate and review admission job succeeds. A final reread checks for races.
A queue run of a docs-only entry lists each skipped suite once, under its unexpanded
name (`Vitest shard ${{ matrix.shard }}/8`). The probe accepts those two skipped jobs in
place of the sixteen shards only when the pushed commit is docs-only or infra-only by
this check: the queue ref (`gh-readonly-queue/main/pr-<N>-<base SHA>`) names the group
base, the pushed commit's first parent is that base, and the base's `change-surface.cjs`,
run on the diff between them, says `docs-only` or `infra-only`. The checkout fetches
depth 2 for the parent. The pushed commit never supplies the classifier. Any other
parent, a missing base SHA or a classifier failure requires all eight shards, so main
runs its full verification.
Equal trees, ancestors, PR runs, dispatches, artifacts and an older success behind
a newer failure are not proof. With two speculative builds, a group's ref base can
be the previous group head, and one push can advance `main` over two group heads.
The pushed SHA is then the later head, and only its own queue run is proof; the
earlier head's run is not read. Unknown evidence or probe infrastructure failure
runs full main CI. The aggregate records the source run and attempt when it reuses
verification. Snapshot publishing still builds after successful verification and
checks out the immutable pushed SHA, even if the branch has moved.

A full rerun refreshes proof. Re-run failed jobs can retain a prior successful
proof job, just as it retains successful test jobs. That is historical evidence
for the same immutable commit, not a fresh read of a later queue attempt. Use
Re-run all jobs or a bare diagnostic dispatch to demand current verification.
Deleted Actions history loses the optimization and causes full fallback.

### Maintainer activation and rollback

The maintainer enabled the merge queue for normal use on 2026-11-01 after the
live pilot in hearsay-tools/cezarion#2404. Current ruleset `22473654` is active:
squash, two concurrent queue builds, minimum/maximum merge count 1, `ALLGREEN`,
and a 45-minute check timeout (verified 2026-11-05). Queue admission is pending
work, not a completed merge. An agent that requests a merge follows it with
`cezar_wait` using `kind: "pr"`, `until: "merge_or_blocked"`. A rejection that leaves
neither queue membership nor enabled auto-merge wakes it with `blocked` and any
known removal/disable reason. It inspects the PR before retrying under its existing
authority. Dependency agents can keep an ordinary `until: "merge"` wait; queue
removal does not end that wait.

Activation or rollback remains a maintainer action. Before changing the mechanism,
verify that queue head/base semantics match the helper, a failing combined guard
blocks merge, no model calls occur, squash lands the tested SHA, reuse succeeds,
and absent proof forces full fallback. Fixtures do not prove live queue semantics
or equal cost.

The admitted settings are squash, build concurrency 1 or 2 (§ Two speculative builds), minimum/maximum merge count 1, only passing
entries (`ALLGREEN`), and a 45-minute check timeout. Keep both required checks
(`Unit, build, E2E, and package` and `Automated Code Review`) bound to GitHub Actions,
review-thread resolution, strict checks false, all other protections, and no
bypass actors. The admission helper rejects other queue settings, including
build concurrency 3 or more and any merge count above 1. Enable the
queue requirement only after required checks can run. Do not auto-enqueue a
backlog or jump the queue. Confirm external merge tools distinguish enqueueing
from actual merging before adoption; documentation here does not update them.

Normal eligible merges replace main's full matrix with queue verification
before merge plus a metadata probe. Every full-matrix entry runs the full unit/browser suites and the remaining checks fresh. This is a
cost goal, not a guarantee. Rebuilds,
failed groups, retries and fallback add work. Measure queue
wait, verification job-seconds, source attempts, reuse hits and fallback reasons.
If squash does not preserve the SHA, keep full fallback and return to design
review. Do not accept tree equivalence to make the metric pass.

Queue failure, timeout, changed head or removal leaves the PR open. Fix the PR
and pass native checks before re-entry, or explicitly requeue a transient failure.
There is no automatic requeue or paid-review loop. Recovery works without a local
session because GitHub owns both the queue and Actions records.

| State | Trigger | Who fires it | Behavior with proposed defaults |
| --- | --- | --- | --- |
| Queued/building | Combined gate and admission succeed | GitHub | Merge tested entry |
| Queued/building | Failure, timeout, conflict or changed head | GitHub | Remove/rebuild; PR stays open |
| Queued/building | Removal/reorder | Authorized human | Stale group cannot authorize current entry |
| Removed | Fix and enqueue, or explicit transient retry | Human | No automatic retry |
| Main proof pending | Exact complete evidence arrives | Actions API probe | Reuse recorded source attempt |
| Main proof pending | Error, missing history, timeout or mismatch | Probe/job deadline | Full main verification, without a session |
| Main verification | Successful proof or full gate | Actions | Permit snapshot of pushed SHA |
| Main verification | Failure/cancellation | Actions | No publication; normal push reporting |

For an incident, bare workflow dispatch forces full CI without publication.
Reverting reuse restores full verification on future pushes. Queue rollback is
maintainer-owned: inspect active entries, remove only the queue requirement and
restore the behind-main policy. Retain full main CI, both required checks,
review-thread resolution and no-bypass protection.

#### Two speculative builds

The speculative merge-queue spec, `.ai/specs/2026-11-03-speculative-merge-queue.md`
(hearsay-tools/cezarion#2622; on `main` after merge),
lets the queue build two entries at once. Entry 2 is built on entry 1's group
head, and each PR still lands as its own tested commit. Admission accepts build
concurrency 1 or 2, so the code lands before the ruleset change and behaves as
before at 1. The owner changes only `max_entries_to_build` in ruleset 22473654,
after the pre-activation exercise in the spec. Rollback sets it back to 1; it
needs no code revert, because admission accepts both values at every read.

Each group ref names one PR, because the merge count is 1. A group whose entry
is gone, for example after a failure ahead invalidated it, finds no entry with
its head SHA and fails closed.

| # | State / case | Trigger | Who or what fires it | Behavior at k=2 | At rollback (k=1) |
| --- | --- | --- | --- | --- | --- |
| 1 | Two entries building; entry 1 finishes first and passes | Required checks succeed | GitHub | Entry 1 merges; `main` = its group head; main-push proof reuses its run. Entry 2 keeps building on that commit | As today |
| 2 | Entry 2 passes before entry 1 | Entry 2 checks succeed first | GitHub | Entry 2 waits. It merges after entry 1 merges | Cannot happen: one build |
| 3 | Both pass; GitHub pushes `main` straight to entry 2's head | Both green | GitHub | One push. Proof reuses entry 2's run (exact SHA). Entry 1's head gets no own `main` push run. Snapshot publishing covers entry 2's SHA, which contains entry 1 | Cannot happen |
| 4 | Entry 1 fails (flaky or real) | A required check fails | GitHub | Entry 1 removed; PR stays open. Entry 2's group is invalidated and built again on `main`. The old entry-2 run keeps running (Q4) and authorizes nothing | Entry 1 removed; next entry builds |
| 5 | Entry 1 removed by a human | Manual removal | Authorized human | As row 4 | As today |
| 6 | Entry 1 times out (45 min) | Check timeout | GitHub | As row 4 | As today |
| 7 | Entry 1's PR head changes | Push to the PR | Author, then GitHub | GitHub removes entry 1; as row 4 | As today |
| 8 | Entry 2 fails while entry 1 builds | A required check fails | GitHub | Entry 2 removed; entry 1 unaffected. The next queued entry builds on entry 1's group head | Cannot happen |
| 9 | Entry 2's PR head changes, or a human removes it | Push or removal | Author or human | Entry 2 removed; entry 1 unaffected | Not building yet: removed from the queue |
| 10 | Queue reordered or an entry jumps ahead | Human action | Authorized human | GitHub builds again with new groups. A stale group's admission finds no matching entry and fails closed | As today |
| 11 | Entry 2 conflicts with entry 1 | Group commit cannot be built | GitHub | Entry 2 removed with `merge_conflict`; PR stays open | Conflict found when it reaches the head |
| 12 | Entry 1 changes `ci.yml` | PR content | Author | Entry 2's run uses its group head's workflow, which holds entry 1's change. Entry 2 runs full suites, as every full-matrix entry does | As today: the next entry runs the merged workflow |
| 13 | Entry 1 changes the admission or proof helpers | PR content | Author | Entry 2 runs entry 1's helpers from its base (G3). If entry 1 fails, entry 2 is built again on `main`'s helpers | Entry 2 runs them after entry 1 merges |
| 14 | Entry 2 changes `ci.yml` | PR content | Author | Its own run uses the group head's workflow; helpers come from its base; full suites run. Same as today | As today |
| 15 | Ruleset set back to 1 with two entries in flight | Owner edits ruleset 22473654 | Owner | Admission accepts 1 or 2 at every read, so in-flight builds stay valid. If GitHub invalidates entry 2, it is built again later | — |
| 16 | Ruleset set to 3 or more, or batching enabled, without a spec change | Owner edits ruleset | Owner | Admission rejects every entry. The queue fails every build until the owner reverts the setting or this spec and the allowlist change | Same |
| 17 | `main` moves outside the queue | Push with bypass | Nobody: the ruleset has no bypass actors | Cannot happen. If it did, GitHub rebuilds every group on the new `main` | Same |
| 18 | Admission API error, deadline or changing evidence | GitHub API | Actions | Entry fails closed and is removed, so it counts as a queue failure. The PR stays open | As today |
| 19 | Docs-only entry at position 2 | PR content | Classifier | The group diff `base..head` is that PR's own diff, so the skip is valid. Main proof: first parent = ref base | As today |
| 20 | Entry at position 2, native suites passed | — | CI | Full suites run; PR selections are never queue proof | Cannot happen |
| 21 | Entry at position 1 on `main`, PR up to date, entries behind it | — | CI | Full suites run; PR selections are never queue proof | Full suites run |
| 22 | An invalidated run finishes green later | Old run completes | Actions | Its group never merges, and its SHA never reaches `main`. It is counted as waste in the pilot metric | Cannot happen |
| 23 | Manual re-run of a failed queue run | Human | Human | The entry was already removed; the run proves nothing for a new group. Requeue the PR | As today |
| 24 | GitHub reports entry 2's `baseCommit` as `main`, not entry 1's head (S5 false) | GitHub data model | GitHub | Entry 2's admission fails closed on every build. The pre-activation exercise catches this before the pilot. Then the lookup changes to: base = the position-1 head, checked through the ref name | — |
| 25 | GitHub cancels invalidated runs itself | GitHub behavior | GitHub | Less waste than the model; no correctness change | — |

Rows that "cannot happen" at k=1 are why the serial queue never needed them.

### Local ratchet baseline merges

Run `npm run setup:merge-drivers` once per clone to register the `cezar-ratchet`
Git merge driver in repository-local config. Linked worktrees share that config.
Dependency installation does not register it. Setup refuses to replace a different
existing definition. Node must be on PATH when Git merges.

The attributes cover `packages/cezar/src/file-length.baseline.json` and
`.ai/ast-grep/rules/*.baseline.json`. The former shared
`packages/cezar/src/ast-grep-rules.baseline.json` no longer exists.
The driver takes the lower numeric pin or site count, matching AST sites by
`(file, rule, site)`. It keeps additions, and preserves a removal against an
unchanged entry. A removal against a modified entry, conflicting metadata,
duplicate AST identities or unsupported JSON leaves a conflict for manual
resolution. Output keeps the existing schema with stable key ordering.

This merge does not approve baseline growth. Existing CI growth and stale-entry
checks still apply; combined source changes can require another baseline refresh.
Only the owner can approve growth through the existing `baseline-growth` policy.
GitHub does not run this custom driver: resolve server-side conflicts with a local
merge and push. Clones without setup use Git's ordinary merge behavior.

Remove registration with `git config --local --unset-all merge.cezar-ratchet.driver`.
This affects developer Git operations only; it adds no cockpit runtime setting.
