# Runner exit attribution proof

Task: hearsay-tools/cezarion#1899. Parent approved preparation of the shared
fix; merge stays on hold for a user decision about the behavior correction.

## Cause and scope

The original failure is run 40278727734, attempt 1, job 121427131876.
The self-exit test took 157 ms, not its 5,000 ms timeout. Its promise resolved
with empty text and session `pi-teardown` instead of rejecting code 143.
Pi and Claude allow 50 ms between stdout EOF and native exit notification.
If notification arrives later, they mark a cleanup signal as Cezar teardown.
Codex can make the same attribution in its EOF watchdog.

The fix checks positive exit evidence before those cleanup signals. A recorded
exit, an absent PID (`ESRCH`), or Linux/Darwin zombie/exit-in-progress state prevents
false teardown attribution. Missing PID data, denied probes, unreadable proc
files and malformed state preserve bounded cleanup. The existing `signalSession`
safety decision is unchanged. Darwin also reads a successful single `ps` STAT value for zombie or exiting
state. Other platforms confirm recorded exit or an absent PID only.
It does not replace waiting for Node to report the actual exit status.

| Case | Before | After |
| --- | --- | --- |
| Pi self-exit 143; exit notification delayed beyond EOF grace | Resolves with teardown note | Rejects code 143 |
| Outside SIGKILL; notification delayed beyond cleanup | Claude/Codex/Pi can succeed | Each reports failure |
| Native OpenCode/Cursor/OMP outside SIGKILL | Reports failure | Same |
| Intentional interrupt/end with signal exit | Successful teardown | Same |
| Live child closes output and ignores TERM | Bounded KILL cleanup | Same, including unreadable process evidence |

No existing regression assertion was removed or relaxed. The original self-exit,
interrupt and end cases remain. S33 extends native `HARNESS_ADAPTERS` coverage to
every `RUNNER_IDS` backend with the existing S22 failure contract. Pi/Claude/Codex
keep its stronger rejection, SIGKILL diagnostic and no-success-event assertions.

## Pinned proof

`proof_base`: `323019f26155f0c7593117b18b6b0fc3f0bfa111`.
Disposable worktree: `/tmp/cezar-1899-proof`, with its own frozen pnpm install.
New tests and the cell registry were copied there first. The source stayed at
the pinned commit. Then only the four fixed source files were copied there.

Both runs used:

```sh
npm --prefix /tmp/cezar-1899-proof test --   packages/cezar/src/core/pi-runner.test.ts   packages/cezar/src/core/runner-shutdown-parity.test.ts   -t 'native exit notification|S33|live EOF cleanup'
```

- Before: 4 failed, 6 passed, 102 skipped. Pi self-exit and Claude/Codex/Pi S33
  failed with resolved success instead of failure.
- After: 10 passed, 102 skipped. Both selected files passed.
- Squeal independently observed the Pi regression FAIL -> PASS.
- Native Pi diagnostic with the fixed source: 20/20 delayed self-exits rejected.

The fault injection postpones delivery of the real native process exit callback
by 250 ms. It preserves the actual OS status and all native wire frames. It uses
Node's private `_handle.onexit` test seam; a Node implementation change may need
a corresponding test adjustment. No exit code or normalized event is fabricated.

## Diagnostic attempts and acceptance limits

All attempts are retained under the task's evidence directory until publication:
`.ai/qa/1899-probe/`.

- Unchanged native fixture, CPU 2 and two bounded busy loops: 100/100 rejected.
  This did not reproduce the failure and did not meet load >= 40.
- Unchanged source with delayed real callback: 100/100 incorrectly resolved with
  the same result and teardown note as the CI failure.
- First scratch six-runner probe required rejection from every runner: 5 failed,
  1 passed. That assertion was stronger than the shared contract and is not the
  defect proof.
- Corrected scratch probe used S22's rejection-or-error contract: 3 failed,
  3 passed. Claude, Codex and Pi were the failures.
