# Software delivery process

## Purpose

Work starts with a task brief or a GitHub issue. The brief or issue defines the
requested outcome and scope. Changes go through affected checks, diff review and
the merge gates below. PRs target `main` in `hearsay-tools/cezarion`.

The current delivery bindings are in [AGENTS.md](AGENTS.md#dev-flow-bindings).
[Campaign](.ai/skills/campaign/SKILL.md) owns campaign coordination;
[land-pr](.ai/skills/land-pr/SKILL.md) owns the landing checks.

## Delivery

- Check current `main`, existing claims and open PRs before starting. Stop or
  coordinate with the existing owner when the work is already covered.
- Keep the change within its accepted scope. Resolve open product decisions
  before implementing the affected behavior. Follow the applicable planning,
  preserved-behavior and regression-proof rules in [AGENTS.md](AGENTS.md).
- Implement in an isolated worktree. Record affected checks and regression
  evidence. Open a draft PR with the scope and verification results.
- Review the actual diff against [CODE_REVIEW.md](CODE_REVIEW.md). Resolve
  findings and record the reviewed head. Recheck changed behavior after fixes;
  compare the patch and check compatibility with the base after a rebase.
- Honor the QA gate and merge authority below. Required checks must pass on the
  current head. Queue admission is not a merge; observe GitHub's merged state.
- Reconcile completed issues after merge. Use closing references only for scope
  the PR completes. Keep partial work open and identify its remaining owner.

For campaigns, the coordinator owns claims, board work, dependency order, diff
review and integrated acceptance. Workers follow their assigned brief and return
an in-scope change with evidence. The campaign skill holds the coordination and
resource-cleanup steps. Record friction through [the friction inbox](docs/sdlc/friction.md#friction-inbox).

## Labels and readiness

GitHub's draft state, checks, review threads and queue membership show PR state.
For same-repository PRs into `main`, [pr-readiness.yml](.github/workflows/pr-readiness.yml)
returns each new head to draft. It marks that head ready only when its required
checks pass and no review thread remains unresolved. It syncs existing PR and
closing-linked issue cards: draft is `In progress`, ready is `In review`. Let the
workflow make those changes; do not run `gh pr ready` or move cards to `In review`
by hand. The [board binding](AGENTS.md#dev-flow-bindings) holds the details.

Readiness uses fresh evidence from the current head for every event, including
human draft or ready changes. CodeRabbit reviews drafts and incremental pushes
automatically, without a label filter or auto-pause. After preflight, the native
`Automated Code Review` gate requires successful current-head execution from the
trusted CodeRabbit App and resolved review threads before heavy verification.
Readiness and queue admission also read that evidence. An authenticated no-files
skip remains blocked while trusted recovery can request one full review per PR
and head, using the existing release App when available. Recovery claims and
commands never grant admission. After manually reopening
or resolving a thread, dispatch **Reconcile CodeRabbit admission** with
`pr_number`, then **PR Readiness** if draft state needs refreshing. Manual thread
changes do not emit a workflow event. Fork PRs retain their author's draft state
and need a maintainer's native review-job rerun. See
[CI review policy](CODE_REVIEW.md#ci-surface-rules) for recovery and exceptions.

Labels still carry routing, ownership and human stops. The tracker adapter keeps
its [label guards](.ai/trackers/github.md#label-guards) and the configured groups
in [.ai/agentic.config.json](.ai/agentic.config.json). A `merge-queue` label does
not establish GitHub queue membership or QA approval.

| Group | Labels | Meaning |
| --- | --- | --- |
| Category | `bug`, `feature`, `refactor`, `security`, `dependencies`, `documentation` | Additive descriptions of the change |
| Area | `area-cezar`, `area-web`, `area-contract`, `area-api-client`, `area-ci`, `area-docs` | At most one per issue; service/CLI, cockpit, contract, client, CI or docs |
| Priority | `priority-low`, `priority-medium`, `priority-high`, `priority-extreme` | Urgency; unset means medium |
| Risk | `risk-low`, `risk-medium`, `risk-high` | Blast radius; unset means medium |

A PR inherits priority and risk from its source issue unless its scope changes.
High risk calls for deeper review and strengthens the case for `needs-qa`.
`blocked` and `do-not-merge` are human-controlled hard stops. `do-not-close` protects
an issue from automatic closure; agents only read it.

## The QA gate

**A PR carrying `needs-qa` must not merge until it also carries `qa-approved`,
even when every other check is green.** The landing workflow must check this
policy; green CI or queue admission does not replace QA approval.

- Apply `needs-qa` to cockpit UI changes, new features and other user-facing
  behavior that needs manual exercise.
- `skip-qa` is the explicit opt-out for docs-only, dependency-only, CI-only and
  similarly low-risk non-user-facing changes. Never combine it with `needs-qa`.
- `qa-failed`, `do-not-merge` and `blocked` prevent merge. An active `qa` label
  means testing is in progress; do not merge while that testing continues.
- The person who tests the PR exercises the affected flow and records the result
  before applying `qa-approved`. Honor any explicit owner QA approval requirement.
- If no separate QA reviewer has capacity in time, an engineer may use the
  self-QA exception: check out and run the PR, exercise the affected flow, and
  attach a screenshot or a written account of the actions and observed result
  to the PR. Apply both `qa-approved` and `qa-self-verified`. No evidence, no
  `qa-approved`.

## The claim protocol

Respect existing ownership before changing an issue or PR. The
[tracker claim conventions](.ai/trackers/github.md#conventions) define the assignee,
`in-progress` label and claim comment. For a campaign, its coordinator owns those
operations. Release the claim on success or failure. A maintainer may clear a
stale `in-progress` claim with no recent activity. Do not merge a PR with an
active `in-progress` claim.

## Validation gate

Use affected local checks. When Squeal validates the worktree, use its background
results and follow its installed skill. The repo's
[validation skill](.ai/skills/validation/SKILL.md) owns test selection, Squeal
waits, browser checks and packaged CLI checks.

**The final gate and full-suite runs belong in CI.** Do not run the complete
local gate just to finish a task, commit, open a PR or complete a review. A full
local run is reserved for an explicit request or investigating a CI failure.
The [CI guide](docs/sdlc/ci.md) and [workflow](.github/workflows/ci.yml) describe
the required checks; [.ai/agentic.config.json](.ai/agentic.config.json) records
the final command list. The [change classifier](.github/scripts/change-surface.cjs)
owns the exact docs and infrastructure allowlists. A permitted skip is not a
full test pass. Required verification failures block merge.

Reuse successful evidence for the same tested tree across commit, PR creation
and review. Record the revision or diff, commands or Squeal status, results and
later changes in the handoff. Later code changes need affected checks again.
Markdown-only or review-only edits leave successful runtime evidence valid.
Never reuse failed or inconclusive evidence or count a targeted run as a full
pass. CI's independent required checks still apply to the current head.

## Merge authority

The owner merges unless the task grants explicit merge permission or the PR
qualifies under [auto-merge](.ai/skills/auto-merge/SKILL.md). Read that skill before
opening a PR into `main`. An owner-review request keeps the owner gate.

[land-pr](.ai/skills/land-pr/SKILL.md) checks approved scope, the reviewed head,
dependencies, current-head CI and review, QA, owner approvals and main CI before
landing. The active merge queue verifies the combined candidate before it merges.
Observe the merge result, then verify integrated acceptance; a closed issue alone
does not prove the outcome. The [CI guide](docs/sdlc/ci.md#merge-queue-and-exact-commit-reuse)
holds queue mechanics.

## Amending this process

The maintainer owns branch protection, labels, configuration and this document,
and resolves conflicts between gates. Keep changes consistent with the current
bindings and the source owners linked above. Tracker operations remain defined
in [.ai/trackers/github.md](.ai/trackers/github.md).
