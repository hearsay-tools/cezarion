# hearsay-tools/cezarion#764 verification

Replace timing assumptions with observable waits. Production behavior, scheduling, and concurrency policy are unchanged.

## Coverage

- Replaced seven browser sleeps, five clock-only waits, and two packaged CLI observation delays.
- History checks wait for paging, response consumption and settled anchors; cumulative counters preserve the negative cascade assertion.
- Focus, persisted preferences, fonts, animations and geometry provide readiness signals. Frame-by-frame arrival and celebration coverage remain intact.
- Shared polling bounds each request and the enclosing deadline; settled probes abort unread response streams.
- The wait guard recognizes clock-only predicates (including constructed Date clocks), distinguishes event deadlines per call, covers packaged helpers, and shrinks the baseline.
- Real-child regressions cover interrupted atomic tick publication and cancellation cleanup. Deterministic variable-latency probes cover the complete stability hold.

## Validation

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm test` | 526 files / 11,345 tests passed at merged full local gate; subsequent focused regressions passed |
| `npm run test:unit` | 568 passed |
| `VITE_CEZ_E2E=1 npm run build` | Passed, including package-content check |
| `npm run test:package` | 62 passed after fixture follow-ups |
| `npm run test:e2e:local` | Four lanes, 63 files; 599 passed, 7 existing skips |
| Controlled idle campaign | 10/10 invocations, 100 selected case executions |
| Controlled eight-task campaign | 10 rounds × 8 lanes; 80/80 invocations, 800 selected case executions |
| [CI on `b9c29860`](https://github.com/hearsay-tools/cezarion/actions/runs/37031350034) | All unit, browser, build, typecheck and package checks passed |

Idle ran on `06836933`, load on `8fb8920b`; later corrections have focused red/green evidence and complete CI validation. Each campaign invocation selected ten cases across history, GitHub focus/geometry, persistence and skills. Fresh isolated worktrees provided private servers, homes and browser namespaces. Actual peak owned browser sessions were 2 idle and 14 loaded (one case temporarily opens two sessions); peak one-minute host load was 2.52 / 15.78, minimum available memory 38.87 / 32.47 GiB. Invocation durations were 29.984–44.250 seconds idle and 28.878–61.275 seconds loaded.

## Evidence and limits

Raw iteration logs, screenshots, probes, reproduction patches, campaign script and samples are retained as a separate archive, not part of the final source diff: [download in Cezar](/tasks/a001c986-83f8-441e-9cb8-874e3a36cac5/files?artifact=cd43dd90-2169-40ce-9a7d-d8610391bb01). GitHub reviewers can also inspect the [archived detailed report and relative evidence at the pre-cleanup commit](https://github.com/hearsay-tools/cezarion/blob/b9c298600d9ff09b17d38d73703bb59c8e48b1ab/.ai/reports/764-observable-waits.md).

An earlier loaded fixture startup failed before browser creation without sufficient child output to establish its cause. Bounded diagnostics were added without changing budgets; the following 80-invocation campaign had no recurrence. This is not a claimed startup fix. Controlled theme-click evidence demonstrates the missing ordering guarantee; the exact original CI event sequence was not retained.

Latest main was merged normally before opening draft PR hearsay-tools/cezarion#773, with no conflicts. Review findings and addressing commits are recorded in the PR threads.

## Review follow-ups

The history observer now restores the exact previous fetch function in `finally` and removes its globals. The identity assertion failed before restoration; the full history file passes 7/7 afterward. A forced observation failure also confirmed restoration and clean globals before the following page-cap test passed.

Plan-control evidence uses a controlled finite sheet animation with a transient transparent hit surface: without `settleVisual`, the native click rejects the covered target; with settlement, all six cases pass with one click and no interception. Removing the injection leaves the ordinary plan file 6/6 green. This proves the readiness requirement under controlled reflow; it does not claim to reproduce the exact historical silent-coordinate miss. The 52 helper/visual/scanner tests and web typecheck pass. [Follow-up logs, patches, bundles and exact commands](/tasks/a001c986-83f8-441e-9cb8-874e3a36cac5/files?artifact=f21b8b6b-a6a1-4ced-9cc4-b2bd2bf902a3) remain outside the source diff.
