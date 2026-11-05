import { MERMAID_IMPORT, scriptLibrary, type ReportLibraries, type ReportLibraryId } from './report-libraries'

/**
 * Prepares a self-contained HTML report for the sandboxed reader frame (hearsay-tools/cezarion#2400,
 * hearsay-tools/cezarion#2716; docs/adr/0057-run-report-scripts-in-a-nested-opaque-frame.md).
 *
 * The isolation boundary is the frame, in three layers: `sandbox` without `allow-same-origin` (an
 * opaque origin, so a report script cannot reach the cockpit's APIs, cookies, storage or DOM, and
 * cannot navigate the top window), the CSP this module puts first in `<head>` (no request leaves
 * the document), and a wrapper frame whose `frame-src 'none'` stops the report frame from
 * navigating itself away. Parsing happens in an inert `DOMParser` document, never in React's DOM.
 * The cleanup below is defence in depth, and it counts what it blocked for the reader's notice.
 */
export const REPORT_CSP = "default-src 'none'; script-src 'unsafe-inline' data:; img-src data:; media-src data:; font-src data:; style-src 'unsafe-inline' data:; form-action 'none'; base-uri 'none'"

/** The wrapper document's policy: the report's, plus no navigation of the report frame. */
export const WRAPPER_CSP = `${REPORT_CSP}; frame-src 'none'`

/** Inline scripts run in an opaque origin; clicked links may open a new tab outside cezarion. */
export const REPORT_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox'

/** Copy buttons call `navigator.clipboard.writeText`; both frames must delegate the permission. */
export const REPORT_ALLOW = 'clipboard-write'

/** The import-map target for a Mermaid ES module URL: the inline Mermaid script's global. */
const MERMAID_SHIM = `data:text/javascript,${encodeURIComponent('export default globalThis.mermaid')}`

export type BlockedContent = { scripts: number; remote: number; relative: number; forms: number; embeds: number }

export function isHtmlPath(path: string): boolean {
  return /\.html?$/i.test(path)
}

