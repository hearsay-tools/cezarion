# Continuous integration

`.github/workflows/ci.yml` uses only `pull_request_target` for PR verification on
`main` and `release/**` maintenance branches. Pushes to `main` and manual
dispatch still run CI.
The trusted base defines classification and the required checks; PR code runs
with read-only repository permissions and no publishing credentials. Each PR
has one concurrency group, so a new head cancels its predecessor without a
competing same-head `pull_request` run. Failed or cancelled verification never
satisfies the required aggregate.

Review polling and recovery use the newest target run for the current head.
They fall back to legacy `pull_request` CI only when no target run exists,
never when target verification failed or was cancelled.

Local typechecking starts with `npm ci` in the checkout being verified, including
nested task worktrees. Both `npm run typecheck:web` and
`npm run typecheck -w @open-mercato/cezar-web` use the web workspace's
`pretypecheck` hook to rebuild the local server declarations before checking web
sources. This prevents missing or stale local declarations from falling back to
an older parent checkout. The full `npm run typecheck` checks web first, then
contract, API client, and server, so it builds declarations once. Direct
`tsc --noEmit` calls bypass preparation; use the npm commands for verification.
The nested-worktree regression runs with `npm run test:unit`.

### Local iteration versus final verification

Use explicit affected tests or `npm run test:changed` during implementation, and
focused browser specs for affected UI flows. Run the final six-command gate once
when implementation stabilizes; reuse recorded success across commit, PR creation,
and review of unchanged inputs. Later code edits require affected gates again;
shared configuration, dependencies, contract changes, or uncertain impact require
the full gate. Review-only/Markdown-only edits do not invalidate runtime results.
The handoff records revision/diff, commands, results and subsequent changes.

`test:changed` uses the merge-base against local `origin/main` (falling back to
`main`), plus staged, unstaged and untracked files; it never fetches. Override with
`npm run test:changed -- --base=<ref>`. `--plan` prints the selection and command
without executing it. Ordinary TS/JS source changes use Vitest's import graph.
Contract/configuration/unknown input, removed paths, missing base or failed Git
inspection run full Vitest. Clean and Markdown-only changes explicitly skip.
No matching tests fails rather than reporting a pass; run `npm test` in that case.
This does not cover all runtime dependencies, Node tests, or browser tests and is
not a final gate. `.ai/agentic.config.json` retains the complete final command list.

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

Verification runs in seven parallel jobs with the current Node LTS:

- Two Vitest shards on `ubuntu-24.04` each install dependencies, build the server, and run `npm test -- --shard=N/2 --maxWorkers=4`.
- The build/package job on `ubuntu-24.04` runs typechecking, Node unit tests, the full application build, packaged CLI E2E tests, and release-package dry-run packing.
- Four cockpit browser E2E shards on `ubuntu-latest` each provision the `agent-browser` provider, build and start their own test environment, and run `npm run test:e2e -- --shard=N/4`. Every shard rejects skipped or failed `TEST_E2E_STATUS` logs.

The required check keeps its name, **Unit, build, E2E, and package**. It succeeds only when the build/package job, both Vitest shards, and all four cockpit browser shards succeed. Packaged CLI E2E and cockpit browser E2E stay separate named checks. The aggregate and snapshot jobs remain on GitHub-hosted Ubuntu. Develop snapshot publishing still waits for this aggregate. Same-repository
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

Local `npm run test:e2e` without arguments still runs the full sequential suite,
with the existing environment reuse and skip-exit-0 behavior. For iteration use
`npm run test:e2e -- smoke.e2e.ts -t 'test name'`. Optional `--force` and
`--force-rebuild` go only to environment bootstrap; other arguments (including
`--shard=N/M`, spec paths and test-name filters) go to Vitest with quoting preserved.
A literal `--` ends wrapper option parsing. A filtered pass is selection-only
verification, not evidence that the complete browser gate passed.

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

Both Codex and Claude automated review wait for the **Unit, build, E2E, and package** verification job in the `ci.yml` pull-request run for the exact head SHA. The selected provider starts only when that job succeeds, while npm snapshot publication can continue independently. Failed, timed-out, cancelled, skipped or inconclusive verification blocks the model job. Standalone CI context collection still reports verification's actual conclusion and failed verification jobs; individual completed-job logs avoid waiting for the whole workflow archive. Missing or unfinished verification stays pending until the bounded wait expires, and ambiguous jobs or job-query errors fail the wait. The context-fetch step rechecks success immediately before model work, so a same-SHA rerun cannot turn a prior successful wait into permission to review a pending or failed build. The wait and both context-fetch scripts still execute from the trusted base checkout. The required CI check and the publication gate are unchanged.

