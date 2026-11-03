# Fast unit suites — Phase 3

Design for hearsay-tools/cezarion#2516, slice 3.1 of
hearsay-tools/cezarion#2487. This document implements the measurement and design
part of the approved revision 2 of
[Retire the workaround skills](2026-11-02-retire-workaround-skills.md).
Slices 3.2 and 3.3 implement the changes described here. This PR changes this
document only. It does not change application behavior, tests or configuration.

## Method

The measurement checkout is `3ae6a032d7f26fc2e518d6f0de48a40e2cccfd4a`.
Dependencies were installed by worktree setup. Node is 24.22.1, Vitest is 4.1.10.
The host is shared. Every test invocation uses one worker and runs alone in this
worktree. Other tasks on the host can still compete for CPU and I/O.

Before timing, stop this worktree's Squeal daemon:

```sh
squeal stop --until-start
```

The stop succeeded at Squeal revision 0. The primer reported 1,144 loaded test
files, 90 slow files, 13 current slow files and 77 pending. These inherited
verdicts are not the measurements below. Squeal stayed stopped during timing.
No `squeal run --slow` was used.

For each file, collect test names with `npm exec -- vitest list <file> --json`.
Run the first case, the first floor(N/2) cases, and all N cases. Match complete
Vitest test names with anchored escaped alternatives. This measures a prefix,
not a random sample. The prefix can contain cheaper or more expensive cases than
the suffix; the table must not be read as a uniform per-case estimate.

Each measured command has this form:

```sh
cat /proc/loadavg
nproc
/usr/bin/time -v -o <prefix>.time npm test -- <file> \
  --maxWorkers=1 --reporter=default -t '<anchored selected names>'
# Full file: omit -t.
```

Raw logs, exact argument arrays, selected and total case counts, starting load,
CPU count, start/end times, exit status and command PID live under the ignored
`.ai/qa/2516/` directory. `measure.py` runs files and sizes in sequence in a persistent command session.
These are local evidence paths, not tool-readable baselines or a slow-file allowlist.
The table below is a record, not an input to any guard.

CPU seconds are GNU time's user plus system seconds, including reaped child
processes. Peak RSS is GNU time's maximum resident set size in KiB: the largest
single process in the tree, not the sum of concurrent processes. It does not
measure total tree memory. Wall time includes npm, Vitest startup, transforms,
imports, tests and teardown. CI suite-summary time excludes much of that setup.
Do not compare these two measures as if they were the same clock.

## CI durations

The manifest is `.github/test-durations.json` at the measurement checkout. Its
values are milliseconds. Recompute the historical set with:

```sh
node -e 'const d=require("./.github/test-durations.json").durationsMs; console.log(Object.entries(d).filter(([,ms])=>ms>60000))'
gh run list --repo hearsay-tools/cezarion --branch main --workflow ci.yml \
  --status success --limit 100 --json databaseId,headSha
gh run view 41334112445 --repo hearsay-tools/cezarion --log
```

The manifest has 36 entries over 60 s. `workflows/monitoring-channel-order.test.ts`
was deleted by hearsay-tools/cezarion#2446. Measure the other 35, not a recreated
copy of the removed test. Fresh CI also selects
`delegation/provision-workflows.test.ts` and `delegation/workspace.test.ts`.

Passed main run **41334112445**, from **2026-11-01**, SHA
`05a1ee28989378319a0f982b7696b276858c89b4`, executed four shards with
`--maxWorkers=4`. Use its per-file passed suite-summary lines. The more recent
passed main run 41639284504 at the measurement SHA skipped the Vitest jobs and
reused queue evidence; it cannot supply fresh suite timings. The chosen run
precedes some subsequent test changes, including removal of the obsolete file.
Its numbers describe that SHA, not an execution of the measurement checkout.


| File under `packages/cezar/src/` | Manifest seconds | Fresh CI seconds | State |
| --- | ---: | ---: | --- |
| `core/ci-tools.test.ts` | 63.780 | 75.129 | Measure |
| `core/harness-autosave-settlement.test.ts` | 101.250 | 117.047 | Measure |
| `core/harness-claude-parity.test.ts` | 225.210 | 211.903 | Measure |
| `core/harness-codex-parity.test.ts` | 97.636 | 106.027 | Measure |
| `core/harness-cursor-parity.test.ts` | 82.797 | 86.670 | Measure |
| `core/harness-opencode-parity.test.ts` | 99.568 | 85.285 | Measure |
| `core/skill-provision-parity.test.ts` | 80.355 | 50.324 | Measure |
| `core/skill-resume-parity.test.ts` | 194.268 | 203.698 | Measure |
| `core/workflow-ask-parity.test.ts` | 63.592 | 58.268 | Measure |
| `core/workflow-autonomous-parity.test.ts` | 158.834 | 182.639 | Measure |
| `core/workflow-final-message-parity.test.ts` | 110.766 | 83.062 | Measure |
| `core/workflow-followup-parity.test.ts` | 90.028 | 97.831 | Measure |
| `core/workflow-no-progress-parity.test.ts` | 71.640 | 73.238 | Measure |
| `workflows/ci-wait-failure-parity.test.ts` | 138.087 | 105.801 | Measure |
| `workflows/ci-wait.test.ts` | 71.305 | 62.628 | Measure |
| `workflows/monitoring-channel-order.test.ts` | 93.999 | 74.176 | Deleted; not measured |
| `workflows/monitoring-turn.test.ts` | 316.866 | 273.720 | Measure |
| `workflows/run.test.ts` | 202.393 | 191.962 | Measure |
| `workflows/waits-claude-parity.test.ts` | 203.736 | 211.056 | Measure |
| `workflows/waits-claude-workers-parity.test.ts` | 256.617 | 259.740 | Measure |
| `workflows/waits-codex-parity.test.ts` | 99.992 | 55.693 | Measure |
| `workflows/waits-codex-workers-parity.test.ts` | 80.937 | 92.102 | Measure |
| `workflows/waits-cursor-parity.test.ts` | 143.114 | 147.445 | Measure |
| `workflows/waits-cursor-workers-parity.test.ts` | 148.254 | 130.376 | Measure |
| `workflows/waits-omp-parity.test.ts` | 86.606 | 54.029 | Measure |
| `workflows/waits-omp-workers-parity.test.ts` | 74.455 | 65.718 | Measure |
| `workflows/waits-opencode-parity.test.ts` | 97.950 | 103.309 | Measure |
| `workflows/waits-opencode-workers-parity.test.ts` | 124.662 | 118.985 | Measure |
| `workflows/waits-pi-parity.test.ts` | 71.544 | 75.493 | Measure |
| `workflows/waits-pi-workers-parity.test.ts` | 70.429 | 61.928 | Measure |
| `workflows/worker-parent-attention.test.ts` | 212.179 | 208.576 | Measure |
| `workflows/worker-questions.test.ts` | 177.982 | 156.895 | Measure |
| `workflows/worker-restart-parity.test.ts` | 66.081 | 71.023 | Measure |
| `workflows/worker-wait-capacity.test.ts` | 90.407 | 94.345 | Measure |
| `workflows/worker-wait-conversations.test.ts` | 87.799 | 72.505 | Measure |
| `workflows/worker-wait-durability.test.ts` | 90.680 | 85.583 | Measure |
| `delegation/workspace.test.ts` | 53.129 | 69.889 | Measure |
| `delegation/provision-workflows.test.ts` | 55.912 | 85.367 | Measure |

## Measurement table

All 111 runs below passed. Each three-value column follows **one / half / full**
selection order. Paths are under `packages/cezar/src/`. RSS is MiB, the largest
single process, not total tree RSS. Load columns preserve all three Linux load
averages before each invocation; these are host observations, not load controls.

