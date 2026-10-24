# Continuous integration

`.github/workflows/ci.yml` uses only `pull_request_target` for PR verification on
`main` and `release/**` maintenance branches. Pushes to `main` and manual
dispatch still run CI.
The trusted base defines classification and the required checks; PR code runs
with read-only repository permissions and no publishing credentials. Each PR
has one concurrency group, so a new head cancels its predecessor without a
competing same-head `pull_request` run. Failed or cancelled verification never
satisfies the required aggregate.

The review's CI context uses the newest target run for the current head. It
falls back to legacy `pull_request` CI only when no target run exists, never
when target verification failed or was cancelled.

Local typechecking starts with `pnpm install --frozen-lockfile` in the checkout being verified, including
nested task worktrees. Both `npm run typecheck:web` and
`npm run typecheck -w @open-mercato/cezar-web` use the web workspace's
`pretypecheck` hook to rebuild the local server declarations before checking web
sources. This prevents missing or stale local declarations from falling back to
an older parent checkout. The full `npm run typecheck` checks web first, then
contract, API client, and server, so it builds declarations once. Direct
`tsc --noEmit` calls bypass preparation; use the npm commands for verification.
The nested-worktree regression runs with `npm run test:unit`.

### Local iteration versus final verification

When Squeal is installed and validating the worktree, use its results during
implementation. It covers unit Vitest, both fast node:test groups, and packaged
CLI and cockpit browser E2E in the slow tier. Otherwise use affected tests and
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

### Runner regression coverage

A runner lifecycle, input-delivery or attention fix adds shared regression
coverage in the same PR, as required by `AGENTS.md` and `AGENT_PROTOCOL.md` §7.
`packages/cezar/src/core/harness-parity.test.ts` and
`packages/cezar/src/workflows/worker-parent-attention.test.ts` run every
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

### CI verification

Verification runs in eight parallel jobs. Seven use the current Node LTS; the build/package job uses exactly the `engines.node` minimum (Node 24.21.0):

- Three Vitest shards on `ubuntu-24.04` each install dependencies, build the server, and run `npm test -- --shard=N/3 --maxWorkers=4` for N=1..3.
- The build/package job on `ubuntu-24.04` runs on exactly Node 24.21.0. It runs typechecking, Node unit tests, the full application build, packaged CLI E2E tests, and release-package dry-run packing. The packaged tests install the tarball, start the CLI and exercise the SQLite run store on the minimum supported Node version.
- Four cockpit browser E2E shards on `ubuntu-latest` each provision the `agent-browser` provider, build and start their own test environment, and run `npm run test:e2e -- --shard=N/4`. Every shard rejects skipped or failed `TEST_E2E_STATUS` logs.

