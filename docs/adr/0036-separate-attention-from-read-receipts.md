# Separate attention status from read receipts

One Node-free attention function defines whether a run needs action for browser and CLI
consumers. Read receipts answer a separate question: whether the user has seen a finished
outcome. Keep that signal outside the status dot so reading a task does not change what
happened or who must act.

## Consequences

The cockpit’s unread rule uses finish and seen timestamps, excludes cancelled and archived
runs, and is mirrored by the store’s mark-read sweep. It is not unified into the reserved
attention `unseen` bucket. Both implementations must stay aligned until there is a shared
read-state owner. A run waiting for a usage-limit resume is not a finished unread outcome.

## Considered Options

- **Use unread as another attention/status color.** Rejected because status and whether the user has seen it are independent facts.

Implementation: [attention.ts](../../packages/contract/src/attention.ts), [read-state.ts](../../packages/web/src/lib/read-state.ts), [store.ts](../../packages/cezar/src/runs/store.ts).

Coverage: [attention.test.ts](../../packages/contract/src/attention.test.ts), [read-state.test.ts](../../packages/web/src/lib/read-state.test.ts).
