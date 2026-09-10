# Mobile Enter Newline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make bare Enter insert a newline on coarse-pointer composer surfaces while preserving desktop and modifier-key submission.

**Architecture:** Keep keyboard policy in `isSubmitShortcut`, where a small media-query helper detects `(hover: none) and (pointer: coarse)` and defaults to desktop behavior when `matchMedia` is unavailable. The existing shared `Composer` remains the single integration point for both task-thread and new-task hosts, while modifier-only callers retain their current guards.

**Tech Stack:** TypeScript, React 19, Vitest, Testing Library, browser `matchMedia`.

**Spec:** [GitHub issue #194](https://github.com/hearsay-tools/cezarion/issues/194) and the approved bounded design in the task session.

## Global Constraints

- Do not use user-agent detection; use exactly `(hover: none) and (pointer: coarse)`.
- When `matchMedia` is unavailable, keep desktop bare-Enter submission.
- Keep Shift+Enter as newline, Alt+Enter unbound, repeats ignored, and IME composition protected.
- Keep Ctrl+Enter and Meta+Enter as submit shortcuts on desktop and coarse-pointer surfaces.
- Do not change review notes, commit-dialog, or hand-to-agent behavior.
- Add no dependency, schema change, API change, imagery, or motion.
- UI states are unchanged: loading, empty, error, offline, success, and conflict behavior remain outside this synchronous keyboard decision.

---

### Task 1: Apply coarse-pointer submit policy through the shared composer

**Files:**
- Modify: `packages/web/src/lib/use-submit-shortcut.ts`
- Test: `packages/web/src/lib/use-submit-shortcut.test.ts`
- Test: `packages/web/src/components/composer/composer.test.tsx`

**Interfaces:**
- Consumes: `window.matchMedia('(hover: none) and (pointer: coarse)')` when available.
- Produces: `isSubmitShortcut(event: SubmitShortcutEvent): boolean`, retaining its existing exported signature and returning `false` for coarse-pointer bare Enter.

- [x] **Step 1: Extend the pure shortcut matrix with the failing coarse-pointer cases**

  Stub `globalThis.matchMedia` so each row controls whether the coarse-pointer query matches. Add literal expectations for desktop bare Enter (`true`), coarse-pointer bare Enter (`false`), coarse-pointer Meta+Enter (`true`), coarse-pointer Ctrl+Enter (`true`), and missing `matchMedia` (`true`). The mutation each new row catches is removal or inversion of the coarse-pointer branch.

- [x] **Step 2: Add the failing shared-composer integration regression**

  In `composer.test.tsx`, stub `matchMedia` to match only `(hover: none) and (pointer: coarse)`, type a draft, dispatch bare Enter, and assert that the real `Composer` does not call `onSubmit` and does not prevent the key event. Then click the existing Send button and assert the draft submits. This proves both task hosts inherit the policy through their shared component and that mobile retains a deliberate submit path.

- [x] **Step 3: Run the focused tests and verify RED**

  Run: `npm test -- packages/web/src/lib/use-submit-shortcut.test.ts packages/web/src/components/composer/composer.test.tsx`

  Expected: the coarse-pointer predicate and composer cases fail because bare Enter still submits; existing desktop and modifier rows pass.

- [x] **Step 4: Implement the minimal coarse-pointer branch**

  Add an internal constant for `(hover: none) and (pointer: coarse)` and an internal helper that returns `false` when `window` or `window.matchMedia` is unavailable. After the existing key, Shift/Alt, repeat, and IME guards, return `true` for Meta/Ctrl+Enter and otherwise return the inverse of the coarse-pointer match. Update the module comments to describe the mobile rule.

- [x] **Step 5: Run the focused tests and verify GREEN**

  Run: `npm test -- packages/web/src/lib/use-submit-shortcut.test.ts packages/web/src/components/composer/composer.test.tsx`

  Expected: both files pass without new warnings.

- [x] **Step 6: Verify product experience**

  Check the shared composer at approximately 360×640 in light and dark themes: Return grows the draft instead of submitting, the 44px Send control remains reachable above the keyboard, and clicking Send works with reduced motion enabled. Confirm no state, imagery, visual hierarchy, focus, or motion-token changes were introduced.

- [x] **Step 7: Run repository verification**

  Run with external temporary paths so fixture tests remain outside the repository: `TMPDIR=/tmp TMP=/tmp TEMP=/tmp npm run typecheck`, `TMPDIR=/tmp TMP=/tmp TEMP=/tmp npm test`, `TMPDIR=/tmp TMP=/tmp TEMP=/tmp npm run test:unit`, `TMPDIR=/tmp TMP=/tmp TEMP=/tmp npm run build`, and `TMPDIR=/tmp TMP=/tmp TEMP=/tmp npm run test:package`.

  Expected: all commands exit 0.

- [x] **Step 8: Commit the logical change**

  ```bash
  git add docs/superpowers/plans/2026-09-09-mobile-enter-newline.md \
    packages/web/src/lib/use-submit-shortcut.ts \
    packages/web/src/lib/use-submit-shortcut.test.ts \
    packages/web/src/components/composer/composer.test.tsx
  git commit -m "fix(web): keep mobile Enter in the composer"
  ```
