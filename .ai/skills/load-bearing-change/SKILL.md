---
name: load-bearing-change
description: Plan or review a change that replaces, removes or merges working behavior (a timer, lock, cap, timeout, state, handler, queue or default), or a change that needs a case table (a run state, a cross-run relationship, a ToolGrant mapping, worktree files, a detached process, restored client state).
---

# Changing a mechanism that already works

Replacing working behavior is the highest-risk change in this repo. It fails in a
characteristic way: the new mechanism is correct, the tests are green, the spec is
thorough — and the DEFAULT path quietly lost a **load-bearing** guarantee, one that
other code reaches a correct state *because of*, whether or not anyone wrote it down.
open-mercato/cezar#810 and open-mercato/cezar#811 both shipped a well-specified
improvement that left the zero-config user worse off than before.

**Name what the old mechanism was load-bearing FOR, not what it was for.**
`IDLE_TIMEOUT_MS` read as session hygiene, and open-mercato/cezar#661 removed it from
the monitoring branch for a good reason (it closed live sessions mid-CI and recorded
them as `done`). It was also the only liveness bound on `CEZ:MONITORING` and the only
reason a parked monitor released its `maxParallel` slot, so `monitoring` became a
state with no exit. Before deleting a timer, lock, cap or timeout, grep for
everything that reaches a terminal state *because* of it.

**Name the load-bearing guarantee before changing a test's expected outcome.** When a
change edits the expected outcome of an existing parity or regression test, the plan —
or the PR body when no plan exists — names the guarantee the old outcome pinned. It
explains how the change replaces that guarantee, or why it is dropped and where the
follow-up is tracked. Recording a follow-up does not itself authorize dropping a
guarantee.

