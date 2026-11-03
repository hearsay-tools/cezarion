# Fast unit suites — Phase 3

Design for hearsay-tools/cezarion#2516, slice 3.1 of
hearsay-tools/cezarion#2487. This document implements the measurement and design
part of the approved revision 2 of
[Retire the workaround skills](2026-11-02-retire-workaround-skills.md).
Slices 3.2 and 3.3 implement the changes described here. This PR changes this
document only. It does not change application behavior, tests or configuration.

## Method

The measurement checkout is `3ae6a032d7f26fc2e518d6f0de48a40e2cccfd4a`.
Dependencies were installed by worktree setup. Node is 24.22.1, Vitest is 4.1.10.
The host is shared. Every test invocation uses one worker and runs alone in this
worktree. Other tasks on the host can still compete for CPU and I/O.

Before timing, stop this worktree's Squeal daemon:

```sh
/home/agent/.codex/plugins/data/squeal-hearsay/bin/squeal stop --until-start
```

The stop succeeded at Squeal revision 0. The primer reported 1,144 loaded test
files, 90 slow files, 13 current slow files and 77 pending. These inherited
verdicts are not the measurements below. The installed Codex launcher reports
0.1.390; the Claude plugin reports 0.1.392. Squeal stayed stopped during timing.
No `squeal run --slow` was used.

For each file, collect test names with `npm exec -- vitest list <file> --json`.
Run the first case, the first floor(N/2) cases, and all N cases. Match complete
Vitest test names with anchored escaped alternatives. This measures a prefix,
not a random sample. The prefix can contain cheaper or more expensive cases than
the suffix; the table must not be read as a uniform per-case estimate.

Each measured command has this form:

```sh
cat /proc/loadavg
nproc
/usr/bin/time -v -o <prefix>.time npm test -- <file> \
  --maxWorkers=1 --reporter=default -t '<anchored selected names>'
# Full file: omit -t.
```

Raw logs, exact argument arrays, selected and total case counts, starting load,
CPU count, start/end times, exit status and command PID live under the ignored
`.ai/qa/2516/` directory. `measure.py` runs files and sizes in sequence. Its
controller PID is 4102848; it runs in persistent command session 38370. These
are local evidence paths, not tool-readable baselines or a slow-file allowlist.
The table below is a record, not an input to any guard.

CPU seconds are GNU time's user plus system seconds, including reaped child
processes. Peak RSS is GNU time's maximum resident set size in KiB: the largest
single process in the tree, not the sum of concurrent processes. It does not
measure total tree memory. Wall time includes npm, Vitest startup, transforms,
imports, tests and teardown. CI suite-summary time excludes much of that setup.
Do not compare these two measures as if they were the same clock.

## CI durations

The manifest is `.github/test-durations.json` at the measurement checkout. Its
values are milliseconds. Recompute the historical set with:

```sh
node -e 'const d=require("./.github/test-durations.json").durationsMs; console.log(Object.entries(d).filter(([,ms])=>ms>60000))'
gh run list --repo hearsay-tools/cezarion --branch main --workflow ci.yml \
  --status success --limit 100 --json databaseId,headSha
gh run view 41334112445 --repo hearsay-tools/cezarion --log
```

The manifest has 36 entries over 60 s. `workflows/monitoring-channel-order.test.ts`
was deleted by hearsay-tools/cezarion#2446. Measure the other 35, not a recreated
copy of the removed test. Fresh CI also selects
`delegation/provision-workflows.test.ts` and `delegation/workspace.test.ts`.

Passed main run **41334112445**, SHA
`05a1ee28989378319a0f982b7696b276858c89b4`, executed four shards with
`--maxWorkers=4`. Use its per-file passed suite-summary lines. The more recent
passed main run 41639284504 at the measurement SHA skipped the Vitest jobs and
reused queue evidence; it cannot supply fresh suite timings. The chosen run
precedes some subsequent test changes, including removal of the obsolete file.
Its numbers describe that SHA, not an execution of the measurement checkout.