| File | Cases: one / half / full | Wall seconds | CPU seconds | Peak RSS MiB | Load averages before one; half; full | CPUs |
| --- | --- | --- | --- | --- | --- | --- |
| `core/ci-tools.test.ts` | 1 / 46 / 93 | 4.39 / 19.84 / 47.36 | 6.23 / 26.20 / 63.29 | 407.0 / 403.7 / 444.9 | 6.08 8.73 8.29; 5.67 8.60 8.25; 6.02 8.48 8.22 | 24 |
| `core/harness-autosave-settlement.test.ts` | 1 / 24 / 48 | 6.41 / 55.58 / 99.48 | 10.65 / 125.04 / 201.12 | 438.0 / 448.4 / 445.4 | 6.63 8.08 8.09; 6.66 8.06 8.08; 8.45 8.34 8.17 | 24 |
| `core/harness-claude-parity.test.ts` | 1 / 58 / 116 | 5.31 / 39.08 / 72.34 | 6.86 / 39.48 / 79.45 | 499.8 / 504.4 / 487.6 | 9.36 8.38 8.19; 9.09 8.34 8.18; 7.71 8.07 8.09 | 24 |
| `core/harness-codex-parity.test.ts` | 1 / 59 / 118 | 5.07 / 87.22 / 117.46 | 6.52 / 31.90 / 68.98 | 520.0 / 525.3 / 530.9 | 7.72 7.97 8.05; 7.58 7.93 8.04; 3.09 6.27 7.43 | 24 |
| `core/harness-cursor-parity.test.ts` | 1 / 58 / 116 | 5.07 / 47.30 / 104.66 | 6.51 / 36.39 / 76.64 | 594.0 / 556.6 / 533.8 | 4.27 5.56 7.02; 4.49 5.59 7.02; 7.38 6.08 7.11 | 24 |
| `core/harness-opencode-parity.test.ts` | 1 / 59 / 118 | 4.36 / 64.24 / 102.91 | 5.76 / 33.50 / 82.85 | 622.5 / 621.5 / 649.9 | 7.33 6.92 7.33; 6.91 6.84 7.30; 5.83 6.45 7.13 | 24 |
| `core/skill-provision-parity.test.ts` | 1 / 15 / 30 | 5.51 / 27.72 / 49.62 | 7.55 / 39.77 / 64.59 | 581.9 / 580.5 / 587.8 | 6.45 6.42 7.04; 6.57 6.45 7.04; 10.07 7.27 7.30 | 24 |
| `core/skill-resume-parity.test.ts` | 1 / 23 / 47 | 11.15 / 62.47 / 103.10 | 16.36 / 90.20 / 132.23 | 591.3 / 593.8 / 610.8 | 10.81 7.86 7.50; 10.60 7.95 7.53; 8.84 7.89 7.54 | 24 |
| `core/workflow-ask-parity.test.ts` | 1 / 30 / 60 | 5.00 / 57.14 / 115.79 | 6.55 / 68.63 / 127.35 | 587.3 / 598.6 / 566.1 | 5.39 7.14 7.31; 5.20 7.07 7.29; 9.22 7.56 7.43 | 24 |
| `core/workflow-autonomous-parity.test.ts` | 1 / 48 / 96 | 8.08 / 88.61 / 238.93 | 8.64 / 107.62 / 250.40 | 577.4 / 563.6 / 528.6 | 10.91 8.84 7.92; 14.12 9.54 8.15; 11.25 9.73 8.34 | 24 |
| `core/workflow-final-message-parity.test.ts` | 1 / 54 / 108 | 5.35 / 53.47 / 129.52 | 6.67 / 65.50 / 137.77 | 494.9 / 501.7 / 586.8 | 8.21 9.43 8.61; 7.87 9.34 8.58; 11.81 9.89 8.80 | 24 |
| `core/workflow-followup-parity.test.ts` | 1 / 28 / 57 | 5.67 / 47.04 / 109.78 | 7.65 / 24.71 / 55.93 | 608.7 / 610.8 / 577.0 | 14.15 11.07 9.35; 13.90 11.07 9.36; 16.01 12.05 9.77 | 24 |
| `core/workflow-no-progress-parity.test.ts` | 1 / 24 / 48 | 8.17 / 52.60 / 97.28 | 9.78 / 52.65 / 91.03 | 576.9 / 570.5 / 568.9 | 18.77 13.94 10.71; 18.07 13.96 10.75; 20.10 15.07 11.31 | 24 |
| `workflows/ci-wait-failure-parity.test.ts` | 1 / 24 / 48 | 4.81 / 72.76 / 219.91 | 6.60 / 87.48 / 254.69 | 606.5 / 598.3 / 584.5 | 19.24 16.49 12.22; 18.50 16.38 12.21; 21.77 17.38 12.86 | 24 |
| `workflows/ci-wait.test.ts` | 1 / 26 / 53 | 5.22 / 42.47 / 75.24 | 6.59 / 30.32 / 56.62 | 572.9 / 575.6 / 568.0 | 24.74 22.52 16.02 **†**; 24.20 22.44 16.03 **†**; 19.39 21.41 15.95 | 24 |
| `workflows/monitoring-turn.test.ts` | 1 / 69 / 138 | 6.24 / 142.67 / 295.94 | 8.24 / 165.61 / 284.62 | 589.9 / 593.9 / 599.5 | 17.72 20.60 16.13; 16.76 20.30 16.08; 8.08 15.63 14.93 | 24 |
| `workflows/run.test.ts` | 1 / 80 / 161 | 5.43 / 20.84 / 69.55 | 7.15 / 24.11 / 91.32 | 561.1 / 586.4 / 604.5 | 10.40 11.32 13.11; 10.75 11.36 13.10; 11.62 11.50 13.11 | 24 |
| `workflows/waits-claude-parity.test.ts` | 1 / 27 / 54 | 5.12 / 32.10 / 68.65 | 6.94 / 42.77 / 95.06 | 587.4 / 581.8 / 578.1 | 9.89 11.16 12.88; 9.34 11.03 12.83; 8.98 10.74 12.66 | 24 |
| `workflows/waits-claude-workers-parity.test.ts` | 1 / 23 / 47 | 6.52 / 49.11 / 85.18 | 9.00 / 60.55 / 108.89 | 579.3 / 610.6 / 590.6 | 9.39 10.50 12.43; 9.28 10.46 12.40; 13.95 11.50 12.65 | 24 |
| `workflows/waits-codex-parity.test.ts` | 1 / 27 / 54 | 5.24 / 39.62 / 68.90 | 7.08 / 54.62 / 97.47 | 589.1 / 569.9 / 555.5 | 7.32 9.96 12.00; 7.21 9.90 11.97; 9.64 10.19 11.99 | 24 |
| `workflows/waits-codex-workers-parity.test.ts` | 1 / 23 / 47 | 6.15 / 55.58 / 97.46 | 8.66 / 68.40 / 125.31 | 583.1 / 579.8 / 606.2 | 11.17 10.58 11.99; 11.40 10.63 12.00; 17.60 12.70 12.63 | 24 |
| `workflows/waits-cursor-parity.test.ts` | 1 / 27 / 54 | 8.07 / 63.30 / 114.03 | 8.34 / 51.47 / 98.79 | 529.9 / 563.7 / 553.7 | 13.60 13.13 12.82; 14.57 13.37 12.90; 8.95 11.92 12.43 | 24 |
| `workflows/waits-cursor-workers-parity.test.ts` | 1 / 23 / 47 | 9.79 / 80.24 / 158.35 | 10.64 / 68.55 / 139.25 | 605.8 / 585.9 / 602.3 | 8.03 10.21 11.71; 9.97 10.56 11.81; 10.63 10.82 11.81 | 24 |
| `workflows/waits-omp-parity.test.ts` | 1 / 27 / 54 | 5.33 / 31.03 / 53.88 | 7.11 / 38.36 / 69.35 | 604.9 / 599.2 / 588.8 | 11.39 11.62 11.99; 11.20 11.58 11.97; 11.98 11.80 12.04 | 24 |
| `workflows/waits-omp-workers-parity.test.ts` | 1 / 23 / 47 | 4.49 / 37.95 / 70.81 | 6.16 / 42.49 / 83.04 | 583.5 / 600.0 / 570.1 | 11.81 11.81 12.03; 11.18 11.68 11.98; 10.17 11.33 11.85 | 24 |
| `workflows/waits-opencode-parity.test.ts` | 1 / 27 / 54 | 6.33 / 42.65 / 72.12 | 8.53 / 56.95 / 96.85 | 625.0 / 596.0 / 610.1 | 11.16 11.42 11.85; 11.39 11.47 11.86; 11.62 11.52 11.86 | 24 |
| `workflows/waits-opencode-workers-parity.test.ts` | 1 / 23 / 47 | 7.30 / 52.53 / 94.36 | 9.71 / 64.21 / 121.30 | 591.1 / 427.9 / 584.8 | 11.25 11.27 11.73; 11.07 11.23 11.72; 11.64 11.55 11.81 | 24 |
| `workflows/waits-pi-parity.test.ts` | 1 / 27 / 54 | 5.15 / 46.07 / 70.14 | 6.99 / 52.36 / 86.47 | 577.1 / 599.9 / 603.3 | 7.53 10.48 11.43; 7.41 10.40 11.40; 16.19 12.32 12.00 | 24 |
| `workflows/waits-pi-workers-parity.test.ts` | 1 / 23 / 47 | 6.25 / 45.32 / 105.72 | 8.04 / 51.55 / 119.38 | 582.8 / 588.3 / 608.4 | 18.80 13.84 12.55; 18.46 13.93 12.59; 15.89 14.04 12.70 | 24 |
| `workflows/worker-parent-attention.test.ts` | 1 / 30 / 61 | 5.54 / 67.62 / 148.85 | 7.11 / 59.90 / 116.61 | 593.2 / 596.7 / 594.1 | 21.39 17.38 14.11; 20.32 17.23 14.08; 21.72 18.68 14.84 | 24 |
| `workflows/worker-questions.test.ts` | 1 / 27 / 54 | 8.37 / 66.51 / 143.81 | 10.41 / 66.12 / 149.94 | 575.3 / 579.8 / 608.6 | 16.63 17.76 15.09; 15.70 17.55 15.03; 13.04 16.30 14.78 | 24 |
| `workflows/worker-restart-parity.test.ts` | 1 / 12 / 24 | 5.66 / 25.66 / 56.38 | 7.36 / 23.88 / 45.60 | 583.4 / 571.3 / 558.7 | 15.11 16.04 14.91; 15.10 16.02 14.91; 14.62 15.87 14.89 | 24 |
| `workflows/worker-wait-capacity.test.ts` | 1 / 18 / 37 | 10.95 / 52.11 / 100.83 | 12.84 / 54.24 / 93.76 | 418.9 / 459.2 / 474.1 | 14.04 15.25 14.74; 13.84 15.18 14.72; 13.29 14.81 14.62 | 24 |
| `workflows/worker-wait-conversations.test.ts` | 1 / 14 / 29 | 8.10 / 44.60 / 80.27 | 8.18 / 30.47 / 52.63 | 534.9 / 541.6 / 543.5 | 15.46 15.75 15.02; 15.19 15.69 15.00; 13.43 15.15 14.85 | 24 |
| `workflows/worker-wait-durability.test.ts` | 1 / 24 / 48 | 6.84 / 45.84 / 97.82 | 7.13 / 43.14 / 79.28 | 598.8 / 596.0 / 525.0 | 14.75 15.07 14.85; 14.61 15.04 14.84; 15.98 15.31 14.93 | 24 |
| `delegation/provision-workflows.test.ts` | 1 / 69 / 138 | 11.21 / 45.83 / 99.99 | 9.68 / 45.67 / 96.63 | 543.2 / 554.2 / 595.0 | 30.17 20.19 16.71 **†**; 31.92 20.91 16.98 **†**; 31.81 22.47 17.70 **†** | 24 |
| `delegation/workspace.test.ts` | 1 / 44 / 89 | 5.95 / 34.64 / 63.50 | 6.76 / 38.13 / 69.05 | 582.3 / 580.7 / 602.3 | 28.09 23.95 18.75 **†**; 27.28 23.85 18.74 **†**; 27.64 24.33 19.09 **†** | 24 |



