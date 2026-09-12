# Skills and Workflows — implementation checkpoint

This is **not a visual-parity sign-off**. The scoped implementation, behavioral checks, and populated browser evidence are ready for parent review. Shared shell/token/glyph integration is still outstanding, and the residual differences below remain visible.

Additional real-API verification is recorded in `real-runtime/README.md`: ten supplementary browser captures and a persisted workflow import/reorder/save/conflict/overwrite/reload/delete round trip, using the parent's reusable isolated fixture. The service's 93 assets match the same build. These content-different captures supplement the original 74 matched-fixture entries and do not establish additional exact visual matches.

## Source and ownership

- Confirmed source: parent `cezarion.pen`, commit `ac3f4a89`.
- SHA256: `56a71a27c7795137cab1c0a40a5839edecbacab4014d2d39ddc90f89343275f8`; 8,498,974 bytes; 193 frames. Verified before implementation and again after it; never edited.
- `reference/` contains original PNG exports for the 26 related frames and their original export metadata. These are from iteration 3, not the rejected iteration-2 design.
- Owned code: Skills route, skill detail/import components, Workflows route, scoped CSS, and two stale copy assertions in the Skills tests. No API, engine, Settings/bookmarklet-inner, shell, shared primitive, global-style, or asset modifications.
- Current source icons are `type: icon`, `library: lucide`, with names such as `search`, `square-check`, `file-code`, and `wand-sparkles`. Rescanned the current JSON instead of using the rejected font-path map. Existing Lucide imports are used; no duplicate adapter was created.
- Parent coordination attempts for the shared adapter were rejected with `Conversation capacity limit reached` (request `27428325-966e-4607-8490-5a1fb7e5ee3e`, progress `4678566f-29af-4531-a86a-50514a320852`). No contract or integration commit was received.

## What changed

The catalog uses the 310px desktop column, responsive 25px/30px headings, search glyphs, the selected tool treatment, and the source's row spacing. The shared reader uses the source badge and a 16px Markdown content rhythm. Manage skills uses the confirmed copy, outline checkbox glyphs over native inputs, flat installation card, and separate mobile filter/action rows.

Workflows uses the 300px palette, left selector chevron, appropriately sized toolbar/palette glyphs, compact desktop step headings, explicit mobile reorder controls, and the confirmed Auto copy. Import is an accessible Radix dialog with its mobile surface below the header. Add-step and destructive confirmations use the source's typography and action labels. Parser errors preserve the user's YAML. Highlighting the first catalog row while Manage is open does not falsely mark that row as the current page.

The browser caught a mobile Import regression during implementation: the compiled shared centering utilities retained `translate: -50% -50%` despite a `transform: none` override, producing `x=-201, y=-110.5` at a 402px viewport. Responsive translate utilities now reset both underlying Tailwind variables. Browser clicks on Import and Cancel succeed without force; captured bounds start at `x=0, y=52`. The drag append indicator also retains a full-width positioned canvas anchor.

## Evidence and reproduction

`pairs.json` is the per-capture ledger: reference ID and PNG hash, actual PNG, URL, viewport, theme, comfortable density, fixture file, confirmed design hash, and exact built index hash. `build-proof.json` records the built index and JS/CSS asset hashes. `browser-capture.log` contains the actual dialog/card bounds. `server-start-proof.json` identifies the locally built service and isolated CEZ_HOME; its index hash is the server's *initial* build, superseded for visual captures by `build-proof.json` and the per-pair hashes.

There are 74 browser captures: 22 full route/frame pairs, 4 selector-control captures, 32 workflow interaction captures, and 16 supplementary managed-skill/error captures. Full-size route pairs are in `comparisons/`; overview sheets are navigation aids rather than pixel-diff verdicts. Original PNGs and actual screenshots remain separate and unchanged.

For fit-content mobile frames, the export manifest's estimated height differs from the actual PNG height. Final route viewport heights use `pngHeight / scaleX`, preserving the PNG's aspect ratio. `pair-images.py` performs only uniform scaling for side-by-side display. Supplementary states without a dedicated frame point to their enclosing design surface; those are not claims that the whole screenshot matches a static base frame. Editing frame 32 is a component sheet, so actual dialog `*-content.png` crops correspond to individual cards in that sheet.

The runtime starts this worktree's built service and serves this worktree's built Vite assets. The fixture follows the earlier verified runtime recipe with its own local repo and CEZ_HOME. Team repositories are explicitly disabled in the portable launcher. Browser fixtures supply populated skills/workflows, managed-skill update states, and parser/overwrite errors. All exercised mutations are intercepted browser responses; no actual installs, updates, PRs, or agent runs are launched. The bookmarklet key is a fixed fixture string, not a credential.

Reproduce from the worktree root after installing locked dependencies:

```sh
npm run build:server
npm run build:web
node .ai/design-reference/iteration-3/skills-workflows/serve-fixture.mjs "$PWD" 44633
```

In another terminal, provide an installed Playwright module, Chromium executable, and the confirmed design export directory:

```sh
env -u TMP -u TEMP TMPDIR=/tmp \
  CEZ_QA_PLAYWRIGHT=/absolute/path/to/playwright/index.mjs \
  CEZ_QA_CHROMIUM=/absolute/path/to/chrome \
  CEZ_QA_DESIGN=/absolute/path/to/iteration-3/design \
  node .ai/design-reference/iteration-3/skills-workflows/capture.mjs
python3 .ai/design-reference/iteration-3/skills-workflows/pair-images.py
```

