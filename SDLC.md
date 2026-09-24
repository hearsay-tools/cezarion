# Software delivery process

## Purpose

This file documents how work flows from ticket to merged PR in this repository. The agent skills configured in `.ai/agentic.config.json` enforce the process; humans read it here. PRs target `main`; issues and PRs live in GitHub (via the `gh` CLI), with every tracker operation the skills run defined in `.ai/trackers/github.md` (edit that file to extend or override tracker behavior).

Work enters through two paths: a free-form task brief handed to an agent, or a filed ticket. Both converge on the same review loop, the same validation gate, and the same merge gates.

## Roles

- **Author** — the human or agent who writes the change. Owns the ticket from claim to a merge-ready PR.
- **Reviewer** — reads the diff and approves or requests changes. May be a human or the `om-auto-review-pr` skill; the `om-code-review` checklist applies either way.
- **QA reviewer** — manually exercises user-facing changes before they merge. Always referenced by role, never by name or handle: assignments change.
- **Maintainer** — owns branch protection, the label taxonomy, the config, and this document; arbitrates when gates conflict.

## Ticket lifecycle

| Stage | What happens | Driven by | Done when |
|---|---|---|---|
| Intake | A ticket or task brief is filed in GitHub with enough detail to act on. | Anyone | Ticket exists |
| Triage | Confirm the issue is real, still unfixed on `main`, and not already claimed or covered by an open PR. Read-only; stops the chain cleanly when there is nothing to do. | `om-verify-in-repo` or a human | Confirmed actionable, or closed as no-action |
| Claim | The author claims the ticket so concurrent agents back off. See the claim protocol below. | `om-fix` / `om-auto-create-pr`, or a human | Claim visible on the ticket |
| Implement | Locate the minimal change surface (`om-root-cause`, read-only), then implement the change with regression tests and run the validation gate. Task briefs without a ticket go through `om-auto-create-pr`, which plans, implements phase by phase in an isolated worktree, and runs the same gate. | `om-root-cause` + `om-fix`, `om-auto-create-pr`, or a human author | Change complete, validation gate green |
| PR | Commit, push, and open a PR against `main` with normalized labels. On a hand-worked branch, `om-check-and-commit` runs the gate, fixes obvious drift, and pushes when green. | `om-open-pr`, `om-auto-create-pr`, or `om-check-and-commit` | Open, labeled PR |
| Review loop | The reviewer reads the diff against the `om-code-review` checklist and approves or requests changes. Requested changes are addressed (`om-auto-continue-pr` resumes agent PRs from the tracking plan) and the PR is re-reviewed until approved. | `om-auto-review-pr` (single PR), `om-review-prs` (sweep), or a human | Approving review submitted |
| QA | A PR carrying `needs-qa` waits for manual QA. A QA reviewer tests it and records the outcome. See the QA gate below. | QA reviewer (manual) | `qa-approved` applied, or `qa-failed` routes it back |
| Merge | `om-merge-buddy` reports, read-only, which PRs can merge now and which are close but blocked. `om-approve-merge-pr` re-checks every gate, approves, and squash-merges. A PR may merge while behind `main` as long as its required check is green and GitHub can merge. | `om-merge-buddy` + `om-approve-merge-pr`, or a human | PR squash-merged into `main` |
| Post-merge housekeeping | Close issues the merged PR fixes; comment on issues whose PRs were closed without merging; turn leftover asks or review comments into tracked follow-up issues. | `om-sync-merged-pr-issues`, `om-followup-issue-from-pr` | Tracker reconciled, follow-ups filed |

## Label state machine

Pipeline labels are mutually exclusive: a PR carries at most one, and it names where the PR sits in the flow.

- A ready, non-draft PR carries `review`.
- The reviewer moves it: request changes → `changes-requested`; after fixes it returns to `review`; approval → `merge-queue`.
- `merge-queue` is routing, not proof of QA: a `needs-qa` PR legitimately sits there until QA signs off.
- Only a QA reviewer sets the `qa` pipeline label. They move a queued `needs-qa` PR from `merge-queue` to `qa` while testing, then back to `merge-queue` with `qa-approved` on pass, or to `qa-failed` on failure. Automated skills request QA with `needs-qa`; they never set `qa`.
- `blocked` and `do-not-merge` are set and cleared by humans and stop the flow wherever it is.

