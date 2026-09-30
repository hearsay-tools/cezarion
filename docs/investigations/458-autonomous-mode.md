# Autonomous mode on the reported `/setup` run (#458)

## Conclusion

A saved `autonomous: true` is the effective launch mode, not evidence that someone
clicked Autonomous. The shipped composer intentionally defaults skills to on
unless a stronger choice overrides it. A `/setup` skill with no `interactive: true`
hint therefore starts autonomous with an untouched draft and unconfigured workspace.

The reproduced toggle, launch payload and saved record agree. No execution change
is warranted by that reproduction. Two source comments incorrectly described the
fallback as off or attributed the saved value to a checkbox choice; this change
corrects those descriptions and adds coverage. Nudge and Finish behavior are unchanged.

**The exact origin of this particular run's choice remains unprovable.** Its browser
draft, launch request, launch-time workspace/env defaults, and resolved skills API
response were not captured. The default path explains how it could happen without
user action; it does not rule out a retained draft or a configured default.

## Historical evidence

The [issue's investigation comment](https://github.com/hearsay-tools/cezarion/issues/458#issuecomment-5759931584)
records an inspection on 2026-09-21 with installed cezar 0.14.4 and repository commit
`366906e8`. That repository commit is **not** an ancestor of `v0.14.4`; this investigation
checked the actual release tag `5e307391813a8c6a81f6321309ff6636ce3dd33c` separately.
Both contain the relevant source-dependent resolver and off-as-omission serializer.

Read-only inspection of the affected project's `.ai/cezar/` state confirmed:

- Project: `/home/agent/projects/mvp-unveiled-july26`.
- Run: `70fbd826-a97e-476e-aca3-19c657df4ded`, created `2026-09-21T10:27:19.130Z`.
- `runs.json`: `autonomous: true`, `(planned)` workflow, one initial step named
  `setup`, `skill: setup`, prompt `{{task}}`, task `Let's set up SDLC for this project`.
- The saved workflow names the skill but does not snapshot its discovered metadata.
- `runs/<id>.ndjson`, event 1: initial run start at `10:27:19.135Z`; event 2:
  isolated worktree selected. Neither records the autonomy source or toggle state.
- Event 262, `continue-1`, `11:16:22.154Z`: assistant says setup is done but omits
  `CEZ:DONE`. Event 268 is the normal turn end at `11:16:22.172Z`. These explain the
  reported parking, not who chose autonomous mode.
- At this later inspection the record is `done`, with `continue-2` started at
  `11:35:06.359Z` and finished at `11:40:02.814Z`. This differs from the earlier
  waiting-state snapshot. No affected record or event was edited by this task.

The run record is mutable and has no flag-change audit trail. Code tracing found
no ordinary Continue/recovery write that promotes this saved flag to true, but
cannot exclude a historical external/manual edit. The original browser state and
HTTP request cannot be reconstructed from the present record. The currently
installed SDLC setup skill lacks an interactive hint, but that is not proof of
which metadata the original browser received.

## Value trace (0.14.4 and current code)

1. `packages/web/src/routes/new-task-draft.ts`: an absent draft choice normalizes to
   `null`; explicit `false` and `true` survive storage, navigation and successful
   submission. Successful launch clears text/source, not the explicit mode choice.
   Draft keys are project-scoped, with a bare legacy key for the boot project.
2. `packages/cezar/src/skills.ts`: only the parsed `interactive: true` frontmatter
   hint recommends off. A skill's name, prose asking for approval, or description
   does not make it interactive. The stored workflow alone does not carry the hint.
3. `packages/cezar/src/server/server.ts`, workspace config response: a saved
   `composerDefaults.autonomous` overrides the env seed. `CEZ_AUTONOMOUS_DEFAULT=0`
   or `1` seeds absent settings; otherwise the fallback is `source-dependent`.
4. `resolveComposerRunMode`: Plan first forces off; otherwise explicit draft choice
   wins, then interactive hint (off), then configured fallback. Source-dependent
   means skill on, workflow/no skill off. The interactive hint is advisory and
   does not override an explicit draft choice.
5. `packages/web/src/routes/new-task.tsx`: the toggle's `aria-checked` and submission
   both consume `runMode.autonomous`. It does not record whether that value arose
   from a click. Execution settings are an expandable disclosure, so DOM agreement
   cannot establish whether the original user saw or noticed the toggle.
6. `packages/web/src/routes/new-task-form.ts`, `buildCreateRunBody`: on sends
   `autonomous: true`; off omits the property. This is the existing wire convention,
   not a mode mismatch: no server-side composer fallback is reapplied to a launch.
7. The runs route forwards the parsed value to `RunManager.startRun`, which stores
   `input.autonomous === true`. `RunStore` serializes that boolean in `runs.json`.
8. Continue retains the record's mode. Queued/interrupted recovery rebuilds inputs
   from `run.autonomous`, not current composer defaults. Missing legacy flags stay
   absent and are treated as non-autonomous. An in-memory continuation/nudge-state
   omission is a separate concern in #426, not evidence of a saved false→true write.

The default is documented in `README.md`'s `CEZ_AUTONOMOUS_DEFAULT` row and in
`.ai/specs/2026-07-25-configurable-composer-run-defaults.md`. Commit `8908ab00`
(configurable defaults) is an ancestor of `v0.14.4`. The interactive precedence is
specified in `.ai/specs/2026-07-25-interactive-skill-composer-defaults.md`.

## Reproduction and coverage

Use an isolated dry-run project with a `setup` skill that has no interactive hint,
workspace defaults unset, no env seed and Plan first off. Select `/setup`, make the
choice below, reload the composer, then start the task:

| Explicit draft choice | Displayed Autonomous | HTTP property | Saved flag |
|---|---|---|---|
| Unset | On | `true` | `true` |
| Off | Off | Omitted | `false` |
| On | On | `true` | `true` |

- `packages/web/e2e/composer-defaults.e2e.ts`: actual browser toggle clicks, reload,
  observed launch request, real API readback and flushed `runs.json` for all three.
  Its isolated fixture and mocked agent do not invoke the real setup skill.
- `packages/web/src/routes/new-task.test.tsx`: `/setup` component matrix also covers
  workspace on/off and interactive hints, including explicit off beating workspace
  on and explicit on beating an interactive hint. The retained choice remains intact.
- `packages/cezar/src/workflows/run.test.ts`: immediate human Continue preserves
  true, false and legacy absent values through disk persistence; runner startup is
  stubbed because this assertion concerns saved mode, not nudge execution.
- `packages/cezar/src/workflows/recover-autonomous.test.ts`: queued recovery and
  deferred Continue/restart preserve saved mode, even under an opposite current env
  seed. Capacity is frozen so no real runner starts.

These are guards for verified existing behavior, not a claimed red/green execution
fix. A mutation replacing nullish precedence with truthiness must fail the component
matrix: explicit off and interactive off must not fall through to an on default.
The original run remains untouched. No conclusions about #426 or #449 being fixed
follow from saved-mode preservation.

## Verification notes

The real browser matrix passed with reload, API and flushed-file checks. The full
four-lane browser command reported `TEST_E2E_STATUS=passed`: 497 passed and six
existing skips, none introduced here. Typecheck, build, the 568 unit-script tests
and 60 package tests passed. Independent review found two test gaps (host env
inheritance and a potentially vacuous recovery assertion); both were corrected
and the reviewer confirmed no remaining substantive findings.

An initial verification overlap was invalid: the browser bootstrap ran `npm ci`
while other checks used `node_modules`. Those missing-module failures were discarded
and the checks rerun after installation. The subsequent default-concurrency full
Vitest run exposed unchanged test races: `application-update/lock.test.ts:16`
assumes acquisition in 10 ms, and `workflows/model-identity-wiring.test.ts:61`
removed a directory while it could still receive writes. The lock case passed
alone; the full suite was rerun with four workers without skipping or weakening
assertions. That full rerun passed all 10,672 tests across 502 files.
