# CI and Review Change-Surface Policy

Status: approved in chat · Date: 2026-09-16 · Issue: #356

## Context

Every pull request currently runs the Vitest shards, cockpit browser E2E
shards, packaged build gate, and automated review. Documentation and process
changes do not need the product-test matrix, but the required `verify` check
must continue to report a result. The policy must also preserve the existing
release-bump and unchanged-patch review skips.

## Policy

Classification uses the pull request file list, never labels. A PR is
`docs-only` only when the list is non-empty, every entry is a valid path, and
every path matches one of these surfaces:

- a root-level `*.md` file;
- `docs/**`;
- `.ai/specs/**` or `.ai/analysis/**`;
- `CODE_REVIEW.md`, `SDLC.md`, `AGENTS.md`, `BACKWARD_COMPATIBILITY.md`,
  `AGENT_PROTOCOL.md`, or `CHANGELOG.md`;
- a root-level `LICENSE*` file.

An absent, empty, malformed, mixed, or otherwise unmatched list is
`full-matrix`. Any `.github/**`, application, package, lockfile, script, or
configuration change is therefore full-matrix. The existing bot
`release/v*` predicate remains an additional reason to skip Vitest and
cockpit E2E; it does not broaden the docs allowlist.

The policy matrix is:

| Surface | Build/package | Vitest | Cockpit E2E | Automated review |
| --- | --- | --- | --- | --- |
| Docs/process only | Run | Skip | Skip | Skip |
| Bot `release/v*` bump | Run | Skip | Skip | Existing bot guard |
| Same three-dot patch-id | n/a | n/a | n/a | Existing skip |
| Full, mixed, or unknown | Run | Run | Run | Run |

## Architecture

`.github/scripts/change-surface.cjs` owns the path matching and exposes a
small pure classifier plus a line-oriented command interface for workflows.
The command interface consumes one JSON-encoded filename per line, so a
malformed API response fails closed instead of becoming an empty docs list.

The CI workflow adds a trusted classification job for pull requests. It checks
out the base revision of the workflow support files, reads the PR file list
through the GitHub API, and publishes the classification as a job output.
`vitest` and `cockpit-browser` use job-level conditions based on that output
and the existing bump predicate. `build-and-package` remains unconditional.
The workflow does not use a top-level `paths` filter.

`verify` remains unconditional with `if: always()`. It always requires
`build-and-package` to succeed. It accepts `success` or `skipped` for Vitest
and cockpit E2E only when the classifier says docs-only or the existing bot
bump predicate applies. Every other surface requires success. `publish-snapshot`
continues to depend on `verify` without a policy change.

The automated review workflow classifies the PR in its trusted `review-round`
job. Docs-only sets `can_review=false`, which skips the wait, provider model,
and posting jobs while allowing `review-complete` to finish successfully.
The round cap and three-dot patch-id logic remain unchanged for full-matrix
PRs. Manual dispatch remains a full review path and bypasses both skip rules.

Recovery remains limited to a failed review run blocked at `wait-for-ci`.
A docs-only review has `review-complete` success and a skipped wait, so it
cannot qualify for recovery. Tests will pin this distinction so future review
workflow changes do not turn an intentional skip into a retry loop.

## Error handling and trust

Only the trusted base revision's classifier is executed for PR classification.
The file list is fetched from GitHub metadata and passed as JSON lines; any
invalid line, invalid path, empty input, or API failure produces the full
classification. Classification failure never greens the required aggregate.
Pushes to branches and manual dispatches bypass file-list classification and
run the full matrix. No environment flag or user label controls the result.

## Verification

- Unit tests cover docs-only paths, mixed docs and code, empty and malformed
  lists, `.github/**`, and bot release-bump precedence.
- CI workflow tests cover trusted classification, job-level conditions,
  fail-closed aggregate behavior, and the absence of workflow-level path
  filters.
- Automated-review workflow tests cover docs-only skip, full-matrix review,
  manual dispatch, and the unchanged recovery contract.
- `SDLC.md` records the matrix and allowed skipped checks. `CODE_REVIEW.md`
  states that a docs/process-only PR may have skipped Vitest and cockpit E2E
  while its required build/package aggregate remains green.
