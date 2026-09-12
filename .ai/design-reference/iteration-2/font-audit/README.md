# Independent font and icon audit

The exact user source is `cezarion.pen`, 4,303,348 bytes, SHA-256 `37378246893ba6259088ec3ddb2702e4220f44ca643ac13e5ac293263021a74b`. It was copied directly from the parent worktree's uncommitted file. No design nodes, variables, font declarations or source bytes were changed. No app source was edited.

## Correct typography

The UI is **Poppins**, not Inter. `variables.cezarion-font-ui.value` is `Poppins`; 3,219 raw font-family properties refer to that variable. Raw declarations also specify JetBrains Mono 22 times and IBM Plex Mono 22 times. Expanding component instances in pen.dev's HTML export yields 7,757 Poppins text elements, 298 JetBrains Mono elements and 22 IBM Plex Mono elements. See `text-instances.json` for the exact frame, text, size, weight, letter spacing, line-height and color of each exported text element. Text IDs repeat across component instances; use frame and surrounding text as well as ID when locating one.

`fonts[]` contains **URL references** for Inter Variable and JetBrains Mono Variable (`fonts/localhost/*.woff2`). It does not embed font bytes and does not override the Poppins variable. pen.dev 0.3.7 instead successfully downloads the requested families from its built-in Google Fonts catalogue. The captured response hashes, byte lengths, font-internal family/weight names and glyph coverage are in `font-provenance.json`. Poppins 400/500/600/700, JetBrains Mono and IBM Plex Mono all loaded; no missing installation needed repairing. System font changes were unnecessary. The 700 face was loaded during full-document export; per-element styles, rather than the load list, determine actual requested text weights.

Proof combines three independent observations: pen.dev DEBUG names the font and URL; a transparent `fetch` observer captures successful public font response bytes; FontTools reads those bytes' name/OS2/cmap/fvar tables. The exported HTML styles resolve to the expected family, and the actual PNGs visibly show Poppins's rounded letterforms and the distinct monospaced prompt text. `E4RdR.png`, made only by adding a probe to a separate unsaved pen.dev session, shows each actual font's different glyph rendering. The original and the source-reference export session never received this probe.

## Known renderer defects, not bad source text

Poppins lacks **U+2304 `⌄`** and **U+21BB `↻`** in its cmap. Every Noto fallback loaded by this renderer also lacks those codepoints. Therefore fresh exports still contain tofu boxes: 105 U+2304-bearing text instances across 51 frames, and ten U+21BB-bearing text instances across ten frames. These counts include shared-component expansion and the reference board. `font-provenance.json` lists every affected frame and text; the main manifest marks each affected view.

JetBrains Mono **does contain U+2304** (`uni2304`). The visual probe renders that same character correctly in JetBrains Mono and as tofu in Poppins and IBM Plex Mono. Loading the correct UI font alone cannot repair pen.dev's fallback selection. This is a renderer fallback limitation, not evidence that the user authored an invalid glyph. JetBrains Mono's coverage of each flagged glyph is recorded individually; do not assume it covers U+21BB.

For implementation, preserve Poppins for UI copy and use an explicit, coverage-tested fallback for the individual glyph, or the supplied Lucide `chevron-down` / `refresh-cw` geometry. Do not reproduce the square. There is no exposed per-glyph fallback registration or rich-text font-run API in this version's supported execute/schema surface. Consequently no speculative font replacement or text mutation was applied to the design merely to hide the artifact. The PNGs are faithful source references with these defects explicitly disclosed, not defect-free references.

## Direct implementation lookup

`icon-correspondence.csv` joins all 3,337 actual icon instances to frame name/ID, adjacent label text, ancestor name/ID context, glyph family/name, size/style, fills and exact SVG file. This is the per-icon correspondence for implementation. In `twLlb`, the inherited name “New task icon” is reused for New task→`plus`, All tasks→`layers`, Tasks→`list-todo`, Git→`git-branch`, GitHub→`github`, Skills→`sparkles`, Workflows→`workflow`, Settings→`settings`, and Global settings→`settings-2`. Using the inherited name as the glyph mapping would be wrong.

`frame-name-map.json` confirms every one of the 158 unique view/reference-board names against its new ID and baseline ID, with image paths and defect flags. `override-review-flags.json` distinguishes confirmed visual defects (the two text-glyph fallback failures) from inherited-name ambiguity and intentional Material hollow-ring styling. It does not label uninspected overrides as visually consistent. Rebuild these joins with `build-correspondence.py`.

## Exact icons

