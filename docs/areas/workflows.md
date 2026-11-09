# Workflows

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`packages/cezar/src/workflows/types.ts`, then `packages/cezar/src/workflows/load.ts`, `packages/cezar/src/workflows/run.ts`, `workflows/run/`

## Two project directories before P5

Union `.ai/cezar/workflows/` and `.ai/squawk/workflows/` by name. Names in the
legacy directory hide the same names in fallback; preserve same-directory
behavior. File workflows retain precedence over built-ins. Saves stay under the
legacy directory. Deletion refuses if the name also exists in fallback and names
that path with the instruction to use the binary that migrated the project.

## Rules

A step is agent (`prompt`/`skill`) XOR check (`command`); a file has `steps` XOR the portable `skills` shorthand — both enforced by zod refinements. `onFail.retry` may only reference an _earlier_ step (`stepsIssue`). `{{task}}` is the substitution token. `quick-task` is the built-in zero-config workflow; built-ins always come back after delete.
