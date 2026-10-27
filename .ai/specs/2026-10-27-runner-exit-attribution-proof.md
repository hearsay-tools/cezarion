# Runner exit attribution proof

Task: hearsay-tools/cezarion#1899. Parent approved preparation of the shared
fix; merge stays on hold for a user decision about the behavior correction.

## Final policy and acceptance

The candidate separates cleanup from attribution. Confirmed exit retains the
native failure. Positive live evidence permits successful automatic teardown.
Unknown evidence still triggers bounded TERM/KILL, but nonzero/signal exit fails
unless explicit end/interrupt intent takes precedence before native exit.

**Tradeoff:** delayed or unavailable probes can make an otherwise live automatic
cleanup report failure, including under ordinary host load. Windows has no live
state fallback. Explicit teardown remains successful. A positive live sample is
not causal proof against an external signal arriving later. This policy is
prepared and verified for review; product merge remains on hold for the user.

The asynchronous ps fallback runs inside the final 50 ms of existing grace; it
adds no scheduled cleanup delay. Native Linux execution, mocked Darwin probes,
and an independent real-ps integration test are recorded below. There is no real
macOS or Windows execution claim. Old signalSession safety semantics remain.

Latest acceptance source: `80cb3dcd3e9ccc5dd0daa5066b99a3d99b75ecc8`.
Exactly 20 native Pi self-exit attempts rejected code 143, each at sampled load
41.21. Both original explicit interrupt/end 143 guards passed. Failures: zero;
below-threshold attempts: zero; retries: zero. Nine positive-evidence and
unknown/unavailable/timeout live-EOF guards also passed in the same load window.
Their positive-live cases assert success GIVEN evidence; they do not promise
real ps availability inside 50 ms.

Initial host load was 11.7876. The authorized supervisor started 23 loops, one
on each CPU except acceptance CPU 2. Actual load reached 41.2109 after 100.041 s.
Acceptance took 13.421 s. Evidence guards ran next; all owned loops were terminated
and reaped by 123.434 s total. Each PID/start identity and post-cleanup absence is
recorded. Independent post-check found all 23 PIDs absent. No source changed during
acceptance, and no test attempt was dropped or restarted.

Final checks: server typecheck, citations, committed clone and complexity gates
pass. Local quality measured 102/102 functions and passed all 217 selected tests;
only the three documented inherited findings remain. Squeal revision 36 reports
current passing shutdown parity. The historical 46-case proof below preceded the
shared Pi cleanup extraction; the final 217-test quality run includes those cases
and the exact during-probe intent correction.

## Historical initial diagnosis and scope

The original failure is run 40278727734, attempt 1, job 121427131876.
The self-exit test took 157 ms, not its 5,000 ms timeout. Its promise resolved
with empty text and session `pi-teardown` instead of rejecting code 143.
Pi and Claude allow 50 ms between stdout EOF and native exit notification.
If notification arrives later, they mark a cleanup signal as Cezar teardown.
Codex can make the same attribution in its EOF watchdog.

The first implementation checked positive exit evidence before those cleanup signals. A recorded
exit, an absent PID (`ESRCH`), or Linux/Darwin zombie/exit-in-progress state prevents
false teardown attribution. Missing PID data, denied probes, unreadable proc
files and malformed state preserve bounded cleanup. The existing `signalSession`
safety decision is unchanged. Darwin also reads a successful single `ps` STAT value for zombie or exiting
state. Other platforms confirm recorded exit or an absent PID only.
It does not replace waiting for Node to report the actual exit status.

| Case | Before initial fix | Initial fixed behavior |
| --- | --- | --- |
| Pi self-exit 143; exit notification delayed beyond EOF grace | Resolves with teardown note | Rejects code 143 |
| Outside SIGKILL; notification delayed beyond cleanup | Claude/Codex/Pi can succeed | Each reports failure |
| Native OpenCode/Cursor/OMP outside SIGKILL | Reports failure | Same |
| Intentional interrupt/end with signal exit | Successful teardown | Same |
| Live child closes output and ignores TERM | Bounded KILL cleanup | Same, including unreadable process evidence |

The initial regression assertions were retained. Later sections record the explicitly approved evidence-policy and fixture changes. The original self-exit,
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


## Unknown evidence policy (review 4387780376)