| File under `packages/cezar/src/` | Manifest seconds | Fresh CI seconds | State |
| --- | ---: | ---: | --- |
| `core/ci-tools.test.ts` | 63.780 | 75.129 | Measure |
| `core/harness-autosave-settlement.test.ts` | 101.250 | 117.047 | Measure |
| `core/harness-claude-parity.test.ts` | 225.210 | 211.903 | Measure |
| `core/harness-codex-parity.test.ts` | 97.636 | 106.027 | Measure |
| `core/harness-cursor-parity.test.ts` | 82.797 | 86.670 | Measure |
| `core/harness-opencode-parity.test.ts` | 99.568 | 85.285 | Measure |
| `core/skill-provision-parity.test.ts` | 80.355 | 50.324 | Measure |
| `core/skill-resume-parity.test.ts` | 194.268 | 203.698 | Measure |
| `core/workflow-ask-parity.test.ts` | 63.592 | 58.268 | Measure |
| `core/workflow-autonomous-parity.test.ts` | 158.834 | 182.639 | Measure |
| `core/workflow-final-message-parity.test.ts` | 110.766 | 83.062 | Measure |
| `core/workflow-followup-parity.test.ts` | 90.028 | 97.831 | Measure |
| `core/workflow-no-progress-parity.test.ts` | 71.640 | 73.238 | Measure |
| `workflows/ci-wait-failure-parity.test.ts` | 138.087 | 105.801 | Measure |
| `workflows/ci-wait.test.ts` | 71.305 | 62.628 | Measure |
| `workflows/monitoring-channel-order.test.ts` | 93.999 | 74.176 | Deleted; not measured |
| `workflows/monitoring-turn.test.ts` | 316.866 | 273.720 | Measure |
| `workflows/run.test.ts` | 202.393 | 191.962 | Measure |
| `workflows/waits-claude-parity.test.ts` | 203.736 | 211.056 | Measure |
| `workflows/waits-claude-workers-parity.test.ts` | 256.617 | 259.740 | Measure |
| `workflows/waits-codex-parity.test.ts` | 99.992 | 55.693 | Measure |
| `workflows/waits-codex-workers-parity.test.ts` | 80.937 | 92.102 | Measure |
| `workflows/waits-cursor-parity.test.ts` | 143.114 | 147.445 | Measure |
| `workflows/waits-cursor-workers-parity.test.ts` | 148.254 | 130.376 | Measure |
| `workflows/waits-omp-parity.test.ts` | 86.606 | 54.029 | Measure |
| `workflows/waits-omp-workers-parity.test.ts` | 74.455 | 65.718 | Measure |
| `workflows/waits-opencode-parity.test.ts` | 97.950 | 103.309 | Measure |
| `workflows/waits-opencode-workers-parity.test.ts` | 124.662 | 118.985 | Measure |
| `workflows/waits-pi-parity.test.ts` | 71.544 | 75.493 | Measure |
| `workflows/waits-pi-workers-parity.test.ts` | 70.429 | 61.928 | Measure |
| `workflows/worker-parent-attention.test.ts` | 212.179 | 208.576 | Measure |
| `workflows/worker-questions.test.ts` | 177.982 | 156.895 | Measure |
| `workflows/worker-restart-parity.test.ts` | 66.081 | 71.023 | Measure |
| `workflows/worker-wait-capacity.test.ts` | 90.407 | 94.345 | Measure |
| `workflows/worker-wait-conversations.test.ts` | 87.799 | 72.505 | Measure |
| `workflows/worker-wait-durability.test.ts` | 90.680 | 85.583 | Measure |
| `delegation/workspace.test.ts` | 53.129 | 69.889 | Measure |
| `delegation/provision-workflows.test.ts` | 55.912 | 85.367 | Measure |

## Measurement table

Measurements are being collected. The completed revision replaces this paragraph
with every size, selected count, wall/CPU/RSS, host load, CPU count and verdict.

## Cost and fix per file

The completed revision ties each file to measured scaling and source evidence,
then gives a slice 3.2 estimate and the slice 3.3 action. Estimates are budgets
to validate on CI, not measured post-change performance.

## Slice 3.2: keep the shipped wire adapters

### The seam and the default path

Use a Vitest partial module mock of `node:child_process.spawn`, installed before
importing the real runner factory or `RunManager`. Match only the selected
`HARNESS_ADAPTERS` mock executable and its native argv. Pass through every other
spawn and every unrelated child-process export. Git, discovery, `tsx`, process
probes and real lifecycle fixtures remain real.

