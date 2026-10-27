# Native Codex park observation proof

Subject: hearsay-tools/cezarion#1641.
`proof_base`: `6c92bf4d85ec0cc73d58bf0dab3f25b5fcd407c1`.

## Original failure

[Run 40124299253, attempt 1, job 120962345058](https://github.com/hearsay-tools/cezarion/actions/runs/40124299253/attempts/1)
failed at `src/workflows/run.test.ts:3516:45`:

```text
AssertionError: expected 'running' to be 'waiting' // Object.is equality
```

The test observed the native `turn-end` in the event file. That event does not
order its next status read after the manager commits the park. The existing
assertion requires the run to park after its native ask receives an answer.
The fix preserves that guarantee and every existing assertion. The existing
post-answer predicate now requires both native turn-end and committed `waiting`.
It retains two sequential wait phases, the 15-second predicate bound and the
30-second test bound. It does not add a third wait or increase either bound.

The parent approved this bounded plan in request
`65c70ccd-5036-4589-9155-5ccca3d0252c`, reply
`9921a66a-a064-4662-b273-c0a6393cf52d`. Review comment
[4387688997](https://github.com/hearsay-tools/cezarion/pull/1961#discussion_r4387688997)
identified the extra sequential wait in the first version. Parent instruction
`83440cac-de49-4a5b-9dc5-46712f43cc21` approved the combined predicate while
retaining the original bounds. Product behavior, shared mocks, runner
helpers, parity cells, configuration and baselines stay unchanged. This is a
test observation fix, so it adds no new runner behavior to cover across runners.

## Controlled scheduling

The proof used an ignored scratch copy under `.ai/qa/1641-review-proof`, outside the
ordinary test include paths. It loaded the repository's server Vitest setup.
Relative imports and the fixture directory were adjusted for that location.
Contract imports resolved to the same contract source files. The native Codex
app-server mock and its answer RPC remained unchanged.

After the initial ask parked, the scratch copy wrapped only the real
post-answer `parkForUser` call. It held that call until the existing turn-end
file observer succeeded. It then released the real call through `setImmediate`.
Both old and fixed tests used exactly this gate:

```typescript
const parkTarget = manager as unknown as {
  parkForUser: (...args: unknown[]) => void;
};
const realPark = parkTarget.parkForUser.bind(manager);
let heldPark: (() => void) | undefined;
let observedTurnEnd = false;
const releasePark = () => {
  if (!observedTurnEnd || !heldPark || process.env.PROOF_NEVER_RELEASE === '1') return;
  const park = heldPark;
  heldPark = undefined;
  setImmediate(park);
};
vi.spyOn(parkTarget, 'parkForUser').mockImplementation((...args) => {
  heldPark = () => realPark(...args);
  releasePark();
});
// Existing sendMessage assertion stays here, before the existing event wait.
await waitFor(() => {
  const seen = readFileSync(eventsPath, 'utf8').includes('"type":"turn-end"');
  if (seen) { observedTurnEnd = true; releasePark(); }
  return seen;
});
```

The fixed scratch predicate replaces `return seen` with
`return seen && store.getRun(record.id)?.status === RUN_STATUS.waiting`.
The event observer releases the gate before and independently of that status
condition. This predicate is the only difference between old and fixed scratch
tests. The gate does not inspect the final assertion. It controls
the disputed event/write order. It uses no load loop, fixed delay, retry or
synthetic normalized runner event. This is controlled ordering evidence, not a
claim that an unchanged test failed again under natural host load.

## Results

Each command selected one native Codex test; 170 unrelated tests were skipped
by the name filter. Captured output on 2026-10-27:

| Case | Selected tests | Result and throwing frame |
| --- | --- | --- |
| Old test, release on `setImmediate` | 1/1 failed | `AssertionError: expected 'running' to be 'waiting' // Object.is equality`, scratch line 3554:45, final one-shot assertion |
| Fixed test, identical release | 1/1 passed | Real park ran; committed status satisfied the combined predicate and the unchanged final assertion |
| Fixed test, never release | 1/1 failed as required | `Error: condition not met in time`, scratch line 3549:5, combined post-answer wait; setup and teardown completed |

These are three separate executions. The never-release case retained the
existing 15-second bound. Its failure shows that observing native turn-end
alone cannot make the fixed test pass.

Commands from the repository root:

```bash
npm test -- --config .ai/qa/1641-review-proof/vitest.config.ts \
  -t 'persists the ask, parks immediately, then routes the answer to the pending RPC'
PROOF_NEVER_RELEASE=1 npm test -- --config .ai/qa/1641-review-proof/vitest.config.ts \
  -t 'persists the ask, parks immediately, then routes the answer to the pending RPC'
```

The published `cezar-1641-review-proof.tar.gz` snapshot contains `setup.py` to rebuild
the old scratch copy from `proof_base`, `replay.py` to run the three cases in
order, both scratch snapshots, the config and all three runner logs. The earlier published
archive `57d0716f-832f-44e7-b0e4-fc5cbd1129d8` retains the original job log
and the superseded third-wait proof. Extract it to `.ai/qa/1641-review-proof` in a checkout containing
`proof_base`, with the repository dependencies installed, then run
`python3 .ai/qa/1641-review-proof/replay.py`. Inspect the failure frames as well as
the exit codes. Artifact ID: `b635dd17-59ca-46aa-b806-6528aeae11b5`.

Initial scratch setup failures from import resolution and fixture relocation
were corrected before these three measured runs. They are not counted as red
proof. Normal validation of the tracked test uses Squeal without this gate.

## Scope and cleanup

No shared name, value or default changed, so no reader sweep was selected.
No run state, tool grant, task-worktree file mechanism or detached process was
added or changed. The special case tables do not apply.

No load process was started. Every focused proof invocation exited. The ignored
scratch tests and config can be removed after publication; the captured evidence
survives worktree cleanup in the task artifact. The parent owns PR review and
merge. Auto-merge stays disabled for this task.