**†** marks a starting one-minute load above nproc (24). CI suite durations
remain the absolute reference. Local F1 conclusions use component shares, not
absolute local seconds.

### CPU and wait classification

The full-run CPU/wall ratio uses all reaped child CPU. A value above one is
possible with parallel child work and compiler threads even with one Vitest
worker. Below 0.70 is evidence of wait/I/O domination; 0.70–1.20 is mixed;
above 1.20 shows substantial CPU work. These are observations under the recorded
load, not claims that an OS scheduler delay is an application timer. SQLite
fsync, Git I/O and waiting for subprocesses can all make wall exceed CPU.

| File | Full CPU/wall | Observed cost class |
| --- | ---: | --- |
| `core/ci-tools.test.ts` | 1.34 | CPU work dominates |
| `core/harness-autosave-settlement.test.ts` | 2.02 | CPU work dominates |
| `core/harness-claude-parity.test.ts` | 1.10 | mixed |
| `core/harness-codex-parity.test.ts` | 0.59 | wait/I/O dominated |
| `core/harness-cursor-parity.test.ts` | 0.73 | mixed |
| `core/harness-opencode-parity.test.ts` | 0.81 | mixed |
| `core/skill-provision-parity.test.ts` | 1.30 | CPU work dominates |
| `core/skill-resume-parity.test.ts` | 1.28 | CPU work dominates |
| `core/workflow-ask-parity.test.ts` | 1.10 | mixed |
| `core/workflow-autonomous-parity.test.ts` | 1.05 | mixed |
| `core/workflow-final-message-parity.test.ts` | 1.06 | mixed |
| `core/workflow-followup-parity.test.ts` | 0.51 | wait/I/O dominated |
| `core/workflow-no-progress-parity.test.ts` | 0.94 | mixed |
| `workflows/ci-wait-failure-parity.test.ts` | 1.16 | mixed |
| `workflows/ci-wait.test.ts` | 0.75 | mixed |
| `workflows/monitoring-turn.test.ts` | 0.96 | mixed |
| `workflows/run.test.ts` | 1.31 | CPU work dominates |
| `workflows/waits-claude-parity.test.ts` | 1.38 | CPU work dominates |
| `workflows/waits-claude-workers-parity.test.ts` | 1.28 | CPU work dominates |
| `workflows/waits-codex-parity.test.ts` | 1.41 | CPU work dominates |
| `workflows/waits-codex-workers-parity.test.ts` | 1.29 | CPU work dominates |
| `workflows/waits-cursor-parity.test.ts` | 0.87 | mixed |
| `workflows/waits-cursor-workers-parity.test.ts` | 0.88 | mixed |
| `workflows/waits-omp-parity.test.ts` | 1.29 | CPU work dominates |
| `workflows/waits-omp-workers-parity.test.ts` | 1.17 | mixed |
| `workflows/waits-opencode-parity.test.ts` | 1.34 | CPU work dominates |
| `workflows/waits-opencode-workers-parity.test.ts` | 1.29 | CPU work dominates |
| `workflows/waits-pi-parity.test.ts` | 1.23 | CPU work dominates |
| `workflows/waits-pi-workers-parity.test.ts` | 1.13 | mixed |
| `workflows/worker-parent-attention.test.ts` | 0.78 | mixed |
| `workflows/worker-questions.test.ts` | 1.04 | mixed |
| `workflows/worker-restart-parity.test.ts` | 0.81 | mixed |
| `workflows/worker-wait-capacity.test.ts` | 0.93 | mixed |
| `workflows/worker-wait-conversations.test.ts` | 0.66 | wait/I/O dominated |
| `workflows/worker-wait-durability.test.ts` | 0.81 | mixed |
| `delegation/provision-workflows.test.ts` | 0.97 | mixed |
| `delegation/workspace.test.ts` | 1.09 | mixed |

## Cost and fix per file

The source evidence below distinguishes native process cost from Git, SQLite,
workflow and real-time wait cost. It does not treat every dry-run session as an
in-memory fake. The process profile and spike section quantifies the portion
that 3.2 can remove. Split groups are candidates for the 40 s CI target; they
must be sized using actual post-change CI measurements.

## Shared fixture evidence

- **H-seam:** `core/harness-parity.testkit.ts:1032–1093` `driveSeam` installs each backend's executable mock, clears dry run, and runs the production runner. It has no Git repository setup. A real native child plus stream/parser/auto-end/drain work occurs per cell.
- **H-run:** same file `:1132–1191` `driveRun` installs the native mock, runs five real Git commands to init/config/add/commit, opens a real `RunStore`, and starts a real manager. More Git/worktree/turn-bookkeeping runs inside the manager.
- **H-owned:** same file `:1300–1350`, `:1441–1490` `withOwnedInputRun` creates real Git, store and owned parent/worker state, then runs native mock children. Resume/recovery can start more children.
- **W:** `workflows/worker-wait.testkit.ts:126–145` creates a fresh Git repo (four Git commands), SQLite store, semaphore and manager per case. `:146–180` teardown cancels sessions, waits actual termination/execution/bookkeeping, disposes and closes the store. Default `CEZ_DRY_RUN=1` is **not an in-memory runner**: `core/claude-cli-runner.ts:66,866–870` selects bundled `scripts/mock-claude.mjs`. Native-wire tests explicitly replace bins. `worker-wait.testkit.ts:119–124` records that notes are disabled by default to avoid autosave Git commits; do not claim every case incurs that removed cost.
- **Controlled W wire:** `worker-wait.testkit.ts:189–218` writes a temporary executable Claude wire with fs gate polling every 5 ms, then selects it as the real CLI. It is a real child, not fake createRunner.
- **Wait parity:** `workflows/waits-parity-cells.testkit.ts:72–78` selects real native mocks; `:420–446` uses W for each row, and registers parts base/workers/process/entries. Existing timer helpers move deadlines or use fake timers: a declared timer of 60 s does not imply a real 60 s sleep. `:91` zeros wake retry backoff, so that retry delay is already removed.

## File-by-file findings

