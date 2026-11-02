# Repository lint

`npm run lint` runs the repository's own source rules (hearsay-tools/cezarion#2416). It is one
command, it fails closed, and it does not depend on which tests a change selects.

## What it runs

`packages/cezar/src/lint/run.ts` runs five parts and prints every problem as
`file:line:column rule: reason → owner`:

1. **oxlint** with the `cez` JS plugin (`packages/cezar/src/lint/plugin.ts`) over `packages/`.
   `.oxlintrc.json` turns every oxlint category off and turns on only the `cez` rules, so lint
   adds no policy of its own.
2. **ast-grep** with the rules in `.ai/ast-grep/rules`, each against its shrink-only baseline.
   [`.ai/ast-grep/README.md`](../../.ai/ast-grep/README.md) says how to write one.
3. **Stale entries**: an exemption, a reader-list entry or a baseline entry that no longer names
   a match fails, so the lists only shrink to what the code still needs.

4. **File length** (`file-length`, a runner check): every tracked non-test source file over 1,000 lines stays at or below its
   pin in `packages/cezar/src/file-length.baseline.json`. Unpinned long files, grown pins and
   stale pins fail. `FILE_LENGTH_UPDATE=1 npm run lint` only lowers or drops existing pins.

5. **Design guardian CSS**: the runner applies the same `cez/design-guardian` rule table to
   `packages/web/src/**/*.css` and `packages/web/e2e/**/*.css`, which oxlint cannot read. It also
   refuses stylesheet overrides that hide or restyle status dots or status pills.

