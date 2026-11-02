---
name: validation
description: Run or choose tests in this repo (Squeal verdicts, Vitest through npm, packaged CLI E2E, browser E2E, typecheck), write waits in unit tests, or check a change before a PR.
---

# Validation

In a fresh task worktree (`.ai/cezar/worktrees/<runId>`), run `pnpm install --frozen-lockfile` unless `worktreeSetup` already did. Without local `node_modules`, Node resolves `@open-mercato/*` in the main checkout, so typecheck/tests use its sources.

Before adding a YAML, shell or Markdown reader, read [Script readers](../../../docs/sdlc/script-readers.md).

## Iterate

**With Squeal.** If Squeal is installed and validating this worktree, it runs the
tests after each edit: follow its installed skill and its `SQUEAL` reports, and
leave those runs to it rather than starting `npm test`, `npm run test:unit`,
`npm run test:e2e` or `npm run test:changed` yourself. `squeal.config.json`
covers the four unit Vitest projects, both fast `node:test` groups from
`npm run test:unit`, and the cockpit browser suite (`npm run test:e2e`) in its
slow tier. It does not cover packaged CLI E2E (hearsay-tools/cezarion#1281
removed it from the config); see *Packaged CLI E2E runs by hand* below.
Under Codex, use the absolute Squeal command printed in its messages when
`squeal` is not on PATH. Report known failures, pending, stale and unknown
results accurately; zero known failures is not a full pass.

<a id="squeal-wait-bound"></a>

**A wait for one file's verdict has a bound.** Squeal's skill says to wait again
when `squeal status --wait` returns on timeout. In this repo, stop waiting for a
unit test file's verdict when either case holds:

- Squeal reports the file unknown: for example, it timed out at the per-file
  cap (`runner.timeoutMs` in `squeal.config.json`), or it was never queued.
  Waiting again does not change an unknown result, and `squeal retry` runs the
  file again under the same cap.
- The file is still pending after the per-file cap plus five minutes, counted
  from your first wait at the revision you will push.

Then do these three things:

1. Run the tests in that file that the change adds, changes or reads:
   `npm test -- <file> -t '<name>'`. Check that each run reports passed tests,
   not only skipped ones. Run the whole file (`npm test -- <file>`) only when no
   test name covers the change, for example after an edit to a shared testkit.
2. In the PR's Verification, record the file and its Squeal state (unknown and
   its reason, or pending and for how long). Also record the load average
   (`uptime`), the logical CPU count (`nproc`), and each command with its passed
   and skipped counts.
3. Let CI's four Vitest shards give the file's full verdict. A focused pass is
   not a full pass, and the PR does not merge until the shards pass.