**Proposed changed runner-source lines: none.** The same applies to
`session-process.ts` and `runner-runtime.ts`. No constructor option, environment
flag or application dependency injection is needed. The shipped default path
executes the identical source, imports, spawn arguments, timers, parser and
cleanup calls. The interception module and virtual process belong in testkits.
This is smaller than a production transport abstraction and satisfies owner
constraint 1 without a default branch that must be reasoned equivalent.

A virtual child is an EventEmitter with PassThrough stdin/stdout/stderr. Keep
`error`, stdout EOF, process `exit`, and pipe/process `close` distinct. Implement
write backpressure and callbacks used by the adapters. Never allocate a plausible
OS PID or send a signal for a virtual child. The existing `spawnSessionLeader`
check excludes non-ChildProcess objects from group registration; preserve its
`never group-signals a fake child` test. PID and OS signal assertions stay real.

If ESM module mocking does not reach a runner's launch, or a native addon needs
a real ChildProcess, keep that cell real. Do not add a runner-source seam as a
fallback without another design review that lists each changed source line and
proves the default path identical. Current source inspection found no such
runner restriction.

| Runner and active wire | Existing launch boundary | What the test replaces | Shipped adapter retained |
| --- | --- | --- | --- |
| Claude, stream JSONL | `claude-cli-runner.ts:140` → `spawnSessionLeader` | Mock executable process and pipes | argv, stdin JSON, Claude parsing, mapping and settlement |
| Codex, app-server JSONL RPC | `codex-app-server-runner.ts:236` → `spawnCodexAppServer` → `spawnSessionLeader` | Mock app-server child and pipes | initialize/thread/turn RPC, correlation, asks, approval replies and mapping |
| OpenCode, serve REST and SSE | `opencode-server-runner.ts:610` → `spawnSessionLeader` | Mock serve child; publish a loopback server URL | URL discovery, real fetch, real node:http SSE reader, parent filtering, question and permission replies |
| Pi, RPC JSONL | `pi-runner.ts:112` → `spawnSessionLeader` | Mock RPC child and pipes | requests, responses, event parsing and mapping |
| Cursor, print stream JSON | `cursor-print-process.ts:39` → `spawnSessionLeader` | Each mock print child and pipes | print argv/stdin, parsing, exit settlement and resume argv |
| OMP, RPC JSONL | `omp-runner.ts:269` → `spawnSessionLeader` | Mock RPC child and pipes | ready gate, correlated replies, bounded refusal respawn and settlement |

Line numbers refer to the measurement checkout and identify read boundaries;
they are not a proposal to edit those lines. Cursor ACP sessions were removed
in hearsay-tools/cezarion#1267. Do not invent an ACP session seam or smoke.
ACP model discovery is a separate mechanism.

OpenCode needs a real loopback HTTP server in the test process. Replacing fetch
alone would leave its separate node:http SSE reader disconnected. Listen on an
OS-assigned loopback port, return the URL through the virtual serve child's
stdout, and exercise the actual REST and SSE parsers. Close connections and the
server in fixture cleanup. This removes the mock server process, not the HTTP
protocol boundary.

### One implementation of each mock scenario

Extract scenario engines from `packages/cezar/scripts/mock-*.mjs` into importable
helpers. Give them streams, argv, environment, cwd, exit and signal hooks. The
CLI wrapper and virtual process must call the same engine. Do not translate a
scenario into normalized AgentEvents. Per-session data must not leak through
shared process.env or module state.

These scripts also implement CEZ_DRY_RUN. Their wrapper defaults and wire bytes
must therefore stay unchanged. For each extracted scenario, compare the real
wrapper's raw native frames, recording files, exit status and terminal ordering
before and after extraction. Mask only pre-existing nondeterministic IDs/times
with the same comparison on both sides. Keep real signal scheduling in wrappers.
A scenario whose equivalence cannot be proved stays real; it does not gain a
second test-only scenario implementation.

Keep RunManager, RunStore, disk recovery and isolated git workspaces real. A
virtual process may reduce native mock startup cost. It must not replace the
behavior the workflow cells assert.

### Real-process smoke cells and mutation proof

