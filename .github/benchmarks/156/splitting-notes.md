# Suite-splitting experiment

Baseline: `b1fe75911378dfe7816a7a83312c2acbdcf848f4`.

The patch partitions only tests. Production sources are unchanged, no test or
suite uses blanket concurrency, and complete top-level scenario groups remain
intact. `run.test.ts` becomes four scheduled files, `harness-parity.test.ts`
becomes three, and worker waits become three. Shared parity criteria, exemption
logic, control IDs, and row registration live in
`harness-parity-cases.testkit.ts`; the matrix self-checks therefore inspect the
same definitions executed by every slice. `worker-wait.testkit.ts` installs
the original per-test setup, failure-state capture, process cancellation,
flush, timer restoration, and recursive temporary-repo cleanup inside each
suite. Real process-exit, fsync/checkpoint, and timer assertions are retained.

Vitest collection by full test name proves inventory equality:

```text
baseline_cases 355
split_cases    355
missing          0
extra            0

worker-wait:   28 + 35 + 42 = 105
harness-parity: 52 + 52 + 21 = 125
run:           51 + 19 + 46 + 9 = 125
```

Correctness evidence from the temporary baseline copy:

- `npx tsc --noEmit -p packages/cezar/tsconfig.test.json --pretty false`: passed.
- Targeted Vitest run of all ten resulting files: 10 files passed, 355 tests passed.
- Balanced-call comparison found 193/195 direct `it(...)` nodes byte-identical.
  The two adapted nodes replace manual store/manager reconstruction with the
  shared fixture's `reopenRuntime()`; their assertions and cleanup order are
  unchanged. All matrix definitions and registration nodes are shared verbatim.
- `git diff --check`: passed.
- Fresh baseline archive plus `git apply --check splitting.patch`: passed.

The targeted run is correctness evidence only. Its local duration is deliberately
not recorded as benchmark evidence; GitHub-hosted campaign measurements remain
the source for performance decisions.
