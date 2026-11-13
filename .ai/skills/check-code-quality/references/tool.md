# Bundled tool

The scripts in `scripts/` serve CI only. They are not the local pre-PR gate or a
fallback for it, and they do not measure requested code. For those, use
[Before a PR](pre-pr.md) and [Measure requested code](measure.md), which use
Squeal.

| Script | What uses it |
| --- | --- |
| `complexity-gate.mjs` | The `complexity-gate` CI job; `docs/sdlc/ci.md` § Checking function complexity and file length |
| `changed-functions.mjs`, `code-metrics.mjs` | `complexity-gate.mjs`: the changed-function scan and the complexity counter |
| `istanbul-merge.mjs` | `.github/scripts/merge-vitest-coverage.mjs`, which merges the Vitest shards' coverage in CI |

The scripts require Node 24.15 or newer and Git. `istanbul-merge.mjs` needs only
Node. The counter needs `@babel/parser`, which resolves from the skill or an
ancestor's `node_modules`. If it is absent, install the bundled manifest:

```sh
npm install --prefix <skill> --ignore-scripts --no-audit --no-fund
```

## Tests

Each script's tests sit beside it in `scripts/`, named `<script>.test.mjs`. A
change to a script updates its tests in the same change. The tests use
`node:test`. Run them from the skill or any directory:

```sh
node --test <skill>/scripts/*.test.mjs
```

## Complexity counting

Complexity uses ESLint's classic convention: one, plus one for each decision
point in the function's own body. A nested function counts its own points.

The change scanner compares function source, excluding nested bodies from the
parent. Comments and whitespace inside a function count as edits. Renamed or
moved functions may appear as added. Duplicate identities can have an unknown
baseline. Inspect the diff and baseline for these cases before deciding origin.
