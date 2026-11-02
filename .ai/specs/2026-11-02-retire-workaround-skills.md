# Retire the workaround skills

Status: approved by the owner on 2026-11-02 (task `0b8679f4`). Plan revision 1.

## Goal

Delete `.ai/skills/validation/`, `.ai/skills/reader-sweep/` and
`.ai/skills/load-bearing-change/`. First fix the causes that make most of their text
necessary. Move the few real policy rules into `CODE_REVIEW.md`, `AGENTS.md` and a
spec template.

The three skills came out of `AGENTS.md` in hearsay-tools/cezarion#2470. Together they
hold 481 lines. Most of the text exists for one of four reasons:

1. A tool needs a manual sequence (typecheck order, packaged runs, parity globs).
2. A test depends on state it did not create (the served clone's catalogs, the scroll
   position left by the case before, untyped fixtures, quoted enum values).
3. A guard already enforces the rule, but the prose stays.
4. The bug that the text works around is fixed (hearsay-tools/squeal#33,
   hearsay-tools/squeal#83).

## Evidence (main `bfda6b492`, 2026-11-02)

| Fact | Source |
| --- | --- |
| Web typecheck builds the server first, because `@wjarka/cezarion/app-type` resolves to `dist/server/app-type.js` | `packages/web/package.json` `pretypecheck`; `packages/cezar/package.json` `exports` |
| 2 packaged tests import `../../dist/`, so `tsconfig.test.json` fails with TS2307 in an unbuilt worktree | `packages/cezar/test/e2e/application-update.test.ts:11`; hearsay-tools/cezarion#1122 |
| hearsay-tools/squeal#33 closed 2026-10-20, hearsay-tools/squeal#83 closed 2026-10-26; Squeal 0.1.392 installed | GitHub; `squeal --version` |
| 936 Vitest files, 7,678 s total on CI; 36 files over 60 s, 13 over 120 s; slowest `monitoring-turn.test.ts` 317 s | `.github/test-durations.json` |
| Parity cells start one real mock runner process per cell, for each runner in `RUNNER_IDS` | `packages/cezar/src/core/harness-parity.testkit.ts` |
| 36 browser specs write `.ai/cezar/runs.json` as raw JSON | `rg -l runs.json packages/web/e2e/*.e2e.ts` |
| 1,040 + 216 enum-literal sites in shrink-only baselines | `.ai/ast-grep/rules/test-enum-literal{,-tsx}.baseline.json` |
| The spec map links cockpit files only; a server, mock or test-env change selects every spec | `scripts/e2e-affected.mjs:7` |
| The served e2e clone copies this checkout, including `.ai/skills` | `.ai/scripts/test-env-up.sh`, `e2e-served-repo.mjs` |
| A browser case depends on the scroll position left by the case before | `packages/web/e2e/workflows.e2e.ts:329` |
| A CI test matches a line of the validation skill's wording | `.github/scripts/ci.workflow.test.cjs:400` |
| `ActiveRun` has 59 fields; about 160 field writes in 27 modules outside `active-run.ts` | `rg` over `packages/cezar/src/workflows/` (approximate) |
| `runInternals(` has 530 call sites in 76 test files | `rg -c 'runInternals\('` |
| `releaseSlot` (32 calls, 11 files) runs the pump, which reconciles auto-resumes | `packages/cezar/src/workflows/run/` |
| `outcome-write-outside-commit-outcome` baseline has 4 entries, 2 in `run/run-cancel.ts` | `.ai/ast-grep/rules/` |

## Rules for every slice

- **Delete a rule only with its replacement.** A PR that lands a fix also deletes the
  skill text that the fix makes unnecessary. A PR never deletes text before its
  replacement lands. This keeps every intermediate `main` usable.
- **Workaround text gets an expiry.** Text that stays until a fix lands carries
  `<!-- until: <owner>/<repo>#<n> -->` (slice 1.5).
- **The skill files are hot files.** Their sections are far apart, so the coordinator may
  run region-separate edits in parallel, under the campaign hot-file control.
- Reuse existing issues where they match: hearsay-tools/cezarion#1122 (slice 1.6),
  hearsay-tools/cezarion#1684 (slice 1.1), hearsay-tools/cezarion#1783 (follow-on to
  slice 1.8).

## End state

| Today | After | Where the remaining rule lives |
| --- | --- | --- |
| `validation`, 248 lines | Deleted | `AGENTS.md` § Validation: Squeal first; `npm test -- <args>`, `npm run typecheck`, `npm run test:package -- <files>`, `npm run test:parity`, `npm run test:e2e:affected`; CI owns the full gate; the `// bound:` rule. About 8 lines. |
| `reader-sweep`, 96 lines | Deleted | `CODE_REVIEW.md`: for saved data and user-facing messages, search the old and the new form. `BACKWARD_COMPATIBILITY.md` already covers saved formats. |
| `load-bearing-change`, 137 lines | Deleted | `CODE_REVIEW.md` § Changing working behavior: name what the old mechanism was load-bearing for; diff the shipped-default path; test the path with no live session; a fail-open helper needs an empty-input test; regression proof (pointer to `docs/sdlc/regression-proof.md`). The six case tables move to a spec template, `.ai/specs/TEMPLATE.md`, under "Case tables". |

