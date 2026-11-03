# Continuous integration

`.github/workflows/ci.yml` uses only `pull_request_target` for PR verification on
`main` and `release/**` maintenance branches. Pushes to `main` and manual
dispatch still run CI.
The trusted base defines classification and the required checks; PR code runs
with read-only repository permissions and no publishing credentials. Each PR
has one concurrency group, so a new head cancels its predecessor without a
competing same-head `pull_request` run. Failed or cancelled verification never
satisfies the required aggregate.

Main PRs run cheap deterministic preflight, automated review, then heavy
verification. Findings block heavy work. Both protected checks remain required.
Native review context is bound to the trusted caller event, workflow, run,
attempt and live head. It reports heavy tests as pending, not successful.
Manual review context reads only the newest current-head native run and its
latest attempt. Missing evidence stays pending; failure/cancellation never
falls back to an earlier success. When the current attempt proves that review
failed and all heavy jobs were skipped, it reports heavy verification as not
started because review blocked it. The failed aggregate remains a merge blocker;
it does not mean tests ran and failed.

CodeRabbit starts automatic draft and incremental reviews on PR changes without
a label filter or custom round cap. Its external review can start before
preflight finishes. Heavy verification still waits for successful preflight and
current-head review admission. The owner accepted automatic review because
CodeRabbit is free for this open-source repository. Both required checks still
gate merge.

Local typechecking starts with `pnpm install --frozen-lockfile` in the checkout being verified,
including nested task worktrees. `npm run typecheck` checks all four workspaces without
writing build output. The web config resolves the server route types from local source,
so missing or stale declarations cannot select an older parent checkout. The
nested-worktree regression runs with `npm run test:unit`. Packaged CLI tests import
built modules; the build/package job checks them with `npm run typecheck:package`
after the application build.

### Local iteration versus final verification

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

The path-filtered `Windows test environment lease` workflow also runs the worker test-app
cleanup regression on native Windows when its cleanup code changes. It checks the pre-fix
failure and the fixed result, including lease and checkout isolation.

Required verification has ten verification jobs, plus the complexity and clone
gates. Typecheck, workflow lint, citations, classification and policy ratchets
feed the `Review preflight` gate. On PRs into main, the other nine jobs wait for
the protected review result. Other events keep their existing test inventory. Eight test jobs use the current Node LTS; typecheck and build/package use
exactly the `engines.node` minimum (Node 24.21.0):

- Four Vitest shards on `ubuntu-24.04` each install dependencies, build the server, and run `npm test -- --shard=N/4 --maxWorkers=4` for N=1..4.
- The required typecheck job uses `blacksmith-2vcpu-ubuntu-2404` (2 vCPU, 8 GB) for PRs and manual dispatches, and `ubuntu-24.04` for pushes and merge groups. It runs pinned workflow lint, issue-citation checking and `npm run typecheck` for all change surfaces, including docs, infrastructure and release bumps. It keeps the minimum-Node setup and its bounded retry.
- The build/package job on `ubuntu-24.04` runs on exactly Node 24.21.0. It builds server declarations, then runs Node unit tests, the full application build, packaged CLI E2E typecheck and tests, and release-package dry-run packing. The explicit server build preserves the preparation that typecheck supplied before the split. The packaged tests install the tarball, start the CLI and exercise the SQLite run store on the minimum supported Node version.
- Four cockpit browser E2E shards on `ubicloud-standard-2` (2 vCPU, 8 GB RAM, Ubuntu 24.04 x64) each provision the `agent-browser` provider, build and start their own test environment, and run `npm run test:e2e -- --allow-skip --shard=N/4`. Every shard rejects skipped or failed `TEST_E2E_STATUS` logs.

The Ubicloud trial moves only the four browser CI shards to the lowest x64 tier,
`ubicloud-standard-2`. The Vitest and coverage trials on that tier hit the existing
15-minute job and 20-minute coverage limits, so those suites stay on GitHub-hosted
Ubuntu. Compare browser job times after the switch before changing shard counts
or worker limits. Other jobs, including nightly verification, keep their existing
runners. The trial changes no test command, worker count, timeout or required check.

