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
| Implement | Locate the minimal change surface (`om-root-cause`, read-only), then implement the change with regression tests and affected checks. Task briefs without a ticket go through `om-auto-create-pr`, which plans and implements phase by phase in an isolated worktree. CI owns the full validation gate. | `om-root-cause` + `om-fix`, `om-auto-create-pr`, or a human author | Change complete, affected checks recorded |
| PR | Commit, push, and open a draft PR against `main` with normalized labels. On a hand-worked branch, `om-check-and-commit` fixes obvious drift and pushes with recorded affected checks; CI runs the final gate. | `om-open-pr`, `om-auto-create-pr`, or `om-check-and-commit` | Open, labeled draft PR |
| Review loop | The reviewer reads the diff against the `om-code-review` checklist and approves or requests changes. Requested changes are addressed (`om-auto-continue-pr` resumes agent PRs from the tracking plan) and the PR is re-reviewed until approved. | `om-auto-review-pr` (single PR), `om-review-prs` (sweep), or a human | Approving review submitted |
| QA | A PR carrying `needs-qa` waits for manual QA. A QA reviewer tests it and records the outcome. See the QA gate below. | QA reviewer (manual) | `qa-approved` applied, or `qa-failed` routes it back |
| Merge | `om-merge-buddy` reports, read-only, which PRs can merge now and which are close but blocked. `om-approve-merge-pr` re-checks every gate, approves, and squash-merges. Before merge queue activation, a PR may merge while behind `main` when its required checks pass and GitHub can merge. After maintainer activation, the authorized merge action enqueues the checked head; GitHub merges only after combined queue verification. Enqueued does not mean merged. See [queue rollout](docs/sdlc/ci.md#merge-queue-and-exact-commit-reuse). | `om-merge-buddy` + `om-approve-merge-pr`, or a human | PR squash-merged into `main` |
| Post-merge housekeeping | Close issues the merged PR fixes; comment on issues whose PRs were closed without merging; turn leftover asks or review comments into tracked follow-up issues. | `om-sync-merged-pr-issues`, `om-followup-issue-from-pr` | Tracker reconciled, follow-ups filed |

## Label state machine

Pipeline labels are mutually exclusive: a PR carries at most one, and it names where the PR sits in the flow.

- A ready, non-draft PR carries `review`. CI decides when a PR is ready (#603). Every new commit converts it back to draft. It is marked ready once every required check on that head is green, including `Automated Code Review`, which fails while the review has open finding threads, and once no review thread is unresolved. The linked board card follows: draft is `In progress`, ready is `In review`. See `CODE_REVIEW.md` § CI surface rules.
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

When Squeal is installed and validating the worktree, use its background results
for iteration and follow its installed skill. It covers unit Vitest, both fast
node:test groups, and packaged CLI and cockpit browser E2E in the slow tier.
Otherwise use affected test files/names and focused browser specs for changed UI
flows. Inspect `npm run test:changed -- --plan` before using `test:changed`; if
it selects the full suite, choose focused checks. An import graph cannot
establish complete runtime coverage.

**The final gate and full-suite runs belong in CI.** Do not run the complete
local gate just to finish a task, commit, open a PR, or complete a review. A full
local run is reserved for an explicit request or investigating a CI failure.
CI's final gate covers:

- `npm run typecheck`
- `npm test -- --shard=1/3 --maxWorkers=4`, then `2/3` and `3/3`
- `npm run test:unit`
- `npm run build`
- `npm run test:package`
- `npm run test:e2e`

Any non-zero exit fails the gate and blocks merge. `npm test` selects the four unit Vitest projects and remains the fast server + cockpit unit/component suite; the gate runs it as CI's three shards, because an unsharded run can be OOM-killed (exit 137) on a host with about 30 GiB free; `npm run test:unit` covers the node:test core modules and root scripts. The build includes the `check:pack` tarball gate, and `npm run test:package` builds a release tarball, installs it into an isolated consumer, and exercises the offline CLI workflow. Packaged CLI E2E (`npm run test:package`) and cockpit browser E2E (`npm run test:e2e`) are separate checks; pull request CI rejects a skipped or failed cockpit suite. The command list lives in `.ai/agentic.config.json`; when it changes, update it there and in this section together. It records the complete CI gate, not a requirement to run every command locally before opening a PR.

Reuse successful evidence for the same tested tree across commit, PR creation,
and review; those actions do not themselves require another run. Record the tested
revision (or uncommitted diff), commands or Squeal status, results, and subsequent
changes in the handoff. Later code changes require affected checks again.
Review-only or Markdown-only edits leave successful runtime evidence valid. Never
reuse failed/inconclusive evidence or count a targeted run as a full pass. CI's
independent required checks remain unchanged; check the required aggregate before
merge. The iteration command does not replace any entry in
`.ai/agentic.config.json`'s final `validation.commands` list.

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
| Infra-only | Every changed path matches the infra allowlist below | Vitest and cockpit browser E2E may skip; the required build/package aggregate and `verify` must pass, and automated review may skip |
| Mixed or full | Any other path, or any invalid/empty classifier input | All checks and automated review are required |

The exact docs-only allowlist is: root-level `*.md`; any file under `docs/`, `.ai/specs/`, or `.ai/analysis/`; `*.md` at any depth under `packages/`, except inside a `fixtures`, `__fixtures__`, or `__snapshots__` directory; the generated upstream scan data `.ai/upstream/ledger.yaml`, `.ai/upstream/LEDGER.md`, and dated `.ai/upstream/scans/YYYY-MM-DD.md` reports, optionally with a same-day suffix `-N` where N is 2 or more; `AGENTS.md`, `CODE_REVIEW.md`, or `SDLC.md`; and root-level `LICENSE*`. The `docs/`, `.ai/specs/`, and `.ai/analysis/` surfaces are recursive. Markdown that a Vitest test or cockpit browser spec reads is never docs-only: `AGENT_PROTOCOL.md` and `.ai/specs/2026-09-04-harness-parity-matrix.md` (`testReadDocuments` in `.github/scripts/change-surface.cjs`) run the full matrix. `npm run test:changed` skips exactly the same set. A missing, malformed, empty, unsafe, or failed classification fails closed to full-matrix. Build and package verification remains unconditional for every surface. The existing release-bump skip applies only to a GitHub Actions bot change on `release/v*`; it skips Vitest and cockpit browser E2E, while build-and-package and `verify` remain required. It is separate from docs-only classification.

The exact infra-only allowlist (#468) is: `.github/workflows/report-workflow-failure.yml`, `sweep-ci-failures.yml`, `upstream-scan.yml`, `npm-preview-cleanup.yml`, `publish-pr-snapshot.yml`, and `issue-intake.yml` — workflows that never run product-test suites — plus their engine scripts `.github/scripts/ci-sweep-api.cjs`, `ci-sweep-collect.cjs`, `ci-sweep-patterns.cjs`, `ci-sweep-report.cjs`, and `apply-issue-intake.cjs`, each with its `.test.cjs` sibling. The list is exact on purpose: a new or renamed file fails closed to full-matrix until deliberately added, and workflows or scripts that run or gate product suites (`ci.yml`, `release.yml`, `nightly.yml` — both execute `npm test` — `automated-code-review.yml`, `ci-benchmark.yml`, `change-surface.cjs`, `require-e2e-passed.cjs`, `ci-test-sequencer.mjs`, `automated-review.cjs`, `release-bump-pr.cjs`) must never appear — a PR that changes how product tests run or widens the skips runs the full matrix. A PR mixing docs with infra paths, or infra with product paths, is full-matrix. Infra-only keeps `build-and-package`, which still runs every `.github/scripts` test through `npm run test:unit`, so an infra-only PR that edits an allowlisted engine script still runs that script's tests.

Manual review dispatches bypass the automated-review budget and the docs-only and infra-only review skips; they judge replies without waiting for or running tests. Automated review runs inside the `ci.yml` main pull-request run after cheap preflight and before heavy verification. Findings block heavy work. **Re-run failed jobs** after a flaky test failure retains successful review and test jobs. Docs-only and infra-only PRs skip only the model round; their required build/package verification still runs. Both required checks must pass before merge.

The review-before-tests order spends automated review rounds on preflight-green
heads whose tests may later fail. Previously, only test-green heads consumed
rounds. The owner requested this order and accepted later test failures. The
unchanged cap can be exhausted earlier, so subsequent final-head changes may
receive no new model review. Final-head model review was already conditional on
the cap. Provider selection and review policy are unchanged.

## Amending this process

This document and `.ai/agentic.config.json` describe the same process: change them together, and re-run the `om-setup-agent-pipeline` skill when the toolchain or label taxonomy changes. Per-skill deviations — extra review rules, a different PR body template, an added gate step — belong in a repo-local skill of the same name at `.ai/skills/<skill-name>/SKILL.md`, which takes precedence over the installed skill (and can `@`-import or reference it to extend rather than replace it); local rules win, but a repo-local skill cannot grant what the installed skill's safety rules forbid.
