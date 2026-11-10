# Separate attention status from read receipts

One Node-free attention function defines whether a run needs action for browser and CLI
consumers. Read receipts answer a separate question: whether the user has seen a finished
outcome. Keep that signal outside the status dot so reading a task does not change what
happened or who must act.

## Consequences

One shared unread rule, `isUnread` in the contract’s run predicates, uses finish and seen
timestamps. Only done or failed runs with a finish time can be unread; archived runs cannot. The cockpit and the store’s mark-read
sweep both use it. It is not unified into the reserved attention `unseen` bucket. The sweep’s
SQL prefilter (`UNREAD_RUN_RULE.sql`) may admit extra rows but must not miss an unread one;
`isUnread` re-checks each decoded record. A run waiting for a usage-limit resume is not a
finished unread outcome.

## Considered Options

- **Use unread as another attention/status color.** Rejected because status and whether the user has seen it are independent facts.

Implementation: [attention.ts](../../packages/contract/src/attention.ts), [run-predicates.ts](../../packages/contract/src/run-predicates.ts), [read-state.ts](../../packages/web/src/lib/read-state.ts), [store.ts](../../packages/cezar/src/runs/store.ts).

Coverage: [attention.test.ts](../../packages/contract/src/attention.test.ts), [run-predicates.test.ts](../../packages/contract/src/run-predicates.test.ts), [read-state.test.ts](../../packages/web/src/lib/read-state.test.ts).
