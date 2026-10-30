# Four Vitest shards

Four duration-balanced shards reduced the median longest coverage job from 882 to
669 seconds (24.15%, 213 seconds) at the fixed source below. Median summed shard
time rose 0.72%. CI and nightly use four shards with four workers each. The
sequencer, weights, test inventory, coverage settings and required gates stay
unchanged. These measurements support the layout choice; they do not promise the
same gain after source or runner changes.

## Fixed-source comparison

Application source was `42412e06cc6cb37f5e3872f9d6d9d91ac30ae497` (B0) throughout.
Each job used GitHub-hosted `ubuntu-24.04`, four logical CPUs, Node 24.22.1,
pnpm 12.11.2, Vitest 4.1.10, frozen dependencies and the existing duration weights.
All 34 shard jobs hit the same pnpm-store cache key. No test-result cache was
added. The same appended evidence reporter and hashed configuration ran in every
wave. Application, configuration, lockfile and instrumentation hashes matched.

Runs used an isolated branch-push workflow. Coverage-on commands matched PR test
semantics; off-mode commands were diagnostic only. This measured shard latency,
not native review scheduling or total PR completion time. Waves ran serially in
the order below. All runs were attempt 1. Job seconds exclude queue wait; wave
seconds span first job creation to last job completion. Runner seconds sum all
shard job durations, including setup and reporting.

