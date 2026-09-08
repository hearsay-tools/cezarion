# Mobile tool-call overlap — issue #160

## Cause and change

`VirtualRows` passed `shift` for every render. Virtua interprets that flag as a change at the beginning of the list and shifts its indexed size cache when the row count changes. An incoming tool appended at the end therefore assigned a short tool height to an existing assistant message. The existing DOM nodes did not resize, so ResizeObserver had no reason to correct those measurements. Cards stayed positioned inside the paragraph while the viewport was stationary.

Enable `shift` only when the first row key changes and the old or new first row survives in the other list. Older-page prepends and start eviction retain their compensation; live appends and tail removal preserve existing measurements. Flat rendering, its containment optimization, the virtualization threshold, and scroll ownership remain intact.

The original screenshot's transcript was located in local run `30705eeb-47d3-48f2-a6b9-736ba9781147`, including the message at seq `14770`. Replaying through seq `14807` and injecting an incoming tool frame reproduced the screenshot's persistent overlap at 360×640. After the fix, the same paragraph's bottom and the following row's top both measured `541.234375px`; before the fix, its bottom was `496.234375px` while the following tool started at `289.984375px`.

## Acceptance results

| Criterion | Result | Evidence |
| --- | --- | --- |
| Cards do not cover assistant text at 360×640 | Pass | Real-browser row geometry assertions and inspected original-transcript replay captures. Both flat and virtual modes exercised. |
| Scrolling in both directions keeps spacing | Pass | Each regression case scrolls up and down after an incoming tool; existing long-thread and progressive-history tests also pass. |
| Stationary incoming tool events do not overlap | Pass | Injected a real-shaped `ui-event` through the run EventSource into the actual reducer/grouping/virtualizer. Original code fails; fixed code passes. |
| Expanding/collapsing tools positions following rows correctly | Pass | Toggle a visible measured card in each browser case, then assert adjacent bounds after ResizeObserver delivery. |
| Mobile themes, desktop and composer remain usable | Pass | Chrome: 360×640 light/dark and 1440×900 dark, both modes. WebKit: both themes at both sizes, both modes. Composer bounds remain in the viewport. |
| Regression fails before the fix | Pass | New Chrome browser test: flat passed, virtual failed with overlapping rows. Unit boundary test also failed against unconditional `shift`. |
| Browser/device identified | Pass, emulated | Chrome for Testing 151 through agent-browser 0.36.0; WebKit 26.6 through a temporary Playwright installation. WebKit mobile cases use iPhone 12 emulation overridden to 360×640 CSS pixels. Desktop is Linux browser emulation at 1440×900. No physical-device run is claimed. The supplied screenshot appears to show Vivaldi on iOS; its exact device/browser version is unknown. |

## Craft and evidence

No new UI state, imagery, animation, or controls are introduced. No artwork is needed. Existing composer keyboard, mobile disclosure and accessibility tests remain in the task-thread suite. This change preserves existing target sizes; it does not redesign the compact tool buttons.

The committed browser regression uses the repository's agent-browser provider. The temporary WebKit replay adds cross-engine evidence without adding a dependency or a second committed test harness. Local artifacts are under `.ai/qa/artifacts_e2e/`:

- `tool-overlap-{flat,virtual}-{360,1440}-{light,dark}.png` — Chrome regression captures (desktop dark only).
- `cez160-webkit-{flat,virtual}-{360,1440}-{light,dark}.png` — original-transcript replay after incoming events and toggles.
- `tool-overlap-webkit-results.json` — eight WebKit scenarios with browser identity and checks.

The inspected mobile replay captures are also committed as [light](assets/160/mobile-light.png) and [dark](assets/160/mobile-dark.png) evidence.

All 40 tests across `thread-scroll.e2e.ts`, `progressive-history.e2e.ts`, and `task-thread.e2e.ts` passed. Independent code review found no actionable issues. Full validation also passed:

- `npm run typecheck` — pass.
- `TMPDIR=/tmp npm test -- --maxWorkers=4` — 7,803 tests, 376 files pass.
- `TMPDIR=/tmp npm run test:unit` — 37 core and 81 script tests pass.
- `npm run build` — pass, including `check:pack`.
- `TMPDIR=/tmp npm run test:package` — 24 tests pass.

The session's inherited temporary directory was inside a Git repository; using `/tmp` restored the fixture boundary tests' required non-Git environment. A GitHub template-menu test and a mock OpenCode startup test failed on separate full runs, each passed its targeted rerun, and the final complete four-worker run passed without changing their code or assertions.