An independent, optional `Warm Ubicloud dependency cache` job installs dependencies
on Ubicloud on every push to `main`, even when queue proof skips verification.
Ubicloud's cache is separate from GitHub's and restores only from the current
branch or the default branch. Seeding `main` lets task and merge-queue branches
reuse its pnpm cache while keeping cache branch protection enabled. The job uses
the browser shards' Node and pnpm setup, skips install scripts, and runs no tests.
It also runs on a bare manual CI dispatch to prove workflow changes; a dispatch
from a feature branch populates only that branch's cache. Cache warming does not
gate verification or snapshot publication.

The separate typecheck uses Blacksmith's 3,000 monthly x64 2-vCPU equivalent
minutes. A seven-day sample projects about 2,833 PR/dispatch typecheck jobs per
30 days. One hosted Blacksmith typecheck job passed in 54 seconds; at that
runtime, the projection is about 2,629 equivalent minutes including existing
release verification. If every job took that long and billing rounded each job
up to a minute, the estimate would be 2,921 minutes including releases. Typecheck
itself took 30 seconds on Blacksmith versus 22 seconds on the same-head GitHub
control, so no execution-speed gain is claimed. Rounding and other organization
usage are unknown; this is an allocation estimate, not a guaranteed free bill. See the [allocation report](../benchmarks/ci-runner-allocation-2026-10.md).

