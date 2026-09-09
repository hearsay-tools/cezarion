# Mobile Git Page Headings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Remove duplicate visible mobile page titles from Git and GitHub without removing route semantics, context, or desktop headers.

**Architecture:** Keep the shell and route DOM unchanged, applying responsive visual hiding only to the two route `h1` elements. Pin the outcome in Chrome with accessibility and geometry assertions at the required viewports and themes.

**Tech Stack:** TypeScript, React 19, Tailwind v4, Vitest, agent-browser with Chrome.

**Spec:** docs/superpowers/specs/2026-09-09-mobile-git-page-headings-design.md

## Global Constraints

- Preserve all Git and GitHub state, navigation, query, control, and pane behavior.
- Mobile means 360×640; desktop means 1440×900. Verify light and dark themes at both sizes.
- Keep semantic route `h1` headings and visible branch/repository context.
- Reuse existing tokens and component vocabulary; add no dependency, artwork, motion, API, or component contract.
- State matrix implemented: existing loading, empty, error, unavailable, search, success, and detail states remain unchanged.
- Skeleton geometry remains unchanged; there is no empty-to-content flash introduced.
- Supporting imagery is deliberately unchanged because no state or section is added.
- Motion and reduced-motion paths remain unchanged.
- Existing labels and ≥44px interactive targets remain unchanged; no horizontal overflow at 360px.
- Each acceptance criterion receives a focused automated assertion or actual browser QA note.

---

### Task 1: Pin responsive title behavior in Chrome

**Files:**
- Create: `packages/web/e2e/page-headings.e2e.ts`

**Interfaces:**
- Consumes the existing mobile shell, Git route header, GitHub route header, branch chip, repository label, and first content-row DOM.
- Produces a regression assertion over actual visibility, accessibility, element rectangles, and viewport overflow.

- [x] **Step 1: Write the failing browser regression**

  Visit Git and GitHub at 360×640 and 1440×900 in light and dark themes. Assert mobile has one visible matching title while retaining the semantic route `h1`, context is visible, content begins below the sticky header without overlap, and the document has no horizontal overflow. Assert desktop hides the mobile bar and visibly renders the route `h1` and context.

- [x] **Step 2: Run the focused browser regression and verify RED**

  Run: `TMPDIR=/tmp npm run build`, `TMPDIR=/tmp sh .ai/scripts/test-env-up.sh --force`, then `TMPDIR=/tmp npm exec vitest run -- --config packages/web/e2e/vitest.config.ts packages/web/e2e/page-headings.e2e.ts`

  Expected: FAIL because both mobile shell and route title are currently visible.

### Task 2: Apply the minimal responsive heading fix

**Files:**
- Modify: `packages/web/src/routes/repo-git/repo-git.tsx`
- Modify: `packages/web/src/routes/github/github.tsx`
- Test: `packages/web/src/routes/repo-git/repo-git.test.tsx`
- Test: `packages/web/src/routes/github/github.test.tsx`

**Interfaces:**
- Keeps route component props, semantic heading levels, shell title resolution, and header context unchanged.
- Produces visually hidden route titles below `md` and the current visible route titles from `md` upward.

- [x] **Step 1: Apply the minimal responsive classes**

  Add responsive visually-hidden behavior to each route `h1`, preserving the current desktop text styling.

- [x] **Step 2: Run the focused browser regression and verify GREEN**

  Run the focused browser command from Task 1 and expect PASS.

- [x] **Step 3: Run focused component coverage**

  Run: `TMPDIR=/tmp npm test -- --maxWorkers=2 packages/web/src/routes/repo-git/repo-git.test.tsx packages/web/src/routes/github/github.test.tsx packages/web/src/components/app-shell.test.tsx`

  Expected: PASS, including semantic headings, context, route titles, and mobile shell title coverage.

- [x] **Step 4: State matrix and craft review**

  Confirm all existing states, skeleton geometry, context, focus, controls, imagery, motion, and reduced-motion paths are unchanged; verify first-row access and no horizontal overflow at 360×640.

### Task 3: Verify and publish the issue branch

**Files:**
- Modify: this plan's checkboxes as steps complete.

**Interfaces:**
- Produces a conventional commit and draft PR against fresh origin/main with `Closes #172`, criterion-level evidence, and QA notes.

- [x] **Step 1: Run the repository verification gate**

  Run in order with `TMPDIR=/tmp` and bounded workers where supported: `npm run typecheck`, `npm test -- --maxWorkers=2`, `npm run test:unit`, `npm run build`, and `npm run test:package`.

- [x] **Step 2: Commit and push**

  Commit with Conventional Commits, fetch and merge fresh `origin/main`, rerun verification if the merge changes the tree, then push the current Cezar task branch with upstream tracking.

- [ ] **Step 3: Open and monitor the draft PR**

  Open a draft PR against `main`, move issue #172 to In review, invoke `apptension-sdlc:pr-checks`, and fix actionable CI or review findings without weakening tests. Stop with a clean reviewed draft PR for the supervisor; do not merge or mark ready.
