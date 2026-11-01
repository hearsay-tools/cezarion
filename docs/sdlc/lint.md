# Repository lint

`npm run lint` runs the repository's own source rules (hearsay-tools/cezarion#2416). It is one
command, it fails closed, and it does not depend on which tests a change selects.

## What it runs

`packages/cezar/src/lint/run.ts` runs three parts and prints every problem as
`file:line:column rule: reason → owner`:

1. **oxlint** with the `cez` JS plugin (`packages/cezar/src/lint/plugin.ts`) over `packages/`.
   `.oxlintrc.json` turns every oxlint category off and turns on only the `cez` rules, so lint
   adds no policy of its own.
2. **ast-grep** with the rules in `.ai/ast-grep/rules`, each against its shrink-only baseline.
   [`.ai/ast-grep/README.md`](../../.ai/ast-grep/README.md) says how to write one.
3. **Stale entries**: an exemption, a reader-list entry or a baseline entry that no longer names
   a match fails, so the lists only shrink to what the code still needs.

A non-zero tool exit, unreadable tool output, a plugin that does not load, a config that turns on
another number of rules than the plugin defines, and a file that does not parse are failures,
never a pass.

## Where it runs

| Where | How |
| --- | --- |
| CI | The required `Typecheck` job's `Lint` step. The job runs on every change surface, docs-only included, so no test selection skips lint |
| Squeal | The bridge test `packages/cezar/src/lint/lint.test.ts` runs the whole lint after an edit, until Squeal runs oxlint itself (hearsay-tools/cezarion#2426) |
| By hand | `npm run lint` from the repository root, about 5 s on an idle host |

## The `cez` rules

| Rule | Refuses | Exceptions |
| --- | --- | --- |
| `cez/contract-root-import` | A runtime import of a contract package root (hearsay-tools/cezarion#1237) | `contract-root-import.baseline.json`, shrink-only |
| `cez/native-mock-source` | A test that reads, splices or swaps native mock source (hearsay-tools/cezarion#1479) | None |
| `cez/raw-query-setter` | A raw `useSearchParams` setter in the cockpit (hearsay-tools/cezarion#1649) | `packages/web/src/test/search-params-discipline.baseline.json`, shrink-only and reasoned |
| `cez/run-fact-reader` | An attention label comparison, a restated usage-limit hold, or an unlisted `autoResumeAt` read (hearsay-tools/cezarion#1496) | `resume-time-readers.json`: add a reader only with its reason |
| `cez/undocumented-env-name` | A `CEZ_*` name in a shipped source or runner script that `.env.example` lacks | The `CEZ_MOCK_*` prefix |

The lists live beside the rules in `packages/cezar/src/lint/`, except the query-setter baseline,
which keeps its path. CI's baseline-growth gate refuses a `*.baseline.json` that grows.

## Add a rule

1. Write the scanner as a pure function of a file's path and source, in
   `packages/cezar/src/lint/<rule>.ts`, and export a `SourceRule` with its scope (`applies`) and its
   findings (`check`). TypeScript 7 has no parser API: read `blankOnce(source)` for code without
   strings and comments, or use the parser the scanner already has.
2. Name the owner or helper to use instead in each message, with a repository-qualified citation.
3. Add it to `RULES` in `plugin.ts` and turn it on in `.oxlintrc.json` as `"error"`.
4. Pin it with fixture cases on inline samples, and add a seeded violation and an approved
   exception to `plugin.test.ts`, which runs the real oxlint.
5. Put a whole-repository check (a baseline, a stale entry) in `run.ts`, never in a rule: oxlint
   runs rules per file, in parallel.

## Migration inventory

Snapshot: the tree at hearsay-tools/cezarion#2416. A **case** is one Vitest `it` (one per rule for a
looped case). **Moved** cases now run in `npm run lint`; the scanner's fixture cases stay as tests.

### Moved

| Family | Old file | Moved cases | Retained in the old file |
| --- | --- | --- | --- |
| Contract import boundaries (M01) | `packages/cezar/src/contract-import-boundaries.test.ts` | 2: no root import; each exemption still imports a root | 33 scanner cases; the api-client shim mirror, which compares files rather than scanning shapes |
| Raw query setters (M02) | `packages/web/src/test/search-params-discipline.test.ts`, now `packages/cezar/src/lint/raw-query-setter.test.ts` | 1: no setter outside the baseline | 8 scanner cases; the exception-policy guard on the baseline |
| Native mock boundaries (M03) | `packages/cezar/src/mock-source-boundary.test.ts` | 1: no test reads or swaps mock source | 9 scanner cases |
| Shared run-fact readers (M05) | `packages/cezar/src/run-fact-readers.test.ts` | 2: no finding; every listed reader still reads | 27 scanner cases |
| Environment-name documentation (M11) | `packages/cezar/src/env-example.test.ts` | 1: every `CEZ_*` name documented | 4 scanner cases |
| Existing ast-grep enforcement | `packages/cezar/src/ast-grep-rules.test.ts` | 14: one repository scan per rule | Rule-file checks, the `ast-grep test` cases, the baseline helpers, the update mode helpers, binary resolution |

21 cases moved. The update mode moved with them: `AST_GREP_RULES_UPDATE=1 npm run lint`.

### Deferred

| Family | Current file(s) | Why not in this migration | Follow-up |
| --- | --- | --- | --- |
| Active-run map ownership (M04) | `packages/cezar/src/workflows/run-active-pin.test.ts` | Its 3 scans cut method bodies by indentation, and call presence does not prove execution, order or cleanup | hearsay-tools/cezarion#2419 |
| Run-history readers (M06) | `packages/cezar/src/runs/history-readers.test.ts` | A per-line substring scan; not every `.ndjson` path is run history, so the rule must target ownership first | hearsay-tools/cezarion#2420 |
| Unit wait discipline (M07) | `packages/cezar/src/test-wait-discipline.test.ts`, `packages/web/src/test/unit-wait-discipline.test.ts` | Three baselines, a cached full scan that fixture cases share, and a host timeout check to separate | hearsay-tools/cezarion#2421 |
| Design guardian (M09) | `packages/web/src/design-guardian.test.ts` | Ten per-file rules fit lint; the token and control cases pin named files' content; the suite reads all sources at import | hearsay-tools/cezarion#2422 |
| Card-2 contrast (M10) | `packages/web/src/test/card-2-contrast.test.ts` | Joins `styles/index.css` with every `.tsx`; dynamic styling still needs browser evidence | hearsay-tools/cezarion#2423 |
| File-length budget (M12) | `packages/cezar/src/file-length.test.ts` | A whole-repository budget over `git ls-files`; it belongs in the runner, with its update mode | hearsay-tools/cezarion#2424 |

### Retained

| Family | File | Reason |
| --- | --- | --- |
| Browser wait discipline (M08) | `packages/web/src/test/e2e-wait-discipline.test.ts` | Its two-line and twelve-line windows depend on formatting; a lint rule would harden a heuristic without new evidence |
| AGENTS.md byte budget (M12) | `.github/scripts/agents-md-budget.test.cjs` | A document budget, not a source rule; it costs under a millisecond in `node:test` |
| Run-search readers (M13) | `packages/cezar/src/run-search-readers.test.ts` | Required-presence checks: a dead `matchesRunSearch(…)` call satisfies them, so they are not proof enough for a hard rule |

### Not adopted

Oxlint's built-in categories stay off. `correctness` reports 527 findings on this tree; adopting
it is hearsay-tools/cezarion#2425.
