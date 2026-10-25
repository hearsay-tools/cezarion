# Friction intake and handling

`friction` records how an obstacle was discovered. Friction Intake uses Jev to
recommend one category and one handling route. A routing label never grants
blanket approval of new behavior; each task verifies the evidence and scope again.
The reference analysis is in
[the category report](../../.ai/analysis/2026-10-19-friction-categories.md).

A finding does not become a `friction` issue when an agent finds it. It goes to
the [friction inbox](#friction-inbox) first. Only the issues the owner approves
from the daily digest carry `friction`, so only those reach the intake and the
handling automations below.

## Friction inbox

### Recording a finding

Write one finding to a file and post it from the repository root:

```sh
node .github/scripts/friction-inbox.cjs post finding.md
```

The command posts the file as a comment on today's inbox issue and prints the
comment URL. The inbox issue is `Friction inbox YYYY-MM-DD` (the UTC date),
labeled `friction-inbox`. The first finding of the day creates it. When two
agents create it at the same time, both post to the lower number and the
command closes the other copy.

Use this format. The command refuses a file without a known `Destination`:

```markdown
**Destination:** project | sdlc | squeal
**Type:** Undocumented knowledge | Long path | Architecture deviation | SDLC gap
**Cost:** about 20 min, 3 retries
**What happened:** one line, with its evidence: the command, the run, the review thread.
**Proposed fix:** the concrete change.
**Source:** task 6ce6ae5a, PR hearsay-tools/cezarion#1234
```

`Destination` names where a fix would live: `project` for this repository,
`sdlc` for an `apptension-sdlc` skill, `squeal` for Squeal. Record every
finding, small ones and already-tracked ones too: the digest counts
recurrences and removes duplicates. Keep the project detail, because the digest
removes it before it files outside this repository. Never include a credential
or a configuration value.

### The daily digest

The `Friction — daily digest` schedule (weekdays at 09:00, cockpit time)
reviews every inbox issue dated before today that does not carry
`friction-inbox-reviewed`. On Monday, that is the issues from Friday to Sunday.
The digest groups the findings, and the watch items from the previous digest,
by root cause. It checks each group against `main`, the docs and the trackers,
and gives it one verdict:

| Verdict | When |
| --- | --- |
| Act | One run lost more than 30 minutes to it, it gave a wrong result, or it occurred in two or more runs |
| Watch | A first occurrence below that bar. The digest carries it forward with its count and first-seen date |
| Drop | Already fixed or tracked, the run doing its job, or a watch item with no new occurrence in 30 days |

For each Act group, the digest names the smallest fix that removes the whole
class, and places any new rule as
[Where a new agent rule goes](#where-a-new-agent-rule-goes) says. It also lists
the rules that the evidence shows are obsolete or duplicated.

The digest posts its report on the newest issue it reviewed and asks the owner
which groups to file. It files one issue per approved group:

| Destination | Repository | Labels |
| --- | --- | --- |
| `project` | `hearsay-tools/cezarion`, written to the task template | `friction`, `friction-log` and one `area-*` label |
| `squeal` | `hearsay-tools/squeal`, written to its friction template | `friction` |
| `sdlc` | The `SDLC feedback` binding's repository, with no project detail | `friction-log`, `dev-flow` |

It then adds `friction-inbox-reviewed` to the issues it reviewed and closes
them. The digest never implements a fix. `node .github/scripts/friction-policy.cjs`
emits its definition, with its prompt, after the three handling polls.

Issue Intake skips an issue opened with `friction-inbox`, so it gets no labels
and is never closed as a duplicate of an earlier inbox issue.

| State | Trigger | Who or what fires it | Behavior at shipped defaults |
| --- | --- | --- | --- |
| Collecting (today's issue) | The UTC date changes | The clock | Awaiting review |
| Awaiting review | The digest asks and the owner answers | The digest task and the owner | Reviewed: labeled and closed |
| Awaiting review | The digest task fails or is cancelled | Nothing | Stays; the next digest reviews it |
| Awaiting review | The owner does not answer | Only the owner | The digest task stays parked. The next weekday's digest reviews the same issues and the new ones; whichever digest the owner answers first files, and the other stops when it finds `friction-inbox-reviewed` |
| Awaiting review | The digest automation is paused | Only the owner, by enabling it or running it once | Issues collect; none is lost |
| Reviewed | None | Nothing | Final |

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

Jev has no repository context beyond the supplied title and body. The
established-behavior question asks whether the report describes an existing
requirement enforced by code, tests or documentation and a bounded way to restore
or explain it. It does not ask Jev to verify the source or infer project approval.
A filename, citation or assertion that something is a bug is insufficient on its
own. The implementation worker must verify the reported requirement before acting.

The established-behavior, policy-change and verification-change questions each
carry explicit true/false criteria. Explaining an existing command or guard, or
finding the assertions for tests already required, preserves the requirement.
Introducing an obligation, exemption, threshold, permission or behavioral
guarantee changes policy even when delivered as documentation. Changing what must
pass, what may be skipped or which results count as accepted changes verification.
Missing evidence remains uncertain; it does not establish permission to act.

These reports illustrate the intended boundary for calibration:

| Report | Intended handling | Reason |
| --- | --- | --- |
| [hearsay-tools/cezarion#1337](https://github.com/hearsay-tools/cezarion/issues/1337) | Knowledge / automatic | Expose the existing counted-roster guard and command. |
| [hearsay-tools/cezarion#1350](https://github.com/hearsay-tools/cezarion/issues/1350) | Knowledge / automatic | Explain visible-text searches to locate affected, already-required browser tests. |
| [hearsay-tools/cezarion#1336](https://github.com/hearsay-tools/cezarion/issues/1336) | Design | Require duration measurements above a new time threshold. |
| [hearsay-tools/cezarion#1344](https://github.com/hearsay-tools/cezarion/issues/1344) | Design | Choose mock-edit exemptions from required park fixtures. |

These are expected outcomes, not measured Jev accuracy. Request-contract tests
verify that the criteria reach the API; real model evaluations must check the
predictions, including the other reports in the audited batch.

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
Before a paid call, an issue event's title, body, open state and friction provenance
must still match the fetched issue. Superseded events skip Jev, artifact upload and
the label-writing job; the latest eligible event handles the current report.
Manual runs deliberately classify the current issue.

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
| `friction-design` | Run `/dev-flow` on its Design Track, prefer a bounded design in chat, ask for approval in the same task, then implement and verify before a draft implementation PR |

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
none may merge or enable automation. Automatic and guarded tasks run autonomously.
The design route selects the `dev-flow` skill in an agent step and sets
`autonomous:false`, so its human design-approval gate can ask questions and pause.
Implementation routes can escalate to a design proposal whenever investigation
exposes an unresolved decision.

Design tasks explicitly select `/dev-flow`'s **Design Track**, even when a Direct
or Micro track might otherwise apply. Prefer a bounded design in chat when the
investigated remedy is small and clear: state behavior, scope, files, acceptance
criteria and verification, then request explicit human approval through
`cezar_ask`. Architectural changes follow the skill's spec-and-plan path, with
working files left untracked. Neither path opens a design-only or plan-only PR,
commits planning files, or posts a standalone Plan handoff to the issue. A missing
`dev-flow` skill is a blocker, not permission to substitute a documentation PR.

The design records current load-bearing guarantees, alternatives and trade-offs,
defaults, cost/authority boundaries, persistence/compatibility, acceptance criteria
and verification. Run-state changes include a **Transitions out** table covering
failure and no-session recovery. Automatic launch and labels never grant design
approval. The task pauses for questions and explicit approval before product
implementation; after approval, **Continue the same task** through `/dev-flow`'s
implementation, verification and draft implementation PR. The approved design
stays in the session, with the handoff maintained for resumption. Recheck
eligibility on Continue while recognizing the same task's own assignment and
claim; competing work still blocks it. Relabeling is not a new-stage handoff:
cezar's existing issue deduplication can block a second task for that issue.

The Jev action itself creates no cezar task, leaving issue deduplication available
for its selected handler. Edits or reclassifications do not launch replacement
work for an issue that already has a task.

## Where a new agent rule goes

A friction fix often adds a rule that agents must follow. First ask whether code, a
test or a script can make the rule unnecessary. If so, file that change, and write
the rule only until it lands, citing the issue that removes it.

`AGENTS.md` loads on every agent turn, so put the rule in the narrowest document that
the tasks it governs already read:

| The rule governs | Put it in |
| --- | --- |
| One code area: the runs store, worktrees, skills, real-time events and the like | That area's doc under `docs/areas/`, or a new one the Task routing row points to |
| Runners, the event protocol or the parity matrices | `AGENT_PROTOCOL.md` |
| Browser specs and the e2e environment | `packages/web/e2e/README.md` |
| CI, workflows or investigating a CI failure | `docs/sdlc/ci.md` |
| Regression proof | `docs/sdlc/regression-proof.md` |
| What a reviewer checks, and severities | `CODE_REVIEW.md` |
| Labels, claims, the QA gate or process | `SDLC.md`, or this file for friction |
| A protected public surface | `BACKWARD_COMPATIBILITY.md` |
| Work every task does, or a design rule for any mechanism change | `AGENTS.md` |

When the rule lands outside `AGENTS.md`, confirm that a pointer reaches it: a Task
routing row or a Related documents line names the document with when-to-read
wording. Add a pointer only when none fits. When the rule belongs in `AGENTS.md`,
state it once: extend the defined term it belongs to (*case table*, *reader sweep*)
rather than adding a paragraph, and keep its incident to one clause and a citation.

`.github/scripts/agents-md-budget.test.cjs` fails when `AGENTS.md` exceeds `maxBytes`
in `.github/agents-md.baseline.json`, and when it falls more than 1,024 bytes below
it, so a PR that shrinks the file also lowers the limit. Raise the limit only with
the owner's approval in that PR.

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
When updating an existing design poll, remove its `task.workflow` key (the CLI
accepts `null` to remove a task key), set its `task.steps` to the `dev-flow` agent
step, and set `task.autonomous:false`. Preview the updated filter without
`--execute`; preserve its existing enablement and backlog settings.

The same command emits the daily digest last. Create it paused too, and enable
it only after the [friction inbox](#friction-inbox) section is on `main`: its
prompt reads that section there.