| Wave | Coverage | Shards | Run / harness head | Longest job s | Wave s | Runner s | Outcome |
| --- | --- | ---: | --- | ---: | ---: | ---: | --- |
| 1 | on | 3 | [40979122853](https://github.com/hearsay-tools/cezarion/actions/runs/40979122853) / `9ab9ef6b4` | 870 | 873 | 2290 | Tests passed; validator failed, later replay passed |
| 2 | on | 4 | [40982128128](https://github.com/hearsay-tools/cezarion/actions/runs/40982128128) / `2775bffe3` | 669 | 672 | 2336 | Passed |
| 3 | on | 6 | [40982128128](https://github.com/hearsay-tools/cezarion/actions/runs/40982128128) / `2775bffe3` | 484 | 486 | 2600 | Failed; incomplete coverage |
| 4 | off | 3 | [40985962944](https://github.com/hearsay-tools/cezarion/actions/runs/40985962944) / `50ecf6bea` | 799 | 802 | 2242 | Passed, diagnostic |
| 5 | off | 4 | same run / `50ecf6bea` | 639 | 642 | 2401 | Passed, diagnostic |
| 6 | on | 4 | same run / `50ecf6bea` | 668 | 671 | 2547 | Passed |
| 7 | on | 3 | same run / `50ecf6bea` | 882 | 885 | 2537 | Passed |
| 8 | on | 4 | same run / `50ecf6bea` | 675 | 678 | 2383 | Passed |
| 9 | on | 3 | same run / `50ecf6bea` | 883 | 886 | 2366 | Passed |

The three coverage samples per selected layout gave median wave time 885→672s
(24.07%). The later adjacent pairs improved longest-job time by 24.26% and 23.56%,
and wave time by 24.18% and 23.48%. Median shard runner time was 2366→2383s.
These exceed the planned 15%/90-second median and 10% adjacent-pair gains, within
the 20% runner-time ceiling. Six shards have no passing complete sample and were
not selected. No failed sample was replaced.

All six selected coverage samples retained exactly 941 project-qualified modules
and 21,333 case identities: 21,319 passed and 14 intentionally skipped. The
coverage scope was 1,892 files, including all 941 tests. Statement, function and
branch maps matched exactly across those six samples. Hit counters did not.

## Coverage investigation

Initially, 42 locations in `task-thread.tsx` had hits in all three controls and
zero in all three candidates: 14 statements, 10 functions and 18 branch arms.
Production remained at three during a separate investigation. Passing case
counts alone were not accepted as proof of equivalent callback execution.

Three bounded local reproductions executed 134, 2 and 136 cases (40.81 seconds
in total). Saved native inputs and transformed source/maps allowed an offline
reduction: changing only wrapper-offset metadata reproduced all 437 task-thread
control counters and, separately, all 437 candidate counters. Zero-offset outputs
were synthetic evidence, not observations of the original hosted inputs. Initial
analysis errors and stopped comparison attempts were retained separately.

A single subsequent [causal diagnostic, run 41003227804](https://github.com/hearsay-tools/cezarion/actions/runs/41003227804),
at harness `3a1e4ee7b21d4dbbe0c8a7207a31c0c1db0b5569`, ran only original control
shard 1/3 at B0. It passed 314 modules and 7,344 cases in a 714-second job.
Its read-only observer captured all 314 native inputs before cleanup. The two
task-thread entries had actual wrapper offsets 209 and 0, bound to the same
transformed source/map. All 437 final counters and maps matched original control.
The native `goToQuestion` range had count zero, while final function counter 31
was 375. The other input's enclosing `ThreadView` count was also zero. Thus the
positive callback count was inflated during coverage processing; it was not
evidence of 375 callback executions.

The diagnostic artifact is [12955310335](https://github.com/hearsay-tools/cezarion/actions/runs/41003227804/artifacts/12955310335).
Its downloaded ZIP SHA-256 was
`ae1954a600260c1109d0df4a36e8f5591cdab358594ee29c949e4346b087f3d8`.
The native observation and controlled offset reduction explain the stable
42-counter pattern sufficiently to select four shards. Actual metadata lookup,
read order, absent-versus-overwritten metadata and native equivalence of the six
original samples remain unobserved. No provider repair, threshold, assertion,
skip, exclusion or coverage-reporter change is part of this layout change.

## Failures, accounting and limits

- [Run 40977872539](https://github.com/hearsay-tools/cezarion/actions/runs/40977872539)
  failed admission with `ENOBUFS` in 10 seconds; no shard ran. A bounded API
  projection repair preceded the screening launch.
- Run 40979122853's validator confused full-discovery announcements with completed
  per-shard modules. The 17-second failure remains in history. Immutable control
  artifacts were replayed under corrected validation harness `2775bffe3`, then
  `50ecf6bea`. Replay did not change the original conclusion or rerun the control.
- Six-shard cell 5 in run 40982128128 failed `human-waits.test.ts:143` with
  `Unexpected end of JSON input` after an existence-only file wait. It produced
  no coverage. The other five cells completed. A read/write race is a hypothesis;
  no cause was proved and no test repair or retry was made.

The performance campaign used nine full-inventory waves and 34 shard jobs:
21,969 job-seconds (366.15 runner-minutes), including 267 seconds of admission,
replay and validation overhead and every failure. The separate causal job brings
the total to 22,683 seconds (378.05 minutes), 35 shard jobs and still nine full
waves. Local and offline diagnostics are separate ledgers. These are measured
runner-seconds, not billed-minute rounding or currency estimates. Raw artifacts,
job/step metadata, complete input hashes and failed samples were retained; GitHub
artifact retention is finite.

Setup took 21–37 seconds in screening. Created-to-start delay was 2–4 seconds;
Actions does not separate runner acquisition from other scheduling delay. Shard
execution dominated. Reporting tails include coverage conversion and teardown,
not pure coverage cost. The single off-mode pair cannot estimate a coverage-cost
distribution. Hosts shared image `20261026.354.1` but used six CPU models, and other
repository CI overlapped. Cache warmth, hardware and order limit generalization.
No weight refresh or suite split was justified as a second change.

## Applying the result to current main

The production base is `92477f6cffdb79ff472a2cdc56e778436ad04b2a`. Relative to B0,
73 paths changed, including 41 tests and five testkits in server workflow
refactoring. No test paths were added or removed. Configurations, lockfile,
weights, sequencer, coverage helper and workflow settings were unchanged.
Existing [main run 41003702079](https://github.com/hearsay-tools/cezarion/actions/runs/41003702079)
reported 941 modules and 21,340 cases, with 14 skips, on Node 24.22.1. It was read
as current-source evidence, not added as a benchmark sample. The seven added
cases and changed server source can affect timing.

Production keeps its existing `lts/*` selector and every other runtime setting.
Final native PR verification and a bare dispatch must prove the current source,
four-cell workflow, full inventory and four coverage artifacts. Native PR CI
uses the base workflow and alone cannot prove changed YAML. Their results are
integration evidence, separate from the immutable benchmark campaign. See
[CI verification](../sdlc/ci.md#ci-verification).
