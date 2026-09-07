# GitHub List Column Resize Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the desktop GitHub Issues/PRs list column resizable with the same accessible pointer and keyboard affordance as the app sidebar, while preserving mobile stacking and sharing one browser-local width across both views.

**Architecture:** Add a focused pure width/storage helper beside `sidebar-width.ts`. `GithubRoute` owns one width state and persistence callback for both Issues and PRs, applies the value through a desktop-only CSS custom property, and renders a local separator handle over the list’s right border. The existing `n`-based mobile list/detail visibility and PR file-tree layout remain unchanged.

**Tech Stack:** TypeScript, React 19, Tailwind v4, Vitest, Testing Library, jsdom.

**Spec:** GitHub issue #126 and its `**Agent context**` comment: https://github.com/wjarka/cezar/issues/126

## Global Constraints

- Use browser-localStorage with the `cez-` namespace; do not write workspace `ui-state.json`.
- Preserve the existing mobile list/detail switch: list is visible only when `n === undefined`, detail is visible for a selected item; the resize handle is unavailable below `md`.
- Keep the existing GitHub list slot `[data-slot="gh-list"]` and the PR changes file tree unchanged.
- Match the sidebar resize contract: pointer capture, primary-button guard, focus on grab, `touch-none`, arrow steps, Home/End bounds, double-click reset, ARIA separator range, and storage on every change.
- Do not add dependencies or change public API contracts.

---

### Task 1: Add the GitHub list width helper

**Files:**
- Create: `packages/web/src/lib/github-list-width.ts`
- Create: `packages/web/src/lib/github-list-width.test.ts`

**Interfaces:**
- Produces `GITHUB_LIST_WIDTH_STORAGE_KEY`, `MIN_GITHUB_LIST_WIDTH`, `MAX_GITHUB_LIST_WIDTH`, `DEFAULT_GITHUB_LIST_WIDTH`, `GITHUB_LIST_WIDTH_STEP`, `clampGithubListWidth(raw: unknown): number`, `readStoredGithubListWidth(): number`, and `writeStoredGithubListWidth(width: number): void`.
- Uses the same total-input and storage-failure behavior as `sidebar-width.ts`.

- [x] **Step 1: Write the failing helper tests**

Create table tests that pin the approved constants and behavior:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_GITHUB_LIST_WIDTH,
  GITHUB_LIST_WIDTH_STORAGE_KEY,
  MAX_GITHUB_LIST_WIDTH,
  MIN_GITHUB_LIST_WIDTH,
  clampGithubListWidth,
  readStoredGithubListWidth,
  writeStoredGithubListWidth,
} from './github-list-width'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('clampGithubListWidth', () => {
  it.each([
    [280, 280],
    [360, 360],
    [520, 520],
    [317.4, 317],
    [317.5, 318],
    [0, MIN_GITHUB_LIST_WIDTH],
    [-4000, MIN_GITHUB_LIST_WIDTH],
    [279, MIN_GITHUB_LIST_WIDTH],
    [521, MAX_GITHUB_LIST_WIDTH],
    [99_999, MAX_GITHUB_LIST_WIDTH],
  ])('%s → %s', (raw, expected) => {
    expect(clampGithubListWidth(raw)).toBe(expected)
  })

  it('parses localStorage strings and returns the default for junk', () => {
    expect(clampGithubListWidth('340.6')).toBe(341)
    expect(clampGithubListWidth('wide')).toBe(DEFAULT_GITHUB_LIST_WIDTH)
    expect(clampGithubListWidth(null)).toBe(DEFAULT_GITHUB_LIST_WIDTH)
    expect(clampGithubListWidth(NaN)).toBe(DEFAULT_GITHUB_LIST_WIDTH)
  })
})