**A replacement that ships OFF is not a replacement.** Diff the default path, not the
feature: *with every new knob at its shipped default, what does the old scenario do
now?* If the answer is "nothing", the change removed a mechanism and added a setting.
A spec's "Resolved assumptions" table answering a COST question with "opt-in, default
null" does not show that the zero-config path still works — cost-safe and functional
are separate reviews. See [AGENTS.md § Zero config](../../../AGENTS.md#zero-config): *never trade a working default for a knob*.

**Preserve queue-head reads when changing queue boundaries.** When splitting, merging
or re-keying a queue, list every value the old task read when it reached the queue
head, and read each one again at the head of the new queue. Carry stable identity
through the queue rather than an earlier copy of mutable settings
. Test the boundary: hold the head
task, enqueue another, change the value, release the head, and assert what the queued
task used. Cover removal or deselection when applicable.

**Enumerate the transitions out of every state you add or keep.** "Who fires this?" is
the question that finds these bugs in one step. A parked run wakes only through a path
someone wrote: a human message, the turn-end nudge, the resolution of a durable wait it
registered (the wait kinds in `packages/contract/src/waits.ts`), conversation input from
a worker or parent, a usage-limit auto-resume, or native runner activity on a monitoring
or worker park (`workflows/run.ts`). No other event calls back, so a state whose only
on-by-default exit is "a human types something" is a dead end, however well it renders. The plan carries a **Transitions out** case table (below).

Outcome writes: `outcome-write-outside-commit-outcome` names the commit helper.
A cleanup write uses `bestEffort` and must never throw past cleanup.
Outside the run store, commit an outcome atomically with or after what it depends on, and test each crash boundary on the committed row, not the final state or the in-memory object.

**Test the path with no live session.** When changing a path that reads
`this.active.get(runId)`, add a test with no session. Restart recovery and scheduler
continuations can reach the path before a session exists; an absent entry must still
produce the required durable outcome and a usable next step.

Find every construction site of a shared in-memory object by grepping its type, not its field, and give it one factory where a new required field fails to compile.
Construction and skills access: `active-run-literal`, `active-run-map-write`, `skills-read-outside-enabled-skills` and `skills-write-outside-load-run-skills` name their owners.

**List each handler's side effects, in order, before you merge handlers into one.** The
merged method can lose one step of a handler's order while every test stays green. For
each entry and each case, list what each handler does, in order: its input delivery,
the timers or waits it opens, the gates it calls, and the heartbeat or note it writes.
Pin each line with a test, or name the test row that already covers it, before you
delete the handler.

**A fail-open helper needs a populated-input guarantee, or it lies.**
`expandRegistrySlashSkill` returning its input unchanged on no-match is right on its own —
a backend's own slash commands must survive. Against an empty registry that same branch
turns "cezar never loaded the list" into a confident user-facing "Unknown skill". Pair
every silent pass-through with a test that pins the *empty/absent input* case.

<a id="regression-proof"></a>

**Prove the regression test fails without the fix.** Pin the pre-fix commit as
`proof_base` and record the command, expected failure and fixed pass. A test written
after the diagnosis can pass against the bug; a green-either-way test does not prove
the fix. Keep the guard tests that pass both ways — they pin behavior you did NOT
want to change (park mode stays reachable; unknown slashes stay untouched) — but
know which is which. A **test-only change that removes a hidden dependency** (on a
catalog, a host setting or a default the test did not write) needs this proof even
when no failure has been observed. Run the proof in a disposable worktree or an
ignored scratch copy, never through the shared stash stack:
[`docs/sdlc/regression-proof.md`](../../../docs/sdlc/regression-proof.md) has the recipes for
a source fix, a test-only fix and a removed hidden dependency, and how to cite the
evidence.

**Read the run-history evidence before theorizing, and cite it.** `.ai/specs/` records
the design, `git log -S` and `git merge-base --is-ancestor <commit> <tag>` settle "was
this in the release the user is on", and a user's "it worked in 0.9.1" is a testable
claim, not an opinion. open-mercato/cezar#810 was confirmed in one command before a
line of code was read.

## Case tables

Some changes fail in cases nobody listed. For these changes the spec or plan MUST
carry a **case table**, reviewed with the spec or plan before implementation starts:
one row per case, every required case covered, behavior shown at shipped defaults,
and a case that cannot happen stated with the reason.

| Change | Table and columns | Required cases |
| --- | --- | --- |
| Adds or changes a cross-run relationship: messaging, delegation or settlement notification | **Both ends**, each state at each end: State · Send path behavior · Settlement path behavior | queued, running, waiting, Finish pending, stopping, review, done, failed, cancelled, deleted, history deletion pending, restart, other process owns it, unreadable record. |
| Adds or changes a run state | **Transitions out**, copied from `workflows/run-states.ts`: State · Trigger · Who or what fires it · Behavior at shipped defaults | Each non-final state; its automatic exits or recorded human-only reason (`run-states.test.ts`). |
| Changes how a `ToolGrant` (`core/agent-runner.ts`) maps onto a runner's tool flags | **Tool-list kinds**, one per affected runner: Case · Emitted runner flags · Callable built-in, MCP and extension tools at shipped defaults | Every case in `TOOL_GRANT_CASES` (`core/tool-grant-parity-cells.testkit.ts`); its cells pin each case on each runner. Show effective tool access, not only the flags sent, and say when a runner ignores a restriction or cannot distinguish two cases. |
| Adds, replaces or removes files in a running task's worktree (`worktree-write-outside-manifest`) | **Worktree cases**: Case · Files written, kept or removed · Worktree state at the next step, Continue and restart | A catalog or source that has not loaded yet; the same name from two sources; records written by an older cezar version; a crash between two writes; the source removing the item. |
| Starts a process that outlives the command that started it (`detached-spawn-outside-helper`) | **Process exits**: Case · What stops it · Behavior at shipped defaults | The normal stop; the starting command interrupted by SIGINT or SIGKILL before and after the start; the handle the stop reads, such as a descriptor, deleted or forged. The helper's tests hold the rest: the leader exits first, a member ignores SIGTERM, zombies, an unreadable or reused start identity. |
| Restores saved client state for an entity | **State restore cases**: Path or trigger · Restored value · Displayed value | Reopen without a selection; switch between two restored entities; entity unavailable after restore; derived display differs from saved state (e.g. provider mask). Derive from one state; never mask in a provider. See hearsay-tools/cezarion#2079. |

Each table exists because a plan named only the obvious case and review rounds found
the rest: hearsay-tools/cezarion#1305 and hearsay-tools/cezarion#1360 (tool lists with
extra MCP names and hand-written default copies), hearsay-tools/cezarion#1494 and
hearsay-tools/cezarion#1539 (three fix rounds on switched-off skill copies, then a
revert), hearsay-tools/cezarion#1406 and PR hearsay-tools/cezarion#1708 (five review
rounds on process exits). The table makes the cases explicit for design review; it
does not decide which ones share a policy. The phase tables in
[the unified-waits spec](../../../.ai/specs/2026-10-17-unified-waits.md) (§ Transitions out
(phase 2a) and later) show the form.


A change to a shared name, value or default also needs a reader sweep:
[`.ai/skills/reader-sweep/SKILL.md`](../reader-sweep/SKILL.md).