| File | Concrete cost evidence | Fix and semantic split candidates |
|---|---|---|
| core/ci-tools.test.ts | H-seam at :151,205,276. Runtime matrix = runners × fresh/resume × valid/invalid/tool cases. `CiToolsController` sessions and actual wire tool calls at :194–205,261–276. Pure schema/argument tests :20–145 are cheap relative to executable cells. | 3.2 replaces native agent child, preserves controller/IPC tool invocation. Split pure definitions/injection (:20–145), descriptor exposure (:146–184), H1 validation (:187–225), U0 native tool calls (:228+), then runner/fresh-resume if a group still exceeds target. |
| core/harness-autosave-settlement.test.ts | H-owned :227,331. :77–100 intercepts only real autosave `git status` with a Node leader that starts a detached holder. All other Git calls remain real (:104–119). :250 creates unrelated child churn. :350 creates further short-lived child churn. Rows :209–214 = 6 runners × fresh/Continue × failure/cancel/success. :310–314 = final autosave churn × fresh/Continue. | Keep holder/churn OS paths real. 3.2 removes only native agent boot, not Git/holder process. Split failure R61/R62, cancellation R63/R64, success R65/R66, unrelated churn R67/R68; divide each by runner and mode as CI weights require. Never fake the detached holder to meet the cap. |
| core/harness-claude-parity.test.ts | One-line wrapper calls `describeHarnessParity('claude')`; H-seam/H-run/H-owned shared registrations, not a small isolated unit. Shared testkit :978 seam,989 input,1054–1250 Continue/recovery/ownership,1300 session control,1452 run,1629 owned input,2528+ settlement,2959+ permissions. | 3.2 in-process ordinary wire cells; retain lifecycle/OS cases real. Split per existing describe groups: seam/session; input; run/ask; ownership/recovery; Finish/settlement; permissions/MCP. Keep every criterion registered once for Claude. |
| core/harness-codex-parity.test.ts | Same wrapper/shared groups, Codex app-server wire. Extra app-server handshake and turn/start/steer RPC occur per H-seam/run invocation. | Same semantic splits as Claude; Codex native RPC parsing stays production code under 3.2. |
| core/harness-cursor-parity.test.ts | Same wrapper/shared groups. Cursor print is one child per turn, so followups/Continue have repeated process cost beyond one child per case. | Same groups; retain print one-shot/resume contract and smoke. In-process print turns must model a distinct child/transport lifecycle per turn, not a permanent channel. |
| core/harness-opencode-parity.test.ts | Same wrapper/shared groups. OpenCode mock serve child plus local HTTP/SSE server/request lifecycle per fixture; startup/listen path is separate from native event parsing. | Same groups; keep server listen/retry OS cases real; in-process HTTP seam must preserve shipped request/event parser. |
| core/skill-provision-parity.test.ts | :66–117 custom fixture creates native mock, five Git commands (:89–95), store/manager, worktree and recovery. R92–R96 each across RUNNER_IDS (:147–221). Reads actual worktree files and Git status (:157). | 3.2 only native wire portion. Split Start R92 / live Continue R93 / recover R94 / live slash install R95 / Stop-preparation R96; combine measured cheap groups if safe; keep real worktree/file assertions. |
| core/skill-resume-parity.test.ts | :231–294 custom native fixture and five Git commands (:266–271), store/manager restart. R100 has Start+Continue+recover in one cell (:351), R53/R54/R57/R59/R55/fresh session :392–518; R56 driveSeam fresh/resume :543–577. OpenCode missing-session fallback :604+. | 3.2 wire boot reduction; split generation R100, live Continue R53/R55, recovery R54/R57/R59, declaration/wire R56, fresh/cross-runner session + OpenCode fallback. Further split runner axis for recovery-heavy group. |
| core/workflow-ask-parity.test.ts | H-run :47. RUNNER_IDS × Q criteria; Q7 fresh/continuation :40–42. Every non-Q9 row deliberately sleeps 350 ms (:78–80) to cross real auto-end 250 ms. Q8 deadline is already manually released (:13–35), not a real 2 s wait. Q5 drains and reopens real store/manager (:85–95). | 3.2 native wire; replace only negative auto-end observation with controlled product timer at proven readiness, retain one real timer smoke. Split ordinary ask/answer Q1–Q4, restart Q5, repeated/continuation Q6–Q7, timeout Q8, autonomous Q9; runner axis as needed. |
| core/workflow-autonomous-parity.test.ts | H-run/H-owned :57,136, driveSeam :124. RUNNER_IDS × A criteria × fresh/continuation for selected cases. A13/A14 execute actual idle callback, not real 15 min wait (:79–84); retain native delayed TERM and 50 ms negative window (:95). A9 has 150 ms negative wait (:171). :22 comment identifies former 13.5 s per-cell Cursor nudge delay, so do not infer current wait from obsolete comment without measured evidence. | 3.2 ordinary wire; preserve real teardown cases A13/A14 where signal/exit prove slot lifetime. Split autonomous budget/normal nudges, refusal/late readiness, idle close A13/A14; then runner and fresh/continuation. |
| core/workflow-final-message-parity.test.ts | H-seam silent tail :47–60; H-owned F rows :74,98,109+. F8 real 150 ms pre-deadline observation (:117), reply bound 300 ms (:126). F9/F11 use filesystem release gates and actual late native reply/start. F10 reply timer is already selectively faked (:214–238). | 3.2 ordinary wire preserves late ACK/turn event ordering; use product-controlled clock for F8 as sibling already does. Split silent-tail seam; ordinary nudge F1–F6; delayed ACK/no reply F7/F8; late reply/late start F9/F11; reply clock F10. Further runner split. |
| core/workflow-followup-parity.test.ts | H-run imported :17; native wrappers COALESCE_BIN/REVERSE_BIN :25–26; main matrix :142, specific Codex coalesced/reverse races :259–525. DEFERRED_TURN_START_MS=800 (:23) is actual delayed-turn boundary. fs gate/record files :95+. | 3.2 must preserve request/response ordering through production adapters. Split H1 completion, H2 ask, H3 hold, H4 delayed start; separate Codex coalesced/reverse/unread races. Preserve one real wrapper smoke per wrapper; controlled scheduling can replace 800 ms once order is proven. |
| core/workflow-no-progress-parity.test.ts | H-owned :91. DEFAULT_NO_PROGRESS_TIMEOUT_MS mocked to 800 (:10–14), selective timer control :20–43; startup/IPC remains real. N5 checks real SIGKILL receipt, process.kill liveness and termination (:120–140). N7 inherited pipe/output drain likewise real. | Ordinary deadline/park/ACK rows can use 3.2; keep N5/N7 real. Split active progress N1/N2, parked/Continue/question N3/N4/N6/N8, real escalation N5, held-pipe N7. Inactivity is already controlled: do not propose fake timers as a new fix for every row. |
| workflows/ci-wait-failure-parity.test.ts | W :12, with native mocks selected per RUNNER_IDS :69+. Git rev-parse :52. Three semantic families at :75 failed final CI/recovery, :128 failed nonfinal checks outcomes, :189 restart boundary recovery. GitHub resource is mocked (:22,28), so no real GitHub latency. | 3.2 native agent, preserve real store and accepted worker identity. Split final recovery, nonfinal check outcome, restart boundary; divide runner and checks outcome to fit. |
| workflows/ci-wait.test.ts | W + controlledWire imported :18. Real native overrides in two RUNNER_IDS matrices :110–114 and :219–223; remainder defaults to bundled Claude subprocess. GitHub watches mocked :25–54. Fake 120 s timer at :597–613; no real 120 s sleep. | 3.2 native children; split registration/dedup, admission/ACK/capacity, native refusal/activity runner matrix, restart/cancel/disconnect, ask/worker coexistence, wait-list/timers (:559+). Preserve durable transitions. |
| workflows/monitoring-turn.test.ts | W fixture :15. Every backend executes modes × M rows (:240–243), extra M13/M14/M17/M23 :245–286. Native bins :188–189. Real worktree Git add/commit for review fixture :107–115. Criteria exact meanings in monitoring-turn.testkit.ts:6–22. | 3.2 native wire; source fanout remains large. Split by semantic group: timer/prose M1/M2, worker review M3/M19, ask precedence M4/M7/M18/M21, done M5, autonomous M13/M14/M23, close M17; each runner or fresh/continuation if needed. |
| workflows/run.test.ts | Mixed suite, not all native: runnerHook mock :52–56, pure text/accounting groups :79–275; real Git setup repeated :283–290,405–410,888–893 and many later beforeEach blocks. CEZ_DRY_RUN=1 in integration groups still native mock. Explicit native Codex ask group :3233–3273. Poll sleeps 25–100 ms at :348,371,1033,1121,1195,2445,3158,3273. | 3.2 only default/mock-backed integration cells, no gain for pure/fake hook tests. Split existing describe boundaries: text/tail; usage/cost; bookkeeper/diff; Continue overrides; settlement gate; skill chain; monitoring/waits; asks; attachments/queued stack; recovery; Codex ask; registry skill expansion. Large monitoring group :1148–2400 needs further split by recovery and continuation families. |
| workflows/waits-claude-parity.test.ts | Wrapper :1–4 selects describeWaitParity({runner: 'claude', part: 'base'}); W setup/teardown for every row; nativeWire selects real mock at shared testkit :72–78. Shared rows :453–1689 exercise tools startup, CI/timer registration, slot/hold admission, budgets, questions, failed delivery/Continue and no-wait nudges. Retry backoff is already zero (:91); timeout deadlines are controlled, not literal waits for authored seconds. | 3.2 native agent startup. Split registration/cancel U26/U1/U4/U7; concurrent wakes/input U2/U3/U8*; budgets U10/U16/U16b; delivery bounds U12/U13/U14/U9c; open-wait failure U9/U11; human asks U7h/U7k/U7a/U9h; done/workflow U6/U6s/U7d; no-wait/answers U5*/U7q/U15/U17/U18. Split runner-local groups by fresh/Continue only if still over target. |
| workflows/waits-claude-workers-parity.test.ts | Wrapper :1–4 selects describeWaitParity({runner: 'claude', part: 'workers'}); W setup/teardown for every row; nativeWire selects real mock at shared testkit :72–78. Shared rows :1695–2840 create parent/worker sessions and real owned Git worktrees. They test simultaneous waits, messages/ACKs, refusal/closed-session continuations and fallback questions; repeated recovery starts additional native children. | 3.2 native agent startup; preserve real SQLite/owned workspace semantics. Split mixed waits U2w/U2t/U2c; worker notices U3w/U3n/U3r/U3d; worker wait/recovery U7w/U9w/U9u/U9v/U14m; conversations/peers U19*; refusal/completion U20*/U21*/R13/R17/R18; closed-session refusal U22*; fallback questions U24/U24r/U25. Subdivide U22 by fresh/restart/Continue when required. |
| workflows/waits-codex-parity.test.ts | Wrapper :1–4 selects describeWaitParity({runner: 'codex', part: 'base'}); W setup/teardown for every row; nativeWire selects real mock at shared testkit :72–78. Shared rows :453–1689 exercise tools startup, CI/timer registration, slot/hold admission, budgets, questions, failed delivery/Continue and no-wait nudges. Retry backoff is already zero (:91); timeout deadlines are controlled, not literal waits for authored seconds. | 3.2 native agent startup. Split registration/cancel U26/U1/U4/U7; concurrent wakes/input U2/U3/U8*; budgets U10/U16/U16b; delivery bounds U12/U13/U14/U9c; open-wait failure U9/U11; human asks U7h/U7k/U7a/U9h; done/workflow U6/U6s/U7d; no-wait/answers U5*/U7q/U15/U17/U18. Split runner-local groups by fresh/Continue only if still over target. |
| workflows/waits-codex-workers-parity.test.ts | Wrapper :1–4 selects describeWaitParity({runner: 'codex', part: 'workers'}); W setup/teardown for every row; nativeWire selects real mock at shared testkit :72–78. Shared rows :1695–2840 create parent/worker sessions and real owned Git worktrees. They test simultaneous waits, messages/ACKs, refusal/closed-session continuations and fallback questions; repeated recovery starts additional native children. | 3.2 native agent startup; preserve real SQLite/owned workspace semantics. Split mixed waits U2w/U2t/U2c; worker notices U3w/U3n/U3r/U3d; worker wait/recovery U7w/U9w/U9u/U9v/U14m; conversations/peers U19*; refusal/completion U20*/U21*/R13/R17/R18; closed-session refusal U22*; fallback questions U24/U24r/U25. Subdivide U22 by fresh/restart/Continue when required. |
| workflows/waits-cursor-parity.test.ts | Wrapper :1–4 selects describeWaitParity({runner: 'cursor', part: 'base'}); W setup/teardown for every row; nativeWire selects real mock at shared testkit :72–78. Shared rows :453–1689 exercise tools startup, CI/timer registration, slot/hold admission, budgets, questions, failed delivery/Continue and no-wait nudges. Retry backoff is already zero (:91); timeout deadlines are controlled, not literal waits for authored seconds. | 3.2 native agent startup. Split registration/cancel U26/U1/U4/U7; concurrent wakes/input U2/U3/U8*; budgets U10/U16/U16b; delivery bounds U12/U13/U14/U9c; open-wait failure U9/U11; human asks U7h/U7k/U7a/U9h; done/workflow U6/U6s/U7d; no-wait/answers U5*/U7q/U15/U17/U18. Split runner-local groups by fresh/Continue only if still over target. |
| workflows/waits-cursor-workers-parity.test.ts | Wrapper :1–4 selects describeWaitParity({runner: 'cursor', part: 'workers'}); W setup/teardown for every row; nativeWire selects real mock at shared testkit :72–78. Shared rows :1695–2840 create parent/worker sessions and real owned Git worktrees. They test simultaneous waits, messages/ACKs, refusal/closed-session continuations and fallback questions; repeated recovery starts additional native children. | 3.2 native agent startup; preserve real SQLite/owned workspace semantics. Split mixed waits U2w/U2t/U2c; worker notices U3w/U3n/U3r/U3d; worker wait/recovery U7w/U9w/U9u/U9v/U14m; conversations/peers U19*; refusal/completion U20*/U21*/R13/R17/R18; closed-session refusal U22*; fallback questions U24/U24r/U25. Subdivide U22 by fresh/restart/Continue when required. |
| workflows/waits-omp-parity.test.ts | Wrapper :1–4 selects describeWaitParity({runner: 'omp', part: 'base'}); W setup/teardown for every row; nativeWire selects real mock at shared testkit :72–78. Shared rows :453–1689 exercise tools startup, CI/timer registration, slot/hold admission, budgets, questions, failed delivery/Continue and no-wait nudges. Retry backoff is already zero (:91); timeout deadlines are controlled, not literal waits for authored seconds. | 3.2 native agent startup. Split registration/cancel U26/U1/U4/U7; concurrent wakes/input U2/U3/U8*; budgets U10/U16/U16b; delivery bounds U12/U13/U14/U9c; open-wait failure U9/U11; human asks U7h/U7k/U7a/U9h; done/workflow U6/U6s/U7d; no-wait/answers U5*/U7q/U15/U17/U18. Split runner-local groups by fresh/Continue only if still over target. |
| workflows/waits-omp-workers-parity.test.ts | Wrapper :1–4 selects describeWaitParity({runner: 'omp', part: 'workers'}); W setup/teardown for every row; nativeWire selects real mock at shared testkit :72–78. Shared rows :1695–2840 create parent/worker sessions and real owned Git worktrees. They test simultaneous waits, messages/ACKs, refusal/closed-session continuations and fallback questions; repeated recovery starts additional native children. | 3.2 native agent startup; preserve real SQLite/owned workspace semantics. Split mixed waits U2w/U2t/U2c; worker notices U3w/U3n/U3r/U3d; worker wait/recovery U7w/U9w/U9u/U9v/U14m; conversations/peers U19*; refusal/completion U20*/U21*/R13/R17/R18; closed-session refusal U22*; fallback questions U24/U24r/U25. Subdivide U22 by fresh/restart/Continue when required. |
| workflows/waits-opencode-parity.test.ts | Wrapper :1–4 selects describeWaitParity({runner: 'opencode', part: 'base'}); W setup/teardown for every row; nativeWire selects real mock at shared testkit :72–78. Shared rows :453–1689 exercise tools startup, CI/timer registration, slot/hold admission, budgets, questions, failed delivery/Continue and no-wait nudges. Retry backoff is already zero (:91); timeout deadlines are controlled, not literal waits for authored seconds. | 3.2 native agent startup. Split registration/cancel U26/U1/U4/U7; concurrent wakes/input U2/U3/U8*; budgets U10/U16/U16b; delivery bounds U12/U13/U14/U9c; open-wait failure U9/U11; human asks U7h/U7k/U7a/U9h; done/workflow U6/U6s/U7d; no-wait/answers U5*/U7q/U15/U17/U18. Split runner-local groups by fresh/Continue only if still over target. |
| workflows/waits-opencode-workers-parity.test.ts | Wrapper :1–4 selects describeWaitParity({runner: 'opencode', part: 'workers'}); W setup/teardown for every row; nativeWire selects real mock at shared testkit :72–78. Shared rows :1695–2840 create parent/worker sessions and real owned Git worktrees. They test simultaneous waits, messages/ACKs, refusal/closed-session continuations and fallback questions; repeated recovery starts additional native children. | 3.2 native agent startup; preserve real SQLite/owned workspace semantics. Split mixed waits U2w/U2t/U2c; worker notices U3w/U3n/U3r/U3d; worker wait/recovery U7w/U9w/U9u/U9v/U14m; conversations/peers U19*; refusal/completion U20*/U21*/R13/R17/R18; closed-session refusal U22*; fallback questions U24/U24r/U25. Subdivide U22 by fresh/restart/Continue when required. |
| workflows/waits-pi-parity.test.ts | Wrapper :1–4 selects describeWaitParity({runner: 'pi', part: 'base'}); W setup/teardown for every row; nativeWire selects real mock at shared testkit :72–78. Shared rows :453–1689 exercise tools startup, CI/timer registration, slot/hold admission, budgets, questions, failed delivery/Continue and no-wait nudges. Retry backoff is already zero (:91); timeout deadlines are controlled, not literal waits for authored seconds. | 3.2 native agent startup. Split registration/cancel U26/U1/U4/U7; concurrent wakes/input U2/U3/U8*; budgets U10/U16/U16b; delivery bounds U12/U13/U14/U9c; open-wait failure U9/U11; human asks U7h/U7k/U7a/U9h; done/workflow U6/U6s/U7d; no-wait/answers U5*/U7q/U15/U17/U18. Split runner-local groups by fresh/Continue only if still over target. |
| workflows/waits-pi-workers-parity.test.ts | Wrapper :1–4 selects describeWaitParity({runner: 'pi', part: 'workers'}); W setup/teardown for every row; nativeWire selects real mock at shared testkit :72–78. Shared rows :1695–2840 create parent/worker sessions and real owned Git worktrees. They test simultaneous waits, messages/ACKs, refusal/closed-session continuations and fallback questions; repeated recovery starts additional native children. | 3.2 native agent startup; preserve real SQLite/owned workspace semantics. Split mixed waits U2w/U2t/U2c; worker notices U3w/U3n/U3r/U3d; worker wait/recovery U7w/U9w/U9u/U9v/U14m; conversations/peers U19*; refusal/completion U20*/U21*/R13/R17/R18; closed-session refusal U22*; fallback questions U24/U24r/U25. Subdivide U22 by fresh/restart/Continue when required. |
| workflows/worker-parent-attention.test.ts | W fixture :29. RUNNER_IDS × fresh/continuation × ordinary/delayed ACK wire :28–34. Native backend plus Claude worker bins :36–37,50; held ACK/response helpers :8. Additional ACK/attention cases :96+. | 3.2 wire removes repeated agent startup, but actual input acknowledgement must stay in production adapter. Split fresh ordinary M26; fresh delayed-ACK M26; Continue ordinary M27; Continue delayed-ACK M27; remaining question/attention rows. Group per runner if needed. |
| workflows/worker-questions.test.ts | W :17,29. Broad question routing/recovery suite with actual default Claude mock subprocesses and owned worktrees. Recovery cases :531–533,693–909. Real 300 ms negative capacity observation :860. Real holder process support imported :3–6 and liveness :9. | 3.2 ordinary wire; keep holder/liveness evidence real. Split routing/admission (:54–245); fallback/Continue/commit failure (:246–411); reply semantics (:411–611); done/cancel relationships (:611–693); crash/recovery/unreadable parent (:693–909); inbox/request capacity and stopping (:909–1070). Split recovery groups again by case family. |
| workflows/worker-restart-parity.test.ts | W :19. Explicit native mocks :28–29,74–75,139–140. :101 real stdin-held Node process; :116 750 ms delayed holder close; :138+ same-boot crash and unreadable process; :199 5 s lock release backstop with bounded cleanup. Real git branch checks :131,205. | Keep real lifecycle/process-holder cells. 3.2 can remove ordinary native wire startup only if it does not remove process identity under test. Split R60 cold terminal starting proof (:26), readable/unreadable destroy by ledger kind (:73), same-boot crash/lock bound (:138), then runner. Do not replace the owned generation with a fake PID. |
| workflows/worker-wait-capacity.test.ts | W imported :13–17. Native matrix :84–89 (Codex/OpenCode/Pi/OMP) and actual held HTTP ACK :141–145. Negative 400 ms observations :50,110. Later rows seed active sessions/store and test restart/Finish persistence (:274–575); selective fake timer :518. | 3.2 native sessions; maintain held ACK semantics and capacity checkpoint ordering. Split nonfinal wake/next-step (:31–236); human answer/recovery (:237–345); inactive Finish/legacy children (:361–476); monitoring/cancel/restart (:514–575). 400 ms negative observations can use a controlled product timer after native readiness, retaining real smoke. |
| workflows/worker-wait-conversations.test.ts | W :12–15. WP1/WP2 runner matrices set real native backend and Claude child :48–51,75–78. WP2's 45/61 minutes are Date-only fake clock jumps (:110–114); native timers keep real time, so there is no real 45-minute sleep. Remaining rows :123–455 use default real Claude mocks plus durable inbox/request checkpoints. | 3.2 native sessions. Split WP1 progress matrix; WP2 resumed/late amendment matrix; progress/inbox ACK (:123–180); request lifecycle/deadline/restart (:207–326); monitoring and boundary races (:363–455). Keep correlation/receipt invariants. |
| workflows/worker-wait-durability.test.ts | W :13–17. Real SQLite checkpoints/reopen and default bundled Claude native sessions. Timer failure/deadline cases already fake at :85,363. 32 terminal outcomes :253–267 calls worker() 32 times; worker-wait.testkit.ts:280–288 only rev-parses HEAD, plans workspace and creates durable queued records, with no enqueue. This is 32 Git rev-parse/planning/store operations, not 32 agent starts. Recovery/delivery checkpoints :385–537, disposal/cancel :637–685. | 3.2 ordinary mock sessions. Split queued human/checkpoint failures (:30–202); capacity/status/outcomes (:203–329); deadline/validation (:330–384); recovery/delivery/message upgrade (:385–537); terminal/capacity ordering (:559–614); disposal/cancel (:637–685). Preserve crash checkpoint probes and actual store. |
| delegation/provision-workflows.test.ts | **Already fake runner:** :63–70 spies createRunner and returns in-memory AgentSession; no native agent startup. Real service fixture :60, `delegation/service.testkit.ts:77–87` runs Git init/config/commit/rev-parse and opens store/manager. Acceptance creates real owned workspaces. Many mode/backend/layout/damage cross-products (:115,252,269,415,442,470,510,523,580,598,614). Controller starts per test (:72). | No 3.2 speedup. 3.3 split governed intent matrix (:115); catalog/retry workflows (:150–237); mixed-runner identity (:252–397); input recipes/grants (:415–470); Claude layout/env (:510–569); account/model locks/identity (:580–666); skills/prompts (:695–719); credentials/revocation/recovery (:749–844). Divide large mode matrices by queued/restart/Continue as measured. Keep real identity/workspace acceptance. |
| delegation/workspace.test.ts | **Real Git topology suite**, not parity-wire cost. fixture :28–42 creates repo, two commits, parent worktree (many synchronous execFileSync calls). Tests exercise actual branch, index, receipt, marker, symlink, reflog, removal/lock/gc state. Only manager subgroups select dry-run :327,350,385,403; no agent in most rows. Large destruction group :419–893 has many parameterized damage/collision/reflog cases. | No general 3.2 speedup. Split committed isolation (:76–223); readOwnedDiff (:225–318); manager enqueue (:325–381); continuation/recovery (:383–417); destruction receipt/registration identity (:419–524); destruction changed HEAD/ref/reflog (:525–609); prepared/checkpoint/crash recovery (:610–747); concurrent topology attacks/locks (:748–845); git gc/reflog (:846–893); generic cleanup bypass (:895–955). Do not fake Git for tests whose guarantee is Git ownership identity. |



