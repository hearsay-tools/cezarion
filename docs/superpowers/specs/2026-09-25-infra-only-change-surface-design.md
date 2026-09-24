# Infra-Only Change-Surface Policy

Status: approved in chat · Date: 2026-09-25 · Issue: #468

## Context

#356 / #361 classify docs-only PRs to skip Vitest, cockpit browser E2E, and
automated review while `build-and-package` and the required `verify` aggregate
stay green. That policy deliberately sent every `.github/**` change to the full
matrix (#356 constraint #4: "Changing CI itself is not a skip"). The overshoot
is waste, not safety: a one-line runner swap in `release.yml` (#467) cannot
regress a product suite yet still schedules two Vitest shards and four cockpit
E2E shards. `SDLC.md` already treats CI-only changes as `skip-qa` candidates;
the CI job graph now gains the counterpart surface.

## Policy

Classification still uses the pull request file list, never labels. A PR is
`infra-only` only when the list is non-empty, every entry is a valid path, and
every path is one of:

- `.github/workflows/release.yml`, `nightly.yml`,
  `report-workflow-failure.yml`, `sweep-ci-failures.yml`,
  `upstream-scan.yml`, `npm-preview-cleanup.yml`, `publish-pr-snapshot.yml`,
  or `issue-intake.yml` — workflows that never run product-test suites;
- `.github/scripts/ci-sweep-api.cjs`, `ci-sweep-collect.cjs`,
  `ci-sweep-patterns.cjs`, `ci-sweep-report.cjs`, or `apply-issue-intake.cjs`,
  each with its `.test.cjs` sibling — the engines of the allowlisted
  workflows above.

Anything else under `.github/**` stays full-matrix: `ci.yml`,
`automated-code-review.yml`, `recover-automated-review.yml`,
`ci-benchmark.yml`, every harness script (`change-surface.cjs`,
`require-e2e-passed.cjs`, `ci-test-sequencer.mjs`, `automated-review.cjs`,
`release-bump-pr.cjs`, and the `*.workflow.test.cjs` pins), application and
package code, lockfiles, and any path not named above — a new or renamed file
fails closed to the full matrix until deliberately listed. A PR mixing docs
with infra paths, or infra with product paths, is full-matrix: each skip
surface stays pure.

The policy matrix gains one row:

| Surface | Build/package | Vitest | Cockpit E2E | Automated review |
| --- | --- | --- | --- | --- |
| Docs/process only | Run | Skip | Skip | Skip |
| Infra-only (this policy) | Run | Skip | Skip | Skip |
| Bot `release/v*` bump | Run | Skip | Skip | Existing bot guard |
| Same three-dot patch-id | n/a | n/a | n/a | Existing skip |
| Full, mixed, or unknown | Run | Run | Run | Run |

Infra-only keeps `build-and-package` for two reasons: it is the cheap honesty
behind `verify`, and it still runs `npm run test:unit`, which executes every
`.github/scripts/*.test.cjs` suite — so an infra-only PR that edits an
allowlisted engine script still runs that script's own tests. Vitest (the
packages' suites) and cockpit browser E2E cannot observe a `.github/**`-only
diff and are skipped.

## Architecture

`change-surface.cjs` gains the third classification alongside docs-only.
`classifyPaths` validates structure first, then requires every path to match
the docs allowlist (docs-only) or every path to match the infra allowlist
(infra-only); any other combination is full-matrix. The command interface and
fail-closed JSON-lines parsing are unchanged.

`ci.yml` accepts `infra-only` in the classification case arm; unknown values
still coerce to full-matrix. `vitest` and `cockpit-browser` keep their
`surface == 'full-matrix'` conditions — the case arm already guarantees the
output is one of the three values, so infra-only skips both exactly like
docs-only. `verify` accepts `skipped` Vitest and cockpit E2E when the surface
is docs-only, infra-only, or the verified bot bump predicate applies;
`build-and-package` success is required for every surface.

`automated-code-review.yml` accepts `infra-only` in both case arms and sets
`can_review=false` for it, mirroring docs-only: the wait, provider, and
posting jobs skip while `review-complete` finishes successfully. Recovery
remains limited to failed review runs blocked at `wait-for-ci`; an infra-only
review has `review-complete` success and a skipped wait, so it cannot qualify.

## Error handling and trust

Nothing changes in the trust model: classification runs from the trusted base
revision under `pull_request_target`; a PR cannot rewrite the classifier that
gates it. A PR that widens the skip surface — `change-surface.cjs`, `ci.yml`,
the review workflow, or any harness script — is itself full-matrix, so it runs
and reviews the suites it affects (issue constraint #5). Pushes and manual
dispatches bypass file-list classification and run the full matrix. No label,
environment flag, or workflow-level `paths:` filter is introduced.

## Verification

- Classifier unit tests: infra-only happy paths (single workflow; workflow +
  engine script + its test), harness and unnamed `.github` paths →
  full-matrix, docs+infra and infra+product mixes → full-matrix, docs-only
  behavior unchanged, CLI emits exactly one of the three values, malformed
  input fail-closed unchanged.
- CI workflow tests pin the new case arm, the verify gate's accepted
  skip-surfaces, and scenario rows for infra-only skipped tests.
- Automated-review workflow tests pin the infra-only `can_review=false` path
  next to the docs-only one.
- `SDLC.md` and `CODE_REVIEW.md` document the surface next to docs-only.
