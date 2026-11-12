# Domain glossary

## Turn

One unit of agent work that ends with the runner's turn-end signal. A session
can carry several turns.

## Turn settlement

Squawk's processing of a completed turn to account for input still owed,
questions, waits, completion requests and workflow progression. A transport
acknowledgement can defer settlement until after the turn-end signal.

Turn settlement concerns what happens after agent work. Session termination
and proof that worker resources can be removed remain separate facts.

## Nudge

One automatic turn that Squawk sends when a turn ends without an accepted done
and without a wait. It has a cause: no wait (the turn named neither a wait nor
a done) or completion (the agent's done was refused). A nudge is charged to the
automatic-wake budget, and a timer bounds its reply. A run that is not
autonomous gets one nudge per cause; when the answered turn ends the same way,
the run parks on Squawk's human wait (no wait) or on the completion wait or the
user (completion). An autonomous run is nudged again until the budget is spent.

_Avoid_: reminder, poke

## Native failure control

A test fixture that selects when a native runner mock fails and how long that
failure remains active. It can hold one failure until release, or keep failing
matching wake prompts until lifted. All matching runs in a test fixture share
that failure state. The state survives mock subprocess restarts and ends with
the fixture; separate fixtures have separate state.

The real runner and its transport remain in use. The mock retains its native
failure response, including an intentional process exit where the test needs
to prove that input was not read.

## Native delivery control

A test fixture that selects how a native runner mock answers an input the
runner sends to it: the mock rejects the input, holds its acknowledgement, or
holds its response. A rejection applies once or until lifted; a hold lasts
until release. Like a native failure control, it applies to every matching run
in a test fixture, survives mock subprocess restarts and ends with the fixture.

A held acknowledgement or response is not a failure, and a rejection refuses
the input before the mock admits it. Failing a turn the mock admitted belongs
to a native failure control. The control changes only timing; what the turn
says still follows the input. The mock keeps its native rejection and
acknowledgement encoding.

_Avoid_: delayed command, patched mock

## Attention rung

One step of the attention ladder: the single answer to "what does this run want
now", chosen by priority from its status, its waits and a live permission
prompt. A run is on exactly one rung at a time. A rung has a stable id and a
label. The label is copy: it can carry a count ("waiting on 2 workers") and can
be reworded, while the id stays. A surface that decides something about a run
reads the rung id; a surface that shows the run prints the label.

_Avoid_: attention label (as an identifier), status (a rung is derived, not
stored)

## Usage-limit hold

A run that a provider usage limit stopped, parked as `waiting` with a booked
resume time (`autoResumeAt`). It holds no slot and no agent session, so the
engine does not own it. Its resume or the user's Continue wakes it, and a wait
that resolves meanwhile is delivered with the resume. A withdrawn resume
settles the run `failed` with the error it kept. Only a `waiting` run can be on
a hold: the store clears the resume time on every write that leaves `waiting`.

_Avoid_: scheduled run (the sidebar's word for it), failed with a resume

## Run exit

A named kind of run status write: the statuses it may leave from, the status it
writes, the fields it settles (such as `finishedAt` and `currentStepId`) and
whether it commits at once or on the debounced save. The run store owns the
exit table, and a status changes only by an exit. A trigger row in the run
state table names the exit it takes.

_Avoid_: transition (as a noun for the declared kind), status patch

## Wait kind

What a wait waits for: `pr`, `timer`, `process`, `human`, `worker`, `peer` or
`subagent`. Each kind has one row in the wait-kind table. The row states the
kind's rules: its deadline, whether it keeps the slot, whether its wake costs
budget, whether the agent can cancel it, its duplicate check, its entry, its
watch, its default result and its text. `request` is a `worker` wait on
replies, and `ci` is an old name that the store reads as `pr`.

_Avoid_: wait type, `request` or `merge` as a kind

## Wait engine

The run module that executes the wait-kind rows: it opens, resolves, re-arms
and cancels waits. Opening checks the open-wait limit through one function, then
commits, arms and parks, with the steps each registration path runs. Cancelling commits, then disarms every watch the wait holds. Wake
admission and the wake budget call the engine; they are not part of it. In the
service, only the engine, the table, the watch adapters, the boundary views and
the read-time upgrade of old rows branch on a wait's kind.

_Avoid_: wait registry (the part that validates requests), wait manager

## No-progress stall

The native mock mode that a `mock:no-progress-*` prompt selects: the mock stops
making progress, so tests can exercise Squawk's no-progress deadline and the
escalation that ends a session. Its variants close the input, ignore SIGTERM,
hold the output pipe open in a child, or leave children behind. The mock writes
`watchdog.pid` only after the variant is in place, so a test may signal it as
soon as the file holds a whole pid.

_Avoid_: hang, freeze

## Mock scenario

A shared script in `packages/cezar/scripts/mock-scenario.mjs` that selects what
an offline agent does for a prompt. It defines text, tools, waits and turn end
as steps. Selection order and the position of native failure control belong
to the script. A scenario does not define native wire frames.

## Wire encoder

The part of a native runner mock that turns mock scenario steps into that
runner's protocol frames. It keeps native ids, usage, acknowledgement, delivery
control, failure control and steering admission. The real runner and mapper
consume those frames in parity tests.

## Run checkout

The directory a cockpit route uses for a run's files and Git state: the run's
worktree, or the repository root for a `worktree: false` run. One server
module decides it for each route that hearsay-tools/cezarion#3158 has migrated;
the other routes still decide it in their handlers. A route names its checkout intent and gets back either a
refusal with a status and an `{ error }` body, or the run, the directory and,
when the intent claims the run, the release. Artifact routes read the data
directory and use no run checkout.

_Avoid_: worktree (when a `worktree: false` run is meant too), working directory

## Checkout intent

What a route will do with a run checkout: `read`, `mutate` (Git commit and
push), `publish` (Draft PR), `remove` (remove the worktree, delete the run,
reclaim one worktree) or `open` (hand the directory to an outside app or
terminal). The intent fixes the checks and their order, and whether the
module takes a claim. A read never refuses a foreign owner and never rebuilds
a reclaimed worktree.

_Avoid_: mode, access level
