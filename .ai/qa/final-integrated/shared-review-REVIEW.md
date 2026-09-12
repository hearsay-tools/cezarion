# Shared target and drilldown browser failure audit

## Genuine fix

`b0013aa9`: ultra density scales the mobile header's spacing gutter from14px to10.5px. The menu's44px pseudo target extends12px left of its20px layout box, so1.5px was outside the viewport. Fixed the gutter at the approved source14px. Ordinary density geometry is unchanged.

## Meaningful target assertions for worker86

The menu's layout box is20x44px; workflow action/grip boxes are26x26px. Their absolute `::after` regions are44x44px. Do not lower the44px threshold or blanket-exempt small controls.

For these explicit controls only (`Open menu`, `wb-step-actions`, `wb-step-grip`), derive the effective absolute pseudo rectangle from getComputedStyle(element,'::after') and the element's bounding box. Require at least44px in both dimensions, all edges inside the viewport, and eight perimeter points (corners inset1px plus edge midpoints) whose elementFromPoint result is the control or its descendant. Other controls retain normal bounding-box assertions. Overlap checks should compare effective rectangles, not only visible boxes. Test an actual pointer click outside the layout box plus keyboard activation and the expected resulting drawer/menu. A decorative pseudo with no hit dispatch must fail.

`hit-regions.mjs` and `hit-regions.json` provide this proof at360x900, comfortable/compact/ultra, light/dark. All18 control combinations pass eight perimeter hit tests. Every menu/action case also opens from outside the layout box and from Enter, then closes with Escape. The grip's pointer region is verified; its drag semantics are separate from dialog activation. Before-fix ultra left perimeter fails atx=-0.5; the fixed region begins atx=2.

No E2E test files were edited; worker86 owns those edits.

## Drilldown diagnosis

The unmodified original agents-dock spec reproduced3 failures (sheet open, long sheet open, collapse), while the real replay passed pointer, Enter and standalone agent-browser selector invocation. A diagnostic pointer listener exposed the difference: the row was sampled at y704.15625, pending layout/scroll moved it to y647.15625, and pointerdown/up/click all landed on the reply textarea at y714.15625. The supposed row click never reached the row. `fc764-drilldown-live.json` records event targets and animation-frame position history; the browser's early frame cadence is approximately1Hz. This is a coordinate sampling/render-settlement race, not an inert row handler. No session route code was changed.


## Red/green harness proof

The unchanged four-test agents-dock spec failed3/4. In a disposable snapshot copy only, waiting for two animation frames before each click makes all4/4 pass in7.12s. Every original expectation is retained: selected child output attribution, sheet placement, long transcript scrolling, follow-tail detach, jump pill, and dock collapse. `diagnostic-frame-wait.patch` shows the complete test-only difference. Worker86 can place the settlement wait in its scoped interaction helper and retain its actual pointer/expected-result checks; do not replace clicks with DOM `.click()` or accept mere row existence.

`reproduce.mjs` also verifies direct pointer, Enter and exact native agent-browser selector activation on the real NDJSON fixture. No session source fix is indicated by this diagnosis. The only source change from this audit is the genuine ultra-density gutter correction.