Parent approved preparation and verification on 2026-10-27; product merge still
requires the final user decision. `proof_base` for this round is
`1d23b3eeae49e97ef9b4a8bc9da6702b61aaea0a`.

The original S33 probe with proc unreadable still found ESRCH after libuv reaped
the child. That attempt passed all six runners. Denying both proc and the PID
signal-0 probe produced three false successes (Claude/Codex/Pi), with the other
three runners preserving failure. A real unreaped Linux zombie accepted TERM
and KILL while retaining its original exit code 143. Signal acceptance therefore
cannot establish causation. Raw evidence was published as artifact
`bd58435c-1f55-44cb-854a-8b49677646d3`.

The approved policy separates positive exited, positive live and unknown evidence.
Confirmed exit retains the real failure. Positive live evidence permits successful
automatic teardown. Unknown evidence still starts bounded cleanup but cannot turn
a nonzero or signal exit into success. Ordinary exit 0 remains successful.
Explicit end/interrupt retains intentional teardown success until native exit.
An existing output/startup failure still takes precedence over teardown intent.
A live sample is not causal proof against an external signal arriving later.

The old live-EOF guarantee is bounded release of execution capacity plus successful
teardown. Existing proc-unreadable success tests keep every assertion: asynchronous
ps can supply a positive live sample. New fully unavailable evidence tests require
failure after bounded cleanup. On Windows, absent Node exit or ESRCH evidence, no
live-state fallback exists; automatic nonzero/signal cleanup can therefore fail.
Darwin coverage uses platform probes on Linux; it is not a native macOS claim.

### Intent precedence case table

These rows run for Claude, Codex and Pi. S23/S27 retain explicit teardown coverage
for all six native runners; S33/S34 retain external-exit coverage for all six.

| Evidence and intent | Ordered effects and result | Coverage |
| --- | --- | --- |
| Unknown automatic EOF, no explicit request | Revoke input; existing grace; TERM; original KILL deadline; await native exit; fail signal/nonzero exit | unknown automatic EOF cleanup |
| Positive live automatic EOF, proc unavailable | Same cleanup; successful teardown | unchanged live-EOF guard |
| Confirmed exit before cleanup | Preserve actual exit result; no attribution from a signal attempt | S33, Pi self-exit143 |
| Explicit end before EOF | Record request; close input; existing EOF cleanup; successful teardown | before EOF / end, S23 |
| Explicit interrupt before EOF | Record intent; existing native cancel and TERM; bounded KILL; success | before EOF / interrupt, S27 |
| End or interrupt during probe | Retain input closure; record explicit intent; no later than existing cleanup deadline; success | during probe / both methods |
| End after automatic TERM | Record intent without reopening input or resetting cleanup; original KILL; success | after TERM / end |
| Interrupt after automatic TERM | Record intent; keep earlier automatic KILL deadline, including Codex; success | after TERM / interrupt |
| Explicit call after native exit | No change to observed failure | native exit guard; cannot affect an already-settled promise |
| Output/startup failure plus explicit intent | Cleanup still runs; existing failure takes precedence | S24 and existing startup tests |

### Probe timing and ordered effects

The probe runs only in the final 50 ms of an existing grace. It never waits on ps
at the signal deadline. It cancels a pending launch and kills an unfinished ps
when sampled or when native exit arrives. Thus added scheduled TERM/KILL latency
is zero; maximum ps execution allowance is 50 ms. Host event-loop scheduling still
applies to all timers. Slow or unavailable ps yields unknown. Strict platform state
validation rejects malformed, multiple and contradictory evidence. The pre-existing
leaderExited/signalSession safety behavior is unchanged.

Pi and Claude retain native output finalization, input revocation, the 50 ms EOF
wait, TERM then their existing KILL grace, native exit wait, timer cleanup, and
failure/timeout precedence. Explicit intent is separate from a cleanup attempt.
Claude's automatic cleanup preserves interrupt's side-effect order while choosing
attribution separately. Codex retains closeInput before stdin.end, its TERM and
KILL grace periods, native exit wait and failure/timeout precedence. Its internal
EOF close no longer declares an explicit end request. Probe collection runs inside
those grace periods. Interrupt during active automatic cleanup retains the earlier
EOF KILL deadline.


### Positive fallback fixture and host-load limit

