# One run checkout module for the cockpit's checkout routes

Decision record: [ADR 0062](../../docs/adr/0062-one-module-decides-run-checkout-access.md).
Glossary: [Run checkout](../../GLOSSARY.md#run-checkout), [Checkout intent](../../GLOSSARY.md#checkout-intent).
Epic: hearsay-tools/cezarion#3158.
Baseline: `main` at `c1ba6f5bf`. The owner approved the plan on 2026-11-10 (planner task
ccaba06a), with B4 in the form Decision 6 states. The rules of
[the worktree retention spec](2026-07-18-worktree-retention.md) and
[the worktree file editing spec](2026-07-20-worktree-file-editing.md) stay; this spec changes
where the routes decide which checkout they use and which guards apply.

Paths are under `packages/cezar/src/` unless they name a package. `srv` means
`server/server.ts`. Line numbers are as of the baseline; every slice moves them.

## Problem

Fourteen cockpit routes in `srv` touch a run's checkout: `diff`, `changes`, `commits`,
`commit/:sha`, `files`, `file-link`, `git/commit`, `git/push`, `pr`, `remove-worktree`,
`DELETE /runs/:id`, `open-in`, `open-in-cli` and `/worktrees/:runId/reclaim`. Each handler
decides by hand which directory it uses, which guards apply and in which order. At the baseline:

- **22 direct guard calls in the 14 handlers.** 6 calls to `worktreeOf` or
  `workingDirectoryOf` (`srv:3740`, `:3758`, `:3770`, `:3860`, `:3915`, `:3929`); 5
  `existsSync` checks on a worktree path (`srv:3629`, `:3668`, `:3728`, `:3965`, `:4150`);
  4 `autosaveCleanupBlocker` calls (`srv:3726`, `:3738`, `:3913`, `:3927`); 4 claim calls
  (`claimForPublish` at `srv:3957`, `:3996`, `:4013`; `claimWorktreeReclaim` at `:4143`); 3
  `manager.isActive` calls (`srv:3954`, `:3994`, `:4008`). `open-in-targets.ts:36` adds one
  more `existsSync`.
- **Five rules choose a directory to read, write or open, and three more choose what to publish
  or remove** (Table A, column *Directory*). `git/commit`, `git/push` and the `/open-in` `default`
  target share one rule (`worktreeOf`). A run with no checkout gets 409 from most routes, 400
  from `/pr` (`srv:3966`), and 200 from `/diff` (`srv:3729`) and `/file-link` (`srv:3782`).
- **The on-disk autosave-cleanup guard runs in 4 of the 14 handlers** (`diff`, `changes`,
  `git/commit`, `git/push`). `pr`, `remove-worktree` and `DELETE` get it inside
  `claimForPublish` (`workflows/run/maintenance-claims.ts:67`), and reclaim inside
  `claimWorktreeReclaim` (`:31`). `commits`, `commit/:sha`, `files`, `file-link`, `open-in` and
  `open-in-cli` have none. The four explicit checks came together in
  hearsay-tools/cezarion#944 (commit `20cff2044`), route by route.
- **One claim, three routes, two wordings.** `claimForPublish` guards publish and also
  `remove-worktree` and `DELETE`. A refused claim answers `its worktree or branch is being
  cleaned up — retry in a moment` on `/pr` (`srv:3958`) and `worktree cleanup pending — retry
  after cleanup is confirmed` on the other two (`srv:3997`, `:4014`).
- **7 same-file clone pairs between these handlers** (jscpd at 50 tokens and 5 lines, as
  `.github/scripts/check-clones.cjs` runs it): `srv:3607↔3651` (82 tokens), `3608↔3990` (51),
  `3722↔3909` (92), `3734↔3923` (97), `3755↔3767` (81), `3755↔3857` (70), `3912↔3926` (76). Two
  more pairs sit between the artifact routes (`3798↔3814`, 104; `3798↔3826`, 101), which stay out
  of scope.
- **`srv` has 5,519 lines and is pinned at exactly 5519** in `file-length.baseline.json:11`
  (limit 1,000). A slice that adds a net line fails lint.
- **Every test of a guard boots the app.** 14 server test files reach these routes, and each
  builds the whole app with `createApp`: `server/git-changes.test.ts`,
  `server/worktrees-api.test.ts`, `server/draft-pr-route.test.ts`,
  `server/open-in-targets.test.ts`, `server/open-in-cli-resume.test.ts`,
  `server/health-forge.test.ts`, `server/open-in-file.test.ts`,
  `server/fallback-run-controls.test.ts`, `server/delegation-cleanup.test.ts`,
  `server/run-ownership-controls.test.ts`, `server/request-validation.test.ts`,
  `server/forge/ref-status-invalidation.test.ts`, `server/artifacts-api.test.ts` (`file-link`) and
  `server/route-parity.test.ts`. No test calls `worktreeOf`, `workingDirectoryOf` or
  `handoffFallbackCommand`: they are closures inside `createApp` (`srv:4079-4085`, `:1345`).

## Decisions

1. **One module, `server/run-checkout.ts`.** It takes a run id, a checkout intent and a
   per-route option set. It returns a refusal or a handle. A refusal carries a literal status
   and today's body: `{ error }`, with no extra field (`manual` and `command` stay in the
   handlers, because the module never produces them). A handle carries the run record and the
   directory. For the publish and remove intents it also carries the claim's `release`. The route
   calls `release` in `finally`, after all of its async work. The open intent's handle resolves
   its directory when the handler calls `directory()`, not during the synchronous lookup:
   `open-in-cli` checks `existsSync` after its provider `await` (`srv:3627-3629`), and a lookup
   before that `await` could hand out a worktree path that was removed meanwhile. The module
   holds no route. If it
   would pass about 12 exported members or 1,000 lines, it splits by intent into
   `server/run-checkout/<intent>.ts` behind the same entry.
2. **Five intents.** Each intent has its own check set and its own handle:

   | Intent | Routes | Claim | Rematerialize | Refuses a foreign owner | Why it is its own intent |
   |---|---|---|---|---|---|
   | read | `diff`, `changes`, `commits`, `commit/:sha`, `files`, `file-link` | none | never (ADR 0009) | never (ADR 0006) | Reads must answer for every run, on every owner |
   | mutate | `git/commit`, `git/push` | none | never | yes, through the middleware | Writes Git state but keeps the directory. Git serializes its own index; the worktree mutation lock stays in `git-worktree.ts` (ADR 0003) |
   | publish | `pr` | `claimForPublish` | yes, under the claim | yes | Holds a claim across rematerialize, push and `gh`, then writes the `draft-pr` exit |
   | remove | `remove-worktree`, `DELETE /runs/:id`, `/worktrees/:runId/reclaim` | `claimForPublish` (first two), `claimWorktreeReclaim` (reclaim) | never | yes | Deletes the directory; a removal must never rebuild it |
   | open | `open-in`, `open-in-cli` | none | never | yes, through the middleware | Hands a directory to an outside program and falls back to the repository root |

   A separate `reclaim` or `delete` intent was rejected: each differs from remove only in its
   claim and its `canDeleteRun` kind, which are per-route options. Three intents (read, write,
   open) were rejected: publish and remove need a claim and mutate does not.
3. **Check and claim in one synchronous step** (ADR 0032). The module's entry is synchronous:
   it reads the record, runs the checks and takes the claim with no `await` between them. It
   calls `manager.claimForPublish` and `manager.claimWorktreeReclaim`; it does not replace them
   and never imports `MaintenanceClaims` (ADR 0053). The spy test
   `server/worktrees-api.test.ts:418` keeps passing. Publish's rematerialize is a second, async
   function of the module that runs under the claim the first one took.
