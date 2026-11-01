# Feature delivery

This path includes new features and behavior-changing fixes. Its contract is
the approved behavior and the guarantees that must survive.

## Readiness

Use `plan-issue` and `refine-scope` for product decisions, the design gate and
plan freshness. An epic plan can supply shared decisions, but each slice still
needs a current, executable handoff. A raw issue list is not an approved plan.
If a required planning skill is unavailable, name that blocker before dispatch.

For each slice, record:

- The approved plan revision, user-visible result and explicit scope limits.
- Preserved guarantees and intentional behavior changes. An existing test's
  expected outcome changes only with the named guarantee, its replacement and
  the approval that authorizes it (AGENTS.md).
- Acceptance criteria mapped to checks, including integration checks shared
  with other slices. Name who runs each check and at which phase exit.
- Interfaces, stored-state changes, dependencies and release conditions.
- Behavior on main after this slice alone, at shipped defaults. If it cannot
  work safely before another slice, change the cut or order before spawning.

Put the case tables AGENTS.md requires in the approved plan. Preserve zero
config: a default-off replacement does not preserve an existing working path.
Use the relevant ADRs and area rules for compatibility, recovery and API shape.

Done when every criterion has an evidence path, every prerequisite has a
release check, and product decisions that affect implementation are resolved.

## Worker brief

Fill this with the admitted item's facts. Use the existing implementation
workflow; the cleanup shortcut does not apply. Coordinator-owned administration
below is the campaign-specific override to that workflow.

```text
Implement <repository-qualified issue> from approved plan <path/comment and
revision>. Read <shared epic decisions> and <relevant area rules/ADRs> first.
Coordinator: <run id>. Merge authority: <owner's words, or "The owner merges">.
PR-opening gate: <coordinator release after the earlier hot-file PR merges,
or none>. When gated, request release when ready and open only after a reply.

Use implement-issue from its current approved Plan handoff. Follow its
verification, code-quality, PR-body and PR-checks rules. The coordinator owns
the issue claim, board, labels, landing and friction posts. Send required label
requests to it before the first push that needs them. Keep draft-state control
with pr-readiness.yml. Read auto-merge before opening the PR; owner-merge mode
requires owner review, and this worker leaves landing to the coordinator/owner.

Deliver: <acceptance criteria and evidence checks>.
Preserve: <existing guarantees>.
Intentional changes: <approved old-to-new behavior>.
Prerequisites accepted on main <SHA>: <release checks and results>.
Shared contracts/resources: <names and permitted changes>.
Expected regions: <files and ranges, as estimates rather than an export ban>.
Integration evidence: <checks, owner and phase exit>.

Use meaningful commits and send a progress message after each with its SHA,
scope and evidence. Request a coordinator decision before changing approved
behavior, a shared contract, acceptance criteria or a dependency. Wait for an
explicit reply; keep any independent in-scope work moving meanwhile.

Run applicable AGENTS.md validation and Reader sweep checks. Use Squeal for
covered suites, and run build, typecheck and packaged checks when required.
For a regression fix, prove the regression fails at proof_base and passes
with the fix. Record preserved guarantees when changing a test's expectation.

Report the draft PR, head, criterion-to-check results, changed contracts,
limitations and friction. Fix in-scope CI/review findings; report inherited
failures with evidence. Register a PR wait. Rebase only when the coordinator
requests it, push with --force-with-lease, then refresh affected evidence.

When checks and review are clear, report readiness at the exact head and
finish the worker with cezar_done. A settled worker can be resumed for review
or repair. Keep the branch on cez/<id8> and keep the handoff current.
```

## Review

Read every commit and compare the full diff with the approved behavior. For
each acceptance criterion, inspect the evidence and its limits. Trace shared
contracts into their consumers; use the Reader sweep for names and defaults.
Check the preserved guarantees and relevant plan case tables, including
failure, restart and absent-input cases when the mechanism needs them.

An additive feature need not fail the whole old suite: demonstrate its new
behavior at the appropriate boundary. A regression fix still needs the repo's
red/green proof. Test changes must preserve unrelated guarantees.

Done when every criterion and preserved guarantee is accounted for at the
current head, required findings are resolved, and cross-issue checks have an
assigned owner and phase exit. A deferred check may hold phase acceptance;
it cannot stand in for a required pre-merge check.
