/**
 * Prepares a self-contained HTML report for the sandboxed reader frame (hearsay-tools/cezarion#2400).
 *
 * The isolation boundary is the frame: `sandbox` without `allow-scripts` or `allow-same-origin`
 * (opaque origin, nothing runs) plus the CSP this module puts first in `<head>` (no request
 * leaves the frame). Parsing happens in an inert `DOMParser` document, never in React's DOM.
 * The cleanup below is defence in depth, and it counts what it blocked for the reader's notice.
 */
export const REPORT_CSP = "default-src 'none'; img-src data:; media-src data:; font-src data:; style-src 'unsafe-inline' data:; form-action 'none'; base-uri 'none'"

/** Clicked links may open a new tab outside cezarion; nothing else is allowed. */
export const REPORT_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox'

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

function removeActive(doc: Document, blocked: BlockedContent): void {
  const remove = (selector: string) => { const found = [...doc.querySelectorAll(selector)]; found.forEach(node => node.remove()); return found.length }
  blocked.scripts = remove('script')
  blocked.embeds = remove('iframe, frame, frameset, object, embed, portal')
  remove('base, meta[http-equiv]')
  for (const link of doc.querySelectorAll('link')) {
    if (HINTS.test(link.getAttribute('rel') ?? '')) link.remove()
  }
  for (const element of doc.querySelectorAll('*')) {
    for (const name of element.getAttributeNames()) {
      if (/^on/i.test(name) || name === 'ping') element.removeAttribute(name)
    }
  }
  for (const form of doc.querySelectorAll('form')) { blocked.forms++; form.removeAttribute('action') }
  for (const control of doc.querySelectorAll('[formaction]')) control.removeAttribute('formaction')
}

/** `#anchors` scroll the report, web and mail links open a new tab, every other link is inert. */
function rewriteLinks(doc: Document, blocked: BlockedContent): void {
  for (const link of doc.querySelectorAll('a[href], area[href]')) {
    const href = link.getAttribute('href')!.trim()
    if (href.startsWith('#')) { link.removeAttribute('target'); continue }
    if (NEW_TAB.test(href)) { link.setAttribute('target', '_blank'); link.setAttribute('rel', 'noopener noreferrer'); continue }
    if (!REMOTE.test(href)) blocked.relative++
    link.removeAttribute('href')
    link.removeAttribute('target')
  }
}

/** Counts what the CSP will refuse to load, for the reader's notice. Changes nothing. */
function countResources(doc: Document, blocked: BlockedContent): void {
  for (const element of doc.querySelectorAll('[style]')) countCss(element.getAttribute('style')!, blocked)
  for (const style of doc.querySelectorAll('style')) countCss(style.textContent ?? '', blocked)
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

export function prepareReport(html: string): { srcdoc: string; blocked: BlockedContent } {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const blocked: BlockedContent = { scripts: 0, remote: 0, relative: 0, forms: 0, embeds: 0 }
  removeActive(doc, blocked)
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
