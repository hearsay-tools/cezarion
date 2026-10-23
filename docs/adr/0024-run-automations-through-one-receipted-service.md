# Run bounded automations through one receipted service

HTTP routes, CLI and session tools use the same automation service. Automations start
ordinary tasks through the cockpit; a missing service does not create a cron or polling-script
fallback. Advertise the built-in instructions only when the feature and cockpit address are
available.

## Consequences

Store bounded schedule shapes rather than evaluate arbitrary cron. Share timezone and occurrence
math between server and editor. Repeating schedules catch up at most the latest eligible missed
occurrence. One-time schedules have their own late-start bound and archive rules.

Project leases serialize launch decisions. Receipts reserve an occurrence before task creation;
reconciliation finds a run carrying that receipt after a crash. A throw after the creating commit
must return that run rather than allow a duplicate retry. A lease loser does not advance shared
schedule state. In-flight reservations in this process stay distinct from crash leftovers.

## Considered Options

- **Store and evaluate arbitrary cron.** Bounded schedule forms make the editor and timer use the same finite semantics.
- **Treat every reserved receipt as abandoned.** Rejected because lazy context construction can reconcile while its own launch is still running.

Implementation: [service.ts](../../packages/cezar/src/automations/service.ts), [schedule-runner.ts](../../packages/cezar/src/automations/schedule-runner.ts), [task-template.ts](../../packages/cezar/src/automations/task-template.ts), [automation-schedule.ts](../../packages/contract/src/automation-schedule.ts).

Coverage: [schedule-runner.test.ts](../../packages/cezar/src/automations/schedule-runner.test.ts), [store.test.ts](../../packages/cezar/src/automations/store.test.ts).
