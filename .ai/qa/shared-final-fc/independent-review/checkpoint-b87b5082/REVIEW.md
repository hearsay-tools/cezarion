> Superseded owned residuals: see `.ai/qa/runtime-verified/geometry-closeout/REVIEW.md` and implementation `2f602324`. Former geometry and mobile-picker findings are closed; historical evidence below is retained.

# Integration checkpoint paired review

Completed scoped independent review on a frozen `b87b5082` snapshot with `5ab8ba8d` applied (`cc7f104b`). Shared controls `6a7d1591` and popover `4ed1a848` were already present. No excluded component or other owner's source was edited. Parent should integrate the original scoped fix/evidence commits; the detached capture snapshot is not another implementation to integrate.

20 fresh route captures: eight Workflow/Auto design frames, four bookmarklet wrappers, four native selector states, four open step menus. 20 fresh shell captures: six original design pairs and fourteen menu/navigation states. All 18 full design/browser pairs were visually inspected, as were the open menus. Original 22 Skills/Workflows + four wrapper coverage and behavior evidence remain in the enclosing review; unchanged Skills/import/manage views were not recaptured.

Both built CLI servers and all 100 served files per server match the frozen output; see `final-proof.json`. Index SHA256: `8c15d6e9a1639f6022e82cf1ddfbc401b15473ab360348110f2d8e62555478b0`. The approved 193-frame source hash and each paired reference hash are verified. Build/check:pack passed. Resize Home/End, persisted project collapse and project-link navigation passed in the fresh browser run. Earlier cross-project pin/archive/status/hit-area tests remain the behavior evidence. Full-suite verification belongs to the parent's assigned worker and was not repeated.

## Remaining real gaps

- Workflow step-number badges remain rounder than the source; small input/button widths and cumulative mobile panel spacing still differ (roughly 2–9px). Earlier Skills reader/row geometry residuals remain. These are geometry differences, not data exceptions.
- The mobile source header has a direct project-picker chevron; the product still uses its working drawer for project switching. Waiting counts, More links, and unreferenced ages are intentionally visible although absent from the static design. Their added space changes later project positions; hiding the functionality is not an acceptable visual fix.
- Bookmarklet wrappers have the expected columns, borders, mobile back control and header. The current inner panel still differs substantially: missing source badge, smaller/bolder title, doubled inner padding, launcher presentation and vertical spacing. The first skill also retains a highlight while the bookmarklet panel is selected. Inner implementation remains excluded ownership; this review does not accept it as design-complete.
- In the current GitHub backdrop the Runner control visibly repeats its label (`Runner` followed by `Runner · claude`), unlike the source. Reported for worker445/GitHub owner; no duplicate edit. The backdrop is not a GitHub-route acceptance claim.
- Tools, Add project, palette, archive filter, native selector popup and workflow step-menu states have no distinct full-page design counterpart in this bounded set. They are inspected supplemental evidence. Native OS select popups are not present in browser PNGs. Persistent footer version is absent from the source and not restored as a separate footer item.

The shared controls/popover update introduces no additional mismatch in the owned shell surfaces observed here. This completes the bounded review with explicit residuals; it is not pixel-identical or global 193-frame acceptance.

## Reproduce

Create a detached checkout at `b87b5082`, apply `5ab8ba8d`, install locked dependencies, and build. Place these scripts under `.ai/qa/runtime-verified/independent-review` in that checkout. Start the route fixture using `.ai/design-reference/iteration-3/skills-workflows/serve-fixture.mjs <checkout> 44863` and `shell/serve.mjs <checkout> 44864`. Run `capture.mjs`, then `capture-step-menus.mjs`, and `shell/capture.mjs` under Xvfb. Use the same Playwright/Chromium paths or adapt them to installed binaries. Run the pairing helpers and `finalize.mjs` while both servers remain live. Runtime stores are isolated and intentionally not committed.