Keep one end-to-end baseline smoke per runner and current wire above. Assert
native resumable session ID, text, tool result, usage, one final done and terminal
ordering. Deliver another input and assert its receipt where the wire supports
it. Cursor must start another print process with --resume. End the session and
check real process exit. Keep cwd/env boundary probes real: a relative recording
file must land in the passed cwd because OS spawn applied cwd/env, not because a
virtual fixture wrote the expected path.

| Wire | Mutation that must make its real smoke fail |
| --- | --- |
| Claude | Suppress its native result frame |
| Codex | Suppress parent-thread turn/completed |
| OpenCode | Suppress the matching main-session session.idle; prompt HTTP acknowledgement alone must not finish the turn |
| Pi | Suppress agent_end |
| OMP | Suppress session_settled |
| Cursor | Suppress the terminal print result, or return nonzero after it |

Record a red mutation and clean pass for every wire against the same commit.
The failure must be the missing terminal guarantee, bounded by the existing
hang guard. Do not increase timeouts or add retries. Smoke is additional to,
not a replacement for, the real lifecycle coverage below.

### Parity guarantees retained

The assertion catalog and exhaustive RUNNER_IDS registration stay intact.
Every cell still runs the runner's own native wire parser. Preserve named inverse
exemptions and no-skips guards. Current cezar_done, cezar_ask and cezar_wait native
tool calls replace historical lifecycle marker examples in the 2026-09-04 spec;
do not restore markers removed by hearsay-tools/cezarion#2397.

| Original matrix guarantee | Evidence after migration |
| --- | --- |
| S1, exactly one final done and no later events | Same cell, virtual native frames; real baseline smoke |
| S2, terminal signal follows final content | Same cell and wire-specific smoke mutation |
| S3, resumable session id | Same cell and real resume smoke |
| S4, usage counters | Same native payload and mapper assertions |
| S5, second input | Same sendMessage cell; real smoke input receipt |
| S6, clean interrupt | In-process intent/order plus real shutdown tests |
| S7, provider/auth failure | Native failure frames through unchanged adapters and real RunManager failure assertion |
| S8, text coalescing | Native chunk boundaries through real parser and mapper |
| S9, child attribution | Native parent/child identifiers through actual filtering |
| S10, real PID | Real smoke and shutdown tests only |
| R1, declared completion reaches terminal status | Same real RunManager and durable store cell |
| R2, provider failure fails the run | Same real RunManager and native failure cell |
| R3, ask reaches the card | Same native ask/tool route and store assertions |
| R4, malformed asks do not become a card | Same malformed wire scenarios and inverse assertions |
| R5, monitoring and wake do not overlap | Same accepted wait and continuation assertions |
| R26, one answer continues an ask once | Same real message delivery and continuation cell |

AGENT_PROTOCOL §6 remains covered by unchanged ui-parity.test.ts: plans,
running/completed/failed tools, reasoning, diffs, subagents, usage, turn stop
reason, nesting, hooks and background-subagent lifecycle. Do not substitute
normalized events in either matrix. Section 7's specSupport proves tool grant,
model, cwd, env, resume, stream, interrupt and input support against each runner's
own mock wire. OS effects such as cwd/env and executable/argv semantics keep
real probes. The complete current criterion catalog, including later additions,
remains registered, not merely this historical subset.

### Process exits

Paths in the following tables are relative to `packages/cezar/src/`. Real
process-group and inherited-pipe cases remain real after 3.2. In-process tests
prove frame and event ordering, not OS cleanup.

