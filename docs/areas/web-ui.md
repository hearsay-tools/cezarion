# Web UI (cockpit)

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`packages/web/src/app.tsx`, then `packages/web/src/routes.tsx`, `packages/web/src/api/`, and the affected component/route

## Project-directory reads before P5

Skill grouping and empty-state path lists include `.ai/squawk/skills/` after the
legacy project directory. Missing-worktree previews recognize both managed tree
names. Runtime reads use the server's winning run source; client API shapes and
tracked `.ai/skills/`, `.ai/qa/` and `.ai/specs/` paths stay unchanged.

## Rules

React 19 + Vite + Tailwind v4 + shadcn/ui; source lives in `packages/web/` (its own npm workspace, `@open-mercato/cezar-web`, with the React/Vite/Tailwind deps in ITS manifest, not the root's), build output in ignored `packages/cezar/web/dist/`. Anything the server and the cockpit BOTH speak — the v2 protocol types, the `/api/v1/p/:projectId` scope helpers, and (as it grows) the typed API client — lives in the third workspace `packages/api-client/` (`@open-mercato/cezar-api-client`), which stays Node-free (AGENTS.md § Repository layout). Keep one global SSE connection and patch the TanStack Query cache in place; authoritative refetch happens on reconnect/visibility. Preserve light/dark/system theming, mobile safe areas, keyboard access, and unit coverage. The legacy vanilla web app was deleted in R7; when `packages/cezar/web/dist` is missing the server answers every shell route with a built-in "run `npm run build:web`" hint page (`packages/cezar/src/server/static-ui.ts`).

**Touch and phone rules:** these come from the iOS checklist in `.ai/specs/2026-07-14-cockpit-ui-redesign.md`. Every control a finger can reach on a touch device has a hit area of at least 44×44 CSS pixels. Editable text is at least 16px, so iOS does not zoom on focus. Chrome clears the safe-area insets. Check these in a real browser (`packages/web/e2e/touch-targets.e2e.ts` and the spec for the view). Check a size with a bound (`>= 44`), never with an exact value. jsdom has no layout, so a unit test that asserts a size class such as `min-h-11` proves nothing about the hit area. Test what the user can do, not the classes that style it.

**Query strings:** write query updates through `useSearchParamsWriter`, never the raw `useSearchParams` setter: render-bound setters can lose earlier writes before a transition renders, and unchanged late navigation can return the reader to a page they left. Read-only `useSearchParams` is valid. The sole approved exception is file selection in `routes/task-git/task-files.tsx`: it pushes history so Back restores the previous file; the writer always replaces history. The lint rule `cez/raw-query-setter` (`npm run lint`) guards raw setter bindings (including aliases) against a reasoned baseline, `packages/web/src/test/search-params-discipline.baseline.json`, that may only shrink.

**Virtualized lists (`virtua`):** `Virtualizer` wraps each child, so put row styling and flags on the rendered item element, never on `ul > li` or `li + li` selectors. The GitHub examples (hearsay-tools/cezarion#1189) are `gh-row-item` in `packages/web/src/routes/github/github.tsx` and `github-layout.css`. In jsdom unit tests, supply scroll-element geometry through a `ResizeObserver` stub and a non-null `offsetParent`; see `packages/web/src/routes/github/github-geometry.testkit.ts`. In browser specs, scroll and collect rows (`allRowNumbersJs` in `packages/web/e2e/github-sidebar.e2e.ts`), or wait for one row, never a total DOM row count. Before virtualizing a list, grep `packages/web/e2e/*.e2e.ts` for `> li` and the list's `data-slot`. Small text on card-2: follow the [measured token table and lint rule](../../packages/web/docs/card-2-contrast.md).

## Activity view

The Activity tab shows live work: `/p/:projectId/activity` for one project and `/activity` for all projects. The spec is `.ai/specs/2026-11-05-live-activity-view.md`; the code is in `packages/web/src/routes/activity/`. Keep these rules when you change it:

- **Stable placement.** A card keeps its column and its order while it stays on the view. A state change never moves a card. Only a card that comes or goes changes the placement (`placeCards` in `layout.ts`).
- **Only open requests and waits.** A line and a rail entry stand for a request with no outcome. A dotted wait line stands for an open peer wait (`hsq message wait --peer`), from the peer to the waiter; it has no rail entry. A settled request or an ended wait leaves the view. The view keeps no message history.
- **Text form of the lines.** The SVG lines are `aria-hidden`. Each card and each worker row carries the same facts as text: "Waiting for a reply from <task>" and "<task> waits for your reply"; for a peer wait, "Waiting for a message from <task>" and "<task> waits for you to write". Tests and screen readers read that text, not the line geometry.
- **Reduced motion.** With `prefers-reduced-motion: reduce`, nothing pulses, breathes, sweeps, marches, drifts or slides, and no comet flies. Changes apply at once. Ages still tick.
- **No motion on the first snapshot.** The client derives every animation from the difference between two snapshots. The first snapshot after a mount has nothing to compare with, so it draws at once, with no motion. This holds after a service restart too: open requests return in the first snapshot without a comet.
- **Hidden tab.** A hidden tab pauses every animation and releases the topic. When the tab is visible again, the view reconciles from a fresh snapshot.
- **Motion cost.** Animate only `transform` and `opacity`, with one named exception: the marching dashes on open lines, stubs and arcs, and the drifting dots on wait lines, animate `stroke-dashoffset` in CSS, with no JavaScript loop. Both pause on a hidden tab and are static with reduced motion. Measure line geometry on layout change (`ResizeObserver`), never on every frame.
- **Live region.** Only the summary chips are a polite live region. Cards and the Just now feed are not, so a busy project does not flood a screen reader.

Build-time `VITE_HSQ_E2E` (`VITE_CEZ_E2E` fallback) and
`VITE_HSQ_API_BASE` (`VITE_CEZ_API_BASE` fallback) take precedence, including
defined empty values. The Vite build marker
uses the same E2E decision as the browser. The dev proxy accepts `HSQ_API_PORT` (`CEZ_API_PORT` fallback)
first; the root dev launcher pins both port names to the port it selected.