describe('readStoredGithubListWidth / writeStoredGithubListWidth', () => {
  it('round-trips the shared width through the documented key', () => {
    writeStoredGithubListWidth(400)
    expect(localStorage.getItem(GITHUB_LIST_WIDTH_STORAGE_KEY)).toBe('400')
    expect(readStoredGithubListWidth()).toBe(400)
  })

  it('clamps on write and read', () => {
    writeStoredGithubListWidth(10_000)
    expect(localStorage.getItem(GITHUB_LIST_WIDTH_STORAGE_KEY)).toBe(String(MAX_GITHUB_LIST_WIDTH))
    localStorage.setItem(GITHUB_LIST_WIDTH_STORAGE_KEY, '12')
    expect(readStoredGithubListWidth()).toBe(MIN_GITHUB_LIST_WIDTH)
  })

  it('defaults when storage is absent, invalid, or unavailable', () => {
    expect(readStoredGithubListWidth()).toBe(DEFAULT_GITHUB_LIST_WIDTH)
    localStorage.setItem(GITHUB_LIST_WIDTH_STORAGE_KEY, 'not a number')
    expect(readStoredGithubListWidth()).toBe(DEFAULT_GITHUB_LIST_WIDTH)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(readStoredGithubListWidth()).toBe(DEFAULT_GITHUB_LIST_WIDTH)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => writeStoredGithubListWidth(400)).not.toThrow()
  })
})
```

- [x] **Step 2: Run the focused helper test and confirm it fails**

Run: `npm test -- packages/web/src/lib/github-list-width.test.ts`

Expected: FAIL because `./github-list-width` does not exist yet.

- [x] **Step 3: Implement the helper**

Create `github-list-width.ts` by following `sidebar-width.ts`’s pure helper shape with these exact values. Preserve the issue’s stronger invalid-input contract by returning the default before numeric conversion for `null`, `undefined`, and `''`; the sidebar’s equal default/minimum currently masks this distinction.

```ts
export const GITHUB_LIST_WIDTH_STORAGE_KEY = 'cez-github-list-width'
export const MIN_GITHUB_LIST_WIDTH = 280
export const MAX_GITHUB_LIST_WIDTH = 520
export const DEFAULT_GITHUB_LIST_WIDTH = 360
export const GITHUB_LIST_WIDTH_STEP = 16
```

Implement `clampGithubListWidth` as `Number(raw)` for other non-number inputs, returning the default for nullish/blank/non-finite values and otherwise rounding then clamping to 280–520. `readStoredGithubListWidth` must return the default for a missing key, invalid value, or storage exception. `writeStoredGithubListWidth` must clamp before `setItem` and swallow storage exceptions.

- [x] **Step 4: Run the helper tests and confirm they pass**

Run: `npm test -- packages/web/src/lib/github-list-width.test.ts`

Expected: PASS with all clamp and storage cases green.

- [x] **Step 5: Commit the focused helper**

```bash
git add packages/web/src/lib/github-list-width.ts packages/web/src/lib/github-list-width.test.ts
git commit -m "feat(web): add GitHub list width preference"
```

### Task 2: Add the GitHub route resize state and handle

**Files:**
- Modify: `packages/web/src/routes/github/github.tsx:1-45, 133-270, 501-660`
- Test: `packages/web/src/routes/github/github.test.tsx` in the list/detail test group

**Interfaces:**
- Consumes the Task 1 helper constants and functions.
- Produces the existing `[data-slot="gh-list"]` with a desktop width controlled by `githubListWidth`, plus `[data-slot="gh-list-resize-handle"]` as a keyboard and pointer separator.

- [x] **Step 1: Add failing route tests for restore, sharing, and the interaction contract**

Import the Task 1 constants and add a local `ghList`, `ghListHandle`, and `drag` helper next to the existing `rows`/`detail` helpers. Use the existing `stubFetch()` and `renderAt()` fixtures. Add tests that assert:

```ts
it('restores one stored width for Issues and PRs', async () => {
  localStorage.setItem(GITHUB_LIST_WIDTH_STORAGE_KEY, '400')
  stubFetch()
  renderAt('/github')
  await screen.findByText('Login form drops session on refresh')
  expect(ghList().style.getPropertyValue('--github-list-width')).toBe('400px')

  cleanup()
  stubFetch()
  renderAt('/github/prs')
  await screen.findByText('Stream tokens over SSE')
  expect(ghList().style.getPropertyValue('--github-list-width')).toBe('400px')
})