| Case | Current file and exact test/criterion | After 3.2 |
|---|---|---|
| Clean completion | core/harness-parity-cells.testkit.ts S1 `terminates with exactly one v1 done, and it is the last event` | In-process plus real wire smoke |
| Terminal signal after content | Same S2 `ends the turn on its own terminal signal, after the last content event` | In-process plus real smoke |
| Clean exit without result | core/cursor-print-runner.test.ts `fails a clean process exit without a native result frame` | Existing non-parity test |
| Boundary waits for print exit | Same `waits for process exit before it emits the v1 turn boundary` | Existing non-parity test |
| Single-line stderr/nonzero | Harness S16 `preserves single-line stderr and nonzero exit codes` | In-process classification; retain real crash wire evidence |
| Empty stderr/nonzero | core/pi-runner.test.ts and core/omp-runner.test.ts `a non-zero exit with empty stderr fails with the bare exit code and no stderr note` | Existing non-parity |
| Crash after malformed output | Harness S15 `preserves actionable crash stderr and full available diagnostics after malformed native output` | In-process parser/order; real crash transport retained |
| Crash before ACK | Harness S18 `reports one actionable crash before terminal boundaries when the opening prompt is unacknowledged` | In-process ordering; real startup/crash evidence retained |
| Late stderr and inherited held pipes | Harness S19 `drains late crash stderr without waiting indefinitely for inherited pipes` (<4s while descendant holds for 5s) | Keep real |
| Harmless stderr during successful teardown | Harness S17 `keeps clean exits and requested signal teardown successful despite stderr` | In-process plus real normal close |
| stderr between exit and close | core/opencode-server-runner.test.ts `retains buffered stderr delivered between child exit and pipe close` | Existing non-parity |
| Event-loop stall and descendant diagnostic | core/runner-runtime.test.ts `reads a descendant diagnostic written while the event loop was blocked, then bounds held pipes` | Keep real |
| Drain budgets/cancel/cap | core/runner-runtime.test.ts `does not spend its budget on a stall, and the wall-clock cap still bounds it`; `cancels`; `gives a crash the longer budget and signal teardown the default` | Existing focused tests |
| Missing executable | Harness S20 `reports missing executables through its existing failure channel without starting a turn`; core/omp-runner.test.ts `ENOENT names omp and omp login`; core/claude-cli-runner.test.ts `rejects with the wrapped spawn error and emits nothing after it` | Keep real S20; no mock child is started |
| Outside signal | core/runner-shutdown-parity.test.ts S22 `treats an outside signal as failure` | Keep real every runner |
| Delayed native signal notification | Same S33 `preserves outside-signal failure when native exit notification follows EOF cleanup` | Keep real every runner |
| Delayed signal, probes unavailable | Same S34 `preserves delayed outside-signal failure when all process probes are unavailable` | Keep real every runner |
| Self-exit 143 is not Cezar signal | core/pi-runner.test.ts `rejects self-exit 143 when its native exit notification arrives after EOF cleanup`; `still rejects exit 143 when Cezar did not send the signal` | Existing non-parity |
| Requested signal success | core/claude-cli-runner.test.ts `settles the session instead of failing it when the CLI exits 143`; core/codex-app-server-runner.test.ts `settles the session instead of failing it when the app-server exits 143`; core/omp-runner.test.ts `a SIGKILL cezar sent is a teardown note, never an error` | Existing tests plus real shutdown |
| Hang/EOF and TERM ignored | core/runner-shutdown-parity.test.ts S23 `end escalates when the child cannot process EOF or SIGTERM` | Keep real every runner |
| Signal before stdout drain | core/claude-cli-runner.test.ts `settles a timeout when signal exit precedes stdout drain (hearsay-tools/cezarion#470)` | Existing test |
| stdout drained while live | Same `keeps timeout escalation alive after stdout has drained (hearsay-tools/cezarion#470)` | Existing test |
| Node killed flag not death | core/codex-app-server-runner.test.ts `escalates on the wall-clock timeout even after Node flagged the child as killed`; Claude `escalates after end() even though Node already flagged the child as killed`; OpenCode `escalates after end() even once Node flagged the server as killed` | Existing tests |
| Real exit cancels escalation | Claude/Codex/OpenCode runner tests `stops escalating once the ... really exits after SIGTERM` | Existing tests |
| Live output transport failure | core/runner-shutdown-parity.test.ts S24 `stops the live child when its output transport fails`; SSE destroyed for OpenCode, stdout for others | Keep real |
| Clean stdout EOF before exit | Same `${backend} reaps a live child after stdout ends cleanly` (Pi/Claude) | Keep real |
| EOF fallback evidence | Same `${backend} keeps live EOF cleanup bounded with unavailable process evidence` (Claude/Codex/Pi) | Keep real |
| EOF no usable evidence | Same `${backend} unknown automatic EOF cleanup fails but still reaps the live child (%s)` (unavailable/timeout) | Keep real |
| Explicit cleanup intent | Same `${backend} explicit ${intent} ${when} wins over unknown automatic cleanup` (end/interrupt × before EOF/during probe/after TERM) | Keep real |
| Interrupt preserves KILL deadline | Same `${backend} interrupt during automatic cleanup keeps the earlier KILL deadline` | Keep real |
| stdin closes/errors while live | core/omp-input-pipe.test.ts `${backend} surfaces closed-input failure S29`; `fails queued-before-ready writes even when the child would exit zero` | Preserve current transport tests; Cursor one-shot print has declared construction gap |
| Leader owns process group | core/runner-shutdown-parity.test.ts S26 `the session leader leads its own process group` | Keep real |
| Stop kills group/preserves setsid | Same S27 `stop ends the leader's process group but not a setsid child` | Keep real |
| Escalation reaches group | Same S28 `end escalation reaches the whole process group` | Keep real |
| Normal leader exit reaps group | Same S30 `a leader that exits on its own leaves nothing in its process group` | Keep real |
| External kill reaps group | Same S31 `a leader killed from outside leaves nothing in its process group` | Keep real |
| Fixture signal readiness race | Same `${backend} an ignore-term stall survives SIGTERM sent as soon as it publishes its pid` | Keep real |
| OpenCode exits before listening | Harness S25 `retries a backend server that exits before listening once and completes the turn`; core/opencode-serve-retry.test.ts `retries a server that exited before listening once, on a new process, and completes the turn` | Keep real S25; other runners lack separate listen stage |
| Retry exits/hangs/spawn fails | core/opencode-serve-retry.test.ts `fails with one error naming both attempts when the retry also exits before listening`; `does not blame both attempts when the retry hangs instead of exiting early`; `names the retry spawn failure instead of only the first early exit when the retry cannot start` | Existing focused tests |
| Retry pause interrupted/ended/deadline | Same `spawns no second server when the session is interrupted during the retry pause`; `spawns no second server when the session is ended during the retry pause`; `spawns no second server once the run deadline fired, and reports only the timeout` | Existing tests |
| OMP bounded refusal respawn | core/omp-runner.test.ts `respawns once without --add-dir and names the dropped directories`; `respawns once without the passed MCP names OMP did not know, with one v1 note`; `a second refusal of a remaining MCP name is surfaced, never a third spawn`; `the respawn gets only the time left on the original deadline` | Existing tests |
| OMP input/PID/control after respawn | Same `a human message sent right after start survives the respawn and reaches the second child once, in order`; `pid is the live child after a respawn, and onPidChange reports it`; `interrupt after a respawn aborts and kills the second child`; `end after a respawn closes the second child and finishes the run` | Existing tests |
| Persisted crash recovery | workflows/worker-restart-parity.test.ts `%s R60 cold terminal starting-proof recovery repairs execution without a synchronous facts join`; `%s completes destroy once the readable holder exits, while an unreadable process runs (${ledgerKind} ledger)`; `%s settles a same-boot crash as gone once recorded processes exit, whatever unreadable process runs, and keeps cleanup locks bounded` | Keep real process-holder evidence; only ordinary wire can move |
| Dead-owner adoption/stop starts nothing | Harness R51 `adopting a dead owner's run mid-turn starts no agent, and Continue resumes it`; R52 `Stop on a dead owner's run mid-turn ends it cancelled and starts no agent` | In-process wire sufficient for start counting; preserve disk recovery |

