# Separate CI model decisions from trusted mutations

Untrusted issue and PR content is input to automation, not authority to change other objects.
CI decision producers return bounded structured output. Trusted applicators validate it and
own GitHub mutations. Publishing decisions resolve repository facts from GitHub rather than
trusting an uploaded artifact’s metadata.

## Consequences

Model calls receive only their required credentials and tools. Intake choices are bounded by
the prefetched candidate set; a decision engine cannot invent another target. CodeRabbit now owns review generation and posting (2026-11-02). Trusted deterministic
admission follows cheap preflight and releases heavy verification only after exact-head
execution succeeds and all review threads resolve. A default-branch reconciler can
retry only the native review gate; a PR-context review signal grants no authority.
See [the replacement plan](../../.ai/specs/2026-11-02-coderabbit-admission-plan.md).

This separation constrains what a model or artifact can request; it does not make arbitrary
same-user shell access an isolation boundary. Keep workflow permission and timing comments
beside their declarations.

Implementation: [jev-issue-intake.cjs](../../.github/scripts/jev-issue-intake.cjs), [apply-issue-intake.cjs](../../.github/scripts/apply-issue-intake.cjs), [pr-snapshot.cjs](../../.github/scripts/pr-snapshot.cjs), [coderabbit-admission.cjs](../../.github/scripts/coderabbit-admission.cjs), [coderabbit-reconcile.yml](../../.github/workflows/coderabbit-reconcile.yml).

Coverage: [jev-issue-intake.test.cjs](../../.github/scripts/jev-issue-intake.test.cjs), [apply-issue-intake.test.cjs](../../.github/scripts/apply-issue-intake.test.cjs).
