> Superseded owned residuals: see `.ai/qa/runtime-verified/geometry-closeout/REVIEW.md` and implementation `2f602324`. Former geometry and mobile-picker findings are closed; historical evidence below is retained.

Latest affected captures: [checkpoint b87b5082 review](checkpoint-b87b5082/REVIEW.md). The original proof below describes its earlier frozen build; refreshed images and proof are separate.

# Independent shared-shell and Skills/Workflows review

Scoped fixes are ready for parent review in commit `5ab8ba8d`. This is an independent review of the integrated starting commit `1c030910`, not global 193-frame acceptance and not a pixel-equality claim. The paired images record the remaining differences below.

## Authority and runtime

Only the approved `cezarion.pen` SHA256 `56a71a27c7795137cab1c0a40a5839edecbacab4014d2d39ddc90f89343275f8` and its 193-frame iteration-3 PNG exports were used. No rejected 158-frame reference guided this work. `final-proof.json` checks the source hash, reference PNG hashes, 74 actual capture hashes, one frozen index hash, both live CLI process commands, and every served asset against disk. The two fixtures serve this worktree's built service and assets on 44863 and 44864; they do not use the installed global CLI.

`pairs.json` is the 74-state route ledger. `comparisons/` contains full design/browser pairs for all 22 Skills/Workflows references and four bookmarklet wrappers. The desktop editing references are component boards, so their pair shows the complete board beside the actual open Import dialog; the additional Add/Delete/Overwrite content crops correspond to the other cards. Overview sheets are navigation aids, not acceptance evidence.

`shell/pairs.json` has six current-source shell pairs and fourteen extra actual interaction captures. `shell/comparisons/` adds source status-sheet/live-component comparisons. `shell/behavior-mutations.json` records real persisted fixture mutations; `shell/statuses.json` records contract-validated browser response fixtures for statuses and variant grouping. These fixtures are test inputs, never values hard-coded into the product. Reference PR/issue numbers use distinct GitHub number slots.

## Corrections made

- Restored visible project waiting counts, More links and unreferenced session ages. Their prior `sr-only` treatment preserved DOM text but removed discovery. New assertions fail against the original source (two failures), then pass with the fix (66 tests).
- Corrected the mobile shell's brand/menu alignment and total header height. Its glyph occupies the design's 20px layout slot; the click area remains 44px. Dark header uses the source background.
- Corrected leading sidebar activity-dot color to the source's readable accent, without recoloring the independent unread signal.
- Restored catalog text width consumed by CSS borders, adjusted tool/back controls, and corrected input surfaces, borders and radii in the owned routes.
- Fixed the Markdown cascade: generic thread rules were overriding skill-reader heading sizes. Restored heading/paragraph rhythm and the source's inline list-marker indentation.
- Corrected Auto panel padding, line heights, gaps and border. Blur is followed by a transition wait in the capture script, so idle source states are compared to idle browser controls; keyboard focus indicators remain functional.
- Restored 26px workflow heading layout while retaining a 44px hit area in the surrounding gutters. Boundary reorder controls remain disabled correctly.
- Matched the mobile Import frame's 50px actions, 18px gaps, 12px explanatory text, 1.8 YAML line height and overlay-stroke padding.

No Settings/bookmarklet-inner, task/new-task/session/plan or Git/GitHub route source was edited. EnginePills, PromptTemplateMenu and DiffStatLabel were untouched. Generic Skills input overrides explicitly exclude the bookmarklet inner panel.

## Per-view findings and remaining differences