4. **What the module never does.** A read never refuses a foreign owner (ADR 0006) and never
   rematerializes (ADR 0009). The run claim never replaces the worktree mutation lock
   (ADR 0003). Artifact reads keep reading `runArtifactDirectory` and need no checkout
   (ADR 0043); they stay out of the module. Handlers keep a literal `c.json(body, status)` call
   for every answer, and a refusal's `status` field has a literal type, so Hono keeps inferring
   each route's response union (ADR 0016).
5. **The ownership middleware stays in front.** `adoptFallbackControl`, `requireRunControl`
   (`srv:3133-3147`, mounted at `:3153-3154`) and `protectFallbackRun` (`server/project-run-files.ts:10-17`)
   run before the handlers, as today. hearsay-tools/cezarion#3117 owns them.
6. **Unchanged in P1:** every status code, refusal string, extra field (`manual`, `command`,
   `path`), contract schema in `packages/contract/src/runs.ts`, and check order. Where routes
   disagree today, the module takes a named per-route option that reproduces today's behavior
   exactly (Table C). Each P2 slice deletes the option it fixes. Differences Table C marks
   *Kept* stay as named options. Only the P2 slices change behavior. B4's rule is fixed by the
   owner: git commit and git push answer 409 `{ error: 'the agent is still working in this
   worktree' }` only when the run's `status === 'running'`, the rule the web client applies
   (`packages/web/src/lib/git-actions.ts:70`, `:81`). It does not use `manager.isActive`,
   because a parked `waiting` run stays in the engine's active set (`workflows/run.ts:436`), and
   Commit and Push keep working while a run is `waiting` or `queued`.

The module reads the project through a narrow host: `root`, and `Pick`s of `RunStore`
(`getRun`, `updateRun`, `sourceDataDir`, `writeRefusal`, `fallbackDeleteError`, `canDeleteRun`) and
`RunManager` (`isActive`, `claimForPublish`, `claimWorktreeReclaim`). The route passes
`c.get('project')`. `updateRun` serves publish's async step: `rematerializeReclaimedWorktree`
takes a `RematerializeStore` (`getRun`, `updateRun`; `runs/retention.ts:78-81`) and clears the
reclaim stamp after it rebuilds the worktree (`:105`). The table test builds the host from fakes
and boots no app.

## Slices

