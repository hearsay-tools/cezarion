# Cross-state GitHub Search Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Find closed issues and merged PRs without losing fork filters or selected detail rows.

**Architecture:** Selectively port upstream 32881e15's on-demand search through the existing contract, chained scoped route, typed client and cockpit. Enrich issue hits with assignees and bounded project membership lookup before applying the fork's shared filter. Retain the open-only default list.

**Tech Stack:** TypeScript, Zod, Hono, React, TanStack Query, Vitest, agent-browser.

**Spec:** Parent-approved design in task #90 conversation (2026-09-05); issue https://github.com/wjarka/cezar/issues/90 and its Agent context comment.

## Global Constraints

- Preserve label AND / case-insensitive assignee OR / board AND; assignee and board controls remain issue-only.
- Preserve @wjarka/cezarion, alias-cezarion and fork version lineage; no new dependency or configuration.
- Every API shape is defined in packages/contract; routes chain validation middleware and mount under /api/v1 and /api/v1/p/:projectId.
- No empty or label-only search requests. Debounce 350 ms; exact numbers use view, text uses scoped search with query after --.
- Incomplete metadata is unknown, never authoritative nonmembership. Preserve query and selected filters on search failures.
- Keep PR draft; parent owns merge assessment.

## Task 1: Port the tested upstream search surface

Files: upstream commit's 17-file diff (forge/github.ts and tests, forge/types.ts, server/github.ts, server/server.ts, github-search-api.test.ts, contract-parity.github.test.ts, contract/src/github.ts, web API client/queries, routes.tsx, github route/filter and tests, BACKWARD_COMPATIBILITY.md).

Interface: searchGithubItems(repoRoot, kind, query, limit) returns ForgeSearchData; useGithubSearch(kind, query, enabled) uses scoped query keys.

- [x] Apply upstream API test first: `git diff 32881e15^ 32881e15 -- packages/cezar/src/server/github-search-api.test.ts | git apply`.
- [x] Run `npm test -- packages/cezar/src/server/github-search-api.test.ts`; expect 404 instead of 200/400.
- [x] Apply remaining upstream patch with three-way merge, resolving conflicts by retaining independent fork fields, controls, routes and inventory.
- [x] Run focused forge, API, filter, route and navigation suites; preserve upstream stale-hit, flag-shaped-query and failure regressions.

## Task 2: Preserve fork filtering for search hits

Files: forge/github.ts and github.test.ts; contract/src/github.ts; forge/types.ts; web/routes/github/github.tsx, issue-filters.tsx and github.test.tsx.

Interface: search payload carries optional projectsReason and fully populated issue assignees/projectIds when available; existing fetchIssueProjects handles returned issue numbers with a shared 15-second budget and 8-second per-call maximum.

- [x] Add driver tests proving assignees and memberships for numeric and text hits; unavailable metadata must omit projectIds and include a reason.
- [x] Add UI tests with three remote issues: Alice/P1, Bob/P2 and Alice/P2, all label bug. Selecting Alice OR Bob + board P2 + label bug shows the latter two; selecting Alice only shows the third.
- [x] Add a metadata-failure UI case with active board P2; assert an explicit incomplete-filter result, retained query and selected board, and no definitive empty verdict.
- [x] Run focused tests red before changing production code.
- [x] Request assignees in search/view field lists; flatten logins. Enrich issue hits through fetchIssueProjects, skipping empty results and PRs. Preserve missing metadata as unknown.
- [x] Apply identical fork options to local-match fallback eligibility and remote rows; merge remote labels/assignees into filter options. Keep selected detail result across list navigation.
- [x] Run focused tests green; prove critical regressions red with production edits temporarily removed if needed.

## Task 3: Verify and deliver

- [x] Run in order: `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, `npm run test:package`.
- [x] Run browser QA against built app: closed issue and merged PR search; combined filters; empty/label-only request suppression; navigation; phone 360x640 light/dark and keyboard. Reuse existing empty state art and reduced-motion spinner.
- [x] Review complete diff for independent fork preservation and API scope; fix findings and repeat affected checks.
- [ ] Commit one logical feature after required gates, push, create draft PR with Closes #90, design, experience, verification and deferrals.
- [ ] Move board to In review; run pr-checks through CI verdict and inline findings; retain draft and record final handoff.

## Verification evidence

- 2026-09-05: API red against base (404); fork metadata/filter and review regressions red before fixes.
- All five required gates passed: typecheck; Vitest 340 files / 6641 tests; core node:test suites; build with 493-file tarball gate; package tests 21/21.
- Independent review fixes: refresh retries searches, capped results do not claim exhaustive absence, foreign repository hits cannot receive local metadata, selected remote detail survives filtering.
- Browser QA on production build using agent-browser 0.36.0 and Chrome: label + assignee + board combinations; closed issue and merged PR navigation; loading, unavailable, network failure and empty states; query preservation; no requests after clearing to a label-only narrow; 360x640 light/dark, keyboard focus and reduced motion. Captured screenshots under /tmp/cezar-90-qa-artifacts.
- Live gh smoke found closed fork issue 89 by number and title with assignee/projectIds, and merged PR 99 by number.