| Group | Labels | Exclusivity | Meaning |
|---|---|---|---|
| Pipeline | `review`, `changes-requested`, `qa`, `qa-failed`, `merge-queue`, `blocked`, `do-not-merge` | one at a time | Workflow state |
| Category | `bug`, `feature`, `refactor`, `security`, `dependencies`, `documentation` | additive | Kind of change |
| Area | `area-cezar`, `area-web`, `area-contract`, `area-api-client`, `area-ci`, `area-docs` | one at a time | Which part of the system an issue touches |
| Meta | `needs-qa`, `skip-qa`, `qa-approved`, `qa-self-verified`, `in-progress` | additive | Process signals |
| Priority | `priority-low`, `priority-medium`, `priority-high`, `priority-extreme` | one at a time; unset = medium | Urgency of the work |
| Risk | `risk-low`, `risk-medium`, `risk-high` | one at a time; unset = medium | Blast radius of the change |

An issue carries at most one area label, named for the part of this monorepo it touches:

- `area-cezar` — service, CLI, runners, workflows, and workspace state (`packages/cezar`)
- `area-web` — cockpit SPA (`packages/web`)
- `area-contract` — HTTP contract schemas (`packages/contract`)
- `area-api-client` — typed API client (`packages/api-client`)
- `area-ci` — GitHub Actions, release, and packaging
- `area-docs` — documentation, specs, and process files

Priority is how urgent the work is; risk is how dangerous the change is to ship. A one-line fix for a broken cockpit can be `priority-extreme` and `risk-low`; a large runner-seam refactor that can wait can be `priority-low` and `risk-high`. A PR inherits both from its source issue unless the scope clearly changed. When an automated skill adds or changes a pipeline or meta label, it leaves a short comment explaining why.

When no priority label is set, infer one:

- `priority-extreme` — the published CLI is broken for users (`npx cezarion` fails), data loss in `.ai/cezar/`, or an active security incident.
- `priority-high` — security hardening or a release-blocking regression.
- `priority-medium` — ordinary bug fixes and net-new features (also the default reading of unset).
- `priority-low` — cosmetic, docs-only, dependency bumps, follow-up cleanup.

When no risk label is set, infer one:

- `risk-high` — the runner seam (`packages/cezar/src/core/agent-runner.ts`), worktree/branch handling, the `.ai/cezar/` state file formats, the HTTP API surface, or broad cross-cutting edits.
- `risk-medium` — an ordinary single-area change (also the default reading of unset).
- `risk-low` — docs-only, typo, or isolated cosmetic changes.

When signals conflict, pick the higher label and say why in the label comment. A `risk-high` PR strengthens the case for `needs-qa` and deeper review even when it would otherwise look routine.

One label lives outside this taxonomy: `do-not-close`, applied by humans to issues that housekeeping skills must never auto-close. Skills only ever read it.

## The QA gate

The one hard rule of this process: **a PR carrying `needs-qa` must not merge until it also carries `qa-approved`, even when every other check is green.** `om-merge-buddy` classifies such a PR as blocked; `om-approve-merge-pr` refuses to merge it.

- Apply `needs-qa` to cockpit UI changes, new features, and other user-facing behavior that needs manual exercise (a `CEZ_DRY_RUN=1` session covers most cockpit flows without a real `claude` login).
- `skip-qa` is the explicit opt-out for docs-only, dependency-only, CI-only, and similarly low-risk non-user-facing changes. Never combine it with `needs-qa`.
- `qa-failed`, `do-not-merge`, and `blocked` are hard blocks regardless of every other signal. An active `qa` pipeline label means a tester is on the PR right now — never merge under an active tester.
- The gate is satisfied when a QA reviewer tests the PR and applies `qa-approved`.
- **Self-QA exception**: when no QA reviewer has capacity in time, any engineer may sign off instead — but only by (1) checking the PR out and running it locally, (2) exercising the affected flow, and (3) attaching evidence to the PR: a screenshot of it working, or a written account of what was exercised and the observed result. Then apply both `qa-approved` (so the gate passes) and `qa-self-verified` (so the exception is auditable). No evidence, no `qa-approved`.

## The claim protocol

Before mutating an issue or PR, an agent claims it with all three signals: it assigns itself, adds the `in-progress` label, and posts a claim comment saying what it is doing. Any agent that finds an existing claim backs off instead of colliding. A PR carrying `in-progress` is also skipped by the merge tooling.

The claim is released when the work finishes — on success and on failure alike. A stale `in-progress` with no recent activity may be cleared by the maintainer.

## Validation gate

During implementation, use affected test files/names or `npm run test:changed`,
and focused browser specs for changed UI flows. Do not repeat all suites for each
edit or review round. `test:changed` is iteration feedback only; an import graph
cannot establish complete runtime coverage.

Run the full gate once when implementation stabilizes, before committing/opening
the PR and before review sign-off, in this order:

