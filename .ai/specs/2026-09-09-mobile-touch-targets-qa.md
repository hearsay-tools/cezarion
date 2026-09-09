# Mobile touch targets — #166

## Scope and design

Approved direct-track bugfix. Density still controls desktop dimensions and spacing;
mobile actions reserve at least 44×44 CSS pixels independently of `--spacing`.
The floor applies to the actual control box, including native picker buttons and menu
items. Switches reserve space with a transparent border around the existing compact
track. No hit-area pseudo-elements, new artwork, dependencies, or state/handler changes.
The mobile header, appearance choices, and workflow toolbar accommodate the larger
targets. Settings tabs retain #183's horizontal scrolling and reveal controller.

## Browser verification

`packages/web/e2e/touch-targets.e2e.ts` runs through the existing agent-browser provider
against a real production build and a disposable local repository/server. Its fixture
contains a completed task with continuation metadata, a skill, and a saved workflow.
The server uses `CEZ_DRY_RUN=1`; no real agent session is resumed.

Matrix: comfortable, compact, ultra × light, dark × 360×640, 1440×900.
The six mobile geometry cases, twelve interaction cases, and six focus-contrast cases pass. Theme/density styling
is applied through the root class/attribute; the appearance density choice is also
activated through the real control. This is Chrome at the requested CSS viewports,
not a claim of native phone keyboard testing.

| Acceptance criterion | Evidence |
| --- | --- |
| Mobile actions measure at least 44×44 in every density | Real `getBoundingClientRect()` measurements across shell, New Task buttons/pickers, workflow actions, appearance controls, task pins, task tabs, follow-up composer, and settings switch. Actual edge midpoints and centers resolve to the intended control through `elementFromPoint()`. |
| Adjacent targets do not overlap or activate neighbors | Pairwise bounds checks, including the workflow count label after renaming. Edge taps toggle the intended pin without opening its task; workflow Remove/Add changes only the selected step; composer disclosure preserves the draft. |
| Density preserves values, drafts, and actions | Cycle all densities with a New Task draft and selected mode; retain the model selection, workflow name, and follow-up draft. Real taps and Enter/Space exercise mode selection, copy, disclosure, and settings switches. |
| Reachable without page overflow at 360×640 | Page scroll-width assertions; actual hit tests after scrolling controls into view; last settings tab remains reachable and labels retain their full intrinsic width. Visual inspection confirmed wrapping in the workflow toolbar. |
| Visible keyboard focus in light and dark | Keyboard modality plus focused-element and computed outline/shadow checks across both themes at both viewports; Enter/Space activates focused controls. Representative screenshots inspected. |
| Criterion results at both requested viewports | All twelve interaction combinations exercised. Desktop model pills remain 26px high, confirming the mobile floor leaves desktop density intact. |

Disabled/pending coverage: tapping empty New Task Send cannot submit. A real config PUT
is held pending to observe the switch's disabled state, retained 44px box, and inert
tap; releasing the request completes the mutation, then Space restores the original
selection. Existing loading/error/offline flows are unchanged; this check does not claim
an exhaustive audit of every data state.

Additional live reduced-motion check at 360×640/ultra/dark: media preference verified,
settings tabs 44px high with unclipped labels, no horizontal page overflow, visible
2px focus outline, and no running control animation.

Screenshots survive locally under `.ai/qa/artifacts_e2e/touch-targets/` using
`<width>-<density>-<theme>-{composer,follow-up,workflow,settings,appearance}.png`.
The reduced-motion screenshot is `/tmp/cez166-reduced-motion.png`. These are local QA
artifacts, not screenshots hosted in the pull request.

## Regression proof

Tests preceded each corresponding fix:

- Original styling: ultra menu/Send measured 33px, picker pills 26px, mode actions 18px
  (`/tmp/cez166-red.log`).
- Follow-up task tabs: ultra height 33px (`/tmp/cez166-thread-red.log`).
- Renamed workflow: the `1 skill` label overlapped Auto before the toolbar wrapping fix
  (`/tmp/cez166-workflow-red.log`).

Command (after building and preparing the local test environment):

```sh
TMPDIR=/tmp XDG_RUNTIME_DIR=/tmp/cez166-browser \
AGENT_BROWSER_SOCKET_DIR=/tmp/cez166-browser AGENT_BROWSER_ARGS=--no-sandbox \
npm test -- --config packages/web/e2e/vitest.config.ts touch-targets
```

## Supervisor focus-contrast follow-up

Integrated main's #184 wordmark without changing its dimensions/assets. The default light
ring is dark and passes; the confirmed regression was the violet accent's ring on the
light sidebar: `rgb(143, 134, 232)` on `rgb(250, 250, 250)` measured **2.9837:1**.
The new regression failed in all three densities before the fix
(`/tmp/cez166-focus-red.log`). Only this PR's mobile outline now uses the existing
`link-foreground` semantic ink token; desktop styling and all hit-target assertions remain.

Six additional browser cases use real Tab navigation, verify `:focus-visible`, wait for
finite transitions to settle, and measure the computed outline against the composited
parent surface (the outline has a 2px offset, outside the control fill). Sampled elements and ancestors have `opacity: 1`; transparent backgrounds are composited. The 48 samples cover settings navigation, appearance buttons,
drawer navigation, and the drawer's button link in both accents/themes and all densities.
Light-theme fixed contrast is **6.78–7.10:1**; the minimum across both themes is **5.76:1**.
Samples and focused screenshots are retained locally as `focus-<pid>.jsonl` and
`focus-<density>-<theme>-<accent>.png` alongside the original browser artifacts.