The pairing helper needs Pillow. These `CEZ_QA_*` values are fixture-script inputs, not service configuration or new product environment variables.

## Review findings by surface

| Surface and references | Evidence | Actual remaining differences / limits |
| --- | --- | --- |
| Skills desktop `EKi57`, `cvBro` | Same-name PNGs and comparisons | Shell is still 232px rather than 264px, putting the catalog at x=268 instead of x=300 and widening the reader. This changes paragraph wrapping. Shared font rendering, glyph strokes, and theme tokens still differ. Some catalog row vertical positions differ by several pixels. |
| Skills mobile `kmHeY`, `XdHUd` | Same-name pairs | Correct catalog-only structure, tools, search/refresh, and seven populated rows. Header brand/project controls belong to shared shell. Small cumulative row-height/type-rendering differences remain; this is not pixel parity. |
| Detail mobile `acXhB`, `utoCL` | Same-name pairs | Back routing, badge, title, source, usage and Markdown are present. Typography/list indentation and several vertical positions still differ slightly. Desktop reading width depends on the shared shell integration. |
| Manage `f2LGv`, `suUEJ`, `MB5Yx`, `IbcKi` | Same-name pairs | Tools, current status, search, remove-all and all three outlined enabled controls are visible. On mobile, the first skill description wraps to two lines in the browser and one in the export, changing the list's height. Global surface/ink colors and font rendering remain different. Runtime tracked-scope and last-check details remain conditional and were not removed to imitate an empty static card. |
| Workflows `C2sfEo`, `s0JzCL`, `aa0TQ`, `Ae0n6` | Same-name pairs | Metadata, toolbar, two populated steps, palette, YAML disclosure and Save are present. Command summaries deliberately show the actual command/retry target rather than replacing them with the design's prose. Shared mobile 44px target floors make step headings taller than the 26px glyph row in the mockup; disabled boundary reorder actions remain visibly disabled. |
| Auto `VDDSI`, `MmQCH`, `Zsg4w`, `e7UWy` | Same-name pairs | Prompt and Build/Cancel controls are populated. Textarea outline/ink and vertical spacing still differ. Shared shell/font/token differences also apply. |
| Import/error `lRC5W`, `KwkJs`, `djknR`, `MF4eF` | `import-*`, `import-error-*`, content crops | Actual dialog opens and controls work on both viewport classes/themes. Real parser-error copy replaces the design's instructional placeholder. The desktop design is a component sheet, not an overlay specification. Mobile header remains the older shell. |
| Add step / delete / overwrite, frame 32 | `add-step-*`, `delete-*`, `overwrite-*` | All dialogs are open with real fixture data and visible controls. Add selection keeps a visible selected state and a close affordance; destructive dialogs retain mobile stacked actions. These runtime states are not represented one-for-one by separate mobile design frames. |
| Workflow selector | `selector-*` | The native closed selector, left chevron, and selected fixture workflow are captured. Native platform popup pixels are not part of Chromium's page screenshots; there is no separate open-selector design frame in the confirmed source. Existing load-selection behavior is covered by route tests. |
| YAML, step menu, empty palette | `yaml-*`, `step-menu-*`, `filter-empty-*` | Supplementary interaction evidence. Source frames show the entry controls rather than separate expanded states. YAML remains actual generated YAML, and the step menu retains removal. |
| Managed states / errors | `manage-{current,available,updating,error,disabled,filter-empty}-*`, `skills-error-*`, `manage-error-*` | Populated mock states exercise conditional update/error/selection layout. Their reference is the enclosing Manage design; the source has no distinct frame for every server status. Supplementary screenshots are not a visual-match claim for those absent frames. |
| Bookmarklet wrapper `gqaUM`, `EsGpp`, `YS15Y`, `wLVhd` | Same-name pairs | Skills tools/list/back wrapper checked. Inner panel is owned by the Settings worker and unchanged. Fixture catalog creates seven launchers versus three examples in the design; its typography, filtering glyph, action glyphs, and mobile length still differ. |

The source badge and browser commands use existing semantic tokens so the shared worker's token/glyph integration can propagate. The final fine-spacing pass must run on that integrated shell and font/asset implementation; otherwise it would compensate for the wrong shared geometry. No remaining assigned subview is declared matching or silently deferred.

## Behavioral verification

- `npm run typecheck:web` — pass.
- `npm run test -w @open-mercato/cezar-web -- src/routes/skills.test.tsx src/routes/workflows/workflows.test.tsx src/lib/workflow-builder.test.ts` — 74 tests pass.
- Production web build — pass.
- Browser matrix — complete; all 74 ledger entries have zero horizontal overflow. That check is supplementary to the visual inspections, not their substitute.
- Existing custom-prompt precedence, parser error preservation, import/save/overwrite, YAML export, reorder, managed-skill write ordering, refresh selection, and bookmarklet routing tests remain active. Only two static copy assertions changed to the confirmed wording.

## Next step

Parent should provide the shared adapter contract/integration commit and combine the owned shell/token work before this worker performs the final spacing/glyph pass and fresh built-browser review. The family message channel currently blocks that coordination. This checkpoint is intentionally left awaiting that dependency rather than marked complete.
