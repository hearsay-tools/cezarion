# Run report scripts in a nested opaque frame

The HTML report reader (hearsay-tools/cezarion#2400) shows a published report in an iframe. Before
this record, the frame ran no script: its `sandbox` had no `allow-scripts`, its CSP had no
`script-src`, and `prepareReport` removed every `<script>` and every `on*` attribute. Agents write
reports with tabs, filters, checkboxes and copy buttons, and many load Tailwind or Mermaid from a
CDN, so most reports looked wrong or did not work in the reader (hearsay-tools/cezarion#2716).

Report scripts now run. The isolation boundary does not depend on blocking them. It has three
layers, set in `packages/web/src/lib/html-report.ts`:

| Layer | Setting | What it stops |
|---|---|---|
| Opaque origin | `sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"`, never `allow-same-origin` | Reading the cockpit's cookies, storage or DOM, calling its APIs with the user's session, and navigating the top window or the reader |
| Report CSP, first in `<head>` | `default-src 'none'; script-src 'unsafe-inline' data:` plus `data:` images, media, fonts and inline styles | Every request the document makes: `fetch`, XHR, WebSocket, image beacons, remote scripts, styles and fonts |
| Wrapper frame | A second sandboxed `srcdoc` frame around the report frame, with the report CSP plus `frame-src 'none'` | Every navigation of the report frame: `location = …` and a meta refresh that a script adds at run time. A CSP does not cover navigations, so without this layer a script could send a request when the report opens |

`script-src` allows `data:` only for the Mermaid import-map shim below. It opens no network path:
an inline script can already run any code.

A new tab still opens only from a user action. Browsers refuse `window.open` without one, and the
Android and iOS shells check for a user gesture before they open a window. A new tab escapes the
sandbox, so an external site it opens works normally. Both frames delegate `clipboard-write`, so
`navigator.clipboard.writeText` works after a click.

## Pinned CDN libraries

The CSP blocks every remote script. For two libraries, the reader puts the cockpit's own pinned
copy into the page in place of the CDN tag (`packages/web/src/lib/report-libraries.ts`):

| CDN script or import | Pinned copy |
|---|---|
| `cdn.tailwindcss.com` (the Tailwind v3 Play CDN) | `@tailwindcss/browser` 4.3.2, with a compat sheet that gives v4 the v3 look |
| jsDelivr or unpkg `@tailwindcss/browser@4` | `@tailwindcss/browser` 4.3.2 |
| jsDelivr or unpkg `mermaid@11` script | `mermaid` 11.16.0 `mermaid.min.js` |
| A `mermaid@11` ES module URL in an inline module (`import`, `import()`) | The same code, and an import map from that URL to `export default globalThis.mermaid` |

The library code loads in a lazy chunk, only for a report that names the library. The code goes into
the page as an inline script, so no request leaves the frame for it either. Any other remote script
stays blocked, and the blocked notice counts it as a remote script.

The compat sheet imports Tailwind without cascade layers, as the v3 Play CDN emitted it. It also
restores the v3 palette, fonts, line heights, the scales v4 renamed and the v3 preflight defaults.
It was checked against Tailwind 3.4.17 on the four v3 reports published on the development host:
three screenshots are pixel-identical, and the fourth differs by at most 1 of 255 in one
translucent background.

## Consequences

A report script can still change its own document, run timers and use the CPU. It cannot reach the
network, the cockpit or another window. A library outside the table needs a change to this record
and to `report-libraries.ts`. The published package grows by about 3.8 MB for the two libraries.
The specs in `packages/web/e2e/html-report-reader.e2e.ts` prove each layer on its own.
