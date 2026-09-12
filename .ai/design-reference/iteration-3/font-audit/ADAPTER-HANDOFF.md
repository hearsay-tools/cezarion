# Exact shared icon adapter handoff

Owner: a4395cbb-69c4-4655-9939-90c5eb8ccc1e (full shell and shared icon adapter).

Canonical input: current193source SHA25656a71a27c7795137cab1c0a40a5839edecbacab4014d2d39ddc90f89343275f8. Everything here was extracted from fresh pen.dev HTML, not copied from the rejected158map.

- `icon-map.json`:76definitions and4,719visibleexpandedinstances. Definitions contain viewBox, exactpathgeometry, SVGrelativepath and geometrySHA. Instances contain actualfamily/icon name, frame/node name/ID, viewBox, renderedwidth/height, fillcolors, andgeometryKey.
- `icons/*.svg`:76standalonefilledglyphoutlines. PreserveviewBox/pathcoordinates and filledrendering; currentColor is already used. Do not substitute strokedReactLucide geometry when exactmatching is required.
- `icon-correspondence.csv`:join eachinstance to frameName,nodeName,adjacentlabel,ancestorcontext,actualglyphname,size,fill,geometryKey andSVGpath. Componentlayernames can be generic/stale; resolve via actualglyph and adjacentlabel.
- `text-instances.json`:9,486actual renderedtextinstances with text/fontsize/family/weight/lineheight/color.
- `all-frames.html`:completeactualcurrentHTML with layerIDs/names, useful to inspect context. `extraction-proof.json` records its SHA and counts.
- `icons/LUCIDE-LICENSE`:upstream license copied from installedlucide-react; retain attribution with incorporatedassets.

Currentvisibleicons are allLucide. All45MaterialSymbols source nodes are explicitlydisabledlegacyglyphs;18Lucidenodes also disabled. Do not restore disabledMaterialcircles. Poppins is theactualUI font. U+2304/U+21BBtextglyphfallback caveats remain recorded in font-provenance/extraction-proof; those are not appiconrequirements.

All193PNGs and currentframeIDs/names/dimensions/hashes are in `../design/manifest.json`. Fullgeometrycan be imported bytheowner fromthisdurableparentpath immediately; exportwork iscomplete.
