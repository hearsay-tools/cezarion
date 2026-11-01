# Campaign state

Use `.ai/qa/campaign/state.json` as a resumable ledger, not as proof of a merge
or a passing check. Reconcile live facts before acting after a restart.

Record these fields:

- **Campaign:** source, epic/planner ids, approved plan path and revision,
  controls, merge authority (the owner's words and source), phase exits.
- **Item:** repository-qualified issue, work type, deciding criterion, approved
  scope and guarantees, expected files/regions at a main SHA, prerequisites and
  their release checks, status and blocker.
- **Execution:** spawn request id, worker id, runner/model, baseline SHA,
  brief path, Cezar wait and request ids, latest collected revision.
- **Evidence:** PR and current head, reviewed head and findings, criterion-to-check
  results, landing outcome and merge SHA, integrated acceptance SHA/results,
  before/after metrics when relevant, preserved artifacts.
- **Decisions:** scope changes, affected dependents, authorized exclusions,
  out-of-scope behavior questions and friction lines.

Keep worker lifecycle separate from delivery and acceptance. A settled worker
can have a PR awaiting its owner; a merged PR can still fail integration.

## Item transitions

| State | Exit condition | Who fires the exit |
|---|---|---|
| Queued | Plan current, prerequisite checks passed, slot free | Coordinator dispatches |
| Running | Evidence ready, question, failure or settlement | Worker report or Cezar worker wait |
| Reviewing | Findings resolved at the current head | Coordinator diff review and worker reply |
| Awaiting owner | Owner approves/merges, rejects or changes scope | Human input or PR wait; this is a deliberate human gate |
| Landing | Observed merge, changed head or blocked gate | land-pr result or PR wait |
| Merged | Integrated acceptance passes or needs repair | Coordinator acceptance check |
| Accepted | Evidence saved, worker collected and destroyed | Coordinator teardown |
| Blocked | Named prerequisite, repair or decision resolves | Matching PR/request/worker wait or human input |
| Excluded | Owner approved removal, or unattended admission left unclear scope out | Coordinator records reason; phase completion still checks remaining scope |

Every blocked entry names its owner, next action and wake source. Preserve an
accepted item's evidence through teardown. A changed plan or head invalidates
affected evidence and returns the item to the relevant earlier step; retain
the superseded evidence as history.

## Resume

1. Read the ledger and handoff. Inspect all owned workers, including remaining
   resources; collect only their latest settled revisions.
2. Fetch main. Query each active PR's head, state and merge result. Reconcile
   accepted spawn requests rather than creating duplicate workers.
   For an older cleanup ledger, preserve worker/PR identities and backfill work
   type, plan and acceptance evidence from their sources. Missing evidence
   remains unverified.
3. Recheck plan freshness and acceptance evidence after changes to main. A
   merged prerequisite unlocks work only after its recorded release checks pass.
4. Restore waits for outstanding work, decisions and PRs. Resume a settled
   worker explicitly when it has more work.

Done when every nonterminal item has a current status, next action and wake
source, and no worker or pending landing is missing from the ledger.
