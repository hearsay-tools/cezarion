# Historical timer parity failures

Subject: hearsay-tools/cezarion#1298. Investigation date: 2026-10-27.
Current guard base: `e53bef4e9997e4dde9794f08b09c62900fb82eed`.

Both historical failure signatures were reproduced. They have different causes.
The U8 startup repair in hearsay-tools/cezarion#1560 is a third case and is not the proof below.
No product behavior, assertion outcome, timeout, shared fixture or mock changed in this work.

## U8: a stale mock session store loses the blocker

- `proof_base`: `dd209a6aa8b12bb80f5040322cf5bb7665ae109b`.
- Original: [CI run 39311043388, attempt 1, job 118260478311](https://github.com/hearsay-tools/cezarion/actions/runs/39311043388/attempts/1).
- Failure: `AssertionError: expected false to be true`, at `worker-wait.testkit.ts:25:100`.
- Exact failed predicate: `store.getRun(blocker.id)?.status === 'waiting'`.

The two native OpenCode mock servers shared `args.opencode-sessions.json`.
`saveSessionStore` uses a truncating write. A peer can read the empty file between
truncate and write, then fall back to its older in-memory store. If that peer
writes its stale store after the first writer finishes, the resulting valid JSON
loses the blocker's session. The mock checks `getSession` before starting the
next prompt. An absent session falls through to HTTP 200 `{}` without SSE events.
The runner has already emitted the nudge's `turn.started`, so the blocker stays running.

A disposable checkout ran the original U8 test and native mock on Node 24.15.0,
CPU 0. A diagnostic wrapper labeled each unchanged predicate. An `LD_PRELOAD`
shim changed only scheduling around the exact owned session-file path: it delayed
the blocker's second truncating open by 250 ms after truncate, and the parked
mock's third truncating open by 300 ms before truncate. The latter has already
read stale fallback data. Neither the shim nor the test wrote synthetic session data.
Only the two test mock children inherited the shim; it was not exported globally.
The process group had a 90-second timeout and a five-second kill grace.

The reproduced tail matches the original log, including sequence numbers:

| Run | Status | Final events |
| --- | --- | --- |
| Parked | waiting | 36 item.started; 38 item.completed; 39 text; 40 turn.completed; 41 turn-end; 42 no-wait note |
| Blocker | running | 12 cost; 14 turn.completed; 15 text; 16 turn-end; 17 turn.started; 18 no-wait nudge note |

The busy count is 1 in both dumps. The file snapshot is valid JSON containing only
the parked session. This proves a mechanism with the original signature; it does
not prove that every historical occurrence had this cause.

The repair already shipped in [hearsay-tools/cezarion#1353](https://github.com/hearsay-tools/cezarion/pull/1353),
commit `73eca508df01bc8a64dce073cee2e96f47a9daa2`: give each live mock its own session file.
Applying only those two path assignments to the historical cell passes under the
same shim and command. The wrapper resolves the exact path separately for each
child, so both isolated files still receive the same scheduling treatment.
The diagnostic output reads both isolated logs in the passing version.

```sh
timeout --kill-after=5s 90s taskset -c 0 \
  env PATH=/home/agent/.nvm/versions/node/v24.15.0/bin:$PATH \
  npm test -- packages/cezar/src/workflows/waits-parity.test.ts \
  -t 'opencode U8 a timer' --maxWorkers=1
```

| Version | Result |
| --- | --- |
| Original shared path, scheduled stale write | 1 failed, 318 skipped, 319 total |
| Same original shared path with per-child exact-path wrapper | 1 failed, 318 skipped, 319 total |
| Separate paths from the shipped repair | 1 passed, 318 skipped, 319 total |

Earlier probes that delayed every write produced corrupt intermediate JSON and
passed because each mock fell back to its own memory. Their traces identified why
that scheduling did not reach the valid-but-stale-file failure. These passes are
retained as diagnostic history, not counted as proof of the repair.

## U21t: late acknowledgment skips the old marker timer

- `proof_base`: `6fd568617403ccd9f29b6a2e0484960fdf61cfb6`.
- Original: [CI run 39526510886, attempt 1, job 118982755188](https://github.com/hearsay-tools/cezarion/actions/runs/39526510886/attempts/1).
- Failure: `AssertionError: expected false to be true`, at `worker-wait.testkit.ts:34:46`.
- Exact failed predicate: marker input delivered, its turn ended, and parent parked on a `monitoring-line` timer.

At that historical version, the cell expected `CEZ:MONITORING` to add a timer beside
a completion worker wait. Under load, the native marker turn can end before its
HTTP acknowledgment reaches the manager. The turn-end handler defers to the
in-flight input. On late acknowledgment, `settleIdleBoundary` takes its
`holdsAgentWaits` branch and parks on the worker wait. It never reaches
`applyTurnEnd`, which would call `openTimerAlias`. Delivery and consumption commit,
but the timer is absent. More waiting cannot make that timer appear.

The original failure reproduced on the matching historical source with Node
24.15.0 and six busy loops, all pinned to CPU 0. The command group was bounded
at 120 seconds with five seconds of kill grace. Every burner was stopped and reaped.

```sh
npm test -- packages/cezar/src/workflows/waits-opencode-parity.test.ts \
  -t 'opencode U8 a timer|opencode U21t' --maxWorkers=1
```

| CPU competitors | Result |
| --- | --- |
| 2 | 2 passed, 76 skipped, 78 total |
| 4, diagnostic predicate labels | 2 passed, 76 skipped, 78 total |
| 6, same labels | U8 passed; U21t failed; 76 skipped, 78 total |

The reproduced parent tail is 56 item.completed, 57 text, 58 turn.completed,
59 turn-end, 60 and 61 conversation-message. The worker tail is 13 cost,
14 turn-end, 15 budget note, 16–18 conversation-message. Both runs are waiting,
busy count 0. These match the original log exactly, apart from identities and times.
The full captured row shows the marker delivered and consumed, with only the
completion worker wait open.

A second probe made that ordering explicit without load: keep the actual native
send and response, but delay the manager's acknowledgment promise until the
native marker turn ends. It fails at the same predicate with the same event tails.
Then change only the historical test's timer request to explicit `cezar_wait`
and read that timer by kind. The same delayed-acknowledgment probe passes all
remaining deadline and exactly-once assertions: 2 passed, 76 skipped, 78 total,
versus 1 failed, 1 passed, 76 skipped, 78 total before.

This is evidence for the already-shipped redesign in
[hearsay-tools/cezarion#1430](https://github.com/hearsay-tools/cezarion/pull/1430),
commit `0539798a0050b4284093d6a9ebbc7ad7dcc46218`.
That change deliberately makes the monitoring marker a fallback: an open worker
wait suppresses its redundant timer. Explicit timers still coexist with it.
The old expected outcome pinned an implicit extra timer; the shipped redesign
replaced that guarantee with no redundant marker timer plus an explicit timer
whose deadline and wake remain independently tested. This task drops no guarantee.

## Current guard and evidence limits

The current U21t test now installs the existing `withHeldAck` control before
spawning OpenCode. It holds only the marker prompt's native HTTP acknowledgment,
observes the real turn end, asserts delivery is still absent and the completion
wait remains open, then releases the acknowledgment. All existing marker,
explicit-timer, deadline and exactly-once assertions remain, on every runner.
All 15-second phase guards and the 45-second outer bound remain.

The historical red proof uses the old marker contract. The current test guards
the shipped explicit-timer contract. Running the current test against the old
product and failing because their contracts differ is not claimed as proof.
U8 needs no further source edit: its separate-file repair is already present.
CI validation of this task's final head is recorded in its PR. Historical floor
reproductions use Node 24.15.0; the current repository floor is Node 24.21.0.

Ignored evidence bundle `.ai/qa/1298/` contains original attempt-1 logs, all probe
outputs, exact before/after test snapshots, the filesystem shim source, the load
wrapper, and validation reports. It is published as a task artifact for handoff.
No full local suite was run. No CI failure was rerun to obtain a pass.