Bot-authored `release/v*` version-bump PRs skip Vitest, cockpit browser E2E, and automated code review only when all of these hold: PR author is `github-actions[bot]` or the exact bot configured in `RELEASE_APP_BOT_LOGIN`, head is `release/v*`, the live file list matches the release-finalization allowlist (`packages/*/package.json`, `alias-cezarion/package.json`, `package-lock.json`), the event head SHA still matches the live PR head, the file-list fetch succeeded in full, and base→head JSON for every listed file differs only by one shared old→new semver pair (optional caret; same keys/structure — no added scripts, deps, or arbitrary retargets).

 The shared check lives in `.github/scripts/release-bump-pr.cjs` (loaded from the trusted base checkout) and feeds CI `classify-pr`, automated review `can_review`, and recovery. The required CI aggregate still runs `build-and-package` and accepts `skipped` for Vitest/cockpit only on that verified shape. Automated review keeps the named **Automated Code Review** check green without a model round when it skips. A human-authored `release/v*` PR still runs the full matrix and review. Manual `workflow_dispatch` of automated review is unchanged.

Release finalization creates bump PRs with a repository-scoped GitHub App token,
which emits native `pull_request_target` CI. It waits for that run and never
starts a competing dispatch. The App client only creates the PR; verification
keeps read-only permissions and the required aggregate name stays unchanged.
CI, review, and review recovery recognize the configured `RELEASE_APP_BOT_LOGIN`
as well as legacy `github-actions[bot]` bumps, with the same file and version
checks. See [release App setup](../publishing.md#release-app-setup).

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

### Recovery after a CI retry

`recover-automated-review.yml` listens for CI completion and reconciles the live open same-repository PR on `main`, its current head, and the newest CI run and exact attempt. Successful aggregate verification can recover an automatic review that failed only at `wait-for-ci`. Snapshot publication's conclusion does not authorize or veto recovery. The normal review path still starts as soon as verification succeeds; the recovery listener runs when the workflow completes.

Recovery reruns the original failed `wait-for-ci` job and its dependent jobs. It does not dispatch a new review or retry CI. Before that API write, it resolves eligibility again: current PR/head/attempt, review activity, posted reviews, bot eligibility, and `AUTOMATED_REVIEW_ROUNDS` (default 3). Successful ancestor outputs retained by GitHub job reruns do not substitute for these fresh checks. Active or completed reviews, same-head reviews, exhausted limits, forks, stale events, and failures in a provider or publisher are skipped with a reason in the workflow log and summary. Manual `workflow_dispatch` review runs remain outside automatic recovery.

The listener also handles automatic-review completion: if CI finished while the original waiter was still failing, that later completion reconciles the successful CI attempt. A failed gate that started after successful verification cannot be recovered again from the same success. Recovery events serialize by head without cancelling an in-flight recovery; the original review retains its PR concurrency, provider selection, and posting safeguards.

The recovery job executes only the default-branch script, with `actions: write` for the rerun API and read access to contents and pull requests. It checks out no PR code, downloads no artifacts, persists no credentials, and has no model secrets. Existing provider jobs remain read-only, and only the separate trusted publisher can write review findings.

**Validation limit:** GitHub loads `workflow_run` listeners from the default branch. A PR changing this listener cannot exercise its new trigger before merge. Local mocked API histories execute the recovery helper and the workflow entry script, including failure→success, changing caps/reviews, stale heads/attempts, duplicates, and completion ordering. They do not prove delivery of a live GitHub event.

**Post-merge observation:** use a dedicated same-repository draft PR against `main`, never a shared PR or a main-branch run. On its next genuine CI failure (or deliberately cancel only that disposable PR's CI run), wait for the original review's `wait-for-ci` to fail. Record the PR head, CI run/attempt, and review run/attempt. Retry that CI run with `gh run rerun <ci-run-id> --failed`; do not push or restart review. After successful verification and CI completion, check the **Recover Automated Review** summary: it must identify that CI attempt and the original review run/job. Confirm the original review has a new attempt, the selected provider alone runs, and exactly one automated review is posted on the unchanged head. Re-run the recovery listener once through GitHub's **Re-run jobs** control: it must explain an active/completed-review skip without another model job or review. Record the run URLs and close the disposable PR without merging. If the CI retry fails again, recovery must remain skipped; do not weaken a test to manufacture success.

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

`report-workflow-failure.yml` listens for completed Release and Nightly failures and files `area-ci` issues with failed-job/step metadata and bounded sanitized diagnostics. It reads the exact failed attempt, so a later retry does not erase the original failure. Success, cancellation, intentional skips, and unrelated workflows do not create reports. Verification, publishing, finalization, and setup remain distinct in occurrence context.

A recognized test and its error diagnostic can match across both workflows. Existing open reports receive deduplicated occurrence comments; failures recurring after closure create linked issues. A shared queued concurrency group serializes all issue writes, and durable issue/comment markers support retry after partial API writes. Missing logs still produce metadata reports; reporter failures surface in its own Actions job and summary without changing or retrying the source workflow.

The listener executes trusted default-branch code with Actions-read, contents-read, and issue-write permissions. It does not use publishing credentials or depend on issue-intake being triggered. See [failure reporting](../failure-reporting.md) for matching examples, redaction, limits, marker maintenance, and manual recovery. The daily cross-CI sweep described below reuses these reporting conventions.

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
names, push/manual routing, classification, cancellation, recovery and snapshot
eligibility. There was no remote `develop` at migration time; live validation
there is deferred. Create any future `develop` from a revision containing the
target workflow before opening PRs against it.
