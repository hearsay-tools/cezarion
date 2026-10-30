# Epic mode

In epic mode you are the **planner**: one long task that owns the spec, the
epic body and the next phase. Each phase runs the campaign loop in its own
coordinator task, which reports back to you. Epic 2051 ran this way: one
planner (task `da62f747`) and five phase coordinators, 69 issues in 42 hours.

Go from phase to phase without asking. Ask the owner only for a product
decision or an exit that the plan cannot reach.

## Before the first phase

When the epic has no approved plan yet:

1. Explore with read-only workers, one per code range, plus one for the
   cross-cutting constraints (guards, test seams, size limits). Measure the
   baseline.
2. Write the plan: a module map, the rules for a PR in this epic, the orders
   that must survive, the phases and the exit of each phase. Get the owner's
   approval.
3. Record it in a spec under `.ai/specs/` (and an ADR when it fixes a
   structure), and file the epic with the phase table and acceptance criteria.

Done when the spec has merged and the epic names every phase with its exit.

## Each phase

1. **Draft.** Write the phase's issue drafts from the spec and current main. A
   drafting worker can do the first pass. Each draft gives the done line, the
   regions, the names to change, the seams to keep and the order gate.
2. **Verify.** When the previous phase has merged, have a read-only worker check
   every draft against the merged code. Apply its corrections; it changed all
   13 Phase 4 drafts of epic 2051.
3. **File.** File the issues as sub-issues of the epic, with the board and
   labels. Add the phase's wave table to the epic body. Send any spec update as
   a docs PR beside the phase.
4. **Start the coordinator** with an explicit model and effort:

   ```bash
   cez task start --runner claude --model opus --effort high --task-file <prompt>
   ```

   Use the prompt template below.
5. **Wait** with `cez message wait --peer <coordinator id>`. Answer its product
   questions. Draft the next phase while you wait, and verify it after the
   phase merges.
6. **Record.** When the coordinator reports, measure the exit on main. Add a
   "Phase N result" paragraph to the epic body (what merged, the metric before
   and after, any change of wave order and why) and to the shared notes.

Done when the phase exit holds on main and both records are written. After the
last phase, tick the acceptance criteria, close the epic and destroy every
worker you own.

## Coordinator prompt

```text
/cleanup-campaign

Epic hearsay-tools/cezarion#<E>, Phase <N>: hearsay-tools/cezarion#<a> to
hearsay-tools/cezarion#<b>. The epic body lists them in waves with their gates.
Read the spec <path> first, especially <sections>.

Controls: <worker model>, at most <k> live workers, at most 2 open PRs that edit
<hot file>. <Only when the owner granted the merge for this epic, in words:
"You merge on the gate when the change is exactly what the issue asked for."
Otherwise: "The owner merges each PR.">

Phase rules: <exceptions the owner approved for this phase, each with its date>.

The previous coordinator recorded what worked in its handoff:
<path to its .handoff.md>. Read it before you spawn workers.

Task <planner id> plans this epic. Message it with cez message progress
<planner id> '<text>' --id <new UUID>:
- when every Phase <N> issue is closed: what merged, <metric> on main, anything
  left undone, and any behavior question a worker found;
- when you need a product decision.
```