The full Vitest suite runs once across the four LTS shards. There is no second full-suite floor matrix. The build/package job checks compatibility at the minimum version; it does not claim full Vitest coverage there once current LTS moves on. Its Node setup retains a three-minute step timeout and one retry for stalled downloads (hearsay-tools/cezarion#1214). The LTS sequencer keeps its measured weights, median fallback for new files and complete test inventory. Individual test timeouts remain unchanged.

The [four-shard measurement](../benchmarks/vitest-four-shards.md) records the fixed-source
comparison, runner cost, failures and coverage investigation. Four workers per shard,
coverage settings, duration weights and all required gates remain unchanged. Manual
review context still recognizes exact skipped three-shard names from older native
base workflows. Queue reuse requires the complete current four-shard roster; old
three-shard proof falls back to full verification.

The legacy floor config, sequencer, reporter and duration manifest remain for PR compatibility. PR CI loads `ci.yml` from the target branch, whose old floor jobs still read these files from the PR checkout. The new workflow has no floor jobs and does not use these helpers. Remove the helpers only after the new workflow reaches the target branch.

The required check keeps its name, **Unit, build, E2E, and package**. It requires
typecheck and build/package on every change surface. Full-matrix changes also
require all four Vitest shards and all four cockpit browser shards. Pull requests
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
verify the full suite. CI keeps four separate serial shards on its matrix.
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

Browser sharding now reuses the unit sequencer's longest-first allocator with a separate duration manifest. It assigns each next file to the lightest shard, resolves ties deterministically, and gives new specs the median known duration. The manifest never controls discovery, so removed specs are ignored and new specs remain included. The initial browser weights come from the successful run above and predict 203.48–204.95s of tests per shard, before setup; this is an allocation estimate, not a measured balanced CI result. The sequencer only overrides shard allocation, preserving Vitest's normal execution order for local full runs and within each shard.

Refresh browser weights from successful per-file suite summary lines in CI logs (not individual test timings), using filenames relative to `packages/web/e2e`, and update the manifest's provenance with the source run and commit. Keep the unit manifest separate: browser durations and unit durations measure different suites.

The Vitest sequencer assigns discovered tests to shards by measured duration using `.github/test-durations.json`. New files receive the median known duration and are always included; deleted files are ignored. The manifest affects balancing only, never discovery. Refreshing its durations can improve balance as the suite changes. Ordinary `npm test` still runs every suite without sharding.

When a PR adds or splits a Vitest unit test file taking longer than about one
minute on CI, add or update its repository-relative path and measured duration
in milliseconds under `durationsMs` in `.github/test-durations.json`. Use the
passed per-file Vitest suite-summary line in the CI log, not an individual test
timing or total job duration; record the source run and commit in provenance.
For split files, measure each resulting file separately. Keep browser E2E weights
in their separate manifest. The paragraph above gives the
sequencer's balancing-only role and median fallback for unlisted files.

The push-only `.github/workflows/ci-benchmark.yml` workflow runs controlled experiments on `bench/156-*` branches. It uses a fixed application baseline, records failures and resource usage, and performs publication experiments only as dry runs. Reproduction instructions and retained results are in [the issue 156 benchmark report](../benchmarks/ci-performance-156.md). Automated review remains enabled throughout.

CodeRabbit starts automatic reviews on push, including drafts and incremental changes. `.coderabbit.yaml` clears label filtering and sets `auto_pause_after_reviewed_commits: 0`. The used keys were checked against the live [v2 schema](https://www.coderabbit.ai/integrations/schema.v2.json) on 2026-11-02. The owner removed the custom round/spend cap because this open-source integration is free. Automatic provider execution now starts before preflight; the native admission gate still follows cheap preflight. No review model keys, commands, provider output artifacts, posting schema or PAT fallback remain. Issue intake keeps its independent model integration.

The native gate requires trusted classification and applicable baseline, complexity and
clone checks, plus typecheck, workflow lint and citations. Typecheck reads local
source without building. The build/package job checks packaged test types after
the application build.

The protected **Automated Code Review** check retains its name and native Actions provenance. `review-result` runs trusted base scripts after successful preflight. It requires the newest `CodeRabbit` execution from App `347564` / slug `coderabbitai` on the exact live PR head to be completed/success, or completed/skipped with exact authenticated `output.title` **No files to review**, plus zero unresolved review threads of any author. The named skip is the provider's no-files decision; it does not prove model execution and needs no prior successful check. Outdated threads still block. All other skipped/neutral, missing/pending, failed/spoofed/stale checks and malformed/truncated/changing API pages fail closed. An empty provider `pull_requests` array is allowed; formal review objects never prove execution. The reader rechecks the provider (including its title) and live head before admitting. Requests have 10-second limits within a 60-second read deadline; it does not poll a pending provider forever.

Expected blocked admission logs a notice and exits unsuccessfully. Broken API/schema evidence is an error. Findings must not become error annotations because the CI sweep groups identical errors across PRs. A passing gate releases the existing build/package, Vitest and browser dependencies. Docs-only and infra-only retain their suite skips but still require review admission. Cancellation never releases heavy work. Both protected checks remain required; branch protections are unchanged.

Readiness additionally proves the latest native `ci.yml` run/attempt and successful protected jobs, and reads fresh CodeRabbit admission. Trusted discovery emits PR numbers before scheduling. Every readiness trigger uses the same per-PR job lock, and every surviving job reads the live head and proof after acquiring it. Automatic CI/provider/signal discovery selects only the event's bounded PR targets, with independent jobs and budgets. An unverified new head returns to draft; a late synchronize event cannot override current green proof. Human ready/draft events request the same reevaluation; verified heads become ready and unverified heads become draft. There is no durable manual draft override. The board sync runs under the same lock even when draft state is unchanged, and Done cards remain protected. On the next readiness trigger, a new pending same-head execution or reopened thread returns a same-repository ready PR to draft. GitHub Actions has no review-thread event for manual reopening or resolution; dispatch **Reconcile CodeRabbit admission** with `pr_number` after either change, then **PR Readiness** if draft state needs refreshing. Fork PRs retain their author's draft state. Native proof requires an official matching main-target PR association; an empty association fails closed. If it appears, inspect the native run and start fresh native CI rather than substituting a dispatch or unrelated same-head run. Queue admission reads the same fresh provider/thread evidence in addition to its existing native proof, rules and membership checks. Queue-suite reuse and exact-push reuse keep their existing proof and snapshot publication rules. `fetch-ci-results.cjs` remains for snapshot consumers.

Bot-authored `release/v*` version-bump PRs skip Vitest, cockpit browser E2E, and automated code review only when all of these hold: PR author is `github-actions[bot]` or the exact bot configured in `RELEASE_APP_BOT_LOGIN`, head is `release/v*`, the live file list matches the release-finalization allowlist (`packages/*/package.json`, `alias-cezarion/package.json`, `pnpm-lock.yaml`), the event head SHA still matches the live PR head, the file-list fetch succeeded in full, and base→head manifests differ only by one shared old→new semver pair (optional caret; same keys/structure — no added scripts, deps, or arbitrary retargets), and the pnpm lockfile stays byte-identical except matching local workspace specifiers (including its pnpm package-manager document).

 The shared check lives in `.github/scripts/release-bump-pr.cjs` (loaded from the trusted base checkout) and feeds CI `classify-pr`; the shared CodeRabbit reader applies the same classifier to complete live files and exact base/head content. The required CI aggregate still runs `typecheck` and `build-and-package` and accepts `skipped` for Vitest/cockpit only on that verified shape. The named **Automated Code Review** gate bypasses provider evidence only on that verified shape, and still requires every review thread resolved. A human-authored `release/v*` PR still runs the full matrix and review. Reconciliation never calls a reviewer.

Release finalization creates bump PRs with a repository-scoped GitHub App token,
which emits native `pull_request_target` CI. It waits for that run and never
starts a competing dispatch. The App client only creates the PR; verification
keeps read-only permissions and the required aggregate name stays unchanged.
CI and review recognize the configured `RELEASE_APP_BOT_LOGIN`
as well as legacy `github-actions[bot]` bumps, with the same file and version
checks. See [release App setup](../publishing.md#release-app-setup).

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
(`refs/heads/gh-readonly-queue/main/pr-<N>-<sha>`) names; the queue is serial, and any other ref reads no
label, so growth then fails. The job's name is in the queue proof roster (`REQUIRED_QUEUE_JOBS`).

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

Eligible pull request runs and manual dispatches collect V8 coverage in the four required
`Vitest shard N/4` jobs (hearsay-tools/cezarion#1958). Each shard runs its tests once, with
`--coverage.enabled`; there is no separate coverage test matrix. Main pushes and merge groups
keep the command without coverage. Docs-only, infra-only, verified queue-proof and bump-PR
runs keep their existing skips.

The optional `Merge Vitest coverage` job uploads `vitest-coverage-<head SHA>`, holding
`coverage-final.json` (Istanbul, paths relative to the repository root, test files included)
and `provenance.json` (tested ref, head and base SHA, run ID and attempt), kept 14 days.
The pre-PR code-quality check downloads this artifact instead of running the tests again;
see `.ai/skills/check-code-quality/references/pre-pr.md` § Coverage from CI.

Test failures, unhandled errors, coverage startup failures and worker failures still fail the
required shard. The coverage-only reporter catches errors from report conversion and writing
on GitHub Actions, emits a warning and removes an incomplete report. It never resets a test
exit code or reruns tests. Local coverage failures remain fatal. Upload and merge steps use
`continue-on-error`; missing reports produce warning annotations and job-summary lines.
The merge job stays outside `verify.needs` and the merge-queue roster.

Coverage now adds time to the required test jobs. PR and dispatch shards have a 25-minute
hang bound, matching the former separate coverage jobs; main and merge groups retain their
15-minute bound. Removing the duplicate matrix saves three dependency installs, server builds
and test executions. It does not promise a shorter time to the required test verdict.

`.github/scripts/ci-coverage.workflow.test.cjs` pins the event selection, single test run,
optional publication and artifact shape. `.github/scripts/vitest-coverage-tests.test.cjs`
checks real Vitest exit codes when report generation or writing fails, with passing and
failing tests. Coverage remains opt-in locally and keeps test files in the report.
Like any `ci.yml` edit, prove the final workflow with a dispatch (§ Proving a `ci.yml` change).

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
sha=$(gh run view <run-id> --repo hearsay-tools/cezarion --json headSha --jq .headSha)
git diff --quiet "$sha" HEAD -- .github/workflows/ && echo current || echo stale
```

The lookup must succeed and the run's commit must be available locally; resolve
any lookup or Git error before using the result. `current` means the workflow
files match, not that the run passed or exercised the skipped jobs above.
`stale` requires a fresh dispatch and an updated citation. This directory-wide
comparison also treats edits to unrelated workflows as stale; later commits
that leave the workflow files unchanged do not invalidate the proof.

### Re-running a review

CodeRabbit owns review execution and finding discussion. CI never requests a model review or resolves findings. Push fixes or discuss a finding with its reviewer. A flaky verification failure uses **Re-run failed jobs**, which retains successful review and heavy jobs.

`coderabbit-reconcile.yml` uses default-branch code, no PR checkout or secrets, and only the Actions write permission needed for targeted retries. It reacts to genuine CodeRabbit check `created`/`completed`, native CI completion, and completion of **CodeRabbit review signal**. Review/comment events run that no-permission, no-checkout signal in PR merge-ref context. The trusted consumer validates official workflow identity, native event and same-repository signal association. The association selects a stable PR number; queued proof validates the exact live PR head. Signal success, artifacts and comment bodies grant no authority. Missing signal associations fail closed; use manual recovery.

Independent automatic discovery uses official PR associations from the verified native CI run or provider check, or the validated review signal PR number. CI run or signal merge SHAs never filter the live PR head. An empty provider association alone permits the bounded two-page open-main listing, which selects only eligible current heads equal to the verified provider head. Old associated events still wake their PR and read its newest proof. An unassociated stale head with no current match is a no-op. At most four association rows or matching targets are accepted per event; duplicates are removed. Missing/malformed CI/check associations, target overflow and incomplete inventory fail closed with explicit `pr_number` dispatch recovery. Trusted discovery emits only these eligible PR numbers in its matrix. Unrelated PRs receive no native/provider proof work. This bounds target work per event, not the repository-wide hourly token budget; four-way parallelism only bounds concurrency. Each job has its own 120-second deadline and PR-number concurrency lock, with at most four jobs running and fail-fast disabled. The admitted event is a wake hint. Only the trusted PR number enters the queue; each job reads the live head and proves its newest native run at its lock head. Manual dispatch scopes its requested PR. It validates the latest native CI workflow/run/attempt and successful preflight, then reruns only the completed `review-result` job if live admission differs from its result. Equal outcomes are no-ops. Both completion orders work: CI completion catches an earlier provider finish, and provider completion catches an earlier CI finish. On the next admission read, reopened threads and new pending same-head reviews revoke historical green results. For same-repository PRs, provider check completion automatically wakes reconciliation; manual thread reopening or resolution needs a **Reconcile CodeRabbit admission** dispatch with `pr_number`. Fork PRs receive no automated reruns, including from this dispatch. For fork PRs, a maintainer must rerun the native **Automated Code Review** job in Actions after provider completion or a manual thread change. Existing queue fork verification remains supported.

Writes are serialized per discovered PR. The reconciler rechecks admission and native identity before the write, then observes the accepted attempt under a bounded deadline before releasing serialization. It observes both successful and ambiguous POST responses without retrying the write. This is a bounded observation barrier, not a durable cross-execution reservation; unresolved acceptance needs manual inspection before further retries. Inspect the native run if acceptance is not visible. GitHub can coalesce pending jobs for one PR; each surviving job reads live evidence. A and B have independent event discovery and separate PR locks; neither discovery job shares a cross-PR pending slot. Manual `pr_number` dispatch recovers dropped or eventless changes. An old valid event cannot select historical proof; its job independently proves the newest native run. Delivery and scheduling still depend on GitHub, so this is not a lossless-delivery claim. GitHub Actions has no review-thread event for manual reopening or resolution, so neither change triggers readiness or the review signal. After either manual change, dispatch **Reconcile CodeRabbit admission** with `pr_number` to refresh native admission. Dispatch **PR Readiness** separately if draft state needs refreshing. It cannot restart a disabled workflow, a run at least 30 days old or one at the 50-attempt limit. Promotion requires the step marker **Require fresh CodeRabbit admission and resolved threads**. A green historical **Require fresh CodeRabbit execution and resolved threads** job can only be revoked after fresh validated admission rejects it under both policies, such as a reopened thread, pending provider, latest failure or generic skip. An admitted decision, including no-files, leaves that old green job unchanged. A failed historical job always requires a fresh native run; it cannot be promoted by a retry. This prevents a no-files retry loop after revocation. Admission read errors alone cannot authorize a historical retry. Reusable `automated-code-review.yml` model jobs remain refused in every direction. Reruns keep their original definition and immutable source checkout; push a new head or start a new native run after rollout when promotion needs the new policy. No whole-CI dispatch or model fallback occurs.

GitHub's targeted rerun can also run dependent heavy jobs when review passes. This preserves the owner-approved dependency graph. Do not use a successful review retry to rerun failed tests.

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

### Merge-queue pilot metrics

The owner reads the parallel queue-build pilot by hand, once a week
([spec](../../.ai/specs/2026-11-03-speculative-merge-queue.md) § Rollout step 4).
This command prints its metrics and both rollback verdicts (§ Owner decisions Q3):

```bash
node .github/scripts/queue-metrics.cjs                    # the 7 days before now
node .github/scripts/queue-metrics.cjs --from 2026-11-01 --to 2026-11-03 --json
```

It only reads, through authenticated `gh api` calls, and needs no configuration.
A date covers its whole UTC day. A `YYYY-MM-DDTHH:MM:SSZ` time is an exact bound.
Each runs and search query covers one UTC day, because GitHub returns at most
1,000 results per query.

- **Runner-minutes**: the jobs of completed `merge_group` runs of `ci.yml`, each
  rounded up to a whole minute. An `ubicloud-*` label is Ubicloud. A GitHub image
  label (`ubuntu-*`, `windows-*`, `macos-*`) is hosted.
- **Per merge**: divided by the PRs merged in the window that entered the queue.
- **Queue failure rate**: `failure`, `timed_out` and `startup_failure` runs over
  completed runs.
- **Invalidated runs**: runs whose group base, from the
  `gh-readonly-queue/main/pr-<N>-<base>` ref, never reached `main`.
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
node .github/scripts/count-test-ci-failures.cjs live-preview.e2e.ts --repo hearsay-tools/cezarion --runs 20
# Or select runs by creation time (inclusive UTC timestamps):

node .github/scripts/count-test-ci-failures.cjs live-preview.e2e.ts --repo hearsay-tools/cezarion --since 2026-10-22T00:00:00Z --until 2026-10-23T00:00:00Z
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
gh api --allow-escape-sequences repos/hearsay-tools/cezarion/actions/jobs/<job-id>/logs > job.log
# List the job IDs of one attempt of a run:
gh api repos/hearsay-tools/cezarion/actions/runs/<run-id>/attempts/<n>/jobs --jq '.jobs[] | {id, name, conclusion}'
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
Node tests and packaged CLI tests always run on that commit. The four Vitest
and four browser jobs can reuse native PR suites for one unchanged queue entry.
Queue runs have no model keys, npm credentials, publishing jobs or OIDC permission.

Native PR test matrices resolve their input once to an immutable merge commit.
For a same-repository PR that contains the trusted workflow's base and whose
head and merge trees match, they test the immutable head instead. Only both
successful full matrices can produce `Attest PR test inputs / <workflow SHA> /
<PR head SHA>`, a read-only job whose official name records those identities.
A missing or moved merge input fails input resolution. An unavailable optional
ancestry check keeps the immutable merge checkout without attestation.

At the queue head, a read-only probe requires exactly one entry, unchanged main,
current native CI/review admission, all eight successful suite jobs, an attestation
for the queue base and PR head, identical head/combined trees, and identical
`ci.yml` blobs at the attested base and queue commit. A changed workflow always
runs the queue suites, since native PR CI used the older definition. It re-reads
membership, main, head and the newest source run/attempt. Missing, partial, old,
failed, fork, multi-entry or changing evidence runs both full queue suites.
The probe is bounded to 60 seconds, with individual requests capped at 10 seconds.
It may read a still-running native workflow only when its required aggregate,
review, attestation and all suites have passed; optional publication can finish
later. Final queue admission still requires the native workflow to finish
successfully. A successful probe leaves each queue matrix job running only a
short reuse receipt, so every required job still has a successful verdict.
This proves content equivalence for these suites; checks that depend on commit
identity, parents or the event still execute on the queue commit.

The required `Automated Code Review` check verifies existing PR-head review
admission. It does not call a model to review combined code. The helper comes
from the group's immutable base SHA. It requires the first live queue entry to
match both group SHAs, effective serial queue rules, an unchanged open non-draft
main PR, successful current native `pull_request_target` CI/review from this
repository's `ci.yml`, fresh exact-head CodeRabbit admission, and no unresolved review threads. Dispatches and unrelated
same-name checks cannot supply review admission. Missing or changing evidence
fails closed. GitHub owns queue persistence; no cockpit session is required.

A main push probes official Actions metadata for at most 60 seconds (each request
at most 10 seconds; at most seven pending reads; complete lists limited to 200
records). It reuses only the newest same-repository queue run's latest successful
attempt for the **exact pushed SHA**, after every classifier, verification leaf (including a verified native-suite
reuse receipt), aggregate and review admission job succeeds. A final reread checks for races.
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

Normal eligible merges replace main's full matrix with queue verification
before merge plus a metadata probe. An eligible single-entry queue reuses the
native PR's unit/browser suites and runs the remaining checks fresh. This is a
cost goal, not a guarantee. Rebuilds,
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
