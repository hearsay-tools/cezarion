# Git tab Pull implementation plan

> For agentic workers: use superpowers:subagent-driven-development for independent UI work; keep server integration in the controlling session.

**Goal:** Implement issue hearsay-tools/cezarion#67 with the Switch & pull design approved in chat on 2026-09-04.
**Architecture:** A project-scoped GET /repo/pull lists local branches; POST /repo/pull resolves the requested/base/current branch, checks risks before mutation, switches safely when necessary, then invokes git pull using that branch's configured upstream. The Git header owns one picker/action and a risk confirmation dialog.
**Tech stack:** TypeScript, Hono, Zod, React, TanStack Query, Vitest.
**Spec:** Issue https://github.com/wjarka/cezar/issues/67 plus approved in-chat design.

## Global constraints
- No new dependency, env knob, auto-stash, force checkout, or custom merge/rebase policy.
- Both route aliases, chained registration, middleware validation, exact contract parity.
- Confirmation permits trying Git; it never overrides Git's protection of local edits.
- A selected different branch stays checked out even if pull fails; UI refreshes after attempted mutation.
- Clean idle pulls have no confirmation. Active runs and any dirty checkout each require confirmation before switching or pulling.
- Native picker and primary buttons at least 44px; 360x640, light/dark, keyboard, reduced motion. No artwork needed for a Git operation.

## Task 1: Server contract and pull operation
Files: packages/contract/src/repo.ts; packages/cezar/src/server/repo-pull.ts and repo-pull.test.ts; server.ts; contract-parity.github.test.ts; typed-bodies.test.ts; BACKWARD_COMPATIBILITY.md.
Interfaces: RepoPullInput {branch?: string, confirm?: boolean}; RepoPullBranchesResponse {branches: string[]}; RepoPullResponse {branch: string, pulled: true, summary: string}; RepoPullConfirmation {error: string, branch: string, risks: ('active_runs'|'dirty_tree')[]}. Other 409s use {error: string}.
- [x] Write real local-remote Git fixtures and route tests: missing endpoint returns 404 where 200/409 required. Cover default base/current, noncurrent branch switch, both gates and confirmed retries, invalid/local-only refs, no remote, Git refusal, project alias, dry-run, remote-only exclusion.
```ts
const response = await post({});
expect(response.status).toBe(200);
expect(g(root, 'rev-parse', 'HEAD').trim()).toBe(remoteHead);
```
- [x] Run `npm test -- packages/cezar/src/server/repo-pull.test.ts` and observe red.
- [x] Define schemas first; implement bounded execFile git commands, local-ref validation, status read that fails closed, project RunManager.isActive gate, and per-root pull exclusion. Chain routes under existing repo family.
```ts
.post('/repo/pull', jsonZodValidator(repoPullInputSchema), async (c) => { /* route resolves project context and returns operation result */ })
```
- [x] Assert 200 and 409 contract parity and typed bodies; inventory both new routes. Run targeted server tests.

## Task 2: Git header control
Files: packages/web/src/api/client.ts; packages/web/src/routes/repo-git/repo-pull.tsx; repo-git.tsx; repo-git.test.tsx.
Consumes Task 1 contract. Produces getRepoPullBranches() and pullRepo(input) client helpers. pullRepo resolves RepoPullResponse | RepoPullConfirmation on structured 409; other errors throw ApiError.
- [x] Write failing UI tests for default picker, switch label, explicit confirmation per risk, cancelled dialog, successful refresh, failed pull and pending state.
```ts
fireEvent.click(screen.getByRole('button', { name: 'Pull', exact: true }));
expect(await screen.findByRole('alertdialog')).toHaveTextContent(/active session/i);
```
- [x] Run `npm test -- packages/web/src/routes/repo-git/repo-git.test.tsx` to observe red.
- [x] Add native local-only select, Pull/Switch & pull button, structured confirmation dialog, toasts; capture project query keys for mutation refresh; do not flash empty during loading.
- [x] Run UI tests and inspect mobile/light/dark rendering.

## Task 3: Verify and deliver
- [x] Review whole diff against issue and contract; fix material findings.
- [x] Run in order: `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, `npm run test:package`.
- [ ] Commit Conventional Commit, push feat/git-tab-pull, open draft PR against main using repository template and Closes hearsay-tools/cezarion#67.
- [ ] Move card In review; use pr-checks until CI verdict. Update handoff at milestones.

## Review and QA evidence
- Final code review approved; status probe explicitly overrides hidden untracked/submodule configuration. Branch input is bounded to 200 characters.
- Both risk gates tested with local Git fixtures. Tests first failed with the missing endpoint; additional regressions failed before each fix.
- Browser checked at 360x640 and 1280x800 in light/dark. Select, Pull, and dialog actions measure 44px high. Cancel and Enter activation work; reduced-motion preference respected. Dialog close restores focus to Pull (regression test).
- No artwork: a repository operation uses existing controls and an icon.

Final local verification: typecheck passed; 6493 Vitest tests; 97 core/workflow-script tests; production build and tarball gate passed; 21 package tests. Browser confirmed focus returns to Switch & pull after Escape.

PR review regression: Git 2.55 pull.autoStash overrides merge/rebase settings. The invocation now uses `git pull --no-autostash`; the new real-Git test failed before this fix on Git 2.55. All 33 pull tests pass on both Git 2.43 and 2.55.