Raw `type: icon` nodes comprise 285 Lucide nodes plus one Material Symbols Rounded `circle`. That count is **not** the expanded icon inventory. Component references and overrides produce **3,337 exported icon instances: 2,968 Lucide and 369 Material Symbols Rounded circles**. They use **73 family/name definitions: 72 Lucide names plus Material Symbols Rounded `circle`**.

`icon-map.json` is the reusable mapping: exact family/name, viewBox, SVG path definitions, geometry hash, and standalone `icons/*.svg`; instances include frame, design node ID/name, rendered size and fill. All definitions come from the renderer's own `html-css` export. No icon family was inferred from a descriptive node name. All source icon-library declarations and override properties were accounted for by expanded rendering.

The renderer loads **lucide-static 0.563.0's `font/lucide.woff2`** and **Material Symbols Rounded v291**. Its SVG export uses **filled font-glyph outlines, no SVG stroke**. Thickness and roundness are baked into the outlines. Exact fidelity uses the supplied viewBox/path geometry with `fill="currentColor"`, plus the recorded instance size/color. A generic `strokeWidth={2}` Lucide SVG may differ in padding/outline metrics from this font export. The Material `circle` is a **thin hollow ring**, not a filled status dot; its node omits an explicit weight, so an invented numeric stroke/weight would be misleading. At a 10px icon box its exported 14-unit viewBox has outer radius about 5.25 and inner radius about 4.6655, an effective ring thickness about 0.4175px. Its paths are the definitive reference.

## Exports and baseline

All 158 source top-level frames were freshly exported with requested scale 2 using pen.dev interactive `Export` in sequential batches. 157 outputs are exactly 2× the resolved frame dimensions. The tall shared-component reference board `nXpJf` resolves to 1660×5438 but pen.dev caps its image at 2501×8192 (about 1.5064×). This resolution limit is recorded rather than misreported as a 2× image. `pen-resolved-bounds.json` comes from supported `Get`/`ctx.bounds`, including auto-height frames. `../design/manifest.json` records source hash, provenance, per-view PNG paths/hashes/dimensions/times and known defects. `export-evidence.json` records the full HTML checksum and export interval. `all-frames.html.gz` preserves the complete HTML export losslessly for re-extraction. No reference-font substitution was used. All 158 fresh PNGs are byte-identical to the previously tracked PNGs: the earlier audit misidentified the font, while those existing images already rendered Poppins. The new manifest and evidence correct that attribution.

The previous baseline claim (71 new, two changed, 85 identical versus `design.pen` on `main`) is withdrawn. The required baseline is **`c3f4d228:cezarion.pen`**. All **158 unique top-level names** match, with no added or removed names. After normalizing IDs/references to named ancestor paths and ignoring top-level canvas placement, 151 frame declarations differ and seven match. Shared variables and document font declarations also changed, so seven matching declarations do not establish seven identical rendered views. `baseline-comparison.json` records the method, IDs and hashes without treating changing IDs as new screens.

All ten contact sheets were visually inspected for gross composition and missing exports. Detailed image inspection covered `twLlb`, `xD5Vz`, `qtABD`, `MAoLU`, `rwgD6`, plus the font probe. It confirms the glyph artifacts in both light and dark Start views, Refresh/filter artifacts in GitHub, and monospaced plan prompts. No blank/corrupt frame was seen in the overview. Contact sheets do not certify every small glyph, clipping edge or pixel in every frame; no all-clear is claimed.

## Reproduction

Use installed pen.dev 0.3.7, read its `execute.md`, then:

1. `NODE_OPTIONS='--require=./.ai/design-reference/iteration-2/font-audit/trace-fonts.cjs' pen interactive --in cezarion.pen --out .ai/design-reference/iteration-2/rendering-audit.pen`
2. Export top-level frame IDs to `design/` at `{scale:2}` and to `font-audit/all-frames.html` with `{includeLayerIds:true}`. Do not save or edit the source. The trace observes only public fonts.gstatic.com responses and never reads credentials.
3. Run `extract.py`; with FontTools available, run `build-report.py`; then run `finalize-manifest.py`. The finalizer asserts the exact source hash. For a checkout without raw HTML, decompress `all-frames.html.gz` first. Font binaries are intentionally local-only; repeat the trace to obtain bytes matching the recorded hashes.

This audit adds no project dependency and runs no application test suite because no app code changed. Validation covers source immutability, all PNG signatures/dimensions/hashes, font metadata/glyph coverage, icon SVG XML/path integrity, export provenance and visual inspection.
