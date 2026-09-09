# Mobile GitHub Item Titles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Show up to two lines of issue and pull-request titles on phones while preserving the existing single-line resizable desktop GitHub list.

**Architecture:** Keep the existing GithubRow DOM and behavior, changing only responsive row geometry. Extend the live GitHub browser spec with computed layout assertions so the regression is observable in Chrome rather than inferred from Tailwind class strings.

**Tech Stack:** TypeScript, React 19, Tailwind v4, Vitest, agent-browser with Chrome.

**Spec:** docs/superpowers/specs/2026-09-09-mobile-github-item-titles-design.md

## Global Constraints

- Preserve selection, filtering, drag-to-composer, hover/focus prefetch, and desktop list resizing.
- Mobile means 360×640; desktop means 1440×900. Verify light and dark themes at both sizes.
- Reuse existing tokens and component vocabulary; no new dependency, artwork, motion, API, or component contract.
- Keep metadata and labels below the title with no horizontal page overflow.

---

### Task 1: Pin responsive GitHub row geometry in Chrome

**Files:**
- Modify: packages/web/e2e/github.e2e.ts

**Interfaces:**
- Consumes the existing gh-row list-row DOM.
- Produces a regression assertion over actual line boxes, element rectangles, overflow, computed truncation, theme, and configured desktop width.

- [x] **Step 1: Write the failing browser regression**

Add a test that visits Issues, substitutes deliberately long title/author text in the first row, and records browser geometry at 360×640 and 1440×900 in both themes. Assert mobile title line count is exactly two, the title is clamped, the icon aligns to the first line, metadata wraps below it, labels do not overlap it, and page overflow is absent. Assert desktop title and metadata remain one line with ellipsis and the list keeps its configured width.

- [x] **Step 2: Run the focused browser test and verify RED**

Run: TMPDIR=/tmp npm run build, then TMPDIR=/tmp sh .ai/scripts/test-env-up.sh --force, then TMPDIR=/tmp npm exec vitest run -- --config packages/web/e2e/vitest.config.ts packages/web/e2e/github.e2e.ts -t "lays out long issue"

Expected: FAIL because the current mobile title has one line and the current metadata group does not wrap.

### Task 2: Implement the approved responsive row layout

**Files:**
- Modify: packages/web/src/routes/github/github.tsx

**Interfaces:**
- Keeps GithubRow's props and link behavior unchanged.
- Produces a two-line mobile title, first-line icon alignment, wrapping mobile metadata, separate labels, and explicit desktop single-line truncation.

- [x] **Step 1: Apply the minimal responsive styles**

Use a two-line clamp on the title below md, restore block/single-line truncation from md, align the icon to the first mobile title line, and allow the metadata row to wrap with consistent horizontal and vertical gaps.

- [x] **Step 2: Run the focused browser test and verify GREEN**

Run the focused command from Task 1 and expect PASS.

- [x] **Step 3: Run focused component coverage**

Run: TMPDIR=/tmp npm test -- packages/web/src/routes/github/github.test.tsx

Expected: PASS, including filtering, selection, responsive list/detail structure, and pointer/keyboard resizing coverage.

- [x] **Step 4: State matrix and craft review**

Confirm loading/empty/error/search/selected states are unchanged; no skeleton geometry, imagery, motion, form labels, target sizes, or reduced-motion paths changed; no horizontal overflow exists at 360px.

### Task 3: Verify and publish the issue branch

**Files:**
- Modify: this plan's checkboxes as steps complete.

**Interfaces:**
- Produces a conventional commit and a draft PR against fresh origin/main with Closes #169, per-criterion evidence, and QA notes.

- [x] **Step 1: Run the repository verification gate**

Run in order with TMPDIR=/tmp and bounded workers where supported: npm run typecheck, npm test, npm run test:unit, npm run build, and npm run test:package.

- [x] **Step 2: Commit and push**

Commit with Conventional Commits, fetch origin/main, verify the branch base/diff, then push the current Cezar task branch with upstream tracking.

- [ ] **Step 3: Open and monitor the draft PR**

Open a draft PR against main, move the issue card to In review, invoke apptension-sdlc:pr-checks, and fix actionable CI/review findings without weakening tests. Stop with a clean reviewed draft PR for the supervisor; do not merge or mark ready.
