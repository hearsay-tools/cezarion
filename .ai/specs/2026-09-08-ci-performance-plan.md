# CI performance implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development for independent experiment patches, with review before applying them.

**Goal:** Measure all six opportunities in issue #156 and ship only verified improvements.

**Architecture:** A push-triggered benchmark workflow checks out the harness and the fixed application separately. Each GitHub-hosted job applies one checked-in patch, measures the full verification sequence, and uploads raw reports even on failure. Three repetitions per variant use identical Node, runner label and cold npm cache conditions. Later campaigns measure combined winners.

**Tech Stack:** GitHub Actions, Node 24, Python standard library, GNU time, installed Vitest.

**Spec:** https://github.com/hearsay-tools/cezarion/issues/156 and its Agent context; design approved in this session.

## Global constraints

- Baseline b1fe75911378dfe7816a7a83312c2acbdcf848f4 from origin/main, never the Blacksmith branch.
- Every performance measurement runs on GitHub-hosted ubuntu-24.04; record actual image and CPU details.
- Every variant has at least three runs; report median/range, failures, queue and setup separately.
- Keep test inventory, lifecycle assertions, real home sandboxing, declarations, contract inlining and package checks.
- Do not suppress review globally. Measurement branches have no PR; final draft PR triggers normal review.
- No snapshot registry writes during experiments; snapshot comparisons use --dry-run.

## Tasks

### 1. Measurement harness
Files: `.github/workflows/ci-benchmark.yml`, `.github/benchmarks/156/measure.py`, `test_measure.py`, `campaign.json`, report under `docs/benchmarks/`.
- [ ] Test a real successful command, failed command and child CPU/memory accounting; failure must remain visible in persisted JSON and exit status.
- [ ] Run `python -m unittest discover -s .github/benchmarks/156 -p 'test_*.py'`, observe red, implement collector, rerun green.
- [ ] Collector executes argument arrays via `/usr/bin/time`, stores wall/user/system/peak RSS, exit status, exact command and logs; metadata records git SHA, lockfile hash, Node/Vitest versions, CPUs, runner image, timestamps and CI identity.
- [ ] Workflow matrix reads campaign.json, checks out baseline, installs without cache reuse, runs collector and uploads artifacts with always(). Push a dedicated measurement ref to start baseline/default and 4/6/8 worker variants.

### 2. Deterministic fixtures
Files: experiment patch in `.github/benchmarks/156/fixtures.patch`; affected test files only.
- [ ] Inspect prompt/state/attachment tests and semaphore sleeps. Replace incidental delays with scripted responses or explicit release gates; keep real timer/process tests intact.
- [ ] Run affected suites against original and proposed fixture; verify same cases/assertions and test selected production mutations.
- [ ] Save independent patch based on fixed baseline, document exact scope and preservation evidence.

### 3. Suite splitting
Files: `.github/benchmarks/156/splitting.patch`; three named test suites and testkits.
- [ ] Partition independent worker-wait, harness-parity and run scenarios into files with shared non-test helpers.
- [ ] Preserve every test name and parity row, no concurrent tests or loss of cleanup hooks.
- [ ] Compare collected case inventory before/after; run split suites; retain independent patch.

### 4. Setup and duplicate builds
Files: `.github/benchmarks/156/setup.patch`, benchmark collector modes, package/build workflow if selected.
- [ ] Audit pure web tests; move eligible files to Node with file environment annotations, retaining isolation and server setup unchanged.
- [ ] Measure reuse of pretypecheck's server artifact by running build:web plus check:pack after tests; declarations and inlining remain from initial build.
- [ ] Compare snapshot fresh install/build with transfer of verified dependency/build artifacts on another job; use dry-run stamping and package checks.

### 5. Balanced shards and full campaign
Files: benchmark workflow and duration assignment manifest.
- [ ] Extract baseline per-suite durations and allocate files to two bins by longest-processing-time greedy assignment.
- [ ] Run full verification gate plus independently measured shard jobs, include total setup/runner time and assert inventory is a disjoint complete partition.
- [ ] Run each individual variant three times, then three combined runs. Retain all failures and retries.

### 6. Select, verify, report and review
Files: selected application/CI changes, `docs/benchmarks/ci-performance-156.md` and raw JSON.
- [ ] Compare median/range, CPU seconds and peak memory, total runner time, wall time and failures for all variants. Reject complexity unsupported by benefit.
- [ ] Apply only winners; run npm run typecheck, npm test, npm run test:unit, npm run build, npm run test:package.
- [ ] Commit, push, merge fresh origin/main and reverify if changed, open draft PR using repository template with Closes #156.
- [ ] Move board to In review, run pr-checks and SDLC docs check, resolve automated review on final SHA and retain green CI/review links.