## Slice 3.2: keep the shipped wire adapters

### The seam and the default path

Use a Vitest partial module mock of `node:child_process.spawn`, installed before
importing the real runner factory or `RunManager`. Match only the selected
`HARNESS_ADAPTERS` mock executable and its native argv. Pass through every other
spawn and every unrelated child-process export. Git, discovery, `tsx`, process
probes and real lifecycle fixtures remain real.

**Proposed changed runner-source lines: none.** This does not mean no shipped
files change. `packages/cezar/package.json` includes `scripts` in its published
files, and CEZ_DRY_RUN executes these scripts. Extracting scenario engines changes
the shipped wrappers `mock-claude.mjs`, `mock-codex-app-server.mjs`,
`mock-opencode-serve.mjs`, `mock-pi-rpc.mjs`, `mock-cursor-print.mjs` and
`mock-omp-rpc.mjs` under `packages/cezar/scripts/`, plus their new shared engine
modules. Any shared control helper imported by those engines must be listed in
the 3.2 diff review too. Dry-run output must stay byte-identical, not merely
semantically similar. The 3.2 PR must record the raw-frame before/after comparison
for **every extracted scenario**, with the same inputs and original defaults.
Keep wrapper changes to imports and explicit dependencies; put the virtual child
and interception code in testkits. The smallest-seam and unchanged-default rule
applies to these shipped scripts as strictly as to runner source.