- `npm run typecheck`
- `npm test`
- `npm run test:unit`
- `npm run build`
- `npm run test:package`
- `npm run test:e2e`

Any non-zero exit fails the gate and blocks the PR. `npm test` is the fast server + cockpit unit/component suite (vitest) and `npm run test:unit` the node:test core-module suite; the build includes the `check:pack` tarball gate, and `npm run test:package` builds a release tarball, installs it into an isolated consumer, and exercises the offline CLI workflow. Packaged CLI E2E (`npm run test:package`) and cockpit browser E2E (`npm run test:e2e`) are separate checks; pull request CI rejects a skipped or failed cockpit suite. The implementing skills run the configured gate before opening a PR, and `om-check-and-commit` runs it before pushing a hand-worked branch. The command list lives in `.ai/agentic.config.json`; when it changes, update it there and in this section together.

Reuse successful evidence for the same tested tree across commit, PR creation,
and review; those actions do not themselves require another run. Record the tested
revision (or uncommitted diff), commands/results, and subsequent changes in the
handoff. Later code changes invalidate affected gates. Shared configuration,
dependency or contract changes, or uncertain impact invalidate the full gate.
Review-only or Markdown-only edits leave successful runtime evidence valid. Never
reuse failed/inconclusive evidence or count a targeted run as a full pass. CI's
independent required checks remain unchanged. The iteration command does not
replace any entry in `.ai/agentic.config.json`'s final `validation.commands` list.

### PR change surface

`pull_request_target` is the sole PR verification trigger for `main` and
`develop`. One concurrency group per PR cancels superseded runs; the required
aggregate still rejects failed or cancelled verification jobs. Review polling
and recovery select the newest target run for the current head, including a
failed or cancelled run; legacy PR runs are a fallback only when no target run
exists. Push and manual CI remain available.

PR snapshots are prepared without publishing credentials after verification.
The separate `Publish PR Snapshot` completion workflow validates the source
run, current same-repository PR head, attempt artifact, and package metadata.
It publishes archives from trusted code with lifecycle scripts disabled.

Migration: the introducing PR removes its `pull_request` trigger while the
installed target workflow continues verifying it. The new artifact publisher
starts after the workflows land on the default branch; old attempts lacking
snapshot archives are ineligible. A base branch must contain the target trigger
before PRs drop the legacy event. At the #371 migration, `main` already did;
`develop` did not exist remotely. Any future `develop` branch must be created
from a revision with these workflows before accepting PRs.

Pull-request CI runs from the trusted `pull_request_target` workflow definition, checks out the PR merge ref only inside the jobs that execute PR code, and classifies the changed paths before selecting checks:

| Surface | Paths | Checks and review |
|---|---|---|
| Docs-only | Every changed path matches the allowlist below | Vitest and cockpit browser E2E may skip; the required build/package aggregate and `verify` must pass, and automated review may skip |
| Mixed or full | Any other path, or any invalid/empty classifier input | All checks and automated review are required |

The exact docs-only allowlist is: root-level `*.md`; any file under `docs/`, `.ai/specs/`, or `.ai/analysis/`; `AGENT_PROTOCOL.md`, `AGENTS.md`, `BACKWARD_COMPATIBILITY.md`, `CODE_REVIEW.md`, or `SDLC.md`; and root-level `LICENSE*`. The `docs/` and `.ai/` surfaces are recursive. A missing, malformed, empty, unsafe, or failed classification fails closed to full-matrix. Build and package verification remains unconditional for every surface. The existing release-bump skip applies only to a GitHub Actions bot change on `release/v*`; it skips Vitest and cockpit browser E2E, while build-and-package and `verify` remain required. It is separate from docs-only classification.

Manual review dispatches bypass the automated-review budget and the docs-only review skip; they run the full matrix. Recovery is limited to a failed automated-review run blocked at a failed `wait-for-ci` after CI had succeeded. Docs-only `review-complete` succeeds with `wait-for-ci` skipped and cannot qualify for recovery. Recovery does not reclassify a PR, recover a skipped check, or dispatch a new review.

## Amending this process

This document and `.ai/agentic.config.json` describe the same process: change them together, and re-run the `om-setup-agent-pipeline` skill when the toolchain or label taxonomy changes. Per-skill deviations — extra review rules, a different PR body template, an added gate step — belong in a repo-local skill of the same name at `.ai/skills/<skill-name>/SKILL.md`, which takes precedence over the installed skill (and can `@`-import or reference it to extend rather than replace it); local rules win, but a repo-local skill cannot grant what the installed skill's safety rules forbid.
