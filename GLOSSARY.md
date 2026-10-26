# Domain glossary

## Turn

One unit of agent work that ends with the runner's turn-end signal. A session
can carry several turns.

## Turn settlement

Cezar's processing of a completed turn to account for input still owed,
questions, waits, completion requests and workflow progression. A transport
acknowledgement can defer settlement until after the turn-end signal.

Turn settlement concerns what happens after agent work. Session termination
and proof that worker resources can be removed remain separate facts.

## Nudge

One automatic turn that Cezar sends when a turn ends without an accepted done
and without a wait. It has a cause: no wait (the turn named neither a wait nor
a done) or completion (the agent's done was refused). A nudge is charged to the
automatic-wake budget, and a timer bounds its reply. A run that is not
autonomous gets one nudge per cause; when the answered turn ends the same way,
the run parks on Cezar's human wait (no wait) or on the completion wait or the
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
