# Pending asks

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`packages/contract/src/pending-ask.ts`, then `packages/cezar/src/workflows/run.ts` and `workflows/run/`

## Rules

The pending ask is built once from a run's `ask.requested` events by `pending-ask.ts`. Worker routing, the cockpit card, `cez task status` and the task webhook read it from there; the ast-grep rule `ask-requested-read-outside-projection` fails a payload read anywhere else. A new field goes in the projection's two output maps, `askStatusFields` and `askCardOf`, and `pending-ask.test.ts` stops compiling until it is placed. `cez task status` and the webhook read the `ask.requested` event, not the human wait, so a design that follows the wait misses them. `workflows/run.ts` only writes the event and opens the human wait (hearsay-tools/cezarion#1471: `context` missed the CLI and webhook).
