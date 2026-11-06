---
name: validation
description: Run or choose tests in this repo (Squeal verdicts, Vitest through npm, packaged CLI E2E, browser E2E, typecheck), write waits in unit tests, or check a change before a PR.
---

# Validation

Before adding a YAML, shell or Markdown reader, read [Script readers](../../../docs/sdlc/script-readers.md).

## Iterate

For changed-test selection rules, run `npm run test:changed -- --help`.

**Packaged CLI E2E runs by hand.** Run `npm run test:package -- <repo-root paths>`.

**Browser E2E.** Run `npm run test:e2e` or `npm run test:e2e:local`; read [the e2e README](../../../packages/web/e2e/README.md).

**Typecheck.** Run `npm run typecheck`; it checks all workspaces without building or writing `dist`. After `npm run build`, run `npm run typecheck:package` to check packaged tests.

**Unit-test waits.** A test that proves something did not happen uses fake timers or states at the call site why it needs real time. Size a bound per step, or use a window that restarts on progress. A shrunk product budget applies only to its step and never races its fixture's startup; review checks it because the scan cannot. Wait guards: `cez/test-wait-discipline` and `cez/unit-wait-discipline` in `npm run lint`.


## CI owns the final gate

**The final gate and full-suite runs belong in CI.** Do not run the entire local
gate, `squeal run --all`, or the full Vitest or browser suite just to finish a
task, commit, open a PR, or complete a review. Run a full local suite only when
explicitly requested or needed to investigate a CI failure. A full local Vitest
run is CI's four shards: `npm test -- --shard=N/4 --maxWorkers=4`,
for N=1..4, one after another.
Record the tested revision (or uncommitted diff), commands or Squeal status,
outcomes, and subsequent edits in the handoff. After later code changes, rerun
affected checks. A targeted run, skipped browser suite, or old pass for changed
inputs never counts as a full pass. CI independently enforces the complete gate
in `.github/workflows/ci.yml`; check its required aggregate before merge.

`npm test` and `npm run test:unit` are the fast unit gate: no server, no browser. They must stay that way.

Read [`docs/sdlc/ci.md`](../../../docs/sdlc/ci.md) before you:

- investigate, cite or file a CI or load-dependent test failure, or back a PR
  with a full local run that failed only under load (§ Investigating a CI or load
  failure, which includes the one-CPU load reproduction);
- edit `ci.yml` or a workflow it calls (§ Proving a `ci.yml` change);
- add or split a Vitest unit test file that takes longer than about one minute
  on CI (the duration manifest, after the Vitest sequencer paragraph).