The full Vitest suite runs once across the three LTS shards. There is no second full-suite floor matrix. The build/package job checks compatibility at the minimum version; it does not claim full Vitest coverage there once current LTS moves on. Its Node setup retains a three-minute step timeout and one retry for stalled downloads (hearsay-tools/cezarion#1214). The LTS sequencer keeps its measured weights, median fallback for new files and complete test inventory. Individual test timeouts remain unchanged.

The legacy floor config, sequencer, reporter and duration manifest remain for PR compatibility. PR CI loads `ci.yml` from the target branch, whose old floor jobs still read these files from the PR checkout. The new workflow has no floor jobs and does not use these helpers. Remove the helpers only after the new workflow reaches the target branch.

The required check keeps its name, **Unit, build, E2E, and package**. It succeeds only when the build/package job, all three Vitest shards, and all four cockpit browser shards succeed. Packaged CLI E2E and cockpit browser E2E stay separate named checks. The aggregate and snapshot jobs remain on GitHub-hosted Ubuntu. Develop snapshot publishing still waits for this aggregate. Same-repository
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
verify the full suite. CI keeps four separate serial shards on its matrix.
`npm run test:e2e` without arguments still runs the full sequential suite,
with the existing environment reuse and skip-exit-0 behavior. For iteration use
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

Browser sharding now reuses the unit sequencer's longest-first allocator with a separate duration manifest. It assigns each next file to the lightest shard, resolves ties deterministically, and gives new specs the median known duration. The manifest never controls discovery, so removed specs are ignored and new specs remain included. The initial browser weights come from the successful run above and predict 203.48–204.95s of tests per shard, before setup; this is an allocation estimate, not a measured balanced CI result. The sequencer only overrides shard allocation, preserving Vitest's normal execution order for local full runs and within each shard.

Refresh browser weights from successful per-file suite summary lines in CI logs (not individual test timings), using filenames relative to `packages/web/e2e`, and update the manifest's provenance with the source run and commit. Keep the unit manifest separate: browser durations and unit durations measure different suites.

The Vitest sequencer assigns discovered tests to shards by measured duration using `.github/test-durations.json`. New files receive the median known duration and are always included; deleted files are ignored. The manifest affects balancing only, never discovery. Refreshing its durations can improve balance as the suite changes. Ordinary `npm test` still runs every suite without sharding.

The push-only `.github/workflows/ci-benchmark.yml` workflow runs controlled experiments on `bench/156-*` branches. It uses a fixed application baseline, records failures and resource usage, and performs publication experiments only as dry runs. Reproduction instructions and retained results are in [the issue 156 benchmark report](../benchmarks/ci-performance-156.md). Automated review remains enabled throughout.

Automated code review runs inside the `ci.yml` pull-request run, as the `review` job that calls `automated-code-review.yml` with `needs: verify`. GitHub starts it only when the **Unit, build, E2E, and package** job succeeds, so no runner sits polling for CI. Failed, cancelled or skipped verification leaves the review skipped. The model jobs still run on the trusted base's scripts, and their context fetch rechecks that verification succeeded for the exact head SHA immediately before model work. Standalone CI context collection still reports verification's actual conclusion and failed verification jobs; individual completed-job logs avoid waiting for the whole workflow archive. Ambiguous jobs or job-query errors fail the recheck.

Codex reviews keep a 12-minute action limit for smaller PRs. At 3,000 added plus
deleted lines or 50 changed files, the action gets 24 minutes. Unavailable or
invalid sizing also gets the bounded 24-minute budget. The Codex job has a
30-minute limit, leaving time for setup and artifact publication. Model, effort,
round limits and full-PR review scope do not change. Large or stuck reviews can
therefore spend twice the previous maximum action time; ordinary reviews return
earlier.

The action retains `continue-on-error`: it can finish writing its review and
then hang (openai/codex-action#150). A complete output object is still uploaded
after the action times out, then passes through the existing trusted schema and
head-SHA validator. Missing or malformed output never counts as a review. When
Codex fails without output, **Review verdict** reads the current run attempt's
Codex check annotations. A confirmed action timeout names the timeout and prints
`gh run rerun <run-id> --failed --repo <owner>/<repo>` in the log and step summary.
Other failures are not called timeouts. Unavailable annotation evidence keeps
the verdict failed and identifies the diagnostic gap. These reads use only
`actions: read` and `checks: read`; the diagnostic job has no write permissions.
The budget and diagnostic helper comes from the trusted workflow revision, so a
manual branch dispatch exercises that branch's policy without running PR code
with diagnostic permissions.

The required **Automated Code Review** check is the `review-result` job in `ci.yml`, because a called workflow's jobs show as `Review / <job>`. It succeeds only when the called review succeeds. The called workflow's **Review verdict** job carries the reasons: new finding threads, still-open threads, or a failed provider or poster. Findings and open threads are logged as notices, not error annotations, because the CI failure sweep groups identical error lines across PRs and open findings are not CI failures. A broken review (a failed provider or poster, or missing thread counts) still logs an error. Outside a pull request into `main` the job is skipped under another name, since a skipped job reports success and must never satisfy the required check. Open findings therefore fail the whole CI run. Snapshot publication still proceeds, because it reads the verification and preparation jobs, not the run's conclusion; it does start only after the review finishes.

Every job in this run can upload artifacts, including jobs that build PR code, such as `prepare-pr-snapshot`, which runs alongside the review. The poster therefore downloads the review output by the artifact ID the provider job reported, never by name, and fails when that ID is missing. Model keys reach only this call: `ci.yml` passes `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` explicitly, never `secrets: inherit`, and only the matching provider job references each key.

Bot-authored `release/v*` version-bump PRs skip Vitest, cockpit browser E2E, and automated code review only when all of these hold: PR author is `github-actions[bot]` or the exact bot configured in `RELEASE_APP_BOT_LOGIN`, head is `release/v*`, the live file list matches the release-finalization allowlist (`packages/*/package.json`, `alias-cezarion/package.json`, `pnpm-lock.yaml`), the event head SHA still matches the live PR head, the file-list fetch succeeded in full, and base→head manifests differ only by one shared old→new semver pair (optional caret; same keys/structure — no added scripts, deps, or arbitrary retargets), and the pnpm lockfile stays byte-identical except matching local workspace specifiers (including its pnpm package-manager document).

 The shared check lives in `.github/scripts/release-bump-pr.cjs` (loaded from the trusted base checkout) and feeds CI `classify-pr` and automated review `can_review`. The required CI aggregate still runs `build-and-package` and accepts `skipped` for Vitest/cockpit only on that verified shape. Automated review keeps the named **Automated Code Review** check green without a model round when it skips. A human-authored `release/v*` PR still runs the full matrix and review. Manual `workflow_dispatch` of automated review is unchanged.

Release finalization creates bump PRs with a repository-scoped GitHub App token,
which emits native `pull_request_target` CI. It waits for that run and never
starts a competing dispatch. The App client only creates the PR; verification
keeps read-only permissions and the required aggregate name stays unchanged.
CI and review recognize the configured `RELEASE_APP_BOT_LOGIN`
as well as legacy `github-actions[bot]` bumps, with the same file and version
checks. See [release App setup](../publishing.md#release-app-setup).

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
keep the full matrix. `build-and-package` stays unconditional, so malformed ledger
entries, missing reports, and an out-of-date render fail its Node unit tests and
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

### Re-running a review

A flaky verification failure needs no separate recovery workflow. **Re-run failed jobs** on the CI run reruns the failed shards, `verify`, and every job downstream of it, including the review. The poster reads the PR's reviews and live head again just before posting, so a rerun never exceeds `AUTOMATED_REVIEW_ROUNDS`, never posts a second review on one head, and never posts on a stale head.

After resolving findings by hand, re-run **Review / review-round** in the PR's CI run rather than the whole run. That reruns the round and every review job after it. An unchanged patch skips the model and only recounts the open threads.

Pushback replies need the model to judge them. Re-running the round does not do that: the patch-ID guard skips the model on an unchanged patch. Instead, run `automated-code-review.yml` manually (`workflow_dispatch`) with `pr_number`. A manual review skips the patch-ID guard and the round cap, judges every earlier thread including its replies, and resolves the addressed ones. Its checks attach to the dispatched branch, not the PR head, so afterwards re-run **Review / review-round** in the CI run to recount the required check.

**Validation limit:** `pull_request_target` loads `ci.yml` from the base branch, so the PR introducing this layout is reviewed by the previous standalone workflow. After it merges, use a disposable same-repository draft PR: confirm one green run with a single posted review, then fail one verification job on purpose and confirm that **Re-run failed jobs** runs the review once verification passes. Record the run URLs and close the PR without merging.

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

`report-workflow-failure.yml` listens for completed Release and Nightly failures, and for CI runs from pushes to `main` ([main CI repair](main-ci-repair.md)), and files `area-ci` issues with failed-job/step metadata and bounded sanitized diagnostics. It reads the exact failed attempt, so a later retry does not erase the original failure. A job stopped at its `timeout-minutes` is reported as a timeout: Actions records it as `cancelled`, so the listener reads cancelled runs and checks each cancelled job's check-run annotation. Success, cancellation by a person or a concurrency group, intentional skips, and unrelated workflows do not create reports. In a cancelled run, a failed job that starts after the cancellation, such as the `always()` verification gate, does not create a report either. Verification, publishing, finalization, and setup remain distinct in occurrence context.

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

CI accepts `merge_group: checks_requested` for `main`. It tests the immutable
combined commit with all eight verification jobs, including the minimum-version
build/package job and browser E2E. Queue runs never use docs/infra or release-bump exemptions. They have no
model keys, npm credentials, publishing jobs or OIDC permission.

The required `Automated Code Review` check verifies existing PR-head review
admission. It does not call a model to review combined code. The helper comes
from the group's immutable base SHA. It requires the first live queue entry to
match both group SHAs, effective serial queue rules, an unchanged open non-draft
main PR, successful current native `pull_request_target` CI/review from this
repository's `ci.yml`, and no unresolved review threads. Dispatches and unrelated
same-name checks cannot supply review admission. Missing or changing evidence
fails closed. GitHub owns queue persistence; no cockpit session is required.

A main push probes official Actions metadata for at most 60 seconds (each request
at most 10 seconds; at most seven pending reads; complete lists limited to 200
records). It reuses only the newest same-repository queue run's latest successful
attempt for the **exact pushed SHA**, after every classifier, verification leaf,
aggregate and review admission job succeeds. A final reread checks for races.
Equal trees, ancestors, PR runs, dispatches, artifacts and an older success behind
a newer failure are not proof. Unknown evidence or probe infrastructure failure
runs full main CI. The aggregate records the source run and attempt when it reuses
verification. Snapshot publishing still builds after successful verification and
checks out the immutable pushed SHA, even if the branch has moved.

A full rerun refreshes proof. Re-run failed jobs can retain a prior successful
proof job, just as it retains successful test jobs. That is historical evidence
for the same immutable commit, not a fresh read of a later queue attempt. Use
Re-run all jobs or a bare diagnostic dispatch to demand current verification.
Deleted Actions history loses the optimization and causes full fallback.

### Maintainer activation and rollback

This implementation does not enable the queue or change repository protections.
Until a maintainer activates it, the existing behind-main merge policy remains.
Before activation, verify in a controlled GitHub repository or equivalent safe
exercise that first-entry head/base semantics match this helper, a failing
combined guard blocks merge, no model calls occur, squash lands the exact tested
SHA, reuse succeeds, and absent proof forces full fallback. Fixture tests and a
branch dispatch do not prove live queue semantics or equal cost.

After the implementation lands and that evidence is accepted, proposed settings
are squash, build concurrency 1, minimum/maximum merge count 1, only passing
entries (`ALLGREEN`), and a 45-minute check timeout. Keep both required checks
(`Unit, build, E2E, and package` and `Automated Code Review`) bound to GitHub Actions,
review-thread resolution, strict checks false, all other protections, and no
bypass actors. The admission helper rejects other queue settings. Enable the
queue requirement only after required checks can run. Do not auto-enqueue a
backlog or jump the queue. Confirm external merge tools distinguish enqueueing
from actual merging before adoption; documentation here does not update them.

Normal eligible merges replace main's full matrix with the same full matrix
before merge plus a metadata probe. This is a cost goal, not a guarantee. Rebuilds,
failed groups, retries, docs-only entries and fallback add work. Measure queue
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
