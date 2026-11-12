# Separate CI model decisions from trusted mutations

Untrusted issue and PR content is input to automation, not authority to change other objects.
CI decision producers return bounded structured output. Trusted applicators validate it and
own GitHub mutations. The `claude` intake provider is an exception: it can close or edit the
triggering issue itself, with tools scoped to that issue number. Publishing decisions resolve repository facts from GitHub rather than
trusting an uploaded artifact’s metadata.

## Consequences

Model calls receive only their required credentials and tools. Intake choices are bounded by
the prefetched candidate set; a decision engine cannot invent another target. CodeRabbit now owns review generation and posting (2026-11-02). Trusted deterministic
admission follows cheap preflight and passes only after the
newest trusted exact-head check reports success or skipped with exact title
`No files to review`, and all review threads resolve (owner policy, 2026-11-03).
Verified release version-stamp PRs and app upstream-scan ledger PRs need no provider check
(`verifiedException`); open threads still block them. Merge-queue admission also refuses
drafts. Once a PR has had a ready-for-review event, the queue needs a provider review that
started after the first such event, or waits out a 180-second settle window
(`POST_READY_SETTLE_MS`, 2026-11-09, hearsay-tools/cezarion#3066). The verified exceptions
and no-files PRs skip that wait.
Heavy verification runs beside typecheck, preflight and admission once its skip inputs
are ready. The `verify` aggregate requires all of them (2026-11-12,
hearsay-tools/cezarion#3342, replacing the preflight ordering of hearsay-tools/cezarion#2727).
The named skip is a provider decision, not proof of model execution. A default-branch reconciler can
retry only the native review gate; a PR-context review signal grants no authority.
Only the new admission marker permits promotion. A green historical execution-only
CodeRabbit job supports revocation after a fresh validated rejection shared by both
policies. A failed historical job requires a fresh native run, so no-files admission
cannot create a retry loop. Reusable model workflows are never rerun.
See [the replacement plan](../../.ai/specs/2026-11-02-coderabbit-admission-plan.md)
and [the no-files policy](../../.ai/specs/2026-11-03-coderabbit-skipped-recovery-plan.md).

This separation constrains what a model or artifact can request; it does not make arbitrary
same-user shell access an isolation boundary. Keep workflow permission and timing comments
beside their declarations.

Implementation: [jev-issue-intake.cjs](../../.github/scripts/jev-issue-intake.cjs), [apply-issue-intake.cjs](../../.github/scripts/apply-issue-intake.cjs), [pr-snapshot.cjs](../../.github/scripts/pr-snapshot.cjs), [coderabbit-admission.cjs](../../.github/scripts/coderabbit-admission.cjs), [queue-coderabbit-admission.cjs](../../.github/scripts/queue-coderabbit-admission.cjs), [issue-intake.yml](../../.github/workflows/issue-intake.yml), [coderabbit-reconcile.yml](../../.github/workflows/coderabbit-reconcile.yml).

Coverage: [jev-issue-intake.test.cjs](../../.github/scripts/jev-issue-intake.test.cjs), [apply-issue-intake.test.cjs](../../.github/scripts/apply-issue-intake.test.cjs).
