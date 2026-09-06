# Project task pins — #93 acceptance and QA

Selective port of upstream `44a8dbba` on fork baseline `064a2f00`. Parent approved Design Track on 2026-09-06. No lifecycle/scheduling changes, dependency changes, package identity/version changes, or configuration requirements.

## Acceptance results

| Criterion | Result | Evidence |
| --- | --- | --- |
| Pin/unpin persistence and project isolation | PASS | Store flush/reopen and old-record tests; boot/default/scoped API parity and colliding IDs in two projects. Built-server restart retained alpha's pin while beta's identical ID remained unpinned. |
| One Pinned group with status/attention/counts | PASS | Grouping/component tests; browser sidebar/table moved pins first and retained status/unread dots. Independent review found no fork behavior loss. |
| Whole visible variant group, no duplicates or recent-budget cost | PASS | Tests cover multiple pinned members, unchanged sibling flags, A/B/C order, archived member filtering, lone survivor, zero and ten-row budgets. Browser pinned B: A/B appeared once, archived C remained excluded; multi-project sidebar kept ten ordinary rows. |
| Archive clears pin; unarchive does not restore | PASS | Single/bulk archive tests, archived API pin-attempt tests, disk deletion/reopen. Browser menu archive/unarchive removed both fields; archived menu offered no pin. |
| Keyboard, accessible state, 44px phone controls | PASS | Buttons announce aria-pressed; mobile menu uses menuitemcheckbox/aria-checked. Browser Enter on a phone card and non-active project's sidebar pin, Space on mobile menu: each mutates without unintended navigation. Cards and drawer buttons measured 44x44; menu item measured 123.95x44 after opening animation. |
| Failure retains state and explains retry; themes/reduced motion | PASS | Network-boundary component failure→retry test; browser aborted unpin showed “Could not update pin… Please retry.” and retained pressed state, retry succeeded. 360x640 and 1280x800 light/dark inspected; no phone page overflow; reduced-motion mode kept feedback and pin transition-property resolved to none. |
| Persistence/grouping/scoped-route/contract tests and QA | PASS | Commands below. Source-only regression reversal produced 27 failures, restored source passed 258 targeted tests. |

No acceptance criteria deferred. Global cross-project pin groups, command-palette pins, drag ordering, and lifecycle/scheduling changes remain outside the issue scope.

## Verification

- `npm run typecheck` → pass; subsequent `npm run typecheck:server` → pass after extending both alias body-type assertions.
- `npm test` → 342 files, 6,804 tests passed (baseline: 6,751).
- `npm run test:unit` → pass.
- `npm run build` → pass, including check:pack (499 files / 84 web assets); rebuilt after baseline browser comparison.
- `npm run test:package` → 22 tests passed, zero skips.
- `TMPDIR=/tmp AGENT_BROWSER_ARGS=--no-sandbox npm test -- --config packages/web/e2e/vitest.config.ts quick-list.e2e.ts task-thread.e2e.ts` → 44 passed.
- `git diff --check` → pass.
- Independent read-only review → no blocking findings.

## Browser environment and observations

Built service + assets; agent-browser 0.36.0 and Chrome for Testing 151. Disposable alpha/beta repositories and isolated CEZ_HOME, CEZ_DRY_RUN=1; no real agents. Headless Chrome reports hover:none at both tested viewport sizes; the no-hover path and keyboard focus are exercised. CSS hover reveal also retains the existing component guard. No new art: Pinned disappears when empty and uses existing status, pin and attention glyphs.

Screenshots remain local artifacts under `.ai/qa/artifacts_e2e/`: `pins-phone-light.png`, `pins-phone-dark.png`, `pins-desktop-light.png`, `pins-desktop-dark.png`. UI was visually inspected, not inferred from class names.

The first additional browser smoke run found six stale expectations, all reproduced on the unchanged baseline (six failures / 37 passes): legacy PR-chip wording, aggregate-token assumptions in historical fixtures without directional counters, a now-collapsed step rail, and the action list missing Mark unread. Tests now exercise the current fork UI: reference chip first, unknown directional usage, explicit workflow expansion, backend badge, and Mark unread plus the new Pin action. No production behavior was changed to satisfy those old assertions. The added browser pin case verifies 44px controls, group promotion, reload, sibling flags and pin-field deletion.