it('exposes the separator range and persists pointer changes', async () => {
  stubFetch()
  renderAt('/github')
  await screen.findByText('Login form drops session on refresh')
  const el = ghListHandle()
  expect(el.getAttribute('role')).toBe('separator')
  expect(el.getAttribute('aria-orientation')).toBe('vertical')
  expect(el.getAttribute('aria-label')).toBe('Resize the GitHub list')
  expect(el.getAttribute('aria-valuemin')).toBe(String(MIN_GITHUB_LIST_WIDTH))
  expect(el.getAttribute('aria-valuemax')).toBe(String(MAX_GITHUB_LIST_WIDTH))
  drag(360, 440)
  expect(ghList().style.getPropertyValue('--github-list-width')).toBe('440px')
  expect(localStorage.getItem(GITHUB_LIST_WIDTH_STORAGE_KEY)).toBe('440')
})

it('supports keyboard bounds, reset, clamp, and ignores non-primary pointer input', async () => {
  stubFetch()
  renderAt('/github')
  await screen.findByText('Login form drops session on refresh')
  const el = ghListHandle()
  fireEvent.keyDown(el, { key: 'ArrowRight' })
  expect(ghList().style.getPropertyValue('--github-list-width')).toBe('376px')
  fireEvent.keyDown(el, { key: 'End' })
  expect(ghList().style.getPropertyValue('--github-list-width')).toBe('520px')
  fireEvent.keyDown(el, { key: 'Home' })
  expect(ghList().style.getPropertyValue('--github-list-width')).toBe('280px')
  fireEvent.doubleClick(el)
  expect(ghList().style.getPropertyValue('--github-list-width')).toBe('360px')
  fireEvent.pointerDown(el, { button: 2, pointerId: 1, clientX: 360 })
  fireEvent.pointerMove(el, { pointerId: 1, clientX: 500 })
  expect(ghList().style.getPropertyValue('--github-list-width')).toBe('360px')
})

it('keeps the mobile structure and hides the resize handle below md', async () => {
  stubFetch()
  renderAt('/github')
  await screen.findByText('Login form drops session on refresh')
  expect(ghList().className).toContain('w-full')
  expect(ghList().className).toContain('md:w-[var(--github-list-width)]')
  expect(ghListHandle().className).toContain('hidden')
  expect(ghListHandle().className).toContain('md:block')

  cleanup()
  stubFetch()
  renderAt('/github/issues/142')
  await screen.findByText('Login form drops session on refresh')
  expect(ghList().className).toContain('hidden')
  expect(document.querySelector('[data-slot="gh-detail"]')?.className).toContain('flex')
})
```

The `drag` helper must stub `setPointerCapture`, `releasePointerCapture`, and `hasPointerCapture` exactly like the sidebar tests before firing pointer down/move/up. This keeps the jsdom test focused on the route state machine while the existing e2e suite remains responsible for real pointer behavior.

- [x] **Step 2: Run the focused route tests and confirm they fail**

Run: `npm test -- packages/web/src/routes/github/github.test.tsx`

Expected: FAIL because the route has no width state, CSS variable, or resize handle.

- [x] **Step 3: Add route-level width state and persistence**

Import the helper from `@/lib/github-list-width` and add `type CSSProperties` to the existing React import. Near the other route state, add:

```ts
const [githubListWidth, setGithubListWidth] = useState(readStoredGithubListWidth)
const changeGithubListWidth = (next: number) => {
  const width = clampGithubListWidth(next)
  setGithubListWidth(width)
  writeStoredGithubListWidth(width)
}
```

Keep this state in `GithubRoute`, not in a view-specific branch, so `/github` and `/github/prs` use the same storage key and the existing element reconciliation preserves the preference while switching tabs.

- [x] **Step 4: Add the desktop-only resize handle**

Define `GithubListResizeHandle` near the route helpers. Copy the sidebar handle’s event flow, replacing its constants and labels with the GitHub list helper values:

- `origin` stores `{ x, width }`.
- Primary `onPointerDown` calls `setPointerCapture`, prevents selection, and focuses the handle.
- `onPointerMove` calls `changeGithubListWidth(start.width + event.clientX - start.x)`.
- `onPointerUp` and `onPointerCancel` clear the origin and release capture when held.
- `ArrowLeft`/`ArrowRight` change by 16; `Home`/`End` use 280/520; other keys remain untouched.
- Double-click calls `changeGithubListWidth(360)`.
- Render `data-slot="gh-list-resize-handle"`, `role="separator"`, vertical orientation, label `Resize the GitHub list`, `aria-valuenow`, `aria-valuemin`, `aria-valuemax`, `tabIndex={0}`, and the same transparent 5px `touch-none cursor-col-resize` hover/focus classes.

- [x] **Step 5: Apply width only on desktop and preserve mobile layout**

Update the list section as follows:

```tsx
<section
  data-slot="gh-list"
  style={{ '--github-list-width': `${githubListWidth}px` } as CSSProperties}
  className={cn(
    'relative w-full min-h-0 flex-col overflow-y-auto overscroll-contain border-border md:flex md:w-[var(--github-list-width)] md:shrink-0 md:border-r',
    n === undefined ? 'flex' : 'hidden',
  )}
