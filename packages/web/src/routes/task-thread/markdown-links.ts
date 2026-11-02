/** Markdown links and bare/autolink URLs, in source order, so a Streamdown link *button*
 *  (link-safety has no `href` in the DOM) can be restored to an `<a>` on copy. */
function withoutMarkdownCode(source: string): string {
  const fence = '`'.repeat(3)
  const tilde = '~'.repeat(3)
  const noBacktickFences = source.split(fence).filter((_, index) => index % 2 === 0).join(' ')
  const noFences = noBacktickFences.split(tilde).filter((_, index) => index % 2 === 0).join(' ')
  return noFences.split('`').filter((_, index) => index % 2 === 0).join(' ')
}

function withoutMarkdownImages(source: string): string {
  return source.replace(/!\[(?:\\.|[^\]\\])*\]\([^)\s]*(?:\s+"[^"]*")?\)/g, ' ')
}

function visibleLinkLabel(raw: string): string {
  return raw.replace(/(?<!\\)(?:\*\*|\*|__|~~|`)/g, '').replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, '$1')
}

export function isSafeHref(href: string): boolean {
  const trimmed = href.trim()
  if (trimmed === '' || trimmed.startsWith('#')) return true
  if (/^(https?:|mailto:)/i.test(trimmed)) return true
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return false
  return true
}

export function markdownLinks(source: string): { label: string, href: string }[] {
  const text = withoutMarkdownCode(withoutMarkdownImages(source))
  const defs = new Map<string, string>()
  for (const match of text.matchAll(/^\s*\[([^\]]+)\]:\s*(\S+)/gm)) {
    if (isSafeHref(match[2]!)) defs.set(match[1]!.toLowerCase(), match[2]!)
  }
  const body = text.replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, ' ')
  const links: { label: string, href: string }[] = []
  const re = /(?<!!)\[((?:\\.|[^\]\\])+)\](?:\(((?:[^()\s]|\([^)]*\))+)(?:\s+"[^"]*")?\)|\[([^\]]*)\])|<(https?:\/\/[^>\s]+)>|(https?:\/\/[^\s<]+)/g
  for (const match of body.matchAll(re)) {
    if (match[2]) {
      if (isSafeHref(match[2])) links.push({ label: visibleLinkLabel(match[1]!), href: match[2] })
      continue
    }
    if (match[1] !== undefined && match[3] !== undefined) {
      const id = (match[3].length > 0 ? match[3] : match[1]).toLowerCase()
      const href = defs.get(id)
      if (href) links.push({ label: visibleLinkLabel(match[1]!), href })
      continue
    }
    const href = (match[4] ?? match[5])?.replace(/[.,;:!?]+$/, '')
    if (href && isSafeHref(href)) links.push({ label: href, href })
  }
  return links
}

