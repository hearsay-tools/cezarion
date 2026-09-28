# PR 675 integration onto shared discovery

The intentional merge retains main's shared discovery and reference coalescing and PR 675's deferred project membership lookup. All list cache reads, request-order publication, generation updates and hydration endpoint reads now use the shared repository/host/account context key. Previous verified memberships compare against the shared resolved repository handle. Viewer and deferred project calls retain the captured context. The profiling harness keeps hydration draining/sampling so pending work cannot contaminate the following sample.

## Live HTTP measurements

Same harness, three list refreshes per phase; before is original PR head 11dd2494, after is its merge with main 22a078a1 plus the context-key integration. The after capture reports the original HEAD because the merge was uncommitted. Measurements finished before the full verification suite. These measure request through HTTP body parse, not browser paint or production tail latency. Small sequential samples are not an SLA.

| Phase | List delivery ms | Median ms | Repo discovery calls per refresh | Hydration after delivery ms |
| --- | --- | --- | --- | --- |
| before | [1528.92, 1442.49, 1376.72] | 1442.49 | [1, 1, 1] | [2392.47, 420.61, 493.6] |
| after | [1187.65, 1157.51, 1115.37] | 1157.51 | [0, 0, 0] | [304.61, 672.91, 315.59] |

All samples returned available data; all list hydrations became ready. Warm refresh discovery dropped from one subprocess to zero while membership work remained off initial delivery. Median initial delivery decreased from 1442.49 to 1157.51 ms (284.98 ms, 19.8%) in this run; network variance remains material.

## Regression evidence

Two parameterized regressions exercise GH_HOST and GH_CONFIG_DIR changes during deferred hydration. Against original PR production code both failed: the foreign context received ready metadata instead of unavailable. With the recombined driver, all 240 focused forge tests passed, including shared-discovery/coalescing, verified-membership preservation, unavailable recovery and reverse request/generation ordering.

SDLC documentation check: no process, workflow, skill or development-binding behavior changes; no SDLC documentation update required.
