# Code review rules

How to review a diff in this repository. Applies to humans and to the `om-code-review` skill alike. The full validation gate in `.ai/agentic.config.json` must be green before merge approval. CodeRabbit reviews automatically on push, including drafts. Its deterministic native admission gate follows cheap preflight and releases expensive verification only when it passes. The full gate remains: typecheck, the vitest unit/component suites (`npm test`, as CI's four shards), the node:test core-module suite (`npm run test:unit`), build (which includes the `check:pack` tarball gate), the packaged CLI E2E (`npm run test:package`), and the cockpit browser E2E (`npm run test:e2e`). The unit/component suites are the fast correctness gate. Packaged CLI E2E and cockpit browser E2E are separate checks; pull request CI rejects a skipped or failed cockpit suite.

Reviewers reuse recorded successful validation for unchanged tested inputs; do not
ask for the entire suite again merely because a commit, PR, or review round began.
During fixes, run targeted tests (`npm run test:changed` or explicit files/names).
Before sign-off, rerun gates affected by later code edits; shared configuration,
dependency/contract changes or uncertain impact require the full gate. Review-only
and Markdown-only edits do not invalidate runtime evidence. Evidence must identify
the tested revision/diff, commands and outcomes; targeted tests and browser skips
are not full passes. See `SDLC.md` § Validation gate. Required CI is unchanged.

## CI surface rules

Docs/process-only PRs may have skipped Vitest and cockpit browser E2E only when the required build/package aggregate is green and `verify` succeeds; docs-only still requires fresh CodeRabbit admission after preflight before build/package verification starts. CI uses the trusted `pull_request_target` workflow definition and checks out PR code only in the jobs that execute it. The exact allowlist is root-level `*.md` and root-level `LICENSE*`; recursive `docs/`, `.ai/specs/`, and `.ai/analysis/`; `*.md` at any depth under `packages/` outside `fixtures`, `__fixtures__`, and `__snapshots__` directories; the generated upstream scan data `.ai/upstream/ledger.yaml`, `.ai/upstream/LEDGER.md`, and dated `.ai/upstream/scans/YYYY-MM-DD.md` reports, optionally with a same-day suffix `-N` where N is 2 or more; and `AGENTS.md`, `CODE_REVIEW.md`, and `SDLC.md`. Markdown a Vitest test or cockpit browser spec reads (`testReadDocuments` in `.github/scripts/change-surface.cjs`: `AGENT_PROTOCOL.md`, `.ai/specs/2026-09-04-harness-parity-matrix.md`) is never docs-only. Any mixed change, unlisted path, malformed input, or classifier failure is full-matrix and must pass every check plus automated review. Build/package verification is never skipped.

Infra-only PRs (#468) follow the same rule: every changed path must be an allowlisted ops workflow — `.github/workflows/report-workflow-failure.yml`, `sweep-ci-failures.yml`, `upstream-scan.yml`, `npm-preview-cleanup.yml`, `publish-pr-snapshot.yml`, or `issue-intake.yml` — or the engine script of one of them (`.github/scripts/ci-sweep-api.cjs`, `ci-sweep-collect.cjs`, `ci-sweep-patterns.cjs`, `ci-sweep-report.cjs`, `apply-issue-intake.cjs`, `issue-intake-candidates.cjs`, `jev-issue-intake.cjs`, `jev-intake-replay.cjs`, each with its `.test.cjs` sibling). Infra-only skips Vitest and cockpit browser E2E while `build-and-package` — which still runs every `.github/scripts` test through `npm run test:unit` — and `verify` stay required. Workflow and harness files that run or gate product suites (`ci.yml`, `release.yml`, `nightly.yml` — both execute `npm test` — `coderabbit-reconcile.yml`, `ci-benchmark.yml`, `change-surface.cjs`, `require-e2e-passed.cjs`, `ci-test-sequencer.mjs`, `coderabbit-admission.cjs`, `release-bump-pr.cjs`) are never infra-only: a PR that changes how product tests run or widens the skips runs the full matrix. Infra-only requires the same fresh review admission as docs-only.

The protected `Automated Code Review` check keeps its compatibility name. Native CI runs a deterministic read-only gate from trusted base scripts. It requires the newest `CodeRabbit` check from App `347564` / `coderabbitai` on the exact live head to be completed with `success`, and every review thread of every author to be resolved. Outdated threads still block. Missing, pending, skipped, neutral, failed, spoofed, stale or incomplete evidence fails closed. Formal review objects are not execution proof. Docs-only and infra-only still need this admission. Verified release-stamp and release-App upstream-ledger PRs may skip provider execution, but not thread resolution; author or branch alone never grants a skip.

The App starts automatic draft and incremental reviews without a label filter. `.coderabbit.yaml` disables auto-pause with zero. The owner removed the custom round and spend cap because CodeRabbit is free for this open-source repository. Automatic review starts before preflight; heavy verification still waits for preflight and admission. No model keys, model commands or owner PAT fallback are part of review CI.

`coderabbit-reconcile.yml` reads trusted default-branch scripts. Genuine provider check events, native CI completion and a no-permission review-event signal wake it. It maps exact heads to open same-repository main PRs and validates current native run/attempt/job identity before rerunning only the completed review gate when admission differs. It never retries tests or dispatches whole CI. GitHub may rerun dependent heavy jobs when that gate passes. Equal outcomes are no-ops; a new same-head pending review or reopened thread revokes admission. Forks retain their existing read-only queue support. They need a maintainer to rerun the native **Automated Code Review** job in Actions after provider completion or thread resolution; the reconciler dispatch does not retry forks.

Draft state follows fresh evidence as well as protected native CI checks. A new head returns to draft. A provider re-review or reopened thread returns a ready PR to draft. Board status follows existing draft/ready rules. Manual thread resolution has no GitHub event: dispatch **Reconcile CodeRabbit admission** with `pr_number`, and dispatch **PR Readiness** when only readiness needs refreshing. Ordinary review disagreements stay in CodeRabbit's finding thread; CI does not judge or resolve them. Existing historical provider threads remain blocking until their reviewer or an authorized human resolves them.

A flaky test needs **Re-run failed jobs** in native CI. Do not rerun a successful review to retry tests: GitHub may rerun its dependents too. Native jobs from before cutover cannot gain the new implementation by retrying; push a new head or start a new native run after rollout. The reconciler refuses legacy review jobs, disabled workflows, attempts at GitHub's 50-attempt limit and runs at least 30 days old. Inspect ambiguous rerun acceptance before retrying; it never blindly retries a POST. Coalesced or missing events use the manual reconciliation dispatch. See [CI recovery and proof limits](docs/sdlc/ci.md#re-running-a-review).

## Review priorities (in order)

1. **Correctness of the run lifecycle** — runs, steps, worktrees, sessions. A bug here loses user work.
2. **Graceful degradation** — the README's core promise: no `gh` → works without PRs, no network → local skills still load, no git repo → tasks run in place, `CEZ_DRY_RUN=1` → everything works offline. A diff that turns a degradation path into an error is a blocker.
3. **State-file compatibility** — `.ai/cezar/` files outlive the process and the version that wrote them (see `BACKWARD_COMPATIBILITY.md`).
4. **Security of the local server** — it binds to `127.0.0.1`, but it executes agents with file access; treat every request body as hostile.
5. **Simplicity** — "every module is meant to be read in one sitting." Push back on new dependencies or abstractions the change doesn't need; browser dependencies must justify their bundle and maintenance cost.

## Checklist

### TypeScript strictness

- `tsconfig.json` has `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride` — the diff must compile without weakening them.
- No `any`, no non-null assertions to silence the checker; prefer narrowing, `unknown` + zod, or explicit optional handling. Indexed access is checked — `arr[0]` is `T | undefined`, handle it.
- ESM with NodeNext resolution: relative imports carry the `.js` extension even in `.ts` files. `node:`-prefixed builtins.

### Zod at every boundary

- Every mutating API route parses its body with `schema.safeParse(await c.req.json().catch(() => null))` and returns `{ error: issues.join('; ') }` with 400 on failure — the established pattern in `packages/cezar/src/server/server.ts`. New routes must follow it; a route that trusts `c.req.json()` raw is a blocker.
- External process output crossing into the app (`gh … --json` in `packages/cezar/src/server/github.ts`, agent CLI streams) is zod-validated at the boundary, extras stripped.
- Persisted files read back in (`config.json`, workflow YAML, the run records in `runs.db`) go through their schema; parse failure degrades to a sane default, never a crash. The one exception is the run store itself: a `runs.db` that cannot be opened is never treated as an empty history (`RunStoreOpenError`, the project answers 409), and a damaged file is left as found.
- Schemas carry the limits (`.max()` on strings/arrays, image size caps, `variants` 1–3, steps ≤ 8). New inputs need explicit bounds — unbounded user input into a file write or a spawned process is a blocker.

### Graceful degradation

- Missing `gh` / no remote / offline: GitHub reads return `{ available: false, reason }`, PR creation returns `{ ok: false, error }` — never a throw, never a 500 for an expected absence.
- Missing or malformed `.ai/cezar/config.json` behaves exactly like the defaults and never blocks startup (`packages/cezar/src/config.ts`).
- git helpers in `packages/cezar/src/git-worktree.ts` never throw (except `createWorktree`); check the diff keeps that contract.
- `CEZ_DRY_RUN=1` paths must still work after the change — that is the offline demo and the de-facto integration test.

### Security

- No secrets in state files: nothing under `.ai/cezar/` (runs.json, NDJSON events, handoff.md, ui-state.json, config.json) may contain tokens or credentials. `GITHUB_TOKEN` stays in the environment; the launch key stays in the gitignored `launch-key` file and is only served same-origin.
- Server stays on `127.0.0.1`; CORS is for `/api/health` only (bookmarklet discovery, spec 011). Widening either is a blocker.
- Path handling on user-supplied names: file-serving routes must sanitize (`basename()` as in `/api/runs/:id/images/:file`); workflow names are slugified before becoming filenames. Any user string that reaches a path or a shell needs the same treatment.
- Spawned processes use `execFile`/`spawn` with argument arrays — never string-interpolated shell commands. Tool access for agents goes through a per-step allowlist (`allowedTools`), but the zero-config default includes unrestricted `Bash` (no `bashAllowlist`), and unapproved tools are denied without prompting (`--permission-mode dontAsk`; `CEZ_APPROVAL_GATE=1` opts into `acceptEdits` and Claude's approval UI; `CEZ_CLAUDE_PERMISSION_MODE=bypass` selects `--dangerously-skip-permissions`) — treat a run as having full shell access in its worktree, not a sandboxed allowlist. Some runners don't honor `allowedTools` at all; each runner's `specSupport.allowedTools` declares which (Codex: its own sandbox, approvals off, network on; OpenCode: its own permission config governs, cezar answers OpenCode's built-in asks once and routes asks from the user's own rules to the cockpit permission card, hearsay-tools/cezarion#1266; Cursor: no per-session tool allowlist) (#430).
- Writes that must not clobber use `wx` or tmp+rename; check new file writes follow one of those.

### State-file and API compatibility

- New fields on `RunRecord`/`StepState` are optional (or defaulted) so old `runs.json` files still parse — the existing comments ("old runs.json files … have neither") show the convention.
- NDJSON event logs are append-only; readers skip unparseable lines. Never rewrite or reorder an existing event file.
- Renaming/removing an API route, an event `type`, or a persisted field is a breaking change — route it through `BACKWARD_COMPATIBILITY.md`.

### Code quality

- Comments cite the spec or issue that motivated the code (`spec 006`, `#348`); non-obvious behavior in the diff should too.
- No new **server runtime** dependencies without strong justification — that dependency budget is hono, @hono/node-server, yaml, zod, smol-toml and ws, and nothing else. The list is exhaustive on purpose: adding to it is a review decision, so the commit that widens it updates this line and says why. (`ws` earned its place because Node ships a WebSocket *client* but no server and `@hono/node-server` provides none, so the `/api/ws` subscription bus had no in-tree option — spec `.ai/specs/2026-07-23-websocket-subscriptions.md`.) Browser packages are build-time dependencies and must remain locked, bundle-measured, and absent from the installed CLI's runtime dependency graph.
- Web UI changes belong under `packages/web/` and follow the accepted React 19 + Vite + Tailwind v4 + shadcn/ui architecture. Keep `packages/cezar/web/dist` reproducible from source, preserve light/dark/system themes and mobile/accessibility behavior, and add unit/component tests for changed behavior. (The legacy vanilla UI was retired in R7; the React cockpit is the only UI, and `/new` is the React composer.)
- User-facing errors are one human-readable line (the `createDraftPr` pattern), not stack traces.

### Cockpit e2e

- A change that fixes or retries a flaky cockpit spec carries its evidence in the PR description or a review thread, not in code comments: the failure bundle (`.ai/qa/failures/…`, the `cockpit-failures-shard-<n>` artifact) or a local reproduction with the single-test recipe in `packages/web/e2e/README.md`. One that carries neither is a guess; request changes. The same page names the wait rules — a one-shot `expect(browser.…)` after an action, `:hover` in a wait, a scrolling predicate, a sleep — and the `e2e-wait-discipline` baseline may only shrink in a diff.

## Severity guidance

- **Blocker** (request changes): data loss or corruption in `.ai/cezar/`; a degradation path turned into a hard failure; unvalidated request body on a mutating route; secret written to disk; server exposed beyond localhost or CORS widened; path traversal; breaking a documented interface without an explanation and migration path; typecheck/build red.
- **Major** (request changes unless trivially fixed in-review): incorrect run/step state transitions; SSE replay duplication or event loss; unbounded input reaching files or processes; a schema field added as required when old files carry it as absent.
- **Minor** (approve with comments): missing spec citation on non-obvious code; inconsistent error shape; naming/style drift; missed `wx`/tmp+rename on a low-stakes write.
- **Nit**: wording, formatting, comment polish. Never blocks.

Verdict: approve when there are no blockers or majors; otherwise request changes with each finding tagged by severity and file/line.