A file that gets a verdict must pass: the bound covers a missing verdict, never
a failure. The bound also covers a test file that Squeal re-runs only because
the change edited a document it reads. For example, an edit to
`AGENT_PROTOCOL.md` prose re-runs
`packages/cezar/src/core/harness-parity.test.ts`, and the focused run is
`npm test -- packages/cezar/src/core/harness-parity.test.ts -t "counted roster"`
(hearsay-tools/cezarion#1326).

**Without Squeal.** Squeal is optional. If it is absent, no daemon is validating, or a needed result
is unknown, run affected test files/test names through npm. Inspect
`npm run test:changed -- --plan` before using `npm run test:changed`; if the plan
falls back to a full run, choose focused checks and leave the full gate to CI.
The browser project's globalSetup uses
the existing test environment bootstrap to prepare or reuse the app and Chrome;
a missing browser is an error in a Squeal run. `npm test` and `npm run test:watch` select
only the four unit projects. Typecheck and build remain separate checks;
run them when the change needs them. When Squeal is unavailable, use focused
browser specs for affected UI flows, e.g.
`npm run test:e2e -- smoke.e2e.ts -t 'test name'` (see `packages/web/e2e/README.md`).

**When a manual Vitest run is needed, use npm, never `npx vitest`.** It is a devDependency of this repo, so `npm test`
uses the installed, version-pinned binary; `npx` will happily reach past it and fetch a different
version from the registry, which is a slow, networked, silently-different test run. To narrow a run,
pass vitest's own arguments after `--`:

```bash
npm test -- packages/web/src/routes/settings   # one directory
npm test -- --testTimeout=30000 path/to/one.test.ts
npm test -- -t "the name of one test"
```

When Squeal is unavailable, `npm run test:changed` compares the branch against
the merge-base with local `origin/main` (or `main`), including staged, unstaged,
and untracked files. Use
`-- --base=<ref>` to override, or `-- --plan` to inspect without running tests.
It selects Vitest tests through the import graph for ordinary source changes;
shared/configuration/unknown inputs, deletions, or unavailable Git/base information
fall back to full Vitest. Clean changes, and changes confined to CI's docs-only
list, explicitly skip iteration tests. `isDocsPath` in
`.github/scripts/change-surface.cjs` is the exact definition. To classify the
current branch's commits as CI does, run
`git diff --name-only --no-renames origin/main...HEAD | jq -R . | node .github/scripts/change-surface.cjs`;
it prints `docs-only`, `infra-only` or `full-matrix`. Markdown that a Vitest
test or cockpit browser spec reads (`testReadDocuments`) is never docs-only.
`.github/scripts/change-surface-readers.test.cjs` fails
when a Vitest test or browser spec reads a docs-only file. No matching tests is
an error: select the relevant test files explicitly and report any coverage gap
rather than treating it as a pass. Import graphs do not cover every runtime
dependency, so this command is only iteration feedback, never a replacement for
CI's final gate.

**Packaged CLI E2E runs by hand.** Packaged tests (`npm run test:package`,
`packages/cezar/test/e2e/*.test.ts`) exercise built output, and Squeal never runs
them, with or without its daemon. Run `npm run build` from the repo root after
relevant source changes; then, from `packages/cezar`, run
`node --import ../../scripts/test-git-env.mjs --import tsx --test <files>` with
paths relative to that directory (e.g. `test/e2e/task-cli.test.ts`). In an unbuilt worktree they fail with a
`Cannot find module` error naming a missing `dist/` module; an assertion failure
is a real failure that needs investigation.

**Browser E2E.** Cockpit browser E2E is a separate command from packaged CLI E2E — it boots the real app and
drives it in a real Chrome through the `agent-browser` provider (`.ai/browsers/agent-browser.md`):

```bash
npm run test:e2e    # .ai/scripts/e2e.sh → test-env-up.sh + vitest (packages/web/e2e/)
npm run test:e2e:local # explicitly requested full local browser run, four lanes (~8 GiB peak)
```

Use `npm run test:e2e` for focused local specs and CI's serial shards. Reserve
`npm run test:e2e:local` for an explicitly requested full local browser run or CI
failure investigation. Both print a `TEST_E2E_STATUS` marker: `skipped` means
agent-browser could not be provisioned and is not a pass, and a filtered run's
`passed` is not a full-suite pass. The server runs under `CEZ_DRY_RUN=1` from a
separate e2e build against an isolated clone, never this checkout or its
production build; stop it with `.ai/scripts/test-env-down.sh`. A red spec leaves a
failure bundle under `.ai/qa/failures/`: read it before theorizing about a flake.
Start at `packages/web/e2e/README.md` to write or fix a spec; it also holds the
exit contract, the served clone, the bundle contents and the four-lane run.

`CEZ_DRY_RUN=1 npm run dev` still exercises the whole cockpit offline for manual verification.
To check a UI change by hand in a real browser, run `node .ai/scripts/qa-fixture.mjs up`
(hearsay-tools/cezarion#1406); `packages/web/e2e/README.md` § Checking a UI change by hand
says what it serves and how it stops.

**Typecheck.** Run `npm run typecheck`; it checks all workspaces without building or writing `dist`. After `npm run build`, run `npm run typecheck:package` to check packaged tests.

**In a unit test, a timeout is a hang guard, never the thing the test waits on.**
Wait for the product's own signal: an event, a callback, a store write, a file
the fixture publishes. A test that proves something did NOT happen moves past
the window with fake timers, or says at the call site why it needs real time.
Size a bound per step, not per row or sequence: a loop of N turns gets a
per-turn budget, or a window that restarts on each sign of progress
(hearsay-tools/cezarion#1145). A product budget a test shrinks, such as a Git
timeout or an autosave budget, applies only to the step it exercises and never
races its own fixture's startup (hearsay-tools/cezarion#1144,
hearsay-tools/cezarion#1146). Any bound that remains states its reason at the
call site, as a `// bound: <reason>` comment. Baselines that only shrink hold
the rest: bare sleeps, waits under the floor (Vitest's 1 s default counts) and
poll loops with no deadline, in `npm run lint`: `cez/test-wait-discipline`
(server, 10 s) and `cez/unit-wait-discipline` (cockpit, 3 s).
The three baselines keep their paths. Shrink them with
`TEST_WAIT_DISCIPLINE_UPDATE=1 npm run lint` (server) or
`UNIT_WAIT_DISCIPLINE_UPDATE=1 npm run lint` (cockpit). A new site gets the product's signal or a `// bound:` reason, never a
baseline entry; a failing scan names the command that shrinks its baseline.
The scan cannot see a shrunk product budget, so review checks that one.


## CI owns the final gate

**The final gate and full-suite runs belong in CI.** Do not run the entire local
gate, `squeal run --all`, or the full Vitest or browser suite just to finish a
task, commit, open a PR, or complete a review. Run a full local suite only when
explicitly requested or needed to investigate a CI failure. A full local Vitest
run is CI's four shards: `npm test -- --shard=N/4 --maxWorkers=4`,
for N=1..4, one after another. An unsharded `npm test`
is not the local full gate: on a host with about 30 GiB free it can be OOM-killed
(exit 137). Squeal's `baseline.onStart: "lookup-then-run-missing"` reuses cached
results and runs missing tests at startup; Stop requires neither a full nor a slow suite.
Record the tested revision (or uncommitted diff), commands or Squeal status,
outcomes, and subsequent edits in the handoff. After later code changes, rerun
affected checks. A targeted run, skipped browser suite, or old pass for changed
inputs never counts as a full pass. CI independently enforces the complete gate
in `.github/workflows/ci.yml`; check its required aggregate before merge.

CI's final gate covers:

```bash
npm run typecheck   # check all four workspaces without building
npm test -- --shard=N/4 --maxWorkers=4  # vitest, N=1..4 — server + cockpit unit suites
npm run test:unit   # node:test — fast core-module coverage (packages/cezar/test/unit/)
npm run build       # tsc → dist/, vite → packages/cezar/web/dist/, then the check:pack tarball gate
npm run test:package # pack/install the release tarball and exercise the built CLI (packages/cezar/test/e2e/)
npm run test:e2e     # cockpit browser E2E in CI shards; skipped is not a pass
```

`npm test` and `npm run test:unit` are the fast unit gate: no server, no browser. They must stay that way. `npm run test:package` needs a completed `npm run build` (it packs the tarball). Pull request CI runs packaged CLI E2E and cockpit browser E2E as separate checks; the required aggregate fails if the cockpit suite is skipped or failed.

Read [`docs/sdlc/ci.md`](../../../docs/sdlc/ci.md) before you:

- investigate, cite or file a CI or load-dependent test failure, or back a PR
  with a full local run that failed only under load (§ Investigating a CI or load
  failure, which includes the one-CPU load reproduction);
- edit `ci.yml` or a workflow it calls (§ Proving a `ci.yml` change);
- add or split a Vitest unit test file that takes longer than about one minute
  on CI (the duration manifest, after the Vitest sequencer paragraph).


<a id="parity-suites"></a>

## Parity suites before a PR


Before opening a PR that changes wait,
turn-end, failure or step-settlement paths in `packages/cezar/src/workflows/run.ts` or
`workflows/run/`, verify every suite matching
`packages/cezar/src/core/*-parity.test.ts` and
`packages/cezar/src/workflows/*-parity.test.ts`: with Squeal, run
`squeal status --wait 60000 packages/cezar/src/core/*-parity.test.ts packages/cezar/src/workflows/*-parity.test.ts`
and require a passing verdict for every selected file that gets one. Repeat the
wait only for files that are still pending. When a file gets no verdict, follow
[the bound on a Squeal wait](#squeal-wait-bound): run the parity cells that the
change affects with `npm test -- <file> -t '<name>'`, record them in the PR's
Verification, and let CI's Vitest shards give the file's full verdict. Without
Squeal, run
`npm test -- packages/cezar/src/core/*-parity.test.ts packages/cezar/src/workflows/*-parity.test.ts`.

