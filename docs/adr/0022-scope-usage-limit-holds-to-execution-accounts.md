# Scope usage-limit holds to the executing account

A provider limit closes an account, not just one task. Derive holds from durable records
and share them through the workspace semaphore. Resolve the executing step or continuation
account before using the run-level fallback, so mixed-runner workflows do not block the
wrong provider or login.

## Consequences

A future reset deadline blocks fresh work and resumes on that account. An in-flight resume
blocks fresh work but permits other resumes, avoiding a mutual hold with no future wake.
Reconcile timers from records on pump and recovery; disabling automatic resume retires durable
appointments too. Expired, archived or spent appointments must not become permanent holds.

A watchdog repairs queued records missing their process-local jobs. It only challenges an idle
queue when no running work or real future appointment explains the pause, then uses ordinary
capacity rules. It is a fallback for lost wakeups, not a second scheduler.

Implementation: [execution-account.ts](../../packages/cezar/src/workflows/execution-account.ts), [run.ts](../../packages/cezar/src/workflows/run.ts), [semaphore.ts](../../packages/cezar/src/workspace/semaphore.ts).

Coverage: [execution-account.test.ts](../../packages/cezar/src/workflows/execution-account.test.ts), [auto-resume.test.ts](../../packages/cezar/src/workflows/auto-resume.test.ts).