## Phases

Each phase runs under its own campaign coordinator. The next phase may start when its
listed prerequisites hold on `main`; it does not wait for the whole previous phase.

### Phase 1 — Stale text and one command per check

Prerequisite: hearsay-tools/cezarion#2479 merged (it edits `validation/SKILL.md` and
moves the wait-discipline scans into lint).

| Slice | Type | Change | Done when |
| --- | --- | --- | --- |
| 1.1 | cleanup | Confirm the fixes for hearsay-tools/squeal#33 and hearsay-tools/squeal#83 on the installed Squeal. Delete the UNKNOWN-burst and "never pass packaged paths to `squeal status`" text. Reuses hearsay-tools/cezarion#1684. | Both behaviors are measured in the PR. No skill text names a closed issue as a current cause. |
| 1.2 | cleanup | Check that each existing guard's failure message states its rule and fix: `active-run-literal`, `active-run-map-write`, the two skills-state rules, `run-states.test.ts`, `outcome-write-outside-commit-outcome`, `detached-spawn-outside-helper`, `worktree-write-outside-manifest`, the wait-discipline lint. Delete the prose those guards enforce, or keep one pointer line. | Each named guard's message states the rule; the prose is gone. |
| 1.3 | cleanup | Delete duplicates: pnpm install (in `AGENTS.md`), Squeal coverage (its primer prints it), the CI gate list (in `ci.yml` and the Verification binding), `test:changed` internals (move to its `--help`), incident citations inside rule text. | `npm run test:changed -- --help` prints the selection rules; the copies are gone. |
| 1.4 | feature | `ci.workflow.test.cjs:400`: check that `package.json` defines `test:e2e:local`, `docs/sdlc/ci.md` names it and CI never runs it. Stop reading the skill. | Deleting `.ai/skills/validation/` leaves this test green. |
| 1.5 | feature | Expiry markers. Mark each remaining workaround rule with `<!-- until: <issue> -->`. A weekly workflow lists markers whose issue is closed and opens or updates one cleanup issue. | The workflow finds a marker on a closed issue in its own test. |
| 1.6 | feature | Typecheck never writes `dist`. Map `@wjarka/cezarion/app-type` to the server source in `packages/web/tsconfig.json` `paths`; remove `pretypecheck`; move the packaged tests to a `tsconfig.package.json` checked after the build in CI; `typecheck:server` runs the three server configs. Fallback if server sources fail under web options: `tsc -b` project references that emit declarations to an ignored directory. Reuses hearsay-tools/cezarion#1122. | `npm run typecheck` passes in a never-built worktree and writes nothing under `dist`; CI still typechecks the packaged tests. The typecheck section shrinks to one line. |
| 1.7 | feature | `npm run test:package -- <files>` takes repo-root paths. It builds when `dist` is older than the sources, or stops and prints the build command. | In an unbuilt worktree no run fails with `Cannot find module …/dist/…`. |
| 1.8 | feature | `npm run test:parity` runs every `*-parity.test.ts` file. hearsay-tools/cezarion#1783 later adds per-path selection. | `AGENTS.md` "Before opening a PR" step 2 names the command; the skill section is gone. |
| 1.9 | feature | Fail fast without `node_modules`: the Vitest global setup and the node:test import hook stop with "run `pnpm install --frozen-lockfile`" when a workspace package resolves outside the worktree. | A run in a worktree without `node_modules` exits non-zero with that message. |
| 1.10 | feature | A skipped browser run exits non-zero unless the caller passes an explicit flag; CI passes it where it needs exit 0, and its aggregate still fails on skipped. Reader sweep on the exit contract, including `BACKWARD_COMPATIBILITY.md` and the e2e README. | Locally, `npm run test:e2e` without a browser exits non-zero; CI is unchanged. |
| 1.11 | feature | Unsharded `npm test` is safe: `vitest.config.ts` sets the default `maxWorkers` from free memory and CPU count. | A plain `npm test` finishes on a 24-CPU, 47 GiB host; the OOM warning is gone. |

**Exit:** on `main`, the validation skill holds only the Squeal wait bound and the
parity procedure (removed in Phase 3) and the `CI owns the final gate` policy; slices 1.6
to 1.11 work as their done lines say; `ci.workflow.test.cjs` reads no skill.

### Phase 2 — Tests own their data and start state

Prerequisite: slices 1.2 and 1.3 merged (they edit `reader-sweep/SKILL.md`).

