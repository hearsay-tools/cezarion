# Node 24.15 floor test load investigation

Source repository: `hearsay-tools/cezarion`. This records the investigation for
[hearsay-tools/cezarion#974](https://github.com/hearsay-tools/cezarion/issues/974).

## Original evidence

Read the original attempts, rather than the successful reruns. Each floor job
ran `npm test -- --shard=<index>/2 --maxWorkers=4` on Node 24.15.0. These logs
record the worker cap, not the host CPU count or sampled load.

| Run and job | Vitest wall time | Failure |
| --- | --- | --- |
| [Main at `81e88a0f`, shard 1](https://github.com/hearsay-tools/cezarion/actions/runs/38248113138/job/114807117031) | 726.33s | Delegation `--runner` retry cell took 5257ms against the default 5000ms timeout. |
| [Main at `81e88a0f`, shard 2](https://github.com/hearsay-tools/cezarion/actions/runs/38248113138/job/114807117015) | 725.60s | Pi S29 refused agent input at 68ms; this was an acknowledgement race, not a duration timeout. |
| [PR run, original shard 2](https://github.com/hearsay-tools/cezarion/actions/runs/38248223698/job/114807501921) | 788.97s | Two `readOwnedDiff` cells exceeded 5000ms; Pi R25 and Cursor R24 timed out waiting for the autosave cleanup note. |
| [Main at `b89db67e`, shard 1](https://github.com/hearsay-tools/cezarion/actions/runs/38293716033/job/114959703140) | 641.28s | Codex coalesced steer/completed cell never settled within 20s. |

The original main shards reported 2532.44s and 2490.33s of accumulated test
duration, respectively. These are overlapping test times, not CPU usage.
The PR shard's `workspace.test.ts` took 143471ms across 89 cells, and its
`harness-autosave.test.ts` took 30788ms across 12 cells. A fast isolated test
does not establish that its bound survives the whole shard.

## Remaining fixes

The delegation retry cell starts a parent, invokes two real `tsx` CLI processes,
and waits for a worker's native input. Its two CLI calls each allow 45s, and its
two input waits each allow 15s. The outer 5s test timeout could expire before any
individual operation's deadline. The cell now allows their 120s serial budget
plus 5s overhead. Its worker identity, backend and deduplication assertions stay
the same.

Pi and OMP write a filesystem marker after closing fd 0, but that marker does
not prove the runner has read the initial prompt response from stdout. While
that acknowledgement is outstanding, both correctly refuse agent input. S29
now releases a gated native acknowledgement and waits for `holdsHumanInput()`
to clear before writing to the broken pipe. The shared `RUNNER_IDS` cell still
requires a rejected receipt, one fatal transport failure, no successful turn,
closed admission and failed settlement. With the gate present and the wait
absent, Squeal revision 3 reproduced `expected false not to be false`; restoring
the wait produced a pass at revision 4. Review found the same admission guard
in OMP; the gated OMP cell reproduced the same rejection at 57ms without the
acknowledgement wait. The fix applies to both cells.

[hearsay-tools/cezarion#976](https://github.com/hearsay-tools/cezarion/pull/976)
merged into `main` at `569251a9` with the separate workspace bounds, autosave
fixture, Codex startup and coalesced-steer fixes. This branch includes that merge
and keeps its Codex admission polling alongside the Pi/OMP acknowledgement gate.

The post-merge full local run also exposed a cold-health cell at 1734ms against
its 1500ms outer deadline. It constructs a real app and reads Git/workspace metadata
as well as the HTTP response; a diagnostic affected-file run measured 100ms of
construction and 86ms of request work. The never-resolving availability mock already
proves health cannot await discovery. Its outer deadline now uses the ordinary 5s
unit budget and explicitly requires that discovery started, so waiting for the
probe still fails. This does not change a production health deadline or global test
configuration.

A later full run passed those cells but hit the `auto-resume` fixture's
`beforeEach` hook at 10222ms against its default 10000ms. The watchdog body had
not run. Setup invokes five real Git processes serially without child deadlines.
Each now has a 10s command deadline; the setup hook covers their combined 50s
budget plus 5s local setup. The watchdog assertions and body deadlines are unchanged.
The reporter also retains native failure messages so a hook failure cannot be
mistaken for a test-body timeout when their budgets differ.

## Measurements retained by future floor runs

Both existing floor jobs retain four workers and their default and GitHub
Actions reporters. The extra floor reporter writes
`node-floor-shard-<index>.json` under the Actions runner's temporary directory:

- Actual Node version, shard, configured worker cap, available parallelism and
  logical CPU count; maximum simultaneously active test modules.
- Elapsed wall time and load averages sampled at start, every 10s and finish.
- Every completed test's project, repository-relative file, full name, start
  time, duration, resolved timeout, result and retry count; per-file duration.
- Native per-test failure messages, run outcome and unhandled-error count. A periodic snapshot remains available
  if the job reaches its overall timeout before Vitest finishes.

The log lists failed tests and cells that use at least 80% of their timeout.
Each shard uploads its JSON as `node-floor-measurements-shard-<index>` on success
or failure, retained for 14 days. The test command's failure exit is preserved.
No global timeout or worker-count reduction is used to conceal a failure.

## Local full-suite checkpoint before the main merge

The local run before merging `main` at `e074b077` on Node 24.15.0 passed all 671 files: 15,312 tests passed
and two existing tests were skipped. It ran the full unsharded suite with four
workers on a host with 24 available CPUs, took 1236.55s, and peaked at four
active modules. Its sampled one-minute host load ranged from 2.51 to 36.96.

| Fixed cell | Duration | Test timeout | Retries |
| --- | --- | --- | --- |
| Delegation `--runner` retry | 1973ms | 125000ms | 0 |
| Pi S29 | 169ms | 10000ms | 0 |
| OMP S29 | 161ms | 10000ms | 0 |

The acknowledgement gate exercises the ordering that caused the original Pi
failure even when the measured cell is fast. The delegation bound covers its
existing serial deadlines; this local duration is one load sample.

## Current combined-tree checkpoint

After merging `main` at `e074b077` and fixing the two additional local budget
failures above, Node 24.15.0 passed all 673 files: 15,336 tests passed and two
existing tests were skipped. Runtime inputs were tested from tree
`892298ad1263967dfe9eba1b291f40abbcecad07`; this documentation update came after
that run. The full unsharded suite kept four workers, took 1203.27s,
and peaked at four active modules on 24 available CPUs. Sampled one-minute
load ranged from 2.39 to 25.33; no test used 80% of its body deadline.

| Fixed cell | Duration | Test body timeout | Retries |
| --- | --- | --- | --- |
| Delegation `--runner` retry | 2029ms | 125000ms | 0 |
| Pi S29 | 168ms | 20000ms | 0 |
| OMP S29 | 158ms | 20000ms | 0 |
| Cold health | 111ms | 5000ms | 0 |
| Watchdog with real Git setup | 1287ms | 60000ms | 0 |

The watchdog's setup hook has its separate 55s serial Git budget. The body
continues to use its original 60s deadline. All fixed cells completed without
retrying.

## Acceptance evidence still required on main

Five consecutive successful pairs of floor shards on `main`, without reruns,
remain the acceptance checkpoint. A draft PR cannot establish that checkpoint
before human integration of this change. The separate fixes above are already on `main`. Keep
hearsay-tools/cezarion#974 open until those five first-attempt pairs are recorded;
PR or local passes do not substitute for `main` passes.

## Browser failures found by the final gate

The two initial full browser attempts failed in different files. The first bundle,
`.ai/qa/local-runs/1791841047711-2778159/lane-3-failures/project-groups/`,
names a More views click at `/p/e2e-alpha/git`; the subsequent snapshot shows the
button back. A deterministic real-shell regression holds the sibling health
response after a project scope change: the workspace-level health cache is keyed
by scope, and the optional view gates previously read the empty new cache. They
now use the shell's existing last-confirmed snapshot. The test keeps the menu
operable during that hold and confirms a new capability-off response removes it.
Unknown initial capabilities still hide optional views.

The second bundle,
`.ai/qa/local-runs/1791841612570-2963029/lane-4-failures/live-preview/`,
names `CDP Page.navigate timed out`; all three browser evidence captures also
exceeded their five-second bounds. The installed agent-browser 0.36.0 pauses new
targets until its daemon initializes and resumes them. A private-daemon hold
reproduces the ten-second navigation timeout with the spec's old raw-CDP target
creation. The provider's native tab operation initializes before returning its
target ID and passes the same regression. A resume on the separate CDP session
alone did not release the provider's pause. Live preview now uses the native
operation; its visibility, takeover, explicit reclaim, input and stop assertions
and the CDP timeout remain intact.

These reproductions pin concrete mechanisms consistent with the bundles; the
original bundles alone do not identify the exact cache or debugger state at the
failed action. No existing open browser issue found by searches for browser,
e2e, preview, sidebar, health, More views and Page.navigate has its full criteria
met by these changes. The broader suite epic hearsay-tools/cezarion#902 and
preview leak-detection CI task hearsay-tools/cezarion#977 remain open.