No source-line change is proposed in
`session-process.ts` and `runner-runtime.ts`. No constructor option, environment
flag or application dependency injection is needed. The shipped default path
executes the identical source, imports, spawn arguments, timers, parser and
cleanup calls. The interception module and virtual process belong in testkits.
This is smaller than a production transport abstraction and satisfies owner
constraint 1 without a default branch that must be reasoned equivalent.

A virtual child is an EventEmitter with PassThrough stdin/stdout/stderr. Keep
`error`, stdout EOF, process `exit`, and pipe/process `close` distinct. Implement
write backpressure and callbacks used by the adapters. Never allocate a plausible
OS PID or send a signal for a virtual child. The existing `spawnSessionLeader`
check excludes non-ChildProcess objects from group registration; preserve its
`never group-signals a fake child` test. PID and OS signal assertions stay real.

If ESM module mocking does not reach a runner's launch, or a native addon needs
a real ChildProcess, keep that cell real. Do not add a runner-source seam as a
fallback without another design review that lists each changed source line and
proves the default path identical. Current source inspection found no such
runner restriction.

| Runner and active wire | Existing launch boundary | What the test replaces | Shipped adapter retained |
| --- | --- | --- | --- |
| Claude, stream JSONL | `claude-cli-runner.ts:140` → `spawnSessionLeader` | Mock executable process and pipes | argv, stdin JSON, Claude parsing, mapping and settlement |
| Codex, app-server JSONL RPC | `codex-app-server-runner.ts:236` → `spawnCodexAppServer` → `spawnSessionLeader` | Mock app-server child and pipes | initialize/thread/turn RPC, correlation, asks, approval replies and mapping |
| OpenCode, serve REST and SSE | `opencode-server-runner.ts:610` → `spawnSessionLeader` | Mock serve child; publish a loopback server URL | URL discovery, real fetch, real node:http SSE reader, parent filtering, question and permission replies |
| Pi, RPC JSONL | `pi-runner.ts:112` → `spawnSessionLeader` | Mock RPC child and pipes | requests, responses, event parsing and mapping |
| Cursor, print stream JSON | `cursor-print-process.ts:39` → `spawnSessionLeader` | Each mock print child and pipes | print argv/stdin, parsing, exit settlement and resume argv |
| OMP, RPC JSONL | `omp-runner.ts:269` → `spawnSessionLeader` | Mock RPC child and pipes | ready gate, correlated replies, bounded refusal respawn and settlement |

Line numbers refer to the measurement checkout and identify read boundaries;
they are not a proposal to edit those lines. Cursor ACP sessions were removed
in hearsay-tools/cezarion#1267. Do not invent an ACP session seam or smoke.
ACP model discovery is a separate mechanism.

OpenCode needs a real loopback HTTP server in the test process. Replacing fetch
alone would leave its separate node:http SSE reader disconnected. Listen on an
OS-assigned loopback port, return the URL through the virtual serve child's
stdout, and exercise the actual REST and SSE parsers. Close connections and the
server in fixture cleanup. This removes the mock server process, not the HTTP
protocol boundary.

### One implementation of each mock scenario

Extract scenario engines from `packages/cezar/scripts/mock-*.mjs` into importable
helpers. Give them streams, argv, environment, cwd, exit and signal hooks. The
CLI wrapper and virtual process must call the same engine. Do not translate a
scenario into normalized AgentEvents. Per-session data must not leak through
shared process.env or module state.

These scripts also implement CEZ_DRY_RUN. Their wrapper defaults and wire bytes
must therefore stay unchanged. For each extracted scenario, compare the real
wrapper's raw native frames, recording files, exit status and terminal ordering
before and after extraction. Mask only pre-existing nondeterministic IDs/times
with the same comparison on both sides. Keep real signal scheduling in wrappers.
A scenario whose equivalence cannot be proved stays real; it does not gain a
second test-only scenario implementation.

Keep RunManager, RunStore, disk recovery and isolated git workspaces real. A
virtual process may reduce native mock startup cost. It must not replace the
behavior the workflow cells assert.

### Imported-testkit seam spike

The uncommitted spike is `.ai/qa/2516/spike.testkit.ts`, `spike.test.ts` and
`spike.vitest.config.ts`. The testkit installs the partial mock before the test
imports the real `driveSeam` and runner factory. A per-child vm.SourceTextModule
realm evaluates the **existing mock script and its dependencies**, with virtual
process/streams/console/timers and a real in-process HTTP server for OpenCode.
No runner or mock script was edited. The child intercept counter was one in
every virtual cell and zero in every real cell. All six baseline comparisons
passed: result text, tokens and v1 event-type order matched through production
adapters. This is feasibility evidence, not proof for every scenario.

```sh
NODE_OPTIONS=--experimental-vm-modules /usr/bin/time -v \
  -o .ai/qa/2516/spike-final.time npm test -- \
  --config .ai/qa/2516/spike.vitest.config.ts --maxWorkers=1
```

Starting load: `65.06 50.17 34.28 47/5164 2675557` **†**; nproc `24`. Ending load: `64.44 50.96 34.88 42/4919 2688676`.
The run passed 6/6 tests. Vitest reported 2.80 s test execution; the whole
invocation took 21.51 s inside Vitest, including imports and transforms. The
following cell times exclude that common Vitest startup. The real cell ran
first, so warm caches and JIT can favor the following virtual cell; one pair is
not a stable performance distribution. Raw per-runner observations are
`spike-<runner>.json` in the same ignored evidence directory.

| Runner | Real cell ms | In-process cell ms | Observed reduction | Interpretation |
| --- | ---: | ---: | ---: | --- |
| claude | 384.55 | 19.62 | 94.9% | Native launch removed; shipped adapter still parses native frames |
| codex | 171.24 | 29.94 | 82.5% | Native launch removed; shipped adapter still parses native frames |
| opencode | 526.96 | 92.91 | 82.4% | Native launch removed; shipped adapter still parses native frames |
| pi | 203.45 | 16.22 | 92.0% | Native launch removed; shipped adapter still parses native frames |
| cursor | 392.12 | 313.79 | 20.0% | The print turn still retains its adapter settlement wait |
| omp | 271.76 | 14.21 | 94.8% | Native launch removed; shipped adapter still parses native frames |