## Shared process helper tests retained

core/session-process.test.ts:
- `spawns a leader that leads its own process group`
- `signalling a session reaches a member that ignores SIGTERM after its leader exits`
- `a setsid member is never signalled`
- `a leader that exits on its own ends a member that handles SIGTERM`
- `a member that ignores SIGTERM is killed after the grace once its leader exits on its own`
- `a setsid member survives a leader that exits on its own`
- `a child spawned in the group after its leader exits on its own is still ended`
- `never group-signals a fake child`

core/session-process-reuse.test.ts:
- `never forwards to the number once a new live leader holds it`
- `never forwards to a reused group whose new leader already exited`
- `a recorded member that moved to another group no longer vouches for this one`
- `a pid reused by a new incarnation no longer vouches for the group`
- `never sends the SIGKILL to a number emptied and reused after the SIGTERM`
- `still SIGKILLs a child that ignores SIGTERM, started after the exit, when every recorded member ends on the SIGTERM`

core/session-process-win32.test.ts:
- `ends a live leader's tree with taskkill /T /F`
- `runs no taskkill for a leader that already exited`
- `never runs taskkill for a child it did not spawn`
- `falls back to the leader alone when taskkill cannot start`

core/mock-opencode-orphan.test.ts:
- `exits after its parent gets SIGKILL`
- `exits after its parent gets SIGKILL in the mode that ignores SIGTERM`