- First pinned guard attempt used `destroy()` for EOF, which raised a transport
  error: 7 failed, 3 passed, 102 skipped. Its three cleanup failures were test
  construction errors. `push(null)` supplies clean EOF to the admitted native
  transport; the corrected before/after counts are recorded above.

The issue's high-load acceptance passed on source commit
`5b5fab1db5ab468d8d1b1e8ddcdb7d82c49605e6`. The parent approved a bounded load
window, but observed one-minute load was already 46.7988 on 24 CPUs, so the
supervisor started **zero** busy loops. All 20 sequential native self-exit cases
rejected code 143. Each iteration recorded load 46.8; none was below 40. The
unchanged interrupt/end assertions also passed, taking 121 ms and 10,125 ms.
The full acceptance command took 13.379 s; ending load was 49.1777. There were
22 attempts, zero failures and zero under-threshold self-exit attempts. There
was no retry. The supervisor logged the same source head before and after.

```sh
timeout --kill-after=5s 480s python3 .ai/qa/1899-probe/load-window.py
# At load >=40, the supervisor ran exactly once:
timeout --kill-after=5s 120s taskset -c 2 node --import tsx \
  .ai/qa/1899-probe/acceptance.ts
```

The acceptance script imports the production Pi runner and unchanged native
SIGTERM fixture. It preserves all original self-exit and interrupt/end
assertions, and records per-attempt load, outcome, elapsed time and events.
`acceptance.jsonl`, `load-window.jsonl` and both scripts are in the published
final evidence archive. No timeout was widened. No load-generator process or
proof checkout remains.

## CI clone correction

The first CI run, 40484583509 attempt 1, job 122123065198, found that the
matching new guards extended an existing Pi/Claude EOF-wait clone. The correction
extracts only that common wait into `waitForEofExit`; it changes no timer value.
Both old paths perform the same ordered side effects: check observed exit;
register exit/close listeners and an unreferenced 50 ms timer; on either exit
notification or timer, remove both listeners, clear the timer, and resolve.
The callers still decide attribution after the wait and await the real exit
status. S33 and the three live-EOF guards cover both timer outcomes.

## Final source verification

After extracting the shared EOF wait, Squeal revision 10 reports current passing
results for Pi, Claude, shutdown parity (including S33 and live clean EOF with
unreadable proc) and session-process tests. The delayed native Pi probe again
rejected 20/20. Server typecheck and the clone gate passed. Quality measured
44/44 changed functions; only the inherited Claude/Pi output loops remain
above policy, tracked in hearsay-tools/cezarion#1954 and hearsay-tools/cezarion#1955.
The 146 tests in the quality collection passed. One earlier collection reported
incomplete because HEAD changed during measurement; rerunning against the
unchanged source head produced the complete report.

## Darwin review correction

Review comment 4387561584 on hearsay-tools/cezarion#1956 identified an unreaped
macOS zombie that can still answer signal 0. The confirmed-exit helper now reads
`ps -o stat= -p PID` on Darwin, bounded to two seconds with SIGKILL on timeout.
Only a successful single Z/E state, with recognized STAT modifiers, confirms
exit. A live state, malformed/multiple values, nonzero status, timeout, spawn
error, denied probe or thrown call retains cleanup. The older `leaderExited`
and `signalSession` implementations remain unchanged.

Darwin `proof_base`: `50110aa43bd8c2ce7d29102cda53638a363690a7`.
The new test file ran against that source in `/tmp/cezar-1899-darwin-proof`
with its own frozen dependency installation, then against only the fixed helper:

```sh
npm --prefix /tmp/cezar-1899-darwin-proof test -- \
  packages/cezar/src/core/session-process.test.ts -t Darwin
```

Before: 12 failed, 6 passed, 23 skipped. Five failures returned false for actual
Z/E test inputs; seven showed that no Darwin state probe ran. After: 18 passed,
23 skipped. Squeal separately observed the failing new cases and their recovery.
These are mocked platform-probe tests on Linux, **not a real macOS execution**.
The existing native six-runner delayed-exit and live-EOF guards remain in place.
The prior high-load acceptance exercises the Linux path, which this correction
leaves unchanged.
