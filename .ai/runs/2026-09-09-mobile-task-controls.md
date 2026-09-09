# Mobile Tasks controls — #175

Supervisor-approved bounded design, September 9, 2026. Start point: `eab3fb3e`.

People managing coding tasks on a phone, often one-handed, need to find and archive tasks without leaving the list. The existing header now puts search above Active/Archived on mobile, with Archive finished in the existing Radix actions menu. Desktop retains its header. No new artwork, API, persistence, dependencies, or task-row changes.

The drawer has **no task-query input**: its search-shaped footer opens the command palette. The supervisor confirmed that adding drawer search is outside #175. Active/Archived remains shared through `ListViewProvider`; the page retains its one local query and input across breakpoints and view changes.

## Acceptance evidence

| Criterion | Result and evidence |
| --- | --- |
| Search without opening the drawer | Chrome test enters a query at 360×640, checks the matching card and no-match state, and confirms the drawer is absent. |
| Active/Archived on the page | Chrome switches the visible filters and checks the archived fixture. |
| Archive finished with existing safeguards | Chrome invokes the menu by keyboard against a disposable server. With only “done” matching the query, the real endpoint archives done, failed, and cancelled records; the review record remains active, and the previously archived record remains archived. Component tests withhold the action for unknown/empty data, running/review-only data, and the Archived view. |
| Shared filter/selection state | Chrome switches Archived on the page, observes it in the drawer, switches Active in the drawer, and observes it on the page. It resizes to desktop and back while checking query and view retention. No separate drawer task query exists, as explained above. |
| 360×640, 44×44 hit areas, list context | At comfortable, compact, and ultra density, Chrome measures every visible header control and menu-row height, checks page overflow and viewport containment, and confirms the first card starts within the first 300px. The existing mobile-card regression also passes. |
| Light/dark, reduced motion, focus and feedback | Both themes and all three densities run at 360×640 and 1440×900, with normal and reduced motion: 24 combinations. Keyboard search focus, menu entry, Escape restoration, archive completion focus on Active, and desktop-resize dismissal are checked. |
| Criterion-by-criterion results at both sizes | This table maps the issue criteria to automated coverage. Representative Chrome screenshots are linked below. The existing desktop title/metadata containment regression also passes. |

## States and regression proof

- Loading and empty: controls remain in place; archive is withheld while runs are unknown or none are eligible. Existing no-task, no-match, and empty-archive states remain.
- Pending: the shared archive mutation disables repeat activation and exposes busy state; reopening the mobile menu reads “Archiving…”. Component coverage verifies disabled state and no handler call.
- Error: component coverage returns a 503, verifies a danger toast, preserves query and rows, and checks that the action becomes available again. The query client's existing offline/pause behavior is retained; native offline device operation was not separately exercised.
- Success: authoritative run-list invalidation updates the result in place. Selecting archive returns keyboard focus to the stable Active button because success removes the menu trigger; it does not focus search and open a phone keyboard.
- Resize: an open mobile menu closes when desktop becomes active, releasing the modal focus trap and restoring focus to the list filters.
- No new animation timings or visual language. Existing menu animation and global reduced-motion/touch-target rules apply.

The original built UI failed the new Chrome test because mobile search was invisible. Stashing only `tasks-overview.tsx` produced three component failures (missing menu, missing pending guard, missing error feedback); restoring it passed all 69 overview tests. Additional Chrome regressions reproduced lost archive-completion focus and a hidden modal after desktop resize before those fixes. Guard cases intentionally pass both versions.

The browser driver requires `Control+a`, not Playwright's `ControlOrMeta+A`; the latter did not select text. The final test uses the supported key and verifies the cleared input and all four archived cards.

## Reproduce browser checks

Use the repository's agent-browser provider and a local `.ai/qa/test-env.json` descriptor. These selected suites boot their own disposable fixture servers with `fixtureServeEnv`, isolated `CEZ_HOME`, and `CEZ_DRY_RUN=1`; they never archive live project data. On this container:

```sh
AGENT_BROWSER_ARGS=--no-sandbox TMPDIR=/tmp/qa175 \
XDG_RUNTIME_DIR=/tmp/qa175/run AGENT_BROWSER_SOCKET_DIR=/tmp/qa175 \
npm test -- --config packages/web/e2e/vitest.config.ts \
  mobile-task-controls quick-list --maxWorkers=1 \
  -t 'mobile Tasks controls|allocates two contained title lines|reflows to cards'
```

Result: **2 suites, 18 tests passed** (25 unrelated tests excluded by the explicit name filter). Screenshot matrix is written to `.ai/qa/artifacts_e2e/mobile-task-controls/`.

These are automated real-Chrome checks plus inspection of representative screenshots, not manual phone QA. Native phone keyboards, assistive-technology hardware, and browser zoom were not tested.

## Screenshots

- [Mobile, light, ultra](assets/mobile-task-controls/mobile-light.png)
- [Mobile, dark, comfortable](assets/mobile-task-controls/mobile-dark.png)
- [Desktop, dark, comfortable](assets/mobile-task-controls/desktop-dark.png)

## Repository and integration gates

Before the clean merge of main `b6df0f65` (#168): typecheck passed; full Vitest **376 files / 7,832 tests** passed; node unit **177 tests** passed; build and **555-file** package inventory passed; packaged CLI **24 tests** passed.

The first full Vitest attempt had one existing OpenCode harness S4 token-event failure (7,831 passed). The unchanged focused test and a fresh complete suite then passed. No backend files or test assertions were changed to obtain the pass.

The supervisor authorized preserving that full-suite evidence for the unrelated clean main integration, with affected checks on the merged tree. After integration:

```text
TMPDIR=/tmp npm run typecheck → passed
TMPDIR=/tmp npm test -- packages/web/src/routes/tasks-overview.test.tsx packages/web/src/routes/new-task.test.tsx packages/web/src/components/composer --maxWorkers=2 → 6 files, 305 tests passed
TMPDIR=/tmp npm run build → passed; check:pack 555 files
AGENT_BROWSER_ARGS=--no-sandbox TMPDIR=/tmp/qa175 XDG_RUNTIME_DIR=/tmp/qa175/run AGENT_BROWSER_SOCKET_DIR=/tmp/qa175 npm test -- --config packages/web/e2e/vitest.config.ts mobile-task-controls new-task-hierarchy composer-defaults selection-states touch-targets --maxWorkers=1 → 5 suites, 85 tests passed
```
