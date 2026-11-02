# Workflows

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`packages/cezar/src/workflows/types.ts`, then `packages/cezar/src/workflows/load.ts`, `packages/cezar/src/workflows/run.ts`, `workflows/run/`

## Rules

A step is agent (`prompt`/`skill`) XOR check (`command`); a file has `steps` XOR the portable `skills` shorthand — both enforced by zod refinements. `onFail.retry` may only reference an _earlier_ step (`stepsIssue`). `{{task}}` is the substitution token. `quick-task` is the built-in zero-config workflow; built-ins always come back after delete.
