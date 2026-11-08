# Repository lint

`npm run lint` runs the repository's own source rules (hearsay-tools/cezarion#2416). It is one
command, it fails closed, and it does not depend on which tests a change selects.

## What it runs

`packages/cezar/src/lint/run.ts` runs five parts and prints every problem as
`file:line:column rule: reason → owner`:

1. **oxlint** with the `cez` JS plugin (`packages/cezar/src/lint/plugin.ts`) over `packages/`.
   `.oxlintrc.json` keeps every category off and explicitly enables all `cez` rules and 93
   built-in correctness rules. The `typescript`, `unicorn` and `oxc` plugins are enabled.
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
a category on, a missing built-in plugin, another rule count than all cez rules plus enabled
built-in entries, and a file that does not parse are failures,
never a pass.

## Where it runs

| Where | How |
| --- | --- |
| CI | The required `Typecheck` job's `Lint` step. The job runs on every change surface, docs-only included, so no test selection skips lint |
| Squeal | Edit-time oxlint diagnostics require Squeal 0.1.392 or later; its provider loads `.oxlintrc.json` and the `cez` JS plugin. Older Squeal reports `lint.tools` as unknown and keeps validating through `packages/cezar/src/lint/lint-runner.test.ts` and `lint-ast-grep-{1,2}.test.ts`: runner checks and two disjoint groups of ast-grep rules only. The split keeps each bridge file below the Vitest per-file duration cap; the sorted rule list assigns every new rule to one group. `npm run lint` before the first push of a package change and CI’s required Lint step remain the gate (hearsay-tools/cezarion#2426) |
| By hand | `npm run lint` from the repository root, about 5 s on an idle host |

## The `cez` rules

| Rule | Refuses | Exceptions |
| --- | --- | --- |
| `cez/card-2-contrast` | Unsafe small text on card-2 (hearsay-tools/cezarion#1133, hearsay-tools/cezarion#2423) | `packages/web/src/test/card-2-contrast.baseline.json`, shrink-only |
| `cez/contract-root-import` | A runtime import of a contract package root (hearsay-tools/cezarion#1237) | `contract-root-import.baseline.json`, shrink-only |
| `cez/design-guardian` | The ten original cockpit design checks; each finding names its original rule, reason and token (hearsay-tools/cezarion#2422) | Original inline allowed predicates and reason comments; tests keep their original scope and the guardian suite excludes itself |
| `cez/home-boundary` | `cezarHomeDir` references, `resolveHome` outside `home/` and CLI dispatch, unlisted `homedir()` calls in non-test `packages/cezar/src/`, and test-side CEZ_HOME writes/stubs/deletes | `home-readers.baseline.json`: reasoned OS-user readers with exact call counts, shrink-only; shared `vitest.setup.ts` selects test homes |
| `cez/test-home-write` | An ambient `cezarHomeDir()` or `homedir()` result reaching a filesystem write in test code | None; use an explicit sandbox path (hearsay-tools/cezarion#2813) |
| `cez/native-mock-source` | A test that reads, splices or swaps native mock source (hearsay-tools/cezarion#1479) | None |
| `cez/raw-query-setter` | A raw `useSearchParams` setter in the cockpit (hearsay-tools/cezarion#1649) | `packages/web/src/test/search-params-discipline.baseline.json`, shrink-only and reasoned |
| `cez/run-fact-reader` | An attention label comparison, a restated usage-limit hold, or an unlisted `autoResumeAt` read (hearsay-tools/cezarion#1496) | `resume-time-readers.json`: add a reader only with its reason |
| `cez/run-history-reader` | An unlisted raw `historyPaths` or `eventsPath` use, or a string/template literal containing `.ndjson` with no preceding character or a preceding character outside `[A-Za-z0-9_-]` (hearsay-tools/cezarion#2420) | `run-history-readers.json`: each file and access kind has a reason; stale entries fail |
| `cez/runner-fact-combination` | A function in a non-test `packages/cezar/src/workflows/` source that reads two different declared runner facts (`RUNNER_FACTS`, `inputDelivery`, `systemPromptOnResume`), because shared parity rows run on a derived runner set that shows each value once, not each combination (hearsay-tools/cezarion#2991) | `COMBINATION_ROWS` in the rule: a function with the parity row that runs its combination on every runner |
| `cez/test-wait-discipline` | Bare sleeps, bounds under 10 s and poll loops without a sufficient deadline in server tests (hearsay-tools/cezarion#2421) | `packages/cezar/src/test-wait-discipline.baseline.json` and `test-wait-discipline-polls.baseline.json`, shrink-only |
| `cez/undocumented-env-name` | A `CEZ_*` name in a shipped source or runner script that `.env.example` lacks | The `CEZ_MOCK_*` prefix |
| `cez/unit-wait-discipline` | Bare sleeps, bounds under 3 s and poll loops without a sufficient deadline in cockpit unit tests (hearsay-tools/cezarion#2421) | `packages/web/src/test/unit-wait-discipline.baseline.json`, shrink-only |

The lists live beside the rules in `packages/cezar/src/lint/`, except the query-setter and card-2 contrast baselines,
which keep their paths. CI's baseline-growth gate refuses a `*.baseline.json` that grows.

Home resolution has two named source entry points: `src/index.ts` and
`src/subcommands.ts`. Operator dispatch resolves once; task commands receive no Home.
The process scripts `packages/cezar/scripts/benchmark-workspace-events.ts`,
`benchmark-family-reconcile.ts`, `benchmark-stuck-destroys.ts`, `benchmark-run-store.ts`,
`measure-transcript-facts-health.mjs`, and `.ai/scripts/probe-questions.ts` resolve
once at their existing environment boundary. Scripts are outside this rule's scope.
The OS-user reader list has one entry per file, with a reason and a call count.
New calls fail per-file lint. Removed calls or files fail the whole-repository
stale-entry check until the count or entry shrinks. CI's baseline-growth gate
refuses additions and increased counts after this list lands.

The home-boundary rule resolves statically known keys and callee forms; dynamic keys, computed variables and eval are out of scope.

Tests use `Home.sandbox(dir)` and the shared test selector. Reading CEZ_HOME and
passing it in a child process environment remain allowed. Test fixtures prove each
forbidden form, parser errors, stale entries and the CI growth ratchet.

### Test home boundary

`cez/test-home-write` and `cez/home-boundary` share `TEST_FILE`, the regular
expression `\.(?:test|testkit)\.[cm]?[jt]sx?$`, across the repository. Both cover
`.test` and `.testkit` files with `.js`, `.jsx`, `.ts`, `.tsx` extensions and
their `m`/`c` variants, including JSX source in these files. The shared pattern keeps ambient-home syntax and CEZ_HOME selection
checks on the same test surfaces. Oxlint scans package tests. The lint
runner applies the same two scanners to tracked and unignored new test files outside
`packages/`, including the two node:test projects. Neither rule has a test baseline.
The guarded names are `homedir`, legacy `cezarHomeDir` and `resolveHome`.
`home/resolve.ts` exports only `resolveHome` as an environment-to-Home resolver.
The Cezar path helpers in `paths.ts` take an explicit `Home`; its agent-home
and tilde APIs remain separate APIs.

The rule checks syntax only. It reports these positions:

- Bare calls and member calls ending in a guarded name.
- Guarded keys in any destructuring pattern, including parameters, catch clauses,
  loop targets, nesting, defaults, rest and TypeScript expression wrappers.
- Guarded names in runtime import/export specifiers, including renamed imports
  and re-exports. An import line needs its own annotation.
- Member references ending in a guarded name, including values passed or assigned.

A permitted use requires `// test-home-read: <reason>` on the same line. The
reason must be nonempty. Only a real line comment grants an exception. Imports
and each guarded use need their own comment. Existing uses were audited as pure
comparisons, sandbox discovery, mocked writes, refusal probes or resolution of
temporary sandbox envs. The annotation is a review contract, not proof of later
read-only behavior. Use `Home.sandbox` or the selected sandbox HOME for writes.

Repeated independent reviews found new binding forms and false positives in alias
tracking. The syntactic rule has no binding or value-flow model. It ignores fixture
strings/comments, explicit type-only syntax and unrelated data-property definitions such
as `{ homedir: '/tmp' }`. Static identifier/string keys are checked directly;
computed expressions such as `os['home' + 'dir']`, eval and cross-module flow are
outside the scan. An allowed import alias is not followed to later calls under
a different name. Runtime TypeScript namespaces/modules, enum initializers, export
assignments, parameter properties and decorators are scanned. Only explicit type
nodes, ambient/declare-only declarations and type import/export specifiers are
skipped; `as`/`satisfies` expressions still scan their runtime operand.

The following are operational tools or read-only helpers, not test source. This
classification preserves existing commands and legacy paths (hearsay-tools/cezarion#2813).

| Surface | Classification and reason |
| --- | --- |
| `packages/cezar/scripts/*benchmark*` | Developer tools; their sandbox/marker checks protect benchmark state while retaining explicit command environments |
| `packages/cezar/scripts/measure-transcript-facts-health.mjs` | Developer measurement tool; it selects its own marked scratch home |
| `.github/scripts/mutants-file.cjs` | Developer mutation tool; probe children use test homes and its host `~/.cache/cez/mutants` remains a cache |
| `packages/cezar/scripts/pi-project-skills.mjs` | Runtime helper; it discovers the operator's installed agent skills |
| `packages/web/e2e/browser-launch.ts` | Read-only discovery of installed browser launch settings |
| `scripts/test-parity.mjs` | Read-only discovery of the installed Squeal launcher |
| `packages/web/e2e/workspace-registry.ts` | Its homedir read is a refusal guard; writes use the explicit shared sandbox |

All test entry points use `scripts/test-home-setup.mjs`. It imports no product
modules, scrubs inherited CEZ flags once, and pins HOME, USERPROFILE, CEZ_HOME and
all four XDG home overrides inside the sandbox. It removes XDG_RUNTIME_DIR and
creates a `test` marker. Per-test repair retains test-owned beforeAll flags and
the P1b Home selector. Browser workers load `scripts/test-browser-home-env.mjs`:
they retain host HOME and USERPROFILE for installed browser discovery (the P0b
exception), while CEZ_HOME and XDG overrides use a private marked sandbox.

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

### Adopted built-in correctness rules

hearsay-tools/cezarion#2425 adopts these 93 rules. Each entry is explicit, at severity `error`;
an oxlint upgrade cannot enable another rule through a category default.

| Plugin | Rules (prefix omitted) |
| --- | --- |
| `eslint` (56) | `constructor-super`, `for-direction`, `getter-return`, `no-async-promise-executor`, `no-caller`, `no-class-assign`, `no-compare-neg-zero`, `no-cond-assign`, `no-const-assign`, `no-constant-binary-expression`, `no-constant-condition`, `no-debugger`, `no-delete-var`, `no-dupe-class-members`, `no-dupe-else-if`, `no-dupe-keys`, `no-duplicate-case`, `no-empty-character-class`, `no-empty-pattern`, `no-empty-static-block`, `no-eval`, `no-ex-assign`, `no-extra-boolean-cast`, `no-func-assign`, `no-global-assign`, `no-import-assign`, `no-invalid-regexp`, `no-irregular-whitespace`, `no-iterator`, `no-loss-of-precision`, `no-misleading-character-class`, `no-new-native-nonconstructor`, `no-nonoctal-decimal-escape`, `no-obj-calls`, `no-self-assign`, `no-setter-return`, `no-shadow-restricted-names`, `no-sparse-arrays`, `no-this-before-super`, `no-unassigned-vars`, `no-unreachable`, `no-unsafe-finally`, `no-unsafe-negation`, `no-unsafe-optional-chaining`, `no-unused-expressions`, `no-unused-labels`, `no-unused-private-class-members`, `no-unused-vars`, `no-useless-backreference`, `no-useless-catch`, `no-useless-escape`, `no-useless-rename`, `no-with`, `require-yield`, `use-isnan`, `valid-typeof` |
| `oxc` (14) | `bad-array-method-on-arguments`, `bad-char-at-comparison`, `bad-comparison-sequence`, `bad-match-all-arg`, `bad-min-max-func`, `bad-object-literal-comparison`, `bad-replace-all-arg`, `const-comparisons`, `double-comparisons`, `erasing-op`, `missing-throw`, `number-arg-out-of-range`, `only-used-in-recursion`, `uninvoked-array-callback` |
| `typescript` (11) | `no-duplicate-enum-values`, `no-extra-non-null-assertion`, `no-misused-new`, `no-non-null-asserted-optional-chain`, `no-unnecessary-parameter-property-assignment`, `no-unsafe-declaration-merging`, `no-useless-empty-export`, `no-wrapper-object-types`, `prefer-as-const`, `prefer-namespace-keyword`, `triple-slash-reference` |
| `unicorn` (12) | `no-await-in-promise-methods`, `no-empty-file`, `no-invalid-fetch-options`, `no-invalid-remove-event-listener`, `no-new-array`, `no-single-promise-in-promise-methods`, `no-thenable`, `no-unnecessary-await`, `no-useless-fallback-in-spread`, `no-useless-length-check`, `prefer-set-size`, `prefer-string-starts-ends-with` |

`no-unused-vars` ignores arguments, variables and caught errors whose names start with `_`, and
ignores rest siblings. The `**/mock-*.mjs` override also ignores arguments: the mock scenario
handlers keep uniform signatures. No built-in rule has a baseline.

Two deliberate cases have reasoned inline disables: `no-empty-pattern` for Vitest 4's required
fixture destructuring parameter, and `unicorn/no-thenable` for a test that observes an await.

| Rule left off | Reason |
| --- | --- |
| `no-control-regex` | Control-character patterns strip ANSI output and refuse unsafe paths and environment values. Every finding was deliberate sanitization. |
| `unicorn/no-useless-spread` | Snapshot copies protect iteration while collections mutate. The dangerous autofix removes that protection, and the rule cannot allow these snapshots. |
| `typescript/no-this-alias` | The getter facade and instance captures in mocks need the alias. They do not use the obsolete `self = this` pattern the rule targets. |

The 15 type-aware TypeScript correctness rules remain off and outside this adoption. They require
`--type-aware`; adopting them needs a separate review: `await-thenable`, `no-array-delete`, `no-base-to-string`, `no-duplicate-type-constituents`, `no-floating-promises`, `no-for-in-array`, `no-implied-eval`, `no-meaningless-void-operator`, `no-misused-spread`, `no-redundant-type-constituents`, `no-unsafe-unary-minus`, `no-useless-default-assignment`, `require-array-sort-compare`, `restrict-template-expressions`, `unbound-method`. Other built-in categories remain off.

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

### Mock lifecycle boundary

`cez/mock-lifecycle-boundary` keeps the no-progress stall, readiness pid and release
wait in `scripts/mock-lifecycle.mjs` (hearsay-tools/cezarion#1529). Other `mock-*.mjs`
scripts cannot define the old lifecycle helpers or contain the `watchdog.pid` literal.
Synthetic cases pin the scanner; tests never read native mock source.

### Product environment reads

`cez/product-env-read` requires shipped source and runner scripts to use
`productEnv('SUFFIX', env?)` from `core/product-env.ts`. The helper selects `HSQ_`
first by presence (an empty string wins), then `CEZ_`. Its optional third boolean
keeps the child-env boundary's case-insensitive lookup. Home resolution uses
`legacyHomeEnv(env)` for the migration source and `preferredHomeEnv(env)` for the
split-layout override; it keeps its existing empty/default-home rules.

The AST scanner covers dot and optional reads, literal brackets and static
expressions, env arguments, simple env aliases, nested destructuring declarations,
assignments, parameters and loop targets, and computed indexing on env objects.
Object annotations support `ProcessEnv` under any qualification, queries of
`process.env` and `globalThis.process.env` (including bracket types), object utility
wrappers, unions, intersections and local type aliases. Arrays and scalar types
are not env objects. Unresolved computed sites are
recorded as `computed` with name `*`; conversion must inspect their possible
suffixes. Tests, testkits, fixtures, plain assignments and deletes are exempt.
Compound assignments and updates remain reads. Helper calls require literal
suffixes; `cez/undocumented-env-name` derives both names from them.

`product-env-read.baseline.json` is empty after hearsay-tools/cezarion#2971.
The file remains for CI's shrink-only ratchet; no product-setting allowance may grow.
Permanent non-setting reads live separately in `nonSettingEnvReads` in the lint
source. Each names its file, computed form, exact expression and reason. They cover
OS PATH, XDG roots, HOME_LAYOUT_ENV projection, third-party Bedrock/Vertex toggles,
controller tool-authority transport, generic mock env interpolation/recording and
benchmark snapshot/restoration. The scanner only exempts anonymous computed sites;
a literal product-setting name never qualifies. `mockEnvReadExemption` permits
only `CEZ_MOCK_*` controls in `packages/cezar/scripts/mock-*.mjs`. These names
belong to fixtures, even though the scripts ship in the package. Mock reads of
real product settings still use the shared helper. Tests pin each exemption and
reject named product reads and altered expressions in those same files.

`legacyEnvNames(env)` collects old names independently of reads so boot can also
report shadowed, empty and retired settings without values. The generated legacy
launcher shell keeps its explicit permanent `CEZ_HOME` fallback (spec section 4).

Computed-key resolution accepts only string literals, static templates and immutable
literal aliases. Member access, calls, mutable bindings, cycles and duplicate or
shadowed binding names remain unknown computed reads. REMOTE uses the explicit
`remoteEnvEnabled` accessor: either prefix's exact `1` keeps hosted mode enabled,
including for old CEZ-only service files awaiting their next deploy.

Native shell controls use `shellProductEnv`: DESKTOP, SUPERVISED, SUPERVISOR_PID,
SUPERVISOR_STDIN and DISCLAIM_EXEC. A defined CEZ value wins, including empty;
HSQ is a fallback only when CEZ is absent. Old and new native shells always pin
CEZ, so inherited HSQ aliases cannot disable supervision or the macOS trampoline.
P5 must revisit this precedence when it removes the CEZ fallback. This is separate
from ordinary HSQ-first operator settings (coordinator decision D11).

#### Known limits

- Untyped values passed across files, function return values and values stored in
  object containers do not carry env identity into the receiving expression.
- Type aliases imported from other modules are not resolved. Local aliases support
  object utility wrappers and generic substitutions. Interface inheritance,
  conditional and mapped types require a type checker and are outside this scan.
  Alias names are tracked conservatively within each file, without lexical scope resolution.
- Dynamic property names cannot be expanded into a complete list of env names.
  Computed reads on recognized env objects and rest copies are reported as `*`;
  dynamic paths through unrecognized objects, reflection and `eval` are not followed.

These limits need code review. They do not permit new baseline allowances.