>
  {/* existing list contents */}
  <GithubListResizeHandle width={githubListWidth} onWidthChange={changeGithubListWidth} />
</section>
```

Render the handle as the last child so its absolute right-edge strip sits above the list border. Its class must include `hidden md:block`; the section’s base `w-full` must remain so the inline custom property cannot force a fixed width on mobile. Do not change the detail section or its `lg:grid-cols-[240px_minmax(0,1fr)]` file tree.

- [x] **Step 6: Run focused route tests and typecheck**

Run: `npm test -- packages/web/src/routes/github/github.test.tsx`

Expected: PASS, including the existing GitHub list/detail tests and all new resize cases.

Run: `npm run typecheck`

Expected: PASS with no TypeScript errors, including the CSS custom property cast.

- [x] **Step 7: Commit the route behavior**

```bash
git add packages/web/src/routes/github/github.tsx packages/web/src/routes/github/github.test.tsx
git commit -m "feat(github): resize the list column"
```

### Task 3: Run the repository verification and record UI QA

**Files:**
- Modify: `/home/agent/projects/cezar/.ai/cezar/runs/3e8f1a16-a92a-4209-9dc0-612b493a339a.handoff.md` (progress/resume notes only)

**Interfaces:**
- Consumes the two implementation commits from Tasks 1–2.
- Produces verified evidence for the draft PR and a manual QA note for the UI acceptance criteria.

- [x] **Step 1: Run the issue-focused web tests**

Run: `npm test -- packages/web/src/lib/github-list-width.test.ts packages/web/src/routes/github/github.test.tsx packages/web/src/components/app-shell.test.tsx`

Expected: PASS, including the unchanged sidebar resize contract.

- [x] **Step 2: Run all binding verification commands**

Run each command from the repository root:

```bash
npm run typecheck
npm test
npm run test:unit
npm run build
npm run test:package
```

Expected: each command exits 0. If any command fails, use `superpowers:systematic-debugging` before making further changes; do not open a PR on red verification.

- [ ] **Step 3: Perform the manual UI craft check**

Use the running cockpit or built web surface at approximately `360×640` and `1280×800`, in light and dark themes. Confirm the handle is absent below `md`, visible and keyboard-focusable on desktop, keeps a visible hover/focus affordance in both themes, and remains usable with reduced motion enabled. Confirm dragging does not alter mobile list/detail stacking, and the PR changes pane still keeps its 240px file list aside.

The repository browser suite attempted this check but was skipped because the agent-browser Chrome provider could not be provisioned in this environment; the draft PR must state this limitation.

- [x] **Step 4: Record verification and resume state**

Append timestamped passing-test and QA lines under `## Progress log`, then replace `## Resume notes` with the exact remaining flow: commit/push if not already complete, draft PR creation, board transition to In review, and `pr-checks` monitoring.