6. **Unit wait discipline** (M07): `cez/test-wait-discipline` scans server test and testkit files
   with a 10 s floor; `cez/unit-wait-discipline` scans cockpit unit tests with a 3 s floor.
   Each rule uses its original scanner. Both use `lint/wait-baseline.ts` for the same shrink-only
   ratchet. The runner checks stale entries in the three baselines,
   server scan scope, and unterminated constructs that would hide a file's tail. Update mode
   runs before oxlint: `TEST_WAIT_DISCIPLINE_UPDATE=1 npm run lint` (both server baselines),
   `UNIT_WAIT_DISCIPLINE_UPDATE=1 npm run lint` (cockpit). Existing allowances only shrink.
   The web host test separately pins `asyncUtilTimeout` in `vitest.setup.ts`.

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
| `cez/card-2-contrast` | Unsafe small text on card-2 (hearsay-tools/cezarion#1133, hearsay-tools/cezarion#2423) | `packages/web/src/test/card-2-contrast.baseline.json`, shrink-only |
| `cez/contract-root-import` | A runtime import of a contract package root (hearsay-tools/cezarion#1237) | `contract-root-import.baseline.json`, shrink-only |
| `cez/design-guardian` | The ten original cockpit design checks; each finding names its original rule, reason and token (hearsay-tools/cezarion#2422) | Original inline allowed predicates and reason comments; tests keep their original scope and the guardian suite excludes itself |
| `cez/native-mock-source` | A test that reads, splices or swaps native mock source (hearsay-tools/cezarion#1479) | None |
| `cez/raw-query-setter` | A raw `useSearchParams` setter in the cockpit (hearsay-tools/cezarion#1649) | `packages/web/src/test/search-params-discipline.baseline.json`, shrink-only and reasoned |
| `cez/run-fact-reader` | An attention label comparison, a restated usage-limit hold, or an unlisted `autoResumeAt` read (hearsay-tools/cezarion#1496) | `resume-time-readers.json`: add a reader only with its reason |
| `cez/run-history-reader` | An unlisted raw `historyPaths` or `eventsPath` use, or a string/template literal containing `.ndjson` with no preceding character or a preceding character outside `[A-Za-z0-9_-]` (hearsay-tools/cezarion#2420) | `run-history-readers.json`: each file and access kind has a reason; stale entries fail |
| `cez/test-wait-discipline` | Bare sleeps, bounds under 10 s and poll loops without a sufficient deadline in server tests (hearsay-tools/cezarion#2421) | `packages/cezar/src/test-wait-discipline.baseline.json` and `test-wait-discipline-polls.baseline.json`, shrink-only |
| `cez/undocumented-env-name` | A `CEZ_*` name in a shipped source or runner script that `.env.example` lacks | The `CEZ_MOCK_*` prefix |
| `cez/unit-wait-discipline` | Bare sleeps, bounds under 3 s and poll loops without a sufficient deadline in cockpit unit tests (hearsay-tools/cezarion#2421) | `packages/web/src/test/unit-wait-discipline.baseline.json`, shrink-only |

The lists live beside the rules in `packages/cezar/src/lint/`, except the query-setter and card-2 contrast baselines,
which keep their paths. CI's baseline-growth gate refuses a `*.baseline.json` that grows.

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
| Active-run map ownership (M04) | `packages/cezar/src/workflows/run-active-pin.test.ts` (removed) | 2 ownership scans replaced by `active-run-map-write`; call-presence scan retired (hearsay-tools/cezarion#2419) | Harness parity R48 runs execute and Continue, checks active pins and release from memory |
| Shared run-fact readers (M05) | `packages/cezar/src/run-fact-readers.test.ts` | 2: no finding; every listed reader still reads | 27 scanner cases |
| Run-history readers (M06) | `packages/cezar/src/runs/history-readers.test.ts` | 1: no raw transcript path outside its owners | The adapted predicate fixture and both compression/reopen behavior cases; new lint fixtures pin helpers, dynamic paths, fixed strings, comments and stale exceptions |
| Unit wait discipline (M07) | `packages/cezar/src/test-wait-discipline.test.ts`, `packages/web/src/test/unit-wait-discipline.test.ts` | 5: server scope, reads-to-end, two server baseline checks, cockpit baseline check | 91 server fixtures; 79 cockpit fixtures moved to `packages/cezar/src/lint/unit-wait-discipline.test.ts`; host `asyncUtilTimeout` test stays in web |
| Design guardian (M09) | `packages/web/src/design-guardian.test.ts` | 11: ten per-file rules and status stylesheet ownership; walker replaced by discovery fixtures (see per-case inventory below) | Five named-content cases; fill-accent spelling fixture moved beside the scanner |
| Card-2 contrast (M10) | `packages/web/src/test/card-2-contrast.test.ts`, now `packages/cezar/src/lint/card-2-contrast.test.ts` | 1: no new unsafe small-text site or stale baseline entry | 20 scanner fixture cases; static classes only, dynamic styling still needs browser evidence |
| Environment-name documentation (M11) | `packages/cezar/src/env-example.test.ts` | 1: every `CEZ_*` name documented | 4 scanner cases |
| File-length budget (M12) | `packages/cezar/src/file-length.test.ts` | 1: no unpinned long file, grown pin or stale pin | 6 fixture cases |
| Existing ast-grep enforcement | `packages/cezar/src/ast-grep-rules.test.ts` | 14: one repository scan per rule | Rule-file checks, the `ast-grep test` cases, the baseline helpers, the update mode helpers, binary resolution |

42 cases moved; M04's call-presence case retired. Update modes moved with them:
`AST_GREP_RULES_UPDATE=1 npm run lint`, `FILE_LENGTH_UPDATE=1 npm run lint`,
`TEST_WAIT_DISCIPLINE_UPDATE=1 npm run lint` and `UNIT_WAIT_DISCIPLINE_UPDATE=1 npm run lint`.


### Deferred

| Family | Current file(s) | Why not in this migration | Follow-up |
| --- | --- | --- | --- |

### Retained

| Family | File | Reason |
| --- | --- | --- |
| Browser wait discipline (M08) | `packages/web/src/test/e2e-wait-discipline.test.ts` | Its two-line and twelve-line windows depend on formatting; a lint rule would harden a heuristic without new evidence. The named cross-package exception in `check-clones.cjs` permits only `packages/cezar/src/lint/wait-baseline.ts` and `packages/web/src/test/wait-baseline.ts`; remove it when M08 moves into lint |
| AGENTS.md byte budget (M12) | `.github/scripts/agents-md-budget.test.cjs` | A document budget, not a source rule; it costs under a millisecond in `node:test` |
| Run-search readers (M13) | `packages/cezar/src/run-search-readers.test.ts` | Required-presence checks: a dead `matchesRunSearch(…)` call satisfies them, so they are not proof enough for a hard rule |

### Not adopted

Oxlint's built-in categories stay off. `correctness` reports 527 findings on this tree; adopting
it is hearsay-tools/cezarion#2425.

### Design guardian (M09)

hearsay-tools/cezarion#2422 accounts for all 18 original cases (the issue's count of 17 omitted
one). The shared table and string-aware comment stripper live in
`packages/cezar/src/lint/design-guardian.ts`; strings remain visible to these rules. The original
regexes, applicability, allowed predicates and their reasons remain unchanged.

| Original case | Fate and guarantee |
| --- | --- |
| `no-raw-hex-colors` | Moved: `cez/design-guardian`; CSS also runs the same table in the runner |
| `no-amber-text` | Moved: same rule and CSS runner; pending-strong stays allowed |
| `no-color-named-or-ambiguous-brand-utilities` | Moved: same rule and CSS runner; token-sheet exception kept |
| `no-action-color-as-chrome` | Moved: same rule and CSS runner; original deliberate gold surfaces kept |
| `no-fill-accent-as-ink` | Moved: same rule and CSS runner; all original ink spellings kept |
| `no-raw-black-white` | Moved: same rule and CSS runner; original overlay exceptions kept |
| `no-native-dialogs` | Moved: same rule over executable src and e2e, including tests; bookmarklet exception kept |
| `no-dark-variant` | Moved: same rule and CSS runner; same matched token |
| `fixture-serve-must-pin-cez-home` | Moved: same rule over e2e; still a same-line heuristic, not proof of a child's environment |
| `no-100vh` | Moved: same rule and CSS runner |
| No stylesheet hides or restyles a status dot or pill | Moved: `guardianCssProblems` in the lint runner; original selector/body regexes |
| Actually scans the codebase | Replaced: nested src/e2e CSS discovery fixture, real oxlint src/e2e fixtures and fail-closed plugin/config checks pin discovery without a test-time repository walk |
| Poppins typeface | Retained: named token sheet and installed font license |
| Mineral-teal/gold vocabulary | Retained: named token sheet content |
| Live-run purple | Retained: named token sheet and status-dot component content |
| Merged-chip purple | Retained: named task-lists stylesheet content |
| Shared-control rhythm | Retained: named button, input, select and composer content |
| Fill-accent ink spellings | Retained scanner fixture, moved to `packages/cezar/src/lint/design-guardian.test.ts` beside its rule |

The five content tests stay in `packages/web/src/design-guardian.test.ts`. They read only the files
named in their assertions; no source walk runs at import. Their old duration weights were removed
from both duration manifests because they measured the removed repository scan; the sequencers use
the median fallback until successful CI suite summaries provide fresh measurements. Historical
benchmark snapshots keep their original measurements.
