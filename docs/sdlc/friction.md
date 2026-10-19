# Friction intake and handling

`friction` records how an obstacle was discovered. Friction Intake uses Jev to
recommend one category and one handling route. A routing label never grants
blanket approval of new behavior; each task verifies the evidence and scope again.
The reference analysis is in
[the category report](../../.ai/analysis/2026-10-19-friction-categories.md).

## Categories

| Label | Obstacle | Minimum handling |
| --- | --- | --- |
| `friction-knowledge` | Missing instructions or discoverability of established behavior | Automatic |
| `friction-diagnostics` | Missing failure evidence or accurate recovery guidance | Automatic |
| `friction-tests` | Broken fixtures, helpers, synchronization or reproducibility | Automatic |
| `friction-maintainability` | Local duplication, dead code or an existing quality-rule violation | Automatic |
| `friction-regression` | Violation of a named, approved contract | Guarded |
| `friction-capability` | Missing command, integration or user workflow | Design |
| `friction-lifecycle` | New wake, timeout, concurrency, recovery or durability guarantees | Design |
| `friction-semantics` | New identity, ownership, accounting, deduplication or retry meaning | Design |

`friction-unclassified` is the no-match fallback, not a ninth substantive
category. It always requires design investigation. The strongest relevant
boundary wins. An approved lifecycle guarantee that is merely broken belongs
under regression. A documentation change that introduces policy requires design.
Capability changes initially use design even for a potentially bounded read-only
extension; investigation can establish its scope before implementation.

## Jev judgments and policy

The dedicated `.github/workflows/friction-intake.yml` action reads title and body
as untrusted reference data. It submits one Choice (category, including no-match)
and five independent Noul questions in one request: established intended behavior,
policy changes, authority changes, verification changes, and runtime changes.
Code combines them; Jev does not select an executable workflow or use tools.

Automatic eligibility requires a selected-category probability of at least 0.8,
an established-behavior probability of at least 0.9, and independently no more
than 0.1 probability of a policy, authority, or verification change. A runtime
change above 0.1 requires guarded handling. Category minimums still apply.
Uncertain evidence, truncated input, or no category match routes to design.
Choice distribution concentration (`confidence`) is retained for audit; it is
not treated as permission. These are conservative starting thresholds, not
measured accuracy. Before enabling implementation routes, evaluate representative
reports, especially policy changes disguised as documentation or test fixes.

The action reuses the existing bounded Jev transport, `TYPESAFE_API_KEY` repository
secret, `ISSUE_INTAKE_JEV_MODEL` repository variable, and default `jev-1.13.0`.
No new secret or required configuration is introduced. Title input is capped at
500 characters and body input at 12,000; original content remains in the snapshot
for freshness checks. Comments are deliberately excluded from model input.
Independent workers read the full current issue and comments before acting.

Each run retains a seven-day classification artifact containing the snapshot,
judgments, probabilities and final route. Read its summary and artifact to inspect
a decision; credentials are never part of either. Invalid answers or service
failures clear the captured managed routing labels rather than authorize work,
even if the body was edited during classification. A different current route is
preserved as a newer decision. Per-issue serialization prevents overlapping
classifier runs from applying out of order.
The action warns and can be rerun after the failure is resolved.

Classification has read-only issue permissions. A separate apply job has issue
write permission without the TypeSafe credential. It re-fetches current state,
rejects stale title/body snapshots, skips PRs, creates missing labels, removes
obsolete managed labels, and adds the category/handling pair. Unrelated labels
survive. A second freshness check follows label setup. GitHub offers no atomic
conditional label mutation, so the task must still verify current scope.
Ordinary issue intake keeps duplicate detection and general labeling, but receives
no `friction` or `friction-*` choices and its structured applicator refuses those
labels. Reporters and explicit friction-reporting tools set the provenance label;
general intake must not infer it. This also avoids relying on a `GITHUB_TOKEN`
label mutation to trigger another Actions workflow, which GitHub suppresses.

## Triggers and preview

Classification runs on friction issue opening, editing and reopening, and when
`friction` is added. Closing an issue or removing `friction` clears managed labels
without paying for Jev. Category/handling label changes do not invoke Jev again.
Per-issue concurrency queues runs instead of interrupting label application.

