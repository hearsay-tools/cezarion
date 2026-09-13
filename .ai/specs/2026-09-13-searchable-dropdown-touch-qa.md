# Searchable dropdown touch focus — #163

## Change and cause

The approved scope includes all searchable dropdowns, including workflow pickers.
Radix opens a popover by focusing its first tabbable control, normally search.
Separately, cmdk changes selection on pointer movement and calls `focus()` on an
already-active search input. Dismissing an iPhone keyboard can leave that input
active, so touch scrolling must not enter cmdk's hover-selection path.

The shared Popover records touch activation at its trigger and focuses the
non-editable content when it contains a cmdk search input. Keyboard/mouse opens,
non-search popovers, and caller autofocus overrides retain their behavior.
CommandList stops propagation of touch pointer movement without cancelling its
native default. CommandInput uses 16px mobile text and a 44px wrapper that cannot
shrink around the input. Existing mobile control target floors remain in effect.

Audience: developers browsing a catalog one-handed on a phone. The task is to
browse/select a skill, workflow, label, project or template and search when wanted.
No new art, loading, network, or mutation state is needed for this focus fix.
Existing empty results, filtering, selection, themes and motion remain available.

## Evidence

Two focus tests failed against the original picker before the first fix; the
shared regression tests then failed against unchanged primitives before moving
the fix into them. The desktop guard passed before and after. The existing GitHub
workflow-picker test also verifies that touch opening focuses its container.

| Criterion | Result / evidence |
| --- | --- |
| Touch opening does not automatically focus search | PASS: shared and new-task component tests; native Chrome touch opening reports `popover-content` as activeElement. |
| Scrolling does not call search focus again | PASS for application focus handling: real cmdk regression test keeps search active, sends touch movement, and observes zero focus calls. Ten Chrome CDP touch swipes also observe zero focus calls. Actual iPhone keyboard reopening remains PENDING. |
| Explicit search focus and filtering | PASS: component tests and a native Chrome tap followed by text insertion. |
| Query survives viewport changes; last result remains selectable | PASS: browser test resizes 360×640 → 360×340 → 360×640, retains `qz163browse`, scrolls to and selects result 24. This is resize coverage, not an iPhone keyboard simulation. |
| Desktop arrows, Enter, Escape and mouse hover | PASS: new-task regression exercises real cmdk/Radix behavior. |
| 360×640 without horizontal overflow or obscured search | PASS: measured popover bounds and page scroll width; inspected light and dark screenshots. Search computes to 16px. |
| Touch scrolling does not select/close | PASS: native Chrome touch dispatch scrolls 1,119px to the last result while the menu stays open; deliberate tap selects and closes. |
| Real iPhone QA with browser/OS version | PENDING: no iPhone was available. No device result or iOS version is claimed. |

Browser environment: agent-browser 0.36.0, HeadlessChrome 151.0.0.0 on Linux,
360×640 CSS viewport, native CDP touch dispatch, also repeated with reduced motion enabled. The installed Chrome binary is
151.0.7922.34. This is browser emulation, not a real mobile-device test.

Surviving local evidence:

- `.ai/qa/artifacts_e2e/skill-picker-mobile-light.png`
- `.ai/qa/artifacts_e2e/skill-picker-mobile-dark.png`
- `/tmp/cez-163-native-touch-result.json`
- `/tmp/cez-163-native-touch.mjs` (manual CDP probe against the disposable local QA server)
- `/tmp/cez-163-red.log`, `/tmp/cez-163-shared-red.log`, `/tmp/cez-163-shared-green.log`

The browser test uses the existing suite and a disposable fixture with 24 uniquely
named skills. Run after building and preparing the local test environment:

```sh
TMPDIR=/tmp AGENT_BROWSER_ARGS=--no-sandbox npm test -- --config packages/web/e2e/vitest.config.ts skill-search-ranking
```

## Verification

- `npm run typecheck` → passed.
- `env -u CEZ_AUTOMATIONS TMPDIR=/tmp npm test -- --maxWorkers=8` → 387 files, 8,030 tests passed.
- `npm run test:unit` → 37 core tests and 261 repository-script tests passed.
- `npm run build` → passed, including the 573-file package-content check.
- `npm run test:package` → 27 tests passed.
- Focused browser suite → 4 tests passed.
- GitHub workflow-picker touch regression → passed.

The core/package commands also used `TMPDIR=/tmp` and an unset `CEZ_AUTOMATIONS`.
The inherited task environment otherwise makes a supposed non-Git temporary
fixture live inside this repository and turns on automations in a default-mode
health assertion. No production or test assertion was weakened to address this.
Reduced test concurrency avoided unrelated process-start and 50ms scheduler races.

## Remaining device QA

On an iPhone, record its model, iOS version and browser/version. For both the skill
and workflow dropdowns: open, browse, tap search, type a query, dismiss the keyboard,
scroll to the last result, and select it. Record whether the keyboard reopens,
whether the query survives, whether search stays visible, and whether scrolling
selects or dismisses anything. Keep the PR under `needs-qa` until this is recorded.