| Source references | Reviewed paired surface | Outcome / limits |
|---|---|---|
| EKi57, cvBro | Skills desktop, both themes | Catalog and reader widths, exact glyphs, surfaces and heading cascade corrected. Same-content row stack still differs by a few pixels cumulatively; no zero-overflow claim is used as visual acceptance. |
| kmHeY, XdHUd | Skills mobile catalog | Header alignment and seven populated rows verified. Minor text rasterization and row-boundary drift remain. |
| acXhB, utoCL | Mobile skill reader | Heading sizes, list indentation and rhythm corrected; reader bottom remains a few pixels different. |
| f2LGv, suUEJ, MB5Yx, IbcKi | Manage skills desktop/mobile | Search surface and reader alignment corrected. Checked states, Remove all, update/error variants and filter-empty states captured. Small control-width and cumulative vertical differences remain. |
| C2sfEo, s0JzCL, aa0TQ, Ae0n6 | Workflows desktop/mobile | Metadata, selector, palette, two steps and Save compared. Heading hit-area/layout mismatch corrected. Canvas/palette bottom and some button widths still differ by single-digit pixels, and step-number badges are more rounded than the source; command text continues to describe the actual command and retry target. Content differences do not excuse those remaining geometry differences. |
| VDDSI, MmQCH, Zsg4w, e7UWy | Auto open desktop/mobile | Idle field border and panel rhythm corrected, with real prompt input. Remaining minor control/text-width drift is visible in the pairs. |
| lRC5W, KwkJs | Desktop Import/Add/Delete/Overwrite board | Actual dialogs, parser error, preserved YAML and controls captured. Desktop source is a component board, not a specification to show four dialogs simultaneously. |
| djknR, MF4eF | Mobile Import | Header/panel boundary, YAML rhythm, text and 50px actions corrected. Source includes an instructional error placeholder; the app shows a real parser error only after invalid input. Idle and error screenshots are both retained. |
| gqaUM, EsGpp, YS15Y, wLVhd | Bookmarklet wrappers only | Shared page header, tools, catalog and reader wrapper reviewed. Inner panel remains visibly different in badge, heading weight, spacing and controls. It is another worker's ownership and is not accepted here. |
| t5OS8c, wDyFh, IbsZT, IFqhi | R1 264/420px shell | Four exact-size pairs; keyboard Home/End resize and persistence verified. Restored More links deliberately increase project-stack height. Waiting counts and ordinary ages are visible again. |
| h690uO, L0VfI | Mobile navigation drawer | 334px settled drawer, hierarchy, footer, scrim and close verified. Existing Tasks selection remains active on a task route. Source does not show restored counts/More/ages. |
| T2fE7, L61J13 | Status component sheets | Actual sidebar fixtures exercise seven run statuses, monitoring, PR/issue status chips and a variant group. Leading dot and tracker state remain independent; dark activity tone corrected. These are component comparisons, not route replicas. |

## Behavior and genuine design gaps

The real browser verifies project-folder disclosure independently from the project-name link, persisted collapse, cross-project pin routing and Pinned placement, Tools → Archived selection with pin withheld, and fixture cleanup. Variant expansion exposes the correctly scoped compare link. `shell/hit-areas.json` verifies actual pointer activation outside the compact glyph boxes and loaded Poppins/IBM Plex/JetBrains fonts. Existing unit behavior coverage for worker nesting, independently pinned workers, reference statuses, counts, capabilities, footer, palette, width persistence and skill/workflow mutations remains intact (800 scoped tests).

The design omits existing waiting counts, More links and ordinary ages. They are preserved visibly rather than hidden for a screenshot. It also omits the version/update text as a persistent footer item; existing version information remains in Tools/accessibility text. The mobile source draws a project chevron, while the current top bar has no direct project-picker control; project switching through the drawer is functional. A direct header picker remains a design/feature gap, not an implemented control.

Tools, Add project, open palette, archived filter, empty/error/update variants and native selector popup have no dedicated full-page source frame. Their actual open-state captures are supplementary; source component boards do not become fictitious routes. R1's illustrative issue/PR hues differ from its own semantic indicator sheet: live chips follow their actual semantic states. The source's `align-left` glyph is a question-circle fallback; no product callsite uses that name as semantic alignment.

## Validation

- `npm run typecheck`: pass.
- Scoped Vitest: 45 files, 800 tests pass.
- `npm run test:unit`: pass.
- `npm run build`: pass, including check:pack (576 files, 104 web files).
- `npm run test:package`: 27 tests pass.
- Full Vitest: 383 files / 7,988 tests pass; 3 files / 6 tests fail outside this scope. Three `new-task.test.tsx` Save-as-chain cases still look for the old `Save` label; two `routes.test.tsx` default-alias fallback cases remain at `scope-resolving`; `worker-wait-durability.test.ts` recovery case times out waiting for the queued worker. These failures are retained in `validation/tests.log` and are not represented as a green full suite.

## Reproduction

Install locked dependencies and build. Start the route fixture with `node .ai/design-reference/iteration-3/skills-workflows/serve-fixture.mjs "$PWD" 44863`. Start the shell fixture with `node .ai/qa/runtime-verified/independent-review/shell/serve.mjs "$PWD" 44864` (the launcher seeds all three registry entries). Set `TMPDIR=/tmp` and clear TMP/TEMP for Chromium (long worktree socket paths otherwise exceed its limit). Run `capture.mjs` with CEZ_QA_PLAYWRIGHT, CEZ_QA_CHROMIUM and CEZ_QA_DESIGN pointing at installed tools and the approved design exports. Run the shell scripts under Xvfb for desktop hover behavior. Generate comparisons with the two `pair-images.py` scripts (Pillow required), then `node .../finalize.mjs`.
