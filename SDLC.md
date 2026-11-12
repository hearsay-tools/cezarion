# Software delivery process

This file holds the labels, claims, QA gate and merge rules for
`hearsay-tools/cezarion`. Each rule here is true today and an agent can follow
it. Add a rule only when its absence causes a real failure.

## Labels

Issue intake labels each new issue with a type and an area when it is
confident. Apply only a label that
`gh label list -R hearsay-tools/squawk --limit 1000` shows. Do not create a label;
the maintainer owns the label set.

## The QA gate

**A PR that carries `needs-qa` must not merge until it also carries
`qa-approved`, even when every other check is green.** Green CI, queue
admission and a merge grant do not replace QA approval.

- Apply `needs-qa` to cockpit UI changes, new features and other user-facing
  behavior that needs manual exercise.
- `skip-qa` is the explicit opt-out for docs-only, dependency-only, CI-only and
  similar low-risk changes that users do not see. Never combine it with
  `needs-qa`.
- The person who tests the PR exercises the affected flow and records the result
  before they apply `qa-approved`. Honor any explicit owner QA approval
  requirement.
- If no separate QA reviewer has capacity in time, an engineer may use the
  self-QA exception: check out and run the PR, exercise the affected flow, and
  attach a screenshot or a written account of the actions and observed result
  to the PR. Apply both `qa-approved` and `qa-self-verified`. No evidence, no
  `qa-approved`.

## The claim protocol

Respect existing ownership before you change an issue or PR. The
[tracker claim conventions](.ai/trackers/github.md#conventions) define the
assignee, the `in-progress` label and the claim comment. In a campaign, the
coordinator owns those operations. Release the claim on success or failure. A
maintainer may clear a stale `in-progress` claim with no recent activity. Do not
merge a PR with an active `in-progress` claim.

## Merge authority

The owner merges unless the task grants explicit merge permission or the PR
qualifies under [auto-merge](.ai/skills/auto-merge/SKILL.md). Read that skill
before you open a PR into `main`. An owner-review request keeps the owner gate.

[land-pr](.ai/skills/land-pr/SKILL.md) checks approved scope, the reviewed head,
dependencies, current-head CI and review, QA, owner approvals and main CI before
landing. Every required check must pass on the current head. Queue admission is
not a merge: observe GitHub's merged state, then verify the integrated result.
A closed issue alone does not prove the outcome. The
[CI guide](docs/sdlc/ci.md#merge-queue-and-exact-commit-reuse) holds the queue
mechanics.
