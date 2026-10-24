# Code quality check

Result: EXCEEDED.

Pinned baseline: `08a46e8ffa89c1e5a5a6e789bc1a4143293df1bf`. Head: `80e2d8707cc85556db6037a9543b6af9324d2125`.

Checked 7/7 changed functions across 4 files.
Limits: complexity > 20 or CRAP > 30. Equality passes.
Maximum complexity: 88. Maximum CRAP: 88.

CRAP uses executable function body line coverage, a line-coverage variant of the original basis-path metric.

## Reproduce

```json
{
  "cwd": "/home/agent/projects/cezar-task-settings-1596",
  "argv": [
    "/home/agent/.nvm/versions/node/v24.21.0/bin/node",
    "/home/agent/projects/cezar-task-settings-1596/.ai/skills/check-code-quality/scripts/check.mjs",
    "--base",
    "origin/main",
    "--coverage",
    ".ai/qa/task-settings-measured-coverage/coverage-final.json",
    "--output",
    ".ai/qa/2026-10-24-task-settings-quality.md"
  ]
}
```

## Measurement

```json
{
  "runner": "istanbul",
  "path": "/home/agent/projects/cezar-task-settings-1596/.ai/qa/task-settings-measured-coverage/coverage-final.json"
}
```

## packages/web/e2e/completion-controls.e2e.ts

SHA-256: `9c53ca2c4915c55b40f422030b13ff22efe107b8181ed102d29a886b79d513d0`.

| File | Function (line:column) | Complexity | Body line coverage | CRAP | Action |
| --- | --- | ---: | ---: | ---: | --- |
| packages/web/e2e/completion-controls.e2e.ts | anonymous@125:110 (125:110) | 3 | 100.00% | 3.0000 | Pass |

## packages/web/src/components/completion-controls.tsx

SHA-256: `6a1ee8328a5840b929a6ec410afc5479189c1c27790aa815cb3806d9ee0f8a7b`.

| File | Function (line:column) | Complexity | Body line coverage | CRAP | Action |
| --- | --- | ---: | ---: | ---: | --- |
| packages/web/src/components/completion-controls.tsx | CompletionControls (6:8) | 13 | 100.00% | 13.0000 | Pass |

## packages/web/src/routes/new-task.test.tsx

SHA-256: `f9c76969c1e14170dc9203dc53bed5f73cd7395f30ffc4c543263ae0600cf641`.

| File | Function (line:column) | Complexity | Body line coverage | CRAP | Action |
| --- | --- | ---: | ---: | ---: | --- |
| packages/web/src/routes/new-task.test.tsx | anonymous@380:30 (380:30) | 1 | 100.00% | 1.0000 | Pass |
| packages/web/src/routes/new-task.test.tsx | anonymous@381:85 (381:85) | 2 | 100.00% | 2.0000 | Pass |
| packages/web/src/routes/new-task.test.tsx | anonymous@405:74 (405:74) | 2 | 100.00% | 2.0000 | Pass |

## packages/web/src/routes/new-task.tsx

SHA-256: `92499ef7852365025d94692a74314a6f4965aac47cf154463cc43732576c3800`.

| File | Function (line:column) | Complexity | Body line coverage | CRAP | Action |
| --- | --- | ---: | ---: | ---: | --- |
| packages/web/src/routes/new-task.tsx | NewTaskRoute (117:8) | 88 | 100.00% | 88.0000 | Review: crap, complexity |
| packages/web/src/routes/new-task.tsx | WorktreeToggle (824:1) | 6 | 100.00% | 6.0000 | Pass |


## Disposition

`NewTaskRoute` already had complexity 90 at the pinned baseline. Its current complexity
and CRAP are 88. CRAP cannot be lower than complexity, so the baseline exceeded both
limits even with perfect coverage. The layout fix removes decisions and introduces
no new uncovered branches. A wider route refactor needs a separate issue; approval
for that issue is pending. The other six changed functions pass. CSS is outside
this tool's supported languages and was checked in the browser.

## Coverage collection

Vitest always excludes `test.include` from coverage. For this measurement, ignored
entry files import the real new-task, automation editor, and completion browser
tests. The temporary config reuses each package's normal setup and environment,
sets root and project `test.include` to those entry files, and includes the four
changed TypeScript files in V8 coverage. No test assertions or source files change.

`pnpm exec vitest run --config .ai/qa/task-settings-measure/vitest.config.ts --maxWorkers 2 --passWithNoTests=false`
passed 172 tests. The normal focused run passed 199 tests, including all 38 browser
cells in completion controls and new-task hierarchy.

## Regression and experience

The same two new unit regressions fail on old source at the pinned baseline and
pass with the source fix in a disposable worktree. They detect the separate After
Done group and the missing inline Worktree description. Normal focused validation
also passes 249 new-task, automation editor, and composer tests.

Browser verification covers 360×640 and 1440×900, light and dark themes, all three
densities, normal and reduced motion, keyboard collapse, 44px targets, no overflow,
and draft preservation during loading and failed submission. Final typecheck and
build pass, including check:pack. This settings form needs no artwork.