| Slice | Type | Change | Done when |
| --- | --- | --- | --- |
| 2.1 | feature | The served clone has no ambient catalogs: `e2e-served-repo.mjs` replaces `.ai/skills`, project workflows and other catalogs in the clone with one fixed fixture set. Coordinate with hearsay-tools/cezarion#1116 (served project registration). | A test that adds five dummy skills to the checkout leaves the workflow and skills specs unchanged. |
| 2.2 | cleanup | Each browser case starts from a known page: the shared browser helper resets viewport, scroll and route before each case. A weekly CI job runs the e2e project with `sequence.shuffle`. | The shuffled job passes twice in a row; the comment at `workflows.e2e.ts:329` is gone. |
| 2.3 | cleanup | Typed run fixtures: a `seedRuns(partials)` helper for browser and packaged tests, built on `makeRunRecord`; a lint rule refuses a raw `runs.json` write in a spec. | Renaming a `RunRecord` field fails typecheck in every fixture that sets it. |
| 2.4 | cleanup | Burn down `test-enum-literal` and `test-enum-literal-tsx` baselines to 0 with a codemod, one directory per PR. | Both baselines are empty. |
| 2.5 | feature | The spec map covers the server and the mocks: `e2e-spec-map.yml` also collects V8 coverage from the served server and `mock-*.mjs` processes; `test:e2e:affected` downloads the map when none is local. | An edit to one `mock-*.mjs` scenario selects only the specs that ran it. |
| 2.6 | feature | Control locations in one table: messages that tell users where a control lives (API errors, CLI output, agent prompts) read one table in the contract package; a cockpit unit test checks each location against the navigation. | Renaming a settings tab without the table fails a test. |

**Exit:** every reader-sweep section except the general rule has a tool that replaces it.

### Phase 3 — Fast unit suites

Prerequisite: none; it can start with Phase 2. Slice 3.2 needs its own design spec with
a **Process exits** case table and a runner owner's review.

| Slice | Type | Change | Done when |
| --- | --- | --- | --- |
| 3.1 | feature | Measure the 36 files over 60 s: time, CPU time and peak memory at several sizes. Add a shrink-only list of files over 60 s read from `.github/test-durations.json`. | A new file over 60 s fails the duration check. |
| 3.2 | feature | Parity cells run the mock wire in-process through each runner's wire adapter; one real-process smoke cell stays per runner and wire. | Every parity file is under 60 s on CI; the smoke cells still fail on a broken wire. The Squeal wait bound and parity procedure are deleted. |
| 3.3 | cleanup | Split files still over 60 s by row group. | The shrink-only list is empty. |

**Exit:** no Vitest file over 60 s on CI; the validation skill has no wait-bound or
parity text.

### Phase 4 — Run lifecycle ownership

Prerequisite: slice 3.2 merged (fast parity makes these refactors cheap to verify).
Slices 4.1 and 4.2 each need a design spec with a case table.

| Slice | Type | Change | Done when |
| --- | --- | --- | --- |
| 4.1 | cleanup | Group `ActiveRun` fields by owner (turn boundary, waits, queue and slot, usage). One ast-grep "write outside owner" rule per group. The turn-boundary fields go behind one transition function. | Each group has one writing module and a rule with an empty baseline. |
| 4.2 | feature | Slot release marks the pump due; one drain runs after the current operation. | No `releaseSlot` caller sees a changed timer set before return; parity suites pass. |
| 4.3 | cleanup | A shrink-only baseline for `runInternals(`; new tests assert store rows, events and run state. | The baseline exists and shrinks in each PR that touches a listed file. |
| 4.4 | cleanup | Move the 4 remaining outcome writes into `RunStore.commitOutcome`. | The baseline is empty. |

**Exit:** the handler side-effect and queue-head rules have nothing left to protect.

### Phase 5 — Retire the skills

Prerequisite: Phases 1 to 4 accepted.

| Slice | Type | Change | Done when |
| --- | --- | --- | --- |
| 5.1 | cleanup | Write `CODE_REVIEW.md` § Changing working behavior and `.ai/specs/TEMPLATE.md` (case tables). Shrink `AGENTS.md` § Validation and § Changing what already works to pointers. | Every policy rule in the End state table is in its new place. |
| 5.2 | cleanup | Delete the three skills. Update their readers: `AGENTS.md`, `docs/sdlc/friction.md` rule table, `packages/web/e2e/README.md`, `docs/sdlc/regression-proof.md`, `docs/areas/skills.md`, `docs/areas/run-search.md`, `README.md`, `.ai/skills/campaign/references/{cleanup-worker-brief,feature-delivery}.md`, and source comments in `run-states.ts`, `detached-process.ts`, `detached-process.test.ts`, `tool-grant-parity-cells.testkit.ts`, `outcome-commit.test.ts`, `outcome-crash.testkit.ts`, `process-waits.test.ts`. Specs stay as history. | `rg 'skills/(validation|reader-sweep|load-bearing-change)'` finds only `.ai/specs/`; the AGENTS.md byte baseline does not grow. |

**Exit:** the three skill directories are gone and CI is green.

## Open risks

- Slice 1.6: server sources under web compiler options are not measured yet.
- Slice 3.2 changes what the parity matrix proves; it needs a runner owner's review.
- Slice 4.2 is itself a load-bearing change.
- Line and site counts above are approximate `rg` counts.