Each slice is one pull request into `main` and changes no behavior, unless its row says so.
Tests run only through Squeal. Before its first push each slice needs a passing Squeal verdict
at its head for the test files its *Acceptance check* lists and for lint (file length, ast-grep,
oxlint) ([AGENTS.md § Validation](../../AGENTS.md#validation)). Squeal does not cover
`npm run typecheck`, `npm run check:clones` and
`node .ai/skills/check-code-quality/scripts/complexity-gate.mjs --base origin/main --head HEAD`;
the slice runs those by hand. A slice that shrinks `srv` runs `FILE_LENGTH_UPDATE=1 npm run lint`
and commits the lower pin.
Coordinators merge reviewed pull requests with green CI through land-pr.

**Parallel work.** Every P1 slice edits the route section of `srv` (`:3605-4159`) and the
helper block (`:4074-4085`), so P1 is a chain: 1.1 → 1.2 → 1.3 → 1.4, each rebased on the one
before. A P2 row starts when its prerequisite P1 slice has merged. P2 rows that edit the same
handler rebase in this order: B1 then B4 (`git/commit`, `git/push`); B5 then B6 (`changes`);
B2 then B8 (`DELETE`); B3 and B9 touch `open-in` and `open-in-cli`, B9 first. Draft PR
hearsay-tools/cezarion#3149 touches only the `srv` imports and its pin: the second of it and any
slice to merge rebases and reruns `FILE_LENGTH_UPDATE=1 npm run lint`. The quoting fix
(Coordination) edits `srv:249` and `:1347`, outside the section.

| Slice | Change | Files and regions at the baseline | Removes | Behavior change | Needs merged | Acceptance check |
|---|---|---|---|---|---|---|
| P0 | This spec, ADR 0062, glossary entries, pointers in two area docs | docs only | — | none | — | `node .github/scripts/check-citations.cjs` |
| 1.1 | Create `server/run-checkout.ts` with the entry, the five intents, the read intent's checks and options, and the intent × run-state table test `server/run-checkout.test.ts` (no app boot) with one row for every Table A row and for every Table B refusal the module answers (Table B, *Answered by*). Route tests keep pinning the refusals the middleware and the handlers answer. Move `worktreeOf`, `workingDirectoryOf` and `NO_WORKTREE` into the module; `worktreeOf` and `NO_WORKTREE` stay exported until 1.2 and 1.4 convert their last callers. The six read routes ask the module once | `srv:3722-3791`, `:3850-3862`, `:4074-4085`; new `server/run-checkout.ts`, `server/run-checkout.test.ts` | clone pairs `3722↔3909`, `3734↔3923`, `3755↔3767`, `3755↔3857`; 4 direct helper calls and 2 `autosaveCleanupBlocker` calls in read handlers | none | — | Squeal verdict for `packages/cezar/src/server/run-checkout.test.ts packages/cezar/src/server/git-changes.test.ts packages/cezar/src/server/worktrees-api.test.ts packages/cezar/src/server/fallback-run-controls.test.ts packages/cezar/src/server/artifacts-api.test.ts packages/cezar/src/server/typed-bodies.test.ts packages/cezar/src/server/contract-parity.runs.test.ts packages/cezar/src/server/route-parity.test.ts packages/cezar/src/server/run-ownership-controls.test.ts` |
| 1.2 | `git/commit` and `git/push` ask the module with the mutate intent | `srv:3909-3941` | clone pair `3912↔3926`; the `worktreeOf` export; 2 `autosaveCleanupBlocker` calls | none | 1.1 | Squeal verdict for `packages/cezar/src/server/run-checkout.test.ts packages/cezar/src/server/git-changes.test.ts packages/cezar/src/server/worktrees-api.test.ts packages/cezar/src/server/forge/ref-status-invalidation.test.ts packages/cezar/src/server/typed-bodies.test.ts packages/cezar/src/server/contract-parity.runs.test.ts packages/cezar/src/server/run-ownership-controls.test.ts` |
| 1.3 | `pr`, `remove-worktree`, `DELETE /runs/:id` and `/worktrees/:runId/reclaim` ask the module with the publish and remove intents. The claims, the explicit checks before them, the reclaim's inline fallback and `writeRefusal` check (`srv:4140`) and the dirty-file count after a failed reclaim (`srv:4150`) move into the module. Reclaim keeps its release point: `.finally(release)` on `reclaimWorktree` (`srv:4147`), so the dirty-file count runs after the release, unclaimed, as today. Rematerialize and the dir/branch check of `/pr` become the module's async publish step. The removal itself stays `releaseThenRemoveWorktree` in the handler | `srv:3943-4019`, `:4133-4159` | clone pair `3608↔3990`; 4 claim calls, 3 `isActive` calls and 2 `existsSync` checks in handlers | none | 1.2 | Squeal verdict for `packages/cezar/src/server/run-checkout.test.ts packages/cezar/src/server/worktrees-api.test.ts packages/cezar/src/server/draft-pr-route.test.ts packages/cezar/src/server/delegation-cleanup.test.ts packages/cezar/src/server/fallback-run-controls.test.ts packages/cezar/src/server/run-ownership-controls.test.ts packages/cezar/src/server/contract-parity.runs.test.ts packages/cezar/src/git-worktree-release.test.ts packages/cezar/src/workflows/maintenance-claims.test.ts` |
| 1.4 | `open-in` and `open-in-cli` ask the module with the open intent for the run and the directory. The hosted-mode check, session, provider, fallback-write, account and terminal steps stay in the handlers and in `open-in-targets.ts` in today's order. `openRunDefaultApp` takes the handle's worktree instead of reading `run.worktreePath`. Each handler calls the handle's `directory()` where it computes `cwd` or `dir` today (`srv:3629`, after the provider `await`; `:3668`) | `srv:3605-3680`; `server/open-in-targets.ts:29-38` | clone pair `3607↔3651`; 3 `existsSync` checks (`srv:3629`, `:3668`, `open-in-targets.ts:36`); the `NO_WORKTREE` export | none | 1.3 | Squeal verdict for `packages/cezar/src/server/run-checkout.test.ts packages/cezar/src/server/open-in-targets.test.ts packages/cezar/src/server/open-in-cli-resume.test.ts packages/cezar/src/server/open-in-file.test.ts packages/cezar/src/server/health-forge.test.ts packages/cezar/src/server/request-validation.test.ts packages/cezar/src/server/contract-parity.runs.test.ts packages/cezar/src/server/run-ownership-controls.test.ts` |
| B1 | The mutate intent refuses a `.ai/squawk/` worktree right after 404, as `/pr` does (`srv:3952`), with the same text. The checks in `commitAll` and `pushCurrentBranch` (`server/git-changes.ts:639-640`, `:661-662`) stay | `server/run-checkout.ts` (mutate) | — | yes: the fallback refusal now wins over the autosave blocker and `NO_WORKTREE`. Red test first: a fallback run with persisted autosave evidence gets the fallback text on both routes | 1.2 | the red test in `server/run-checkout.test.ts` and `server/fallback-run-controls.test.ts`; Squeal verdict for `packages/cezar/src/server/git-changes.test.ts packages/cezar/src/server/worktrees-api.test.ts` |
| B2 | The remove intent refuses a usage-limit hold before the claim, as `/pr` does (`srv:3956`), with `run is waiting on a usage-limit hold — choose Don’t resume in the task’s usage-limit hint, then retry`. Deletes the `ignoresHold` option | `server/run-checkout.ts` (remove) | `ignoresHold` | yes: `remove-worktree` and `DELETE` on a held run answer 409; reclaim of a held run keeps 409 with the hold text instead of its claim text. Red test first: `remove-worktree` on a held run answers 200 and clears `worktreePath` today | 1.3 | the red test in `server/auto-resume-api.test.ts`, which seeds held runs (`:58`); Squeal verdict for `packages/cezar/src/server/run-checkout.test.ts packages/cezar/src/server/draft-pr-route.test.ts packages/cezar/src/server/delegation-cleanup.test.ts` |
| B3 | `open-in-cli` never resumes a session the engine owns (`engineOwnsRun`): it opens the run's CLI fresh in the directory, as the `/open-in` cli target does (`server/open-in-targets.ts:101`, `:107`). Deletes the `ignoresEngineOwnership` option. B3 changes only an engine-owned run that has a session. `open-in-cli` stays a resume route: its 409 `no agent session to resume` (`srv:3625`) stays where it is and unchanged for every state, so a run without a session, `queued` included, still gets it | `srv:3623-3647`; `server/run-checkout.ts` (open) | `ignoresEngineOwnership` | yes: on a `queued`, `running` or `waiting` run (not a hold) that has a session, the command is the fresh CLI, not `--resume`. A run without a session: unchanged. Red test first | 1.4 | the red test in `server/open-in-cli-resume.test.ts`; Squeal verdict for `packages/cezar/src/server/health-forge.test.ts packages/cezar/src/server/open-in-targets.test.ts` |
| B4 | The mutate intent refuses a run whose `status === 'running'` with 409 `{ error: 'the agent is still working in this worktree' }`, after the 404 and the fallback check. The owner chose this form on 2026-11-10: the server mirrors the web client's status check once, at admission, and takes no claim. A run that starts during the Git operation is not refused. The agent's own Git commands and Git's index lock are unchanged | `server/run-checkout.ts` (mutate) | — | yes: API and CLI callers can no longer commit or push while the agent runs; `queued` and `waiting` runs still can. Red test first | 1.2 | the red test in `server/run-checkout.test.ts` and `server/git-changes.test.ts`; Squeal verdict for `packages/cezar/src/server/worktrees-api.test.ts` |
| B5 (implemented, hearsay-tools/cezarion#3186) | `/changes` on a run with a worktree builds its listing in a private copy of the real index, as `worktreeDiff` does (`withPrivateIndex`, `git-worktree.ts:842-867`), instead of `git add -N .` on the real index (`server/git-changes.ts:275-277`). The scratch branch for `intentToAdd: false` and fallback paths (`:270-274`) stays | `server/git-changes.ts:255-300`; `srv:3742-3748` | the real-index branch of `collectChanges` | yes: the agent's index is never written by a read. Red test first: the real index's bytes and mtime are unchanged after `GET /changes` on a worktree with an untracked file | 1.1 | the red test in `server/git-changes.test.ts`; Squeal verdict for `packages/cezar/src/server/worktrees-api.test.ts packages/cezar/src/server/github-pr-changes-api.test.ts`; Squeal's browser group for `packages/web/e2e/task-changes.e2e.ts` and `packages/web/e2e/markdown-preview.e2e.ts` |
| B6 | The read intent never checks autosave cleanup up front; mutate, publish and remove always do. Deletes the read intent's `checksAutosave` option. A read can still write the live index in one case: `withPrivateIndex` falls back to it when no scratch directory can be created (`git-worktree.ts:852-856`, ADR 0003). B6 adds a `beforeLiveIndex` check to that path for `diff` and `changes`: it asks the autosave blocker first and refuses with today's 409 text when one is set. Result contract: `worktreeDiff` takes the check as an optional parameter and, when it refuses, returns a typed refusal carrying the blocker text instead of a diff string. The `diff` handler (`srv:3731`) answers that refusal with `c.json({ error }, 409)` and keeps `c.text` for a diff. `run-settlement.ts:390` passes no check and keeps the string result. `collectChanges` returns its existing `{ ok: false, error }`, which the `changes` handler already answers with 409 (`srv:3749`) | `server/run-checkout.ts` (read); `git-worktree.ts:842-895`; `server/git-changes.ts:255-300`; `srv:3722-3732` | `checksAutosave`; the up-front autosave refusal on `diff` and `changes` | yes: `GET /diff` and `GET /changes` answer under persisted autosave evidence, unless the read must fall back to the live index. Red tests first: both answer 200 under evidence; with scratch allocation failing, both still answer 409 `{ error: <blocker text> }` (JSON, not a 200 text body) and leave the live index untouched | B5 | the changed case at `server/worktrees-api.test.ts:464`; Squeal verdict for `packages/cezar/src/server/run-checkout.test.ts packages/cezar/src/server/git-changes.test.ts` |
| B7 | `/pr` with no worktree or branch answers 409 with the same text | `server/run-checkout.ts` (publish) | the no-checkout branch | shipped: status 400 → 409, same text. Red test first | 1.3 | the red test in `server/draft-pr-route.test.ts`; Squeal verdict for `packages/cezar/src/server/contract-parity.runs.test.ts packages/cezar/src/server/typed-bodies.test.ts` |
| B8 | `DELETE /runs/:id` checks the record (404) before `isActive`. Deletes the `activeBeforeLookup` option | `server/run-checkout.ts` (remove) | `activeBeforeLookup` | yes: an unknown id that the manager counts active answers 404, not 409. Red test first | 1.3 | the red test in `server/run-checkout.test.ts`; Squeal verdict for `packages/cezar/src/server/worktrees-api.test.ts packages/cezar/src/server/fallback-run-controls.test.ts` |
| B9 | The `/open-in` `default` target resolves its directory with the working-directory rule: a `worktree: false` run opens its image from the repository root. Deletes the `defaultTargetNeedsWorktree` option | `server/run-checkout.ts` (open); `server/open-in-targets.ts:29-38` | `defaultTargetNeedsWorktree` | yes: `worktree: false` runs no longer get 409 `NO_WORKTREE` from the default target. A missing worktree still does. Red test first | 1.4 | the red test in `server/open-in-targets.test.ts`; Squeal verdict for `packages/cezar/src/server/open-in-file.test.ts` |

**Exit on integrated `main`:** each of the 14 routes asks the module once; no in-scope handler
calls `worktreeOf`, `workingDirectoryOf`, `existsSync` on a worktree path,
`autosaveCleanupBlocker`, `manager.isActive` or a claim method directly; the table test covers
every Table A row; the `srv` pin is lower than 5519; every approved P2 row has merged with its
red test; CI passes.

### Guards each slice keeps green

| Guard | What fires on a move | What the slice does |
|---|---|---|
| File length (`lint/file-length.ts`, `file-length.baseline.json:11`, `.github/scripts/baseline-growth.cjs`) | `srv` growing past 5519; a stale pin after a cut; a new file over 1,000 lines; a raised pin | Each P1 slice net-shrinks `srv` and runs `FILE_LENGTH_UPDATE=1 npm run lint`. The module splits by intent before it nears 1,000 lines |
| Clone gate (`.github/scripts/check-clones.cjs`) | A new cross-file pair (`srv` ↔ the module); a same-file clone in a new file (`New same-file clone`); a grown same-file total in `srv` | Remove the repeated preludes; never move two copies of a prelude into the module. Each handler's call is one statement and one refusal line |
| Complexity gate (`complexity-gate.mjs`, `docs/sdlc/ci.md:382-415`) | A new or grown function over 20 | Move bodies verbatim first (a moved identical body matches its source), then change them in a later commit |
| ast-grep `server-declared-validator-schema` (`.ai/ast-grep/rules/server-declared-validator-schema.yml:8`) | Covers `srv` only | Routes stay in `srv`'s chains. A slice that moves a route out adds the new file to the rule's `files:` |
| `AppType` chain: `server/typed-bodies.test.ts`, `server/contract-parity.runs.test.ts:83-88`, `server/route-parity.test.ts` | A route that leaves the chain; a success branch the handler no longer infers | Keep every route in its chained family; keep literal `c.json(body, status)` calls |
| Middleware order: `server/run-ownership-controls.test.ts:65`, `server/fallback-run-controls.test.ts:74`, `:174`, `:192` | A guard that answers before `requireRunControl`, or an adoption on a read | The module runs inside the handler, after the middleware |
| Spy on `RunManager.claimForPublish`: `server/worktrees-api.test.ts:418` | A claim taken through `MaintenanceClaims` instead of the manager | The module calls `manager.claimForPublish` and `manager.claimWorktreeReclaim` |
| `git-worktree-release.test.ts` source scan | A direct `removeWorktree` or `removeOwnedWorkspace` call | Run worktrees leave through `releaseThenRemoveWorktree`; owned worker workspaces through `releaseThenRemoveOwnedWorkspace` (delegation cleanup). The module removes neither |

Tests per slice are in the *Acceptance check* column.

## Orders that must survive

| Operation | Order | Today |
|---|---|---|
| ownership | the `/api/*` origin guard, then `adoptFallbackControl`, then `requireRunControl`, then route middleware (`protectFallbackRun`, validators), then the handler and the module | `srv:3153-3154`; `server/project-run-files.ts:33-47`; `srv:3989`, `:4005` |
| lookup | 404 before any run-state check, on every route, including `DELETE /runs/:id` (B8 implemented) | `srv:4008-4010` |
| claim | the explicit checks, then the claim, with no `await` from the record read to the claim; the claim before rematerialize and before any other `await` | `srv:3950-3958`, `:3992-3996`, `:4007-4013`, `:4138-4143` |
| release | `release()` in `finally` after all async work under the claim: rematerialize, push, `gh`, Git removal, `deleteRun` | `srv:3982-3984`, `:4002`, `:4018` |
| reclaim release | `.finally(release)` on `reclaimWorktree`; the dirty-file count after a failed reclaim runs after the release, unclaimed | `srv:4147-4150` |
| open directory | `open-in-cli` resolves its directory after the provider `await`; the module resolves it only when the handler calls `directory()` | `srv:3627-3629` |
| removal | Two removal paths, each releasing the preview before Git removes the checkout: `releaseThenRemoveWorktree` for a run worktree, and `releaseThenRemoveOwnedWorkspace` for an owned worker workspace, which only delegation cleanup calls. The module removes neither; the handlers call `releaseThenRemoveWorktree` | `git-worktree-release.ts:6-44`; `srv:3999`, `:4016`; `delegation/worker-cleanup.ts:256` |
| publish | claim → rematerialize → read the record again (404) → dir and branch check → `createPR` → `draft-pr` exit → note → 201 | `srv:3957-3981` |
| open-in-cli | 404 → hosted → session → provider → directory → fallback write → command (resume, or fresh when engine-owned) → account → fallback command → terminal | `srv:3611-3646` |
| `/open-in` cli target | fallback write → provider → engine ownership → command → account → fallback command → terminal | `server/open-in-targets.ts:96-128` |

## Case tables

The run states and their exits do not change, so the **Transitions out** table of the template
does not apply: `/pr` keeps its `draft-pr` exit (`srv:3976`, `runs/run-exits.ts`), and no
other route writes a status. The **Worktree cases** table applies to B5 only: it changes how
`GET /changes` touches a running task's index. Tables A to C are the case tables for this
change.

### Table A: each route and its checks, in today's order

A cell holds the step number and the line in `srv` (or the named file). `—` means the route does
not run the check. *MW* is the ownership middleware: `adoptFallbackControl` →
`requireRunControl` (`srv:3153-3154`); GET routes pass it (`srv:3135`), and `DELETE /runs/:id`
skips adoption (`server/project-run-files.ts:36`). The reclaim route is not under `/runs/:id`,
so no middleware runs for it. Step `0` marks the middleware, which runs before the handler. *AB* is `autosaveCleanupBlocker(store.sourceDataDir(id), id)`.
*Claim* includes the checks inside the claim (`maintenance-claims.ts:31`, `:67`: already
claimed, the manager's autosave blocker, `isActive`, `writeRefusal`; reclaim adds
`isReclaimable`).

| Route (handler) | Intent | MW | 404 | Fallback | Active | Hold | AB | Directory | Worker | canDelete | Claim | Rematerialize |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| GET `diff` (`:3722-3732`) | read | — | 1 `:3725` | — | — | — | 2 `:3726` | 3 `:3728`: worktree if it exists, else 200 text `(no worktree — …)` (`:3729`); ignores `worktree: false` | — | — | — | — |
| GET `changes` (`:3734-3751`) | read | — | 1 `:3737` | — | — | — | 2 `:3738` | 3 `:3740`: `workingDirectoryOf`, else 409 `NO_WORKTREE`; real index written at `:3747` | — | — | — | — |
| GET `commits` (`:3754-3763`) | read | — | 1 `:3757` | — | — | — | — | 2 `:3758`: `workingDirectoryOf` | — | — | — | — |
| GET `commit/:sha` (`:3766-3775`) | read | — | 1 `:3769` | — | — | — | — | 2 `:3770`: `workingDirectoryOf` | — | — | — | — |
| GET `files` (`:3850-3907`) | read | query validator | 1 `:3859` | — | — | — | — | 2 `:3860`: `workingDirectoryOf` | — | — | — | — |
| GET `file-link` (`:3777-3791`) | read | param, query validators | 1 `:3780` | — | — | — | — | 2 `:3782`: `worktreePath ?? root`, no `existsSync` | — | — | — | — |
| POST `git/commit` (`:3909-3921`) | mutate | 0, body validator | 1 `:3912` | 4 `git-changes.ts:639` | — | — | 2 `:3913` | 3 `:3915`: `worktreeOf`, else 409 `NO_WORKTREE`, also for `worktree: false` | — | — | — | — |
| POST `git/push` (`:3923-3941`) | mutate | 0 | 1 `:3926` | 4 `git-changes.ts:661` | — | — | 2 `:3927` | 3 `:3929`: `worktreeOf` | — | — | — | no: a reclaimed row gets 409 `NO_WORKTREE` |
| POST `pr` (`:3947-3985`) | publish | 0 | 1 `:3951`; again 7 `:3964` | 2 `:3952`, on `worktreePath` | 3 `:3954` | 4 `:3956` | in claim | 8 `:3965`: worktree exists and `branch` set, else 400 | rematerialize skips workers (`runs/retention.ts:101`) | — | 5 `:3957` `claimForPublish` | 6 `:3962` |
| POST `remove-worktree` (`:3989-4003`) | remove | 0, `protectFallbackRun('worktree')` | 1 `:3993` | middleware | 2 `:3994` | — | in canDelete and claim | stored `worktreePath`, no `existsSync` (`:3999`); clears `worktreePath` and `branch` (`:4000`) | 3 `:3995`: refuses | 3 `:3995` `(id, 'worktree')` | 4 `:3996` `claimForPublish` | — |
| DELETE `/runs/:id` (`:4005-4019`) | remove | 0 (no adoption), `protectFallbackRun('record')` | 1 `:4010` | middleware | 2 `:4008` | — | in canDelete and claim | stored `worktreePath`, no `existsSync` (`:4016`) | keeps the worker's checkout (`:4016`) | 3 `:4012` `(id)` | 4 `:4013` `claimForPublish` | — |
| POST `/worktrees/:runId/reclaim` (`:4136-4159`) | remove | none; param validator | 1 `:4139` | 2 `:4140`, with `writeRefusal` | in claim | — | in claim | `isReclaimable` needs the directory; dirty count at `:4150` | `isReclaimable` (`retention.ts:35-45`) | — | 3 `:4143` `claimWorktreeReclaim` | — |
| POST `open-in-cli` (`:3607-3648`) | open | 0 | 1 `:3611` | 5 `:3630`, on the directory | — (resumes an engine-owned session) | — | — | 4 `:3629`: worktree if it exists, else repository root (after hosted 2 `:3614`, session 3 `:3625`, provider `:3627`) | — | — | — | — |
| POST `open-in` (`:3651-3680`) | open | 0, body validator | 1 `:3655` | cli target: `open-in-targets.ts:96`; app target: none | cli target: `engineOwnsRun` picks a fresh CLI (`open-in-targets.ts:101`) | — | — | 3 `:3668`: worktree if it exists, else repository root (after hosted 2 `:3656`); `default` target: `workingDirectoryOf` (repository root for `worktree: false`, otherwise live worktree), else 409 `NO_WORKTREE` | — | — | — | — |

### Table B: every refusal site

*Readers* names the code outside `srv` that reads the exact text or status. Every refusal
reaches the web client as `ApiError.message` (`packages/web/src/api/client.ts:249-262`), which
also lifts `manual` and `command`. *After P1* is the value when P1 has merged; *After P2* names
the row that changes it.

*Answered by* after P1. The module answers rows 1, 2, 5, 6, 13 to 17, 19, 21 to 23 and 25 to 27,
and rows 9, 10 and 20 once B1, B4 and B2 have merged. The table test in
`server/run-checkout.test.ts` pins these. The middleware answers rows 3 and 4. The handlers answer
row 7 (from the module's `null` directory), rows 8, 11, 12, 18, 24 and 28 to 36, and row 9 until
B1. Route tests keep pinning these; the module never produces provider, account, terminal, forge,
Git or file errors.

| # | Route | Status and exact body today | Readers | After P1 | After P2 |
|---|---|---|---|---|---|
| 1 | every route but reclaim | 404 `{ error: 'not found' }` | `packages/web/src/routes/task-git/git-tab-loading.tsx:34`, `routes/task-thread/task-thread.tsx:142`, `lib/project-switch.ts:192`; `server/git-changes.test.ts:598`, `:707`; `server/open-in-file.test.ts:165`; `server/health-forge.test.ts:332` | unchanged | DELETE: before the active check (B8 implemented) |
| 2 | reclaim | 404 `{ error: 'not found' }` | none | unchanged | unchanged |
| 3 | POST and DELETE under `/runs/:id` | 409 `{ error: RUN_IN_USE_ELSEWHERE }`, `RUN_QUARANTINED` or the fallback text, from `requireRunControl`; 409 adoption error from `adoptFallbackControl` | `server/run-ownership-controls.test.ts:65-90`; `server/fallback-run-controls.test.ts:91-105` | unchanged (middleware) | unchanged |
| 4 | `remove-worktree`, DELETE | 409 `{ error: 'Cannot write read-only project data in <path>. Use the binary that migrated the project.' }` from `protectFallbackRun` | `server/fallback-run-controls.test.ts:74-89` | unchanged (middleware) | unchanged |
| 5 | `diff`, `changes`, `git/commit`, `git/push` | 409 `{ error: <autosave blocker text> }` (`autosave-cleanup.ts:48-73`) | `server/worktrees-api.test.ts:464` (status, for `changes`, `git/commit`, `git/push`) | unchanged | `diff`, `changes`: admitted with a private index; no up-front check, live-index fallback keeps the 409 blocker (B6); commit, push: implemented after the fallback check (B1) |
| 6 | `changes`, `commits`, `commit/:sha`, `files`, `git/commit`, `git/push` | 409 `{ error: 'no worktree — this task ran directly in the repo working tree' }` | `packages/web/src/lib/git-actions.ts:65`; `routes/task-git/task-changes.tsx:104-105`, `task-commits.tsx:47-50`, `task-files.tsx:55`; web tests `task-files.test.tsx:481`, `task-changes.test.tsx:254`, `project-switch.client.test.ts:53`; `server/git-changes.test.ts:654-686` | unchanged | unchanged |
| 7 | `diff` | 200 text `(no worktree — this task ran directly in the repo working tree)` | `packages/web/src/lib/unified-diff.ts:7`, `unified-diff.test.ts:131`, `components/run-diff.tsx:49`, `routes/task-thread/review-panel.test.tsx:180`; `cez task diff` (`task-cli/cli.ts:688-690`) | unchanged | unchanged |
| 8 | `changes`, `commits`, `commit/:sha`, `git/commit`, `git/push` | 409 `{ error: <git error> }` | `server/git-changes.test.ts` (`nothing to commit`, `no remote configured`) | unchanged | unchanged |
| 9 | `git/commit`, `git/push` | 409 fallback text, from `commitAll` / `pushCurrentBranch` after the directory check | `server/run-checkout.test.ts`, `server/fallback-run-controls.test.ts` pin fallback, autosave and missing-directory precedence | unchanged | implemented right after 404, from the module (B1) |
| 10 | `git/commit`, `git/push` | none today | — | — | 409 `{ error: 'the agent is still working in this worktree' }` when `status === 'running'` (B4); the client already shows `Commit unavailable — the agent is still working in this worktree` (`git-actions.ts:70`, `:81`) |
| 11 | `files` | 409 `{ error }` from `readWorktreePath`; raw: `raw serving is limited to images: <path>`, `file too large to serve raw (<n> bytes): <path>` | `server/git-changes.test.ts:721`, `:744`, `:753`, `:830`, `:842`; `routes/task-git/file-preview.tsx:54` | unchanged | unchanged |
| 12 | `file-link` | 409 `{ error: 'Only bounded raster images can be served inline.' }` | `server/artifacts-api.test.ts:67` (status) | unchanged | unchanged |
| 13 | `pr` | 409 fallback text (`srv:3953`) | none | unchanged | unchanged |
| 14 | `pr` | 409 `{ error: 'run is still active — wait for the review gate' }` | `git-actions.ts:104` mirrors it as `Create PR unavailable — the run is still active; wait for the review gate` | unchanged | unchanged |
| 15 | `pr` | 409 `{ error: 'run is waiting on a usage-limit hold — choose Don’t resume in the task’s usage-limit hint, then retry Draft PR' }` | `server/draft-pr-route.test.ts:74-83` | unchanged | unchanged |
| 16 | `pr` | 409 `{ error: 'its worktree or branch is being cleaned up — retry in a moment' }` | same text in `workflows/continuation-admission.ts:232` (Continue) | unchanged | unchanged |
| 17 | `pr` | 409 `{ error: 'no worktree/branch to publish — this task ran in the repo working tree' }` | `review-panel.tsx` toasts any status; sibling text in `server/forge/draft-pr.ts:24` | B7 shipped: 400 → 409, same text | 409, same text (B7) |
| 18 | `pr` | 409 `{ error: <forge error>, manual: 'git merge <branch>' }` | `review-panel.tsx` (`setManual`); `repo-git/repo-not-landed.tsx:220` | unchanged (built in the handler) | unchanged |
| 19 | `remove-worktree`, DELETE | 409 `{ error: 'run is active — cancel it first' }` | `packages/web/src/api/client.ts:196` (comment), `client.test.ts:533-537` | unchanged | DELETE: after 404 (B8 implemented) |
| 20 | `remove-worktree`, DELETE, reclaim | Phase 1: no explicit hold refusal; B2: 409 hold text before the claim | `server/auto-resume-api.test.ts` and `server/run-checkout.test.ts` | B2 implemented | 409 `{ error: 'run is waiting on a usage-limit hold — choose Don’t resume in the task’s usage-limit hint, then retry' }` (B2); reclaim answered row 26 for a held run before |
| 21 | `remove-worktree` | 409 `{ error: 'owned resources require verified worker cleanup' }` | `server/delegation-cleanup.test.ts:42-61`, `server/worktrees-api.test.ts:252-270` (status) | unchanged | unchanged |
| 22 | DELETE | 409 `{ error: 'owned resources require verified worker cleanup and explicit child history deletion first' }` | `server/worktrees-api.test.ts:252-270` (status) | unchanged | unchanged |
| 23 | `remove-worktree`, DELETE | 409 `{ error: 'worktree cleanup pending — retry after cleanup is confirmed' }` | `server/worktrees-api.test.ts:433-445` (status) | unchanged | unchanged |
| 24 | DELETE | 409 `{ error: 'history cleanup incomplete — retry deletion' }` | none | unchanged | unchanged |
| 25 | reclaim | 409 `{ error: <fallbackDeleteError or writeRefusal> }` (`srv:4140`) | `server/fallback-run-controls.test.ts:192-205` | unchanged | unchanged |
| 26 | reclaim | 409 `{ error: "this worktree is in use or already reclaimed — only a finished task's worktree can be reclaimed" }` | `server/worktrees-api.test.ts:405-430` (status) | unchanged | B2 implemented: a held run gets row 20 before the claim; other claim refusals stay unchanged |
| 27 | reclaim | 409 `{ error: 'the worktree has <n> uncommitted file(s) that exist nowhere else — commit or discard them first' }` (singular `file` for 1) or `'the worktree directory could not be removed'` | `server/worktrees-api.test.ts` (status) | unchanged | unchanged |
| 28 | `open-in-cli` | 409 `local handoff is disabled — this cockpit runs in hosted mode (CEZ_REMOTE); resume the session from a machine that has the checkout` | `server/open-in-cli-resume.test.ts:273`, `server/health-forge.test.ts:312`, `:318` (substring `hosted mode`) | unchanged (handler) | unchanged |
| 29 | `open-in` | 409 `local handoff is disabled — this cockpit runs in hosted mode (CEZ_REMOTE)` | `server/open-in-cli-resume.test.ts` | unchanged (handler) | unchanged |
| 30 | `open-in-cli` | 409 `no agent session to resume` | `packages/web/src/routes/task-thread/run-header.test.tsx:623-627`; `git-actions.ts:135` mirrors it; `server/health-forge.test.ts:325` | unchanged | implemented in B3: unchanged for every state, before the engine-ownership choice |
| 31 | `open-in-cli`, `open-in` cli target | 409 provider block; 409 fallback text; 409 account error; 409 `this account's folder cannot be used in a terminal command`; 409 `{ error: 'no terminal emulator found', command }` | `server/open-in-cli-resume.test.ts:281-314`; `server/open-in-targets.test.ts:104-132`; `packages/web/src/api/client.test.ts:552`; `run-header.test.tsx:590-611` | unchanged (handler) | implemented in B3: the `command` is fresh on an engine-owned run with a session; fresh launches use the project account; other refusals stay unchanged |
| 32 | `open-in-cli` | 409 `the recorded session id has an unexpected shape` | none | unchanged | unchanged |
| 33 | `open-in` default target | 409 `{ error: NO_WORKTREE }` without a live worktree, also for `worktree: false` | `server/open-in-targets.test.ts:72-78` (runs with no `worktree` flag) | unchanged | `worktree: false`: opens from the repository root; absent or missing worktree without that flag: 409 `NO_WORKTREE` (B9 implemented) |
| 34 | `open-in` default target | 400 `path required for the default-app target`; 409 `not a file: <path>`, the SVG text, `opening in the default app is limited to images: <path>`, `{ error: 'could not open <path>', path }` | `server/open-in-file.test.ts:165-179` | unchanged | unchanged |
| 35 | `open-in` cli target | 409 `the configured OMP executable cannot be used in a terminal command` (or `Cursor`) | `server/open-in-cli-resume.test.ts` | unchanged | unchanged |
| 36 | `open-in` app target | 409 `{ error: 'could not open <target>', path }` | `server/open-in-targets.test.ts:65-70` | unchanged | unchanged |

### Table C: dispositions of every difference between routes

D-numbers are the research's disagreements; B-numbers are the plan's rows.

| # | Difference | Disposition | Reason or slice |
|---|---|---|---|
| D1 | The autosave guard runs on `diff` and `changes` but not on `commits`, `commit/:sha`, `files`, `file-link` | Implemented B6 (after B5): reads skip the up-front guard; live-index fallback checks it | One rule per intent. `diff` reads through a private index (`git-worktree.ts:888`), and after B5 `changes` does too. A read then writes the live index only when no scratch directory can be created (`git-worktree.ts:852-856`); B6 keeps the autosave refusal on that path |
| D1 | `open-in` and `open-in-cli` have no autosave guard | Kept | The open intent has no guard; B6 does not add one |
| D2 | Routes read the autosave evidence under `store.sourceDataDir(id)`; claims read the manager's memory, then its own data dir (`workflows/run/worktree-autosave.ts:67-70`); `canDeleteRun` reads `this.dataDir` (`runs/store.ts:2970`) | Kept | The approved plan's Kept list. Fallback writes are refused by other checks. Switching routes to the manager's blocker would refuse more often |
| D3.1 | `worktree: false` runs: reads use the repository root, commit and push refuse | Kept | `server/git-changes.test.ts:615-665` pins both; the client mirrors it (`git-actions.ts:69`, `:78`). A commit in the user's own checkout is not the task's |
| D3.2 | A removed or reclaimed worktree: reads answer 409 `NO_WORKTREE` (they never read the root) | Kept | `server/git-changes.test.ts:667-686`; the rule from open-mercato/cezar#735 |
| D3.3 | `open-in` and `open-in-cli` fall back to the repository root for a reclaimed or removed run | Kept | Plan Kept list; `server/open-in-targets.test.ts:58-63`; `runs/retention.ts:91` |
| D3.4 | `/diff` answers 200 placeholder text where others answer 409 | Kept | Protected surface (`srv:4074-4076`, ADR 0002); `unified-diff.test.ts:131`; `cez task diff` prints it. Option: the read handle's directory is `null` and the route answers the text |
| D3.5 | `/file-link` uses `worktreePath ?? root` with no `existsSync` and may read project files | Kept | Plan Kept list; `artifacts/resolve.ts:101-116` (`allowedRoot`) |
| D3.6 | `/open-in` `default` target uses the root for a `worktree: false` run, as do its app and cli targets and `/files`; an absent or missing worktree without that flag still refuses | B9 implemented | Same run, same directory |
| D3.7 | "No checkout" answers 409 on `/pr`; refusal text unchanged | B7 shipped | Every other refusal of this kind is 409 (worktree file editing spec, L666-667) |
| D3.8 | Only `/pr` (and Continue) rebuild a reclaimed worktree; `git/push` on the same row answers 409 `NO_WORKTREE` | Kept | Not in the approved plan; Draft PR is the documented rebuild path (worktree setup spec, L73) |
| D4.1 | `/pr` says `run is still active — wait for the review gate`; `remove-worktree` and DELETE say `run is active — cancel it first` | Kept | Each text names the action that unblocks it; `client.test.ts:533-537` and `git-actions.ts:104` read them |
| D4.2 | `git/commit` and `git/push` have no server-side run-state check; only the client disables them for `running` | B4 | The server is the guard; API and CLI callers bypass the client |
| D4.3 | Both routes open a fresh CLI for an engine-owned run with a session; `open-in-cli` still refuses a missing session first | B3 implemented | A second CLI would write to the transcript the engine writes (`open-in-targets.ts:83-87`) |
| D5 | Publish and remove refuse a usage-limit hold; remove checks it after active and removal refusals, before the claim | B2 implemented | `remove-worktree` on a held run passes `isActive` (a hold is a `failed` run moved to `waiting`, not in the active set, `workflows/run/auto-resume.ts:70`, `:98`), clears `worktreePath` (`srv:4000`), and the resume then runs in the repository root (`workflows/run/continuation-session.ts:109`). For DELETE the resume finds no record (`auto-resume.ts:110-111`); B2 covers it for one rule per intent |
| D6.1 | `git/commit` and `git/push` refuse a fallback worktree after the autosave and directory checks; `/pr` refuses right after 404 | B1 | The research premise ("no refusal") was wrong: `commitAll` and `pushCurrentBranch` already refuse with the same text (`server/git-changes.ts:639-640`, `:661-662`). B1 now refuses right after 404, before autosave and directory checks; both helper checks stay |
| D6.2 | Four fallback mechanisms: `/pr` inline, open routes inline on the directory, remove and DELETE by middleware, reclaim inline with `writeRefusal` | Kept | The middleware stays (Decision 5). The reclaim check moves into the module unchanged (1.3). The open routes keep their positions (1.4) |
| D6.3 | Every matched POST adopts a fallback family before the handler, also `open-in` and `open-in-cli` | Kept | Middleware owned by hearsay-tools/cezarion#3117 |
| D6.4 | `open-in-cli` checks the provider before the fallback; the `/open-in` cli target checks the fallback first | Kept | Not in the approved plan; 1.4 moves only the directory |
| D7.1 | `remove-worktree` refuses a worker; DELETE accepts it and keeps its checkout | Kept | `server/delegation-cleanup.test.ts:42-61` pins 409 and 200 |
| D7.2 | `/changes` on a run with a worktree (workers included) now runs intent-to-add, anchor resolution and the listing in `withPrivateIndex`, copied from the real index | B5 implemented (hearsay-tools/cezarion#3186) | The normal read preserves real index bytes and mtime, staged entries and older intent-to-add entries. A missing index is seeded privately from HEAD. ADR 0003's no-scratch degraded fallback remains; repo and fallback paths retain their HEAD-seeded scratch index |
| D7.3 | `claimWorkerCleanup` checks `hasExecution` and skips `writeRefusal` | Out of scope | Worker destroy |
| D8.1 | `claimForPublish` also guards `remove-worktree` and DELETE | Kept | Facade name and spy test stay (ADR 0053; `worktrees-api.test.ts:418`) |
| D8.2 | A refused `claimForPublish` has two wordings | Kept | Plan Kept list; the `/pr` text matches Continue's (`continuation-admission.ts:232`) |
| D8.3 | A null claim folds four causes into one text | Kept | The explicit checks before the claim keep their own texts |
| D9 | `remove-worktree` uses `canDeleteRun(id, 'worktree')`, so a delegation root needs every child history deleted first, and the text does not name children | Kept | Not in the approved plan |
| D10 | Reclaim keeps the branch and needs a clean tree; `remove-worktree` deletes the branch and forces | Kept | Plan Kept list; `srv:4133-4135` |
| D11 | DELETE checks 404 before `isActive` (B8 implemented) | B8 | One check order |

### Worktree cases for B5

B5 changes no file in the worktree. It stops `GET /changes` from writing the running task's
index (`server/git-changes.ts:276`). The index of a linked worktree lives in the Git directory,
and the agent's `git status`, `git stash` and `git commit` read it.

| Case | Files written, kept or removed | Index state at the next agent step, Continue and restart |
|---|---|---|
| The worktree has no index yet (fresh worktree, nothing staged) | Today: `git add -N .` creates the real index with intent-to-add entries. After B5: the copy fails, the private index is seeded from `HEAD` (`git-worktree.ts:865`); nothing is written in the Git directory | Today: the agent sees every untracked file as a new intent-to-add entry. After: the agent sees its own index, unchanged |
| A path staged by the agent and also changed in the tree | Today: kept; `-N` does not touch tracked entries. After: the copy keeps the staged entry | Unchanged in both |
| Intent-to-add entries that an older cezar wrote into the real index | After B5: kept; B5 does not clean them. The listing reads them from the copy | Unchanged: they stay until the agent commits or resets |
| A crash between the index write and the listing | Today: Git may leave `index.lock` in the run's Git directory, and the agent's next Git write fails until it is removed. After: a crash leaves a `cez-diff-index-*` directory in the OS temp directory or the Git directory; the real index is untouched | After: the agent's Git commands are unaffected |
| The agent deletes or renames a file during the listing | Today: the real index holds an intent-to-add entry for a path that no longer exists. After: only the private copy holds it, and it is removed | After: the agent's index has no stray entry |
| No scratch directory can be created (temp directory and Git directory not writable) | `withPrivateIndex` falls back to the real index (ADR 0003: a degraded fallback, not the normal guarantee); a `.ai/squawk/` worktree refuses instead (`git-worktree.ts:853-854`). B6 checks autosave before this fallback | As today in that degraded case; under autosave evidence the read refuses with the blocker text, as `changes` does today |
| `worktree: false` run and `.ai/squawk/` worktree | Unchanged: they already use a scratch index seeded from `HEAD` (`server/git-changes.ts:270-274`) | Unchanged |

### Reader sweep for each P2 row

Each P2 slice sweeps these readers ([CODE_REVIEW.md § Changing working behavior](../../CODE_REVIEW.md#changing-working-behavior))
with `rg --hidden -n -F` for the old and the new value, and updates its Table B and Table C rows.
A row covers what a reader sees on success as well as on refusal.

| Row | What changes for a reader | Readers | Disposition |
|---|---|---|---|
| B1 | Which 409 text a fallback run gets from `git/commit` and `git/push` when it also has autosave evidence or no worktree | `packages/web/src/routes/task-git/commit-dialog.tsx` and the push action in `task-changes.tsx` (toast of `ApiError.message`); `server/fallback-run-controls.test.ts`; `server/worktrees-api.test.ts:464` (a non-fallback run); `docs/areas/runs-store.md:72` | No code reader changes. The red test pins the new precedence |
| B2 | New 409 on `remove-worktree` and `DELETE` for a held run; reclaim's text for a held run | `removeRunWorktree` (`packages/web/src/api/client.ts:2184-2191`); `deleteRun` in `routes/task-thread/run-header.tsx:471`; `reclaimRunWorktree` in `routes/repo-git/worktrees-panel.tsx:74`; all toast the message. `server/worktrees-api.test.ts:405-430` (reclaim status) | No web change; the reclaim status stays 409 |
| B3 | Success: `command` is the fresh CLI, not `--resume`, for an engine-owned run that has a session. A run without a session still gets 409 `no agent session to resume`, and the client hides the Terminal button (`routes/task-thread/run-actions.ts:149`) and disables the menu entry for it (`lib/git-actions.ts:130-136`). The fresh CLI opens on the project's account (`resolveProfileEnvForRoot`), as the cli target does (`server/open-in-targets.ts:115-120`), not on the session's account. The terminal opens in the same directory | `useResumeInTerminal` (`routes/task-thread/run-workspace.tsx:71-80`) and the Terminal action in `routes/task-git/task-changes.tsx:82-95` read only `error.command`; the client hides the Terminal button and menu entry for such runs (`routes/task-thread/run-actions.ts:149`, `lib/git-actions.ts:137`); `server/open-in-cli-resume.test.ts` (`/open-in-cli` cases at `:144`, `:290`, `:301`, `:385`); `routes/task-thread/run-header.test.tsx:590-627` | Tests that resume an engine-owned run change in the slice; no web change |
| B4 | New 409 `the agent is still working in this worktree` for a `running` run | the client already disables both actions with the same words (`lib/git-actions.ts:70`, `:81`); `server/git-changes.test.ts` route cases (their runs are not `running`) | No web change |
| B5 | `/changes` output is unchanged; the run's live index no longer gains intent-to-add entries, so the agent's `git status` and `git stash` stop seeing them | the comment at `server/git-changes.ts:262-266`; `/repo/changes` (`srv:4627`, already a scratch index, unchanged); `packages/web/e2e/task-changes.e2e.ts`, `markdown-preview.e2e.ts`; ADR 0003 (now holds for `changes` too) | Rewrite the comment; no reader changes |
| B6 | `diff` and `changes` answer 200 under autosave evidence | `server/worktrees-api.test.ts:464` (drops `/changes`); the cockpit's neutral 409 rendering (`routes/task-git/task-changes.tsx:104-105`) no longer shows the blocker; `cez task diff` (`task-cli/cli.ts:679-691`) gets 200 | Updated the test; CLI and cockpit consume the admitted 200 unchanged; settlement calls without a check and keeps a string |
| B7 | Status 400 → 409 for no worktree or branch on `/pr`; the `AppType` error union of the route loses 400 | `routes/task-thread/review-panel.tsx` (toasts any status); `routes/task-git/task-changes.tsx:75` and `routes/repo-git/repo-not-landed.tsx:220` (toast any status); `createRunPr` forwards to the generic unwrap; `server/contract-parity.runs.test.ts:87` reads only 201 and `typed-bodies.test.ts` has no 400 reader | Checked for B7: no reader change |
| B8 | Implemented: an unknown id the manager counts active answers 404, not 409 | `deleteRun` doc comment (`api/client.ts:1587`); `lib/project-switch.ts:192` treats 404 as gone | No web change |
| B9 implemented | Success: for a `worktree: false` run the `default` target opens `<repository root>/<path>` and answers `{ opened: true, path }` with that path; containment and the image gate stay (`server/open-in-targets.ts:40-69`, ADR 0031) | `openRunFileInApp` from the diff pane (`routes/task-git/task-changes.tsx:97-100`); `server/open-in-targets.test.ts:72-78` (runs with no `worktree` flag, unchanged); `server/open-in-file.test.ts` | No web change |

## Older specs that disagree with the code

The code wins. This spec changes none of these, except where a P2 row says so.

- **"All degrade with 409 + human reason"** ([cockpit UI redesign spec](2026-07-14-cockpit-ui-redesign.md),
  L155) and **"`{ error }` + `400/404/409` uniformly"** ([worktree file editing spec](2026-07-20-worktree-file-editing.md),
  L666-667). `/diff` answers 200 text for no worktree (kept), and `/pr` now answers 409. B7 brought
  `/pr` in line with both specs, so those older spec lines need no changes.
- **"In a fallback worktree … Git writes … refused"** ([runs-store area doc](../../docs/areas/runs-store.md),
  L72). The code matches for commit and push, but the refusal comes from the Git helpers, after
  the autosave and directory checks. B1 moves it to the front.

## Open decisions

None. The owner settled the plan, B4's form and the merge path on 2026-11-10.

## Coordination

- **Independent fix, any time:** `handoffFallbackCommand` (`srv:1345-1347`) interpolates `cwd`
  into `cd '${cwd}'` without `shellQuote` (`core/shell-env.ts:14`). A repository path with `'`
  breaks the copy-paste command, and `$()` or backticks in a path stay inside quotes only by
  accident. The fix calls `shellQuote(cwd)` and adds it to the import at `srv:249`; `srv` keeps
  its length. Red test first: it runs the command's `cd` part through `sh` with spaces,
  apostrophes, `$`, `$()` and backticks in the path, and checks that the shell lands in that
  directory and runs nothing else. `server/open-in-targets.test.ts:108` and
  `packages/web/src/routes/task-thread/run-header.test.tsx:590`, `:608` keep passing (identical
  output for paths without `'`). The Windows `cd` spelling is a separate issue. Its own issue
  draft; it shares no region with P1.
- Out of scope: artifact routes (they read the data directory), Continue (engine admission),
  `worker-destroy` (delegation), bulk reclaim, branch delete, the preview socket, agent-only
  routes, and the session-handoff logic.
- hearsay-tools/cezarion#3117 owns `requireRunControl` and `adoptFallbackControl`. Its
  coordinator checks overlap with the middleware rows of Table A.
- hearsay-tools/cezarion#963 changes `autosaveCleanupBlocker` semantics that the module calls;
  hearsay-tools/cezarion#1110 changes what publish pushes. Their coordinators check overlap with
  1.3 and B6.
- Each slice's pull request names this spec and the epic. The planner gets each slice's pull
  request number.
