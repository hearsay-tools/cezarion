# Deterministic fixture experiment

Baseline: `b1fe75911378dfe7816a7a83312c2acbdcf848f4`.

## Scope

`fixtures.patch` changes only these test files:

- `packages/cezar/src/workflows/workspace-semaphore.test.ts`
- `packages/cezar/src/workflows/pasted-attachments.test.ts`

The semaphore suite's shared three-second subprocess and four attachment queue holders with fixed 500–700 ms lifetimes become real Node subprocesses blocked on per-test filesystem gates. Tests release each process immediately after observing the state that the holder exists to protect. The semaphore suite retains its 50–300 ms negative-observation windows: these allow an asynchronously pumped run time to expose an admission bug before the assertion reads its status. The fairness test uses a distinct, unreleased gate for the newer run, so it still proves that the older cross-project run receives the first freed slot.

No application source, workflow, interactive `scripts/mock-claude.mjs`, cancellation path, or real timing/process test changes. Test names and assertions are unchanged. The attachment cases still use the complete interactive mock session after their queue-state setup; replacing that mock with a one-shot response would stop exercising stdin capture, handoff/todo side effects, continuations, and follow-up delivery. `system-prompt.test.ts` and `model-identity-wiring.test.ts` were inspected and left unchanged for the same reason: their assertions depend on the interactive mock's argv capture, session persistence, naming, marker, or handoff behavior rather than an incidental holder delay.

## Functional verification

Applied to a clean `git archive` of the baseline with the workspace `node_modules` linked in:

```text
TMPDIR=/tmp npm test -- --run packages/cezar/src/workflows/workspace-semaphore.test.ts packages/cezar/src/workflows/pasted-attachments.test.ts
Test Files  2 passed (2)
Tests       37 passed (37)
```

The original baseline also passed these cases as part of the parent's clean full-suite run (374 files, 7,797 tests). Case names and assertion inventory are preserved by the patch.

The gate commands quote the executable, inline script, and release path with the repository's `shellQuote` helper. One semaphore holder and one attachment holder also passed with `TMPDIR=/tmp/cez-$-\`-…`, covering literal dollar and backtick characters in generated paths.

Post-measurement review added failure-path cleanup to the shipped attachment suite; the archived experiment patches remain unchanged so the measured candidate is reproducible. The final attachment suite registers every gate before starting its subprocess. `afterEach` releases outstanding gates, cancels every nonterminal run, and waits for terminal state; `afterAll` repeats that defense and disposes the manager in `finally` before deleting the fixture repository. A temporary prerelease assertion failure completed in 24 ms and the following attachment case still passed in 2.4 s, demonstrating that neither the holder nor the failed case's queued agent work leaked across the test boundary. The intentional failure was reverted before the final 37-test run.

Mutation checks in the isolated copy:

- Removing `await participant.pump()` from `WorkspaceSemaphore.release()` made `a slot freed in one project starts the run queued in ANOTHER project` fail because B remained queued.
- Removing the workspace `busy() < maxParallel` admission condition made `caps concurrent runs across two projects: with cap 2, the third run queues` fail after the retained 300 ms observation window (`expected queued`, received `done`).
- Removing the per-project `busySlots() < projectMax` condition made `per-project cap: project A limited to 1 runs one at a time while B fills the workspace cap` fail after its retained 300 ms window (`expected queued`, received `running`).

The production source was restored before generating the patch. These checks show that the deterministic holder still detects release, workspace-cap, and per-project-cap regressions.

Hosted performance results are recorded in `docs/benchmarks/ci-performance-156.md`.
