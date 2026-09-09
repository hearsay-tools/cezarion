# Worker-wait suite split

Baseline: `76429dcf` (`origin/main` at implementation). The worker-wait portion of `.github/benchmarks/156/splitting.patch` was applied; the other large-suite prototypes were not applied. Production code is unchanged.

The original 105 cases now occupy three independently schedulable files:

| File | Cases |
| --- | ---: |
| `worker-wait.test.ts` | 28 |
| `worker-wait-capacity.test.ts` | 35 |
| `worker-wait-durability.test.ts` | 42 |

`worker-wait.testkit.ts` contains the original shared fixture and helpers. Vitest's existing file isolation provides each suite its own module state; no concurrent test mode was added. The 30-second suite and teardown budgets, 15-second state assertions, runner timers, cancellation, execution/bookkeeping drains, manager disposal, store flush, temporary-directory removal and environment restoration are unchanged.

## Preservation evidence

- Ran `npm exec -- vitest list` on the original file and on the three split files, each with `--maxWorkers=4` and `TMPDIR=/tmp TMP=/tmp TEMP=/tmp`. Both inventories contain 105 cases; sorted complete case names are exactly identical, including parameter expansions and the original describe name.
- Compared all 66 source test declarations (expanded by loops/parameters to 105 cases). Every body matches after whitespace normalization and only two mechanical fixture-access rewrites: assigning the captured diagnostic state becomes `setFailureState(captureState())`; two repeated store/manager reconstruction sequences become `reopenRuntime()`. That helper performs the same open, constructor and tracking calls in the same order.
- The complete original `beforeEach` and `afterEach` hook text is byte-identical in the shared fixture. No assertions, cases, skips or timeouts were removed or weakened.
- The source-line multiset comparison shows only exported fixture declarations, duplicated imports/describe wrappers, fixture-hook installation and those access rewrites. No production edits were needed.

## Validation

All commands used OS temporary paths (`TMPDIR=/tmp TMP=/tmp TEMP=/tmp`).

```sh
npm test -- packages/cezar/src/workflows/worker-wait.test.ts packages/cezar/src/workflows/worker-wait-capacity.test.ts packages/cezar/src/workflows/worker-wait-durability.test.ts --maxWorkers=4
npm run typecheck:server
```

Targeted Vitest result: **3 files passed, 105 tests passed**, 68.36 seconds elapsed, 174.56 seconds summed test execution. Server typecheck passed. This targeted run proves preservation and isolation; it does not establish whole-shard performance under CI load.

`worker-wait-split.patch` is baseline-relative and includes all four source files, including the three newly created files. Raw local inventory and validation logs were recorded under `/tmp/worker-wait-{before,after}.json`, `/tmp/worker-wait-targeted.log`, and `/tmp/worker-wait-typecheck.log`; the new inventory was also copied to `/tmp/cez-worker-wait-split-inventory.json` for benchmark weight derivation.