const NEW_TAB = /^(?:https?:|mailto:)/i
const DATA = /^data:/i
const REMOTE = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i
const CSS_URL = /url\(\s*(['"]?)([^'")]*)\1\s*\)|@import\s+(['"])([^'"]+)\3/gi
const RESOURCE_ATTRS = ['src', 'href', 'xlink:href', 'poster', 'background'] as const
const SRCSET_URL = /(?:^|,)\s*(data:\S+|[^,\s]+)/gi
const HINTS = /\b(?:preconnect|dns-prefetch|prefetch|preload|modulepreload|prerender)\b/i

function classify(url: string, blocked: BlockedContent): void {
  const value = url.trim()
  if (!value || value.startsWith('#') || DATA.test(value)) return
  if (REMOTE.test(value)) blocked.remote++
  else blocked.relative++
}

function countCss(text: string, blocked: BlockedContent): void {
  for (const match of text.matchAll(CSS_URL)) classify(match[2] ?? match[4] ?? '', blocked)
}

/** A library's code as the text of an inline script: `</script` would end the element early. */
function inlineScript(doc: Document, code: string): HTMLScriptElement {
  const script = doc.createElement('script')
  script.textContent = code.replace(/<\/script/gi, '<\\/script')
  return script
}

/**
 * Keeps inline scripts. Removes every remote `<script src>` and counts it, except a library from
 * `report-libraries.ts`, whose pinned code takes the tag's place. A deferred tag's code moves to
 * the end of `<body>`, so it runs after the document's own styles, as the deferred tag would.
 * A Mermaid ES module import resolves through an import map to the same code.
 */
function placeScripts(doc: Document, blocked: BlockedContent, libraries: ReportLibraries): void {
  const placed = new Set<ReportLibraryId>()
  const imports = new Set<string>()
  for (const script of [...doc.querySelectorAll('script')]) {
    const src = script.getAttribute('src')
    if (src === null) {
      if (script.getAttribute('type') === 'module') for (const match of (script.textContent ?? '').matchAll(MERMAID_IMPORT)) imports.add(match[2]!)
      continue
    }
    const id = scriptLibrary(src)
    const library = id === 'tailwind-v3' ? 'tailwind' : id
    const code = library ? libraries[library] : undefined
    if (!library || code === undefined || (id === 'tailwind-v3' && libraries['tailwind-v3'] === undefined)) { blocked.scripts++; script.remove(); continue }
    if (placed.has(library)) { script.remove(); continue }
    placed.add(library)
    const inline = inlineScript(doc, code)
    const nodes: Node[] = [inline]
    if (id === 'tailwind-v3') {
      const compat = doc.createElement('style')
      compat.setAttribute('type', 'text/tailwindcss')
      compat.textContent = libraries['tailwind-v3']!
      nodes.unshift(compat)
    }
    const deferred = script.hasAttribute('defer') || script.hasAttribute('async') || script.getAttribute('type') === 'module'
    if (deferred) { script.remove(); doc.body.append(...nodes) } else script.replaceWith(...nodes)
  }
  if (!imports.size) return
  if (libraries.mermaid === undefined) { blocked.scripts += imports.size; return }
  const map = doc.createElement('script')
  map.setAttribute('type', 'importmap')
  map.textContent = JSON.stringify({ imports: Object.fromEntries([...imports].map(url => [url, MERMAID_SHIM])) })
  doc.head.prepend(map, ...(placed.has('mermaid') ? [] : [inlineScript(doc, libraries.mermaid)]))
}

function removeActive(doc: Document, blocked: BlockedContent, libraries: ReportLibraries): void {
  const remove = (selector: string) => { const found = [...doc.querySelectorAll(selector)]; found.forEach(node => node.remove()); return found.length }
  placeScripts(doc, blocked, libraries)
  blocked.embeds = remove('iframe, frame, frameset, object, embed, portal')
  remove('base, meta[http-equiv]')
  for (const link of doc.querySelectorAll('link')) {
    if (HINTS.test(link.getAttribute('rel') ?? '')) link.remove()
  }
  for (const element of doc.querySelectorAll('[ping]')) element.removeAttribute('ping')
  for (const form of doc.querySelectorAll('form')) { blocked.forms++; form.removeAttribute('action') }
  for (const control of doc.querySelectorAll('[formaction]')) control.removeAttribute('formaction')
}

const XLINK = 'http://www.w3.org/1999/xlink'


/** `#anchors` scroll the report, web and mail links open a new tab, every other link is inert.
 *  SVG links may name their destination in `xlink:href`; the same policy applies to it. */
function rewriteLinks(doc: Document, blocked: BlockedContent): void {
  for (const link of doc.querySelectorAll('a, area')) {
    const raw = link.getAttribute('href') ?? link.getAttributeNS(XLINK, 'href')
    if (raw === null) continue
    const href = raw.trim()
    if (href.startsWith('#')) {
      // srcdoc inherits the cockpit's base URL: a bare fragment would load the cockpit
      // inside the opaque frame, losing its auth cookies instead of scrolling the report.
      link.setAttribute('href', `about:srcdoc${href}`)
      link.removeAttributeNS(XLINK, 'href')
      link.removeAttribute('target')
      continue
    }
    if (NEW_TAB.test(href)) { link.setAttribute('target', '_blank'); link.setAttribute('rel', 'noopener noreferrer'); continue }
    if (!REMOTE.test(href)) blocked.relative++
    link.removeAttribute('href')
    link.removeAttributeNS(XLINK, 'href')
    link.removeAttribute('target')
  }
}

/** Counts what the CSP will refuse to load, for the reader's notice. Changes nothing. */
function countResources(doc: Document, blocked: BlockedContent): void {
  for (const element of doc.querySelectorAll('[style]')) countCss(element.getAttribute('style')!, blocked)
  // A sheet of another type, such as Tailwind's `text/tailwindcss`, is never applied, so it loads nothing.
  for (const style of doc.querySelectorAll('style')) if (/^(?:text\/css)?$/i.test(style.getAttribute('type')?.trim() ?? '')) countCss(style.textContent ?? '', blocked)
  for (const link of doc.querySelectorAll('link[href]')) classify(link.getAttribute('href')!, blocked)
  for (const element of doc.querySelectorAll('img, source, video, audio, track, input, image, use, body, table, td')) {
    for (const name of RESOURCE_ATTRS) {
      const value = element.getAttribute(name)
      if (value !== null) classify(value, blocked)
    }
    // A data URL carries its own comma, so a candidate is a data URL up to whitespace, or a plain URL.
    for (const candidate of (element.getAttribute('srcset') ?? '').matchAll(SRCSET_URL)) classify(candidate[1]!, blocked)
  }
}

export function prepareReport(html: string, libraries: ReportLibraries = {}): { srcdoc: string; blocked: BlockedContent } {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const blocked: BlockedContent = { scripts: 0, remote: 0, relative: 0, forms: 0, embeds: 0 }
  removeActive(doc, blocked, libraries)
  rewriteLinks(doc, blocked)
  countResources(doc, blocked)
  const csp = doc.createElement('meta')
  csp.setAttribute('http-equiv', 'Content-Security-Policy')
  csp.setAttribute('content', REPORT_CSP)
  const referrer = doc.createElement('meta')
  referrer.setAttribute('name', 'referrer')
  referrer.setAttribute('content', 'no-referrer')
  doc.head.prepend(csp, referrer)
  return { srcdoc: `<!DOCTYPE html>${doc.documentElement.outerHTML}`, blocked }
}

const escapeAttribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

/**
 * The wrapper document the reader frame loads. It holds only the report frame, under the same
 * sandbox and a policy whose `frame-src 'none'` makes the browser refuse every navigation of that
 * frame: a report script cannot send a request by moving its own frame (`location = …`, a meta
 * refresh). In-page anchors and new tabs are not navigations of the frame, so they still work.
 */
export function wrapReport(srcdoc: string, title: string): string {
  return `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${WRAPPER_CSP}">`
    + '<meta name="referrer" content="no-referrer">'
    + '<style>html,body{margin:0;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}</style></head>'
    + `<body><iframe title="${escapeAttribute(title)}" sandbox="${REPORT_SANDBOX}" allow="${REPORT_ALLOW}" referrerpolicy="no-referrer" srcdoc="${escapeAttribute(srcdoc)}"></iframe></body></html>`
}
