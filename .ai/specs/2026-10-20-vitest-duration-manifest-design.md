# Make Vitest duration maintenance discoverable

Status: proposed; requires design approval and Continue on the same task.
Subject: hearsay-tools/cezarion#1336. Design only; no implementation authorized here.

## Eligibility and evidence

Checked on 2026-10-20 against current main `9adb3f1d9beda70f61e76d185db385d88196562f` (also this worktree's starting HEAD).
The issue is open, authored by wjarka, unassigned, has `friction`, exactly one
handling label (`friction-design`) and one recognized category (`friction-knowledge`).
Its comments are empty; its timeline shows no competing claim or linked PR.
Open-PR searches for 1336 and duration manifest found none. The cockpit returned
all 711 tasks, including archived tasks; only this run's task references the
subject issue. This run is the existing claim, excluded from the duplicate check.
Recheck eligibility before any later implementation.

The missing recipe is verified on main: `AGENTS.md` Validation describes three
Vitest shards but contains no `.github/test-durations.json` reference.
`docs/sdlc/ci.md` already describes the unit manifest, median fallback and
balancing-only role, but does not give the requested long-file update trigger.
`.github/scripts/ci-test-sequencer.mjs` reads `durationsMs`, maps repository-relative
paths, and assigns discovered specifications longest-first to the lightest bin.
The manifest's current median is 381 ms, rather than the issue's approximate
“few seconds”; it contains no `waits-` entries.

Verified historical evidence:
[run 39433215923, shard 3/3](https://github.com/hearsay-tools/cezarion/actions/runs/39433215923/job/118663518999),
commit `22c111dd7efa98709bd89493900b979da8c29818`, ran from 13:46:19 to
14:00:23 UTC (14m04s). Its passed file-summary lines report
`src/workflows/monitoring-channel-order.test.ts` at 210007 ms and
`src/workflows/waits-parity.test.ts` at 416197 ms. Vitest's overall duration is
815.06 seconds; that is distinct from job wall time. The job succeeded, although
the overall workflow failed elsewhere. These logs establish the long-file
measurement source, not a controlled proof that new weights alone would meet a
particular wall-time target. No expensive CI rerun is needed to verify this
instruction gap, and no shard-speedup claim is made.

## Existing load-bearing guarantees

- Test discovery is independent of manifest membership: new files stay included,
  removed paths are ignored, and missing or invalid positive weights use a median
  fallback. The manifest is an allocation hint, never a suite allowlist.
- Unsharded runs retain ordinary Vitest behavior; sharding does not change
  within-shard ordering. The same unit sequencer also serves Node-floor shards.
- Unit weights and browser E2E weights measure different suites and stay separate.
- CI retains its verification gates, worker limits and timeout budgets. Local
  Squeal results do not substitute for CI file measurements or the final gate.

## Recommended behavior (proposal)

Add one concise paragraph beside Validation's CI shard description in AGENTS.md:

> When a PR adds or splits a Vitest unit test file taking longer than about one
> minute on CI, add or update its repository-relative path and measured duration
> in milliseconds under `durationsMs` in `.github/test-durations.json`. Use the
> passed per-file Vitest suite-summary line in the CI log, not an individual test
> timing or total job duration; record the source run and commit in provenance.
> See `docs/sdlc/ci.md` for the sequencer and its median fallback.

The one-minute trigger is a recommended contributor maintenance policy, not an
existing enforced threshold and not permission supplied by a classification label.
Approval explicitly adopts it. It targets material outliers without requiring a
complete rebenchmark for every short new file. “About” makes this review guidance,
not an exact automated rejection boundary.

After approval, implementation is limited to that instruction. Follow the existing
manifest structure when a future test PR supplies measurements. Paths in server
logs such as `src/workflows/waits-parity.test.ts` need their workspace prefix
(`packages/cezar/`) in the root-relative manifest. A split uses each resulting
file's own summary duration, never the old parent's duration copied to every child.
Do not invent measurements before CI runs; obtain a passed file result from the
PR's normal CI, then update the same PR. A failed overall workflow can still
supply a passed file measurement; a failed or interrupted file is not a completed
measurement. Reuse a representative available measurement for a new path and
retain existing aggregation descriptions accurately; do not claim a multi-run
median for a single new measurement.

## Alternatives and trade-offs

1. Leave the detail only in CI documentation: no new policy, but preserves the
   verified discovery gap at the contributor entry point.
2. Recommend an optional refresh with no long-file trigger: less contributor work,
   but easier to repeat the omission that motivated the report.
3. Require weights for every new test or enforce a CI manifest gate: more coverage,
   but adds policy, measurement bootstrapping and maintenance cost. It also risks
   confusing allocation with discovery. Outside this proposal.
4. Generate weights automatically: could reduce manual edits, but needs decisions
   about trust, aggregation, concurrency and repository writes. Outside scope.

Recommend the narrow paragraph; no sequencer, weight-refresh tooling, or actual
manifest edits are part of this design task.

## Defaults, authority, cost, persistence and compatibility

Shipped runtime defaults remain unchanged, including fallback behavior and all
CI gates. No environment variable, dependency, network surface, account grant,
automation or paid execution is added. The later approved paragraph introduces a
human maintenance expectation, using normal existing CI evidence. It does not
require extra full local suites or permission to trigger paid reruns.

The proposal is tracked Markdown. The eventual instruction is tracked AGENTS.md;
future measured weights remain ordinary versioned JSON with source provenance.
There is no new application durable state, migration or required user config.
Existing manifests, missing entries and local test workflows stay compatible.
Users see better contributor guidance; cockpit behavior is unchanged. No run
state or transition changes are proposed, so a Transitions out table and
no-session recovery changes are not applicable.

## Acceptance criteria after approval

- Validation names the exact unit manifest and its `durationsMs` units/path form.
- It states the add/split trigger of about one minute on CI, measurement source,
  and provenance requirement, with a CI documentation pointer.
- Passed file summaries are distinguished from individual test, total suite and
  job wall timings; browser E2E weights remain separate.
- Discovery, fallback, ordering, runtime defaults and verification are unchanged.
- No guessed weights, new enforcement, runtime changes or extra full-suite gate.

## Verification plan

For this proposal: inspect current main, source, manifest, issue/timeline and CI
job logs as above; review the patch for documentation-only scope and run
`git diff --check`. No application tests are needed for a standalone design file.

For an approved instruction: compare the paragraph to sequencer behavior and the
manifest structure; confirm its location with `rg` and review `git diff --check`.
Use a real existing CI file-summary example to verify milliseconds and root-path
translation without changing weights as an incidental cleanup. No synthetic
unit test is necessary for prose, and no weakened or added CI gate is proposed.

## Decision and next step

Design approval and **Continue on this same task** are required before changing
AGENTS.md. Keep the issue open and its routing labels unchanged. A draft proposal
PR is review material, not implementation approval; do not relabel to launch a
second task, merge, or enable an automation.