Squeal revision 26 observed one failure of the original Pi proc-unreadable live
success guard. Its automatic same-input retry passed. Both outcomes are retained;
this was not accepted as a fix. Host load sampled afterward was 34.575. A finite
50 ms ps window cannot guarantee evidence availability under ordinary host load.
The guard therefore contained a hidden dependency on local process startup speed.

Parent approved splitting the old environmental guarantee on 2026-10-27. The live
native guard keeps every success/cleanup assertion and real SIGSTOP, EOF, TERM,
KILL and native exit. It now supplies deterministic positive-live fallback evidence.
It proves success GIVEN that evidence, not guaranteed availability. A separate real
ps integration test uses a 2 s test bound; production deadlines remain unchanged.
Unknown/unavailable evidence and probe-timeout tests retain cleanup and require
signal failure. Delayed or unavailable probes can therefore turn an otherwise live
automatic cleanup into failure on an ordinary loaded host, as well as on Windows.
This candidate behavior remains subject to final human approval before merge.


### Final round-two proof ledger

All proof runs used a disposable checkout with its own frozen dependencies.
No shared stash was used. Original exploratory results remain recorded above.

| Run | Result |
| --- | --- |
| Initial round-two native regression, prior source | 6 fail / 21 pass |
| Same 27 cases, first policy implementation | 27 pass |
| Native exact KILL-deadline case, prior source | Codex fails; Claude/Pi pass |
| Same deadline case, fixed source | 3 pass |
| Held real ps completion, original live-EOF arrangement | 3 fail |
| Same held scheduling and product source, explicit positive-live fixture | 3 pass |
| Final S34, unavailable/timeout live cleanup, intent and deadline cases on proof_base | 10 fail / 23 pass |

Final red command:

```sh
npm test -- packages/cezar/src/core/runner-shutdown-parity.test.ts \
  -t 'S34|unknown automatic EOF|explicit .* wins|earlier KILL deadline'
```

The ten red failures are three delayed external exits, six live automatic cleanups
with unavailable/timed-out evidence, and the Codex interrupt deadline. The other
23 cases guard preserved behavior. Final source proof additionally selects S33,
the positive-live guards and original Pi 143 cases.

The Pi and Claude EOF blocks moved into immediate local `cleanupAfterEof` helpers
to keep the changed output-loop complexity below baseline. The ordered effects
listed above are unchanged. `leaderExited` and `signalSession` remain byte-identical
to the prior source. The inherited Codex reader complexity is tracked in
hearsay-tools/cezarion#1965, alongside hearsay-tools/cezarion#1954 and
hearsay-tools/cezarion#1955 for Claude/Pi.


Final fixed-source command selected the two native suites with
`S33|S34|unknown automatic EOF|explicit .* wins|earlier KILL deadline|keeps live EOF|143`:
**46 passed, 99 skipped**, including the original Pi self-exit and explicit teardown
143 assertions. Squeal revision 29 reports current passes for the affected runner,
process helper, transport, shutdown and file-length suites. Final local quality
measurement checked **101/101 functions** and its **217 selected tests passed**.
The three inherited findings are Claude output loop complexity 135 (baseline 138),
CRAP 2242.3396; Codex reader complexity 33 (baseline 33), CRAP 40.5258; and Pi output
loop complexity 122 (baseline 127), CRAP 137.2076. Their follow-up issues are
hearsay-tools/cezarion#1954, hearsay-tools/cezarion#1965 and hearsay-tools/cezarion#1955.
New evidence/probe and attribution helpers meet both quality thresholds.


Parent review made the during-probe intent test deterministic: after native child
admission, it controls timeout timers, drains real EOF, asserts input closed and
no TERM call, applies intent, then advances the original grace/escalation. It
cannot silently become the after-TERM case on a loaded host.

The committed clone gate found the Pi TERM/KILL block duplicated between clean
EOF and output failure after its movement. A local `terminateAfterOutput` helper
now preserves the shared order: TERM; arm the same KILL grace; unref the timer;
return its handle. The failure caller still awaits native exit, clears that timer,
and throws its original error. The clean-EOF caller retains its ordinary native
exit wait. S24, S33/S34 and the deadline tests cover these paths.


After that extraction and the exact during-probe test correction, the final local
quality rerun again passed all 217 tests. It measured 102/102 changed functions.
Only the same three inherited findings remain; Pi's output loop complexity is now
121 (baseline 127). Server typecheck passed. The parent reviewed the helper's
ordered effects and the exact intent boundary with no further finding.
