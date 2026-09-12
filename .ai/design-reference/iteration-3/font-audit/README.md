# Current193 reference extraction

Source: `cezarion.pen`, SHA256 `56a71a27c7795137cab1c0a40a5839edecbacab4014d2d39ddc90f89343275f8`, 8,498,974 bytes. User confirmed 19A. Fresh pen.dev0.3.7 session36244 exported all193 frames and full HTML without editing source; independent fresh session4248 captured font responses and re-exported Start.

- `../design/manifest.json`: all193 PNGs, source/hash, frame names/IDs/CSS bounds, actual PNG dimensions/scales/hashes. Requested2x; tall component board can be size-capped, recorded explicitly.
- `all-frames.html` and `.gz`: actual complete current HTML, includes layer IDs/names. HTML SHA recorded in extraction-proof.
- `icon-map.json` and `icons/*.svg`: 4,719 visible expanded instances,76 exact filled Lucide geometries. Geometry preserves viewBox/path coordinates, uses currentColor. Per-instance fills and dimensions are in map and CSV. These are font glyph outlines, not interchangeable generic stroked icons.
- `icon-correspondence.csv`: frame/node identity, nearby label, ancestor context, actual icon name, width/height/colors and SVG path.
- `text-instances.json`:9,486 rendered text instances, exact text and inline styles including explicit font family/size/weight/color/line-height/spacing.
- `frame-name-map.json`:193 unique frame names to current IDs and PNG paths.
- `previous-158-comparison.json`: exact-name structural comparison to rejected source37378246.65added,122changed,6unchanged declarations,30removed. IDs/ref IDs normalized; top-level canvas x/y ignored. This is not a pixel comparison and shared component changes can affect unchanged declarations.
- `font-provenance.json`, `font-fetch.ndjson`, `*.font`: freshly downloaded public font response hashes and actual binary family/cmap inspection. HTML families:8,550Poppins,721JetBrains Mono,215IBM Plex Mono.

All45 raw Material Symbols nodes are explicitly disabled (legacy glyphs replaced by filled dots).18Lucide nodes also disabled. Thus visible export correctly has only Lucide; do not copy the old Material circle map into the app.

Poppins binaries lack U+2304/U+21BB. Current HTML has89text instances containing U+2304; affected frame/node lists for both characters are in extraction-proof. Start PNG visually shows fallback squares. Treat these as renderer/font fallback limitations, not required application glyph defects. JetBrains Mono contains U+2304 and IBM Plex Mono contains U+21BB, so check each instance family before drawing conclusions.

Validation: all193 PNG signatures, dimensions and hashes checked; all76SVG files parsed as XML;4719ordered icon occurrences joined against independent HTML parse. This certifies extraction integrity, not app visual acceptance. Keep relevant upstream icon/font licenses when incorporating assets into app code.