The first diagnostic attempt failed at module registration: Vitest does not
allow `export const x = vi.hoisted(...)`. A local hoisted binding followed by
`export { x }` works from the imported testkit. A second diagnostic attempt
passed five runners but OpenCode timed out because VM console output went to
the host console instead of the virtual child's stdout. Connecting its Console
to the virtual streams fixed discovery. No timeout was increased. The final
six-runner pass, not those failed attempts, supports feasibility.

These baseline deltas do not show that a whole parity file falls below 60 s.
The profiles below separate first-frame/close cost from real Git and residual
workflow/store/wait cost. CI suite durations remain the absolute performance
reference. Any file whose conservative residual exceeds the 40 s target gets
an explicit 3.3 split or measured cause fix; the design does not assume startup
removal fixes every row group.

### Real-process smoke cells and mutation proof

Keep one end-to-end baseline smoke per runner and current wire above. Assert
native resumable session ID, text, tool result, usage, one final done and terminal
ordering. Deliver another input and assert its receipt where the wire supports
it. Cursor must start another print process with --resume. End the session and
check real process exit. Keep cwd/env boundary probes real: a relative recording
file must land in the passed cwd because OS spawn applied cwd/env, not because a
virtual fixture wrote the expected path.

| Wire | Mutation that must make its real smoke fail |
| --- | --- |
| Claude | Suppress its native result frame |
| Codex | Suppress parent-thread turn/completed |
| OpenCode | Suppress the matching main-session session.idle; prompt HTTP acknowledgement alone must not finish the turn |
| Pi | Suppress agent_end |
| OMP | Suppress session_settled |
| Cursor | Suppress the terminal print result, or return nonzero after it |

Record a red mutation and clean pass for every wire against the same commit.
The failure must be the missing terminal guarantee, bounded by the existing
hang guard. Do not increase timeouts or add retries. Smoke is additional to,
not a replacement for, the real lifecycle coverage below.

### Parity guarantees retained

The assertion catalog and exhaustive RUNNER_IDS registration stay intact.
Every cell still runs the runner's own native wire parser. Preserve named inverse
exemptions and no-skips guards. Current cezar_done, cezar_ask and cezar_wait native
tool calls replace historical lifecycle marker examples in the 2026-09-04 spec;
do not restore markers removed by hearsay-tools/cezarion#2397.

| Original matrix guarantee | Evidence after migration |
| --- | --- |
| S1, exactly one final done and no later events | Same cell, virtual native frames; real baseline smoke |
| S2, terminal signal follows final content | Same cell and wire-specific smoke mutation |
| S3, resumable session id | Same cell and real resume smoke |
| S4, usage counters | Same native payload and mapper assertions |
| S5, second input | Same sendMessage cell; real smoke input receipt |
| S6, clean interrupt | In-process intent/order plus real shutdown tests |
| S7, provider/auth failure | Native failure frames through unchanged adapters and real RunManager failure assertion |
| S8, text coalescing | Native chunk boundaries through real parser and mapper |
| S9, child attribution | Native parent/child identifiers through actual filtering |
| S10, real PID | Real smoke and shutdown tests only |
| R1, declared completion reaches terminal status | Same real RunManager and durable store cell |
| R2, provider failure fails the run | Same real RunManager and native failure cell |
| R3, ask reaches the card | Same native ask/tool route and store assertions |
| R4, malformed asks do not become a card | Same malformed wire scenarios and inverse assertions |
| R5, monitoring and wake do not overlap | Same accepted wait and continuation assertions |
| R26, one answer continues an ask once | Same real message delivery and continuation cell |

AGENT_PROTOCOL §6 remains covered by unchanged ui-parity.test.ts: plans,
running/completed/failed tools, reasoning, diffs, subagents, usage, turn stop
reason, nesting, hooks and background-subagent lifecycle. Do not substitute
normalized events in either matrix. Section 7's specSupport proves tool grant,
model, cwd, env, resume, stream, interrupt and input support against each runner's
own mock wire. OS effects such as cwd/env and executable/argv semantics keep
real probes. The complete current criterion catalog, including later additions,
remains registered, not merely this historical subset.

### Process exits

Paths in the following tables are relative to `packages/cezar/src/`. Real
process-group and inherited-pipe cases remain real after 3.2. In-process tests
prove frame and event ordering, not OS cleanup.

| Case | Current file and exact test/criterion | After 3.2 |
|---|---|---|
| Clean completion | core/harness-parity-cells.testkit.ts S1 `terminates with exactly one v1 done, and it is the last event` | In-process plus real wire smoke |
| Terminal signal after content | Same S2 `ends the turn on its own terminal signal, after the last content event` | In-process plus real smoke |
| Clean exit without result | core/cursor-print-runner.test.ts `fails a clean process exit without a native result frame` | Existing non-parity test |
| Boundary waits for print exit | Same `waits for process exit before it emits the v1 turn boundary` | Existing non-parity test |
| Single-line stderr/nonzero | Harness S16 `preserves single-line stderr and nonzero exit codes` | In-process classification; retain real crash wire evidence |
| Empty stderr/nonzero | core/pi-runner.test.ts and core/omp-runner.test.ts `a non-zero exit with empty stderr fails with the bare exit code and no stderr note` | Existing non-parity |
| Crash after malformed output | Harness S15 `preserves actionable crash stderr and full available diagnostics after malformed native output` | In-process parser/order; real crash transport retained |
| Crash before ACK | Harness S18 `reports one actionable crash before terminal boundaries when the opening prompt is unacknowledged` | In-process ordering; real startup/crash evidence retained |
| Late stderr and inherited held pipes | Harness S19 `drains late crash stderr without waiting indefinitely for inherited pipes` (<4s while descendant holds for 5s) | Keep real |
| Harmless stderr during successful teardown | Harness S17 `keeps clean exits and requested signal teardown successful despite stderr` | In-process plus real normal close |
| stderr between exit and close | core/opencode-server-runner.test.ts `retains buffered stderr delivered between child exit and pipe close` | Existing non-parity |
| Event-loop stall and descendant diagnostic | core/runner-runtime.test.ts `reads a descendant diagnostic written while the event loop was blocked, then bounds held pipes` | Keep real |
| Drain budgets/cancel/cap | core/runner-runtime.test.ts `does not spend its budget on a stall, and the wall-clock cap still bounds it`; `cancels`; `gives a crash the longer budget and signal teardown the default` | Existing focused tests |
| Missing executable | Harness S20 `reports missing executables through its existing failure channel without starting a turn`; core/omp-runner.test.ts `ENOENT names omp and omp login`; core/claude-cli-runner.test.ts `rejects with the wrapped spawn error and emits nothing after it` | Keep real S20; no mock child is started |
| Outside signal | core/runner-shutdown-parity.test.ts S22 `treats an outside signal as failure` | Keep real every runner |
| Delayed native signal notification | Same S33 `preserves outside-signal failure when native exit notification follows EOF cleanup` | Keep real every runner |
| Delayed signal, probes unavailable | Same S34 `preserves delayed outside-signal failure when all process probes are unavailable` | Keep real every runner |
| Self-exit 143 is not Cezar signal | core/pi-runner.test.ts `rejects self-exit 143 when its native exit notification arrives after EOF cleanup`; `still rejects exit 143 when Cezar did not send the signal` | Existing non-parity |
| Requested signal success | core/claude-cli-runner.test.ts `settles the session instead of failing it when the CLI exits 143`; core/codex-app-server-runner.test.ts `settles the session instead of failing it when the app-server exits 143`; core/omp-runner.test.ts `a SIGKILL cezar sent is a teardown note, never an error` | Existing tests plus real shutdown |
| Hang/EOF and TERM ignored | core/runner-shutdown-parity.test.ts S23 `end escalates when the child cannot process EOF or SIGTERM` | Keep real every runner |
| Signal before stdout drain | core/claude-cli-runner.test.ts `settles a timeout when signal exit precedes stdout drain (hearsay-tools/cezarion#470)` | Existing test |
| stdout drained while live | Same `keeps timeout escalation alive after stdout has drained (hearsay-tools/cezarion#470)` | Existing test |
| Node killed flag not death | core/codex-app-server-runner.test.ts `escalates on the wall-clock timeout even after Node flagged the child as killed`; Claude `escalates after end() even though Node already flagged the child as killed`; OpenCode `escalates after end() even once Node flagged the server as killed` | Existing tests |
| Real exit cancels escalation | Claude/Codex/OpenCode runner tests `stops escalating once the ... really exits after SIGTERM` | Existing tests |
| Live output transport failure | core/runner-shutdown-parity.test.ts S24 `stops the live child when its output transport fails`; SSE destroyed for OpenCode, stdout for others | Keep real |
| Clean stdout EOF before exit | Same `${backend} reaps a live child after stdout ends cleanly` (Pi/Claude) | Keep real |
| EOF fallback evidence | Same `${backend} keeps live EOF cleanup bounded with unavailable process evidence` (Claude/Codex/Pi) | Keep real |
| EOF no usable evidence | Same `${backend} unknown automatic EOF cleanup fails but still reaps the live child (%s)` (unavailable/timeout) | Keep real |
| Explicit cleanup intent | Same `${backend} explicit ${intent} ${when} wins over unknown automatic cleanup` (end/interrupt × before EOF/during probe/after TERM) | Keep real |
| Interrupt preserves KILL deadline | Same `${backend} interrupt during automatic cleanup keeps the earlier KILL deadline` | Keep real |
| stdin closes/errors while live | core/omp-input-pipe.test.ts `${backend} surfaces closed-input failure S29`; `fails queued-before-ready writes even when the child would exit zero` | Preserve current transport tests; Cursor has no live writable follow-up stdin after prompt admission: print closes stdin after one prompt and queues human follow-ups for a new child. `PARITY_EXEMPTIONS` in `core/harness-parity.testkit.ts:763` declares S29 `scenario-unconstructible`; `core/omp-input-pipe.test.ts` registers the inverted exemption assertion |
| Leader owns process group | core/runner-shutdown-parity.test.ts S26 `the session leader leads its own process group` | Keep real |
| Stop kills group/preserves setsid | Same S27 `stop ends the leader's process group but not a setsid child` | Keep real |
| Escalation reaches group | Same S28 `end escalation reaches the whole process group` | Keep real |
| Normal leader exit reaps group | Same S30 `a leader that exits on its own leaves nothing in its process group` | Keep real |
| External kill reaps group | Same S31 `a leader killed from outside leaves nothing in its process group` | Keep real |
| Fixture signal readiness race | Same `${backend} an ignore-term stall survives SIGTERM sent as soon as it publishes its pid` | Keep real |
| OpenCode exits before listening | Harness S25 `retries a backend server that exits before listening once and completes the turn`; core/opencode-serve-retry.test.ts `retries a server that exited before listening once, on a new process, and completes the turn` | Keep real S25; other runners lack separate listen stage |
| Retry exits/hangs/spawn fails | core/opencode-serve-retry.test.ts `fails with one error naming both attempts when the retry also exits before listening`; `does not blame both attempts when the retry hangs instead of exiting early`; `names the retry spawn failure instead of only the first early exit when the retry cannot start` | Existing focused tests |
| Retry pause interrupted/ended/deadline | Same `spawns no second server when the session is interrupted during the retry pause`; `spawns no second server when the session is ended during the retry pause`; `spawns no second server once the run deadline fired, and reports only the timeout` | Existing tests |
| OMP bounded refusal respawn | core/omp-runner.test.ts `respawns once without --add-dir and names the dropped directories`; `respawns once without the passed MCP names OMP did not know, with one v1 note`; `a second refusal of a remaining MCP name is surfaced, never a third spawn`; `the respawn gets only the time left on the original deadline` | Existing tests |
| OMP input/PID/control after respawn | Same `a human message sent right after start survives the respawn and reaches the second child once, in order`; `pid is the live child after a respawn, and onPidChange reports it`; `interrupt after a respawn aborts and kills the second child`; `end after a respawn closes the second child and finishes the run` | Existing tests |
| Persisted crash recovery | workflows/worker-restart-parity.test.ts `%s R60 cold terminal starting-proof recovery repairs execution without a synchronous facts join`; `%s completes destroy once the readable holder exits, while an unreadable process runs (${ledgerKind} ledger)`; `%s settles a same-boot crash as gone once recorded processes exit, whatever unreadable process runs, and keeps cleanup locks bounded` | Keep real process-holder evidence; only ordinary wire can move |
| Dead-owner adoption/stop starts nothing | Harness R51 `adopting a dead owner's run mid-turn starts no agent, and Continue resumes it`; R52 `Stop on a dead owner's run mid-turn ends it cancelled and starts no agent` | In-process wire sufficient for start counting; preserve disk recovery |