After the workflow lands on the default branch, preview one issue with:

```sh
gh workflow run friction-intake.yml -f issue_number=123 -f dry_run=true
```

Manual runs are admitted only on the repository's current default branch.
Feature-branch and tag dispatches are skipped before classification. Both jobs
check out the admitted event's commit.

Read the Actions summary and artifact. Set `dry_run=false` only to apply the
result. This action does not bulk classify the reference issues. A failed run
needs a rerun; no background retry task is created outside the bounded transport.

## Handling automations

| Handling label | Result |
| --- | --- |
| `friction-auto` | Verify established intent, implement a bounded remedy, verify, open a draft PR |
| `friction-guarded` | Name the approved guarantee, reproduce the violation, prove regression red/green, verify neighboring and boundary-specific guarantees, open a draft PR |
| `friction-design` | Investigate, propose behavior and alternatives with acceptance criteria and a verification plan, then stop before product implementation |

All three require an open issue by `wjarka`, `friction`, their own handling label,
no other handling label, exactly one recognized category, and no existing claim,
assignee, implementation PR or other task. Polls use handling-label additions,
a 300-second interval, a seven-day bounded lookback and at most 25 records.
All three opt into `filters.requireCurrentLabels:true`: an open state and label filters are checked
against a fresh GitHub read before reserving a receipt and again before creating
a task. A closed item is skipped; a missing or invalid state cannot authorize work. Historical label events cannot let an obsolete handler consume the
issue task slot. Manual receipt retries use the same launch check. If the final read rejects a
candidate after reservation, the receipt becomes `released`: it remains an audit
record but cannot block the same event or a later event for that issue. Ordinary
launch errors retain their receipt and explicit retry behavior.

| Receipt state | Exit trigger and owner | Behavior at shipped defaults |
| --- | --- | --- |
| `reserved` | Launcher creates a run | `launched`; retains the issue claim |
| `reserved` | Scheduler/retry catches a fresh eligibility rejection | `released`; audit only, no issue or event claim |
| `reserved` | Ordinary exception or startup recovery | `launch-error`; retains the claim |
| `released` | Scheduler observes an eligible event | A new reservation is allowed |
| `launch-error` | Human explicitly retries through the API | Returns to `reserved`; no automatic retry |
| `launched` | Scheduler sees later observations | Remains claimed; no automatic exit |

The default
for other automations is unchanged: historical event labels still match. Preview
counts describe historical matches; execution can skip a superseded route.

Tasks use Codex, one isolated worktree, no generated follow-ups, and human review;
none may merge or enable automation. Implementation routes can escalate to a
design proposal whenever investigation exposes an unresolved decision.

A design proposal records current load-bearing guarantees, alternatives and
trade-offs, defaults, cost/authority boundaries, persistence/compatibility,
acceptance criteria and verification. Run-state changes include a **Transitions
out** table covering failure and no-session recovery. Approve the proposal and
**Continue the same task** to implement it. Relabeling is not a new-stage handoff:
cezar's existing issue deduplication can block a second task for that issue.

The Jev action itself creates no cezar task, leaving issue deduplication available
for its selected handler. Edits or reclassifications do not launch replacement
work for an issue that already has a task.

## Rollout

The previous Friction automation is disabled. Replacements are created **paused**,
with `includeExisting:false`. They need the classifier workflow merged, a cockpit build with
`requireCurrentLabels` support running, and paused previews reviewed before a
separate explicit enablement. Older builds preserve this additive filter in
storage but do not enforce it; keep the replacements paused until upgraded. Default enablement
starts a current-time baseline, so earlier label additions do not replay.
The paused state is intentional; no existing backlog is launched by this change.

`.github/scripts/friction-policy.cjs` owns labels, routing rules and the three
prompts. Running `node .github/scripts/friction-policy.cjs` emits the definitions
for review. Create each with `cez automation create --file <definition.json>`
without `--enable`, then use `cez automation check <id>` without `--execute`.
Compare existing definitions before updating them; do not create duplicate polls.