## Required detached-process cases

All evidence in detached-process.test.ts.

| Case | Exact evidence or gap | After 3.2 |
|---|---|---|
| Normal stop | `stops a running group with SIGTERM` | Preserve |
| Leader exits before members | `kills a member that ignores SIGTERM and outlives its leader`; `stops what is left of the group once Node reaped its leader, a member that ignores SIGTERM included`; watchGroup `stops what is left of a group whose leader exited on its own` | Preserve real |
| Starter dies during boot before descriptor | watchGroup `leaves the group to its starter, then stops it once the starter dies during boot` (real SIGKILL) | Preserve real |
| Starter SIGINT before/after start | No exact generic helper test found | Explicit coverage gap; do not claim generic helper proves it |
| Starter SIGKILL after descriptor | Boot test is before descriptor; no exact after-descriptor test found | Explicit gap; preserve owner-specific lifecycle tests |
| Handle deleted | watchGroup `stops the group once its handle is deleted, and settles the verdict after the stop` | Preserve real |
| Forged/reused PID | `never signals a live process whose start identity differs from the record: a reused or forged pid` | Preserve real |
| Unreadable identity | `never signals a live leader whose start identity cannot be read now: its pid may lead another group`; `stops a leader this process holds, though its start identity cannot be read` | Preserve both |
| Missing identity | `never signals a leader whose start identity was not recorded: its pid may name another process` | Preserve |
| Zombie main thread, live port-holding threads | `counts it running while another thread holds its port, and stops it only once the port is free` | Preserve real |
| Intentional unowned launch survives starter | startAndForget `keeps nothing alive: its caller exits while the process runs and before the settle window ends` asserts child remains alive | Preserve; distinct from owned cleanup |

No tracked files changed. No tests ran.


## Slice 3.3 plan

Split remaining slow files by semantic row group. Keep one definition of each
row and have thin files register disjoint groups. A guard must prove that every
criterion/runner pair appears exactly once across those files. Do not replace
coverage with skips, retries, higher timeouts or runner exemptions.

Add a reporter that records Vitest's actual test-module execution duration,
including that file's hooks and teardown, using the same clock as the per-file
suite summary. It must run on every shard. At the end of each shard, fail if
any completed file takes **60,000 ms or more**, or if a collected file has no
completed measurement. Keep only completed Vitest files in this check, not
modules imported by a test. A crashed worker or skipped shard must also fail the
required aggregate. Print path, measured milliseconds and the hard limit.

Upload raw per-shard timing records tagged with exact head SHA, run ID, shard
identity, maxWorkers and reporter version. The existing required aggregate must
read all four artifacts from the current run, reject missing, duplicate or
foreign-SHA records, and fail any value at or above the limit. The live shard
reporter fails locally in CI; the aggregate proves complete coverage. Neither
reads the historical duration manifest, this document's table, a baseline, an
allowlist or a prior run's median to decide admission. The sequencer may keep
using its scheduling hints independently.

Prove the cap with a synthetic reporter input at 59,999 ms, 60,000 ms and
60,001 ms; missing file, crashed worker, missing shard and wrong-SHA artifacts
must fail. Show one real over-limit suite turns the shard and required aggregate
red. Land the cap only on a head where every real Vitest file passes all four
shards under the actual CI worker count. If one remains slow, fix its cause or
split its rows first. No exception list and no allowance for historical files.

## Required case tables

This docs-only PR changes no state, cross-run relationship, ToolGrant mapping,
worktree write or restored client state. Those five application-change tables
do not apply. Slice 3.2 changes the test transport, not shipped state or grants;
it must preserve their existing parity rows and recovery fixtures. Process
lifecycle tables do apply because removing real mock processes can remove proof
about detached descendants. The Process exits table names what remains real,
including the separate detached-helper ownership cases.
