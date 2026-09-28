# #662 ranked fix 2 — asynchronous project metadata

Base: `e97c6314629502298e89919b8774762307fb1b77` (`main`, 2026-09-28). PR #673 was still open when work began; none of its discovery/coalescing changes are included. This is a partial fix, related to #662.

## First list delivery

| Capture | Median ms | Range ms | Samples |
| --- | ---: | ---: | ---: |
| before | 2201.85 | 2109.65–3803.63 | 3 |
| after | 1547.89 | 1413.01–3393.22 | 3 |

Median reduction: **653.96 ms (29.7%)**. This is a small, sequential live sample, not a latency guarantee or measured browser paint. The original diagnosis estimated 220–570 ms from its own spans; this run has different GitHub latency and a 2.12-second pre-change membership tail.

After-change first responses arrived at 1413.01, 3393.22 and 1547.89 ms, with memberships still `refreshing`. Their membership subprocesses ended at 3469.50, 3979.26 and 2059.75 ms: 2056.49, 586.04 and 511.86 ms after list delivery. Every follow-up settled `ready`. The last two are near the diagnosis estimate; the outlier demonstrates that a slower optional lookup no longer delays the list.

Counts still gate delivery and remain unchanged. In the first and third after samples the last required subprocess finished at 1407.01 and 1544.01 ms (counts); membership began at 1209.24 and 1429.44 ms. Thus simply subtracting membership duration would overstate the saving. In the second after sample issue listing itself took the critical path through 3389.30 ms.

## CLI control

| Command | Before median ms | After median ms |
| --- | ---: | ---: |
| startup | 70.10 | 60.46 |
| repo | 420.27 | 456.48 |
| light | 456.61 | 442.45 |
| rich | 644.91 | 692.32 |

CLI controls are unchanged production queries; differences are environmental variation, not fix-2 gains. Discovery and ref-status behavior are out of scope.

## Reproduction and capture details

Reused `profile.mjs` and `cli.mjs` from `origin/fix/github-discovery-coalescing`. Before JSON used the original scripts. The retained profile adds metadata state/generation and drains the follow-up **after** measuring the initial response, before resetting its instrumentation epoch; this prevents background spans being attributed to the next sample. No response contents or credentials are retained. The original HTTP cases and CLI rounds remain intact.

```sh
node --import tsx .ai/analysis/662-github-refresh/profile.mjs > .ai/analysis/662-github-refresh/fix2-after-http.json
node --import tsx .ai/analysis/662-github-refresh/cli.mjs > .ai/analysis/662-github-refresh/fix2-after-cli.json
```

HTTP JSON records the base HEAD because the source changes were uncommitted while measured. The after source is the implementation in this PR. The harness uses an ephemeral isolated HTTP app, not a second cockpit serve.

The regression test holds the membership subprocess unresolved: it failed on the original implementation (`delivered` was false), then passed with asynchronous hydration. Client coverage checks pending lists, preserved selected filters, convergence, unavailable metadata and network failures. Server coverage checks recovery, repository isolation and obsolete-generation completion.

## UI and review evidence

A real Chrome session reused the full browser gate's test environment, serving
synthetic list and deferred metadata responses through browser fetch. At 360×640
and 1280×800, light and dark, the board selector retained `P1`, kept a 44px target,
and stayed within the viewport. Two visible rows during refreshing converged to
one after verified memberships arrived. `fix2-browser-qa.json` records the DOM
observations. The pending state uses `role="status"`; no imagery or motion was added.

Independent review found a reverse-list-completion race. A new regression failed
before request-order protection, then passed with it. This guard was added after
the timing captures; it adds no I/O and leaves the measured critical path intact.
The follow-up endpoint also refuses expired and cross-repository generations.

## Final verification

All six project gates passed: typecheck; Vitest (483 files, 10,201 tests);
Node unit (64 service and 503 root tests); build and check:pack (706 files);
packaged CLI (59 tests); full browser suite (49 files, 473 passed, six existing
conditional skips, `TEST_E2E_STATUS=passed`). The request-order review fix also
passed a fresh typecheck and 224 focused server tests. The requested existing
client pattern `refresh|Refresh|batch|union|cached` passed 15 tests (178 unmatched).