## Shared process helper tests retained

core/session-process.test.ts:
- `spawns a leader that leads its own process group`
- `signalling a session reaches a member that ignores SIGTERM after its leader exits`
- `a setsid member is never signalled`
- `a leader that exits on its own ends a member that handles SIGTERM`
- `a member that ignores SIGTERM is killed after the grace once its leader exits on its own`
- `a setsid member survives a leader that exits on its own`
- `a child spawned in the group after its leader exits on its own is still ended`
- `never group-signals a fake child`

core/session-process-reuse.test.ts:
- `never forwards to the number once a new live leader holds it`
- `never forwards to a reused group whose new leader already exited`
- `a recorded member that moved to another group no longer vouches for this one`
- `a pid reused by a new incarnation no longer vouches for the group`
- `never sends the SIGKILL to a number emptied and reused after the SIGTERM`
- `still SIGKILLs a child that ignores SIGTERM, started after the exit, when every recorded member ends on the SIGTERM`

core/session-process-win32.test.ts:
- `ends a live leader's tree with taskkill /T /F`
- `runs no taskkill for a leader that already exited`
- `never runs taskkill for a child it did not spawn`
- `falls back to the leader alone when taskkill cannot start`

core/mock-opencode-orphan.test.ts:
- `exits after its parent gets SIGKILL`
- `exits after its parent gets SIGKILL in the mode that ignores SIGTERM`

## Required detached-process cases

All evidence in detached-process.test.ts.

| Case | Exact evidence or gap | After 3.2 |
|---|---|---|
| Normal stop | `stops a running group with SIGTERM` | Preserve |
| Leader exits before members | `kills a member that ignores SIGTERM and outlives its leader`; `stops what is left of the group once Node reaped its leader, a member that ignores SIGTERM included`; watchGroup `stops what is left of a group whose leader exited on its own` | Preserve real |
| Starter dies during boot before descriptor | watchGroup `leaves the group to its starter, then stops it once the starter dies during boot` (real SIGKILL) | Preserve real |
| Starter SIGINT before/after start | No exact generic helper test found | Explicit coverage gap; do not claim generic helper proves it |
| Starter SIGKILL after descriptor | Boot test is before descriptor; no exact after-descriptor test found | Explicit gap; preserve owner-specific lifecycle tests |
| Handle deleted | watchGroup `stops the group once its handle is deleted, and settles the verdict after the stop` | Preserve real |
| Forged/reused PID | `never signals a live process whose start identity differs from the record: a reused or forged pid` | Preserve real |
| Unreadable identity | `never signals a live leader whose start identity cannot be read now: its pid may lead another group`; `stops a leader this process holds, though its start identity cannot be read` | Preserve both |
| Missing identity | `never signals a leader whose start identity was not recorded: its pid may name another process` | Preserve |
| Zombie main thread, live port-holding threads | `counts it running while another thread holds its port, and stops it only once the port is free` | Preserve real |
| Intentional unowned launch survives starter | startAndForget `keeps nothing alive: its caller exits while the process runs and before the settle window ends` asserts child remains alive | Preserve; distinct from owned cleanup |




## Slice 3.3 plan

Split remaining slow files by semantic row group. Keep one definition of each
row and have thin files register disjoint groups. A guard must prove that every
criterion/runner pair appears exactly once across those files. Do not replace
coverage with skips, retries, higher timeouts or runner exemptions.

The design target is **at most 40 s per file on CI**, with a hard failure at
60 s. The 20 s gap gives load headroom. Use measured post-3.2 CI durations to
choose row groups. If a proposed group exceeds 40 s, split it again or remove
its measured cause. Do not aim for a 55–59 s file. The final per-file plan below
assigns groups and budgets; all budgets need confirmation on the actual CI
worker count, not extrapolation from local one-worker wall time.

Add one Vitest reporter in every shard. At file completion, read the actual
module execution duration used by Vitest's suite summary, including that file's
hooks and teardown. Fail the shard when any completed file takes **60,000 ms or
more**. Print its path, measured duration and the hard limit. A crashed worker
must already fail Vitest; a collected file without a completed verdict must not
be treated as a passing duration. Reporter tests pin those paths as well as the
59,999 / 60,000 / 60,001 ms boundary.

Keep the existing required aggregate that needs all four shard jobs to pass.
This is sufficient: a failed reporter fails its shard, and missing/skipped shards
cannot satisfy the required aggregate for a run that owes tests. A separate
artifact admission system adds no failure coverage here and is not proposed.
Optional timing artifacts can help analysis; they never admit a failing shard.
The guard reads live measurements only. It does not read this table, the
historical manifest, a baseline, an allowlist or an earlier run's median.

Merge-queue reuse must reuse only successful PR test evidence for the exact
immutable tested head/tree allowed by the existing evidence contract. The PR
Vitest run enforces the cap on all four shards. A changed head needs fresh
cap-enforcing PR evidence; queue reuse must not turn missing evidence, evidence
from before the reporter landed, or another head's timing pass into admission.
Prove this with the existing evidence/queue tests in the 3.3 PR. The main run
that skips Vitest is evidence reuse, not a fresh measurement of file durations.

Land the cap only after every real Vitest file passes in CI. First fix causes or
split rows for any file over the 40 s target. Then demonstrate all four shards
pass with the reporter. No exceptions, skip, retry or longer timeout.

### Removing the Squeal wait bound

`squeal.config.json` currently sets `runner.timeoutMs` to 900,000 ms. The bound
in `.ai/skills/validation/SKILL.md` (the `squeal-wait-bound` section) handles
unknown verdicts at that cap and files still pending after cap plus five
minutes. Faster CI alone does not prove that this escape path is unnecessary:
Squeal queue latency, local load and missing verdicts must also be measured.

The 3.2 PR records time from the first verdict wait at its exact revision to a
current Squeal verdict for the heaviest changed parity files, with starting and
ending load average, nproc, Squeal state, file count, queue delay and file
execution time. Trigger the actual shared-testkit invalidation, not only a
single warm cached cell. All affected files must reach current passing verdicts
without the targeted-run escape path, unknown results or a cap timeout. Compare
these verdict times with the unchanged 900 s cap and 1,200 s pending bound.
Do not increase either value to obtain a pass.

Remove the bound with the replacement, per the campaign rule. If any parity
file still requires it after 3.2, the 3.2 report must name that file, measured
queue/execution cause and its 3.3 split or cause fix. Keep the bound until that
fix lands and repeat the verdict measurement. If the issue is Squeal failing to
queue a file rather than suite cost, a row split does not fix it; resolve that
cause before claiming the bound obsolete. The cap lands only after the final
file fix, and the bound disappears only with measured current verdict evidence.

## Required case tables

This docs-only PR changes no state, cross-run relationship, ToolGrant mapping,
worktree write or restored client state. Those five application-change tables
do not apply. Slice 3.2 changes the test transport, not shipped state or grants;
it must preserve their existing parity rows and recovery fixtures. Process
lifecycle tables do apply because removing real mock processes can remove proof
about detached descendants. The Process exits table names what remains real,
including the separate detached-helper ownership cases.
