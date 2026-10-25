import { memo, useContext, useMemo } from 'react'
import {
  Streamdown,
  defaultRemarkPlugins,
  type CodeHighlighterPlugin,
  type LinkSafetyConfig,
} from 'streamdown'

import { SYN_THEME, highlight, highlightSync, supportedLanguages } from '@/lib/highlighter'

import { LinkSafetyDialog } from './link-safety-dialog'
import { TaskFileContext, taskFileHref } from './file-links'
import { TaskLink } from './task-link'

/**
 * Streamdown code-highlighter plugin over the shared Shiki instance. Return resident tokens
 * synchronously or notify after lazy loading; both theme slots use SYN_THEME.
 */
const shikiPlugin: CodeHighlighterPlugin = {
  name: 'shiki',
  type: 'code-highlighter',
  getThemes: () => [SYN_THEME, SYN_THEME],
  // The truthful list — Streamdown falls back to its plaintext body for anything else, which
  // is the required behavior for the fence infos LLMs invent (```wat, ```output, …).
  getSupportedLanguages: () => supportedLanguages() as never[],
  supportsLanguage: (language) => supportedLanguages().includes(String(language).toLowerCase()),
  highlight: ({ code, language }, callback) => {
    const resident = highlightSync(code, String(language))
    if (resident) return resident
    void highlight(code, String(language)).then((result) => callback?.(result))
    return null
  },
}

interface MdastNode {
  type: string
  value?: string
  url?: string | undefined
  children?: MdastNode[]
}

/**
 * Turn every newline inside a text node into a hard `break` — CommonMark's "a single newline is
 * just a space" rule, disabled.
 *
 * Used for chat text: what a HUMAN typed (#524) and the assistant's replies (#730). A person
 * hitting Enter in a textarea means a line break, and an agent's reply that puts steps on
 * separate lines means it too; collapsing those reflows the message into one paragraph. Documents
 * and compact previews keep the CommonMark reading. `remark-breaks` does exactly this, but it is not a
 * dependency here and `unist-util-visit` is only a transitive one — an mdast tree is plain
 * objects, so the walk is cheaper to inline than either import is to take on.
 *
 * Only `text` nodes are split, which is what keeps it safe: `code` and `inlineCode` carry their
 * content in `value` with no children, so fences and spans are never touched.
 */
function remarkHardBreaks() {
  const walk = (node: MdastNode): void => {
    if (!node.children) return
    const out: MdastNode[] = []
    for (const child of node.children) {
      if (child.type === 'text' && child.value?.includes('\n')) {
        const parts = child.value.split(/\r?\n/)
        parts.forEach((part, index) => {
          // A trailing newline would otherwise emit a dangling `break`, padding every message
          // that ends in Enter with a blank line.
          if (index > 0 && !(part === '' && index === parts.length - 1)) out.push({ type: 'break' })
          if (part) out.push({ type: 'text', value: part })
        })
      } else {
        walk(child)
        out.push(child)
      }
    }
    node.children = out
  }
  return walk
}

/**
 * Streamdown's `remarkPlugins` prop REPLACES its defaults rather than extending them, so passing
 * a bare `[remarkHardBreaks]` would silently drop remark-gfm (links, tables, strikethrough, task
 * lists) and its code-meta plugin — user text would lose the very autolinking this whole change
 * exists to make consistent between the two sides. Compose onto the defaults instead.
 */
const HARD_BREAKS = [...Object.values(defaultRemarkPlugins), remarkHardBreaks]

/**
 * A compact preview still uses the real Markdown parser, but it cannot expose links or block
 * structure: ReasoningItem places an invisible collapsible trigger over this text, so a nested
 * focusable anchor would create a second control under the button. Disallowed block elements are
 * unwrapped to their text while the inline vocabulary (emphasis, strong, strike and code) stays.
 */
const INLINE_ELEMENTS = ['p', 'strong', 'em', 'del', 'code', 'a'] as const
const INLINE_COMPONENTS = { p: 'span', a: 'span' } as const

/**
 * Streamdown's link confirm, rendered by US so it portals out of the thread's contained rows —
 * see link-safety-dialog.tsx for the whole story. Module-level, not built per render: Streamdown
 * memoizes on `linkSafety` by identity, so a fresh object here would re-render every message on
 * every parent render.
 */
const LINK_SAFETY: LinkSafetyConfig = {
  enabled: true,
  renderModal: (props) => <LinkSafetyDialog {...props} />,
}

/** Where a refused document image points: the reserved `.invalid` TLD never resolves. */
const REFUSED_IMAGE = 'https://refused.invalid/'

/**
 * A fresh cache key per `Markdown` memo, for its closure plugins. Streamdown caches its unified
 * processors module-wide, keyed by each plugin's function NAME plus its JSON options, so a
 * closure plugin is built once, by whichever instance renders first, and every later instance
 * gets that one's captured state: task B's file links opened task A's Files tab, and the
 * internal-link record filled a Set no component read. An `instance` option keys each memo's
 * plugins apart; a processor evicted from the cache is rebuilt from the same closures.
 */
let markdownInstances = 0

/**
 * Memoized per message (Streamdown additionally memoizes per block): during streaming only the
 * message whose `children` string actually grew re-renders — the research doc's one hard rule
 * for markdown in chat threads.
 *
 * `breaks` opts into hard line breaks — set it for chat messages (user and assistant), leave it
 * off for documents and compact previews (see `remarkHardBreaks`).
 *
 * `imageSrc` lets a `document` load images after all: given an image's own `src`, it answers the
 * URL to fetch, or `null` to keep the inert `[Image: …]` text. Without it a document fetches no
 * image (a published snapshot has no live directory to resolve against). The diff's Markdown
 * preview (hearsay-tools/cezarion#1012) passes one that resolves repository paths only. Pass a
 * stable function: the memo compares it by identity.
 */
export const Markdown = memo(function Markdown({
  children,
  breaks = false,
  inline = false,
  document = false,
  imageSrc,
}: {
  children: string
  breaks?: boolean
  inline?: boolean
  document?: boolean
  imageSrc?: ((src: string) => string | null) | undefined
}) {
  const fileContext = useContext(TaskFileContext)
  const contextual = useMemo(() => {
    const instance = { instance: ++markdownInstances }
    const internal = new Set<string>()
    // Only a link this walk REWROTE skips the link-safety confirm. A cockpit URL the author
    // wrote themselves, even one naming this task, keeps it: `taskFileHref` returns null for it.
    function taskLinks() {
      const walk = (node: MdastNode): void => {
        if ((node.type === 'link' || node.type === 'definition') && node.url && fileContext) {
          const target = taskFileHref(node.url, fileContext)
          if (target) { node.url = target; internal.add(target) }
        }
        node.children?.forEach(walk)
      }
      return walk
    }
    const resolvedImages = new Set<string>()
    // Images resolve HERE, on the mdast, because Streamdown's harden step blocks every relative
    // `src` before a component could see it (with its own unthemed "Image blocked" pill). The
    // resolved URL is made absolute so harden lets it through; a refused one becomes a URL that
    // can never resolve, so it too reaches the `img` component below, which renders an <img>
    // ONLY for URLs this walk produced and the inert `[Image: …]` text for everything else.
    function documentImages() {
      const walk = (node: MdastNode): void => {
        if (node.type === 'image' && node.url && imageSrc) {
          const resolved = imageSrc(node.url)
          node.url = resolved ? new URL(resolved, window.location.href).href : REFUSED_IMAGE
          if (resolved) resolvedImages.add(node.url)
        }
        node.children?.forEach(walk)
      }
      return walk
    }
    const links = fileContext ? [[taskLinks, instance] satisfies [typeof taskLinks, typeof instance]] : []
    const images = document && imageSrc ? [[documentImages, instance] satisfies [typeof documentImages, typeof instance]] : []
    return {
      remark: [...(breaks ? HARD_BREAKS : Object.values(defaultRemarkPlugins)), ...links, ...images],
      components: {
        ...(fileContext || document ? { a: ({ href, children }: { href?: string | undefined; children?: React.ReactNode }) => {
          // A snapshot has no live directory. Relative links cannot silently target the host.
          if (document && !fileContext && !/^(?:https?:|mailto:|#)/i.test(href ?? '')) return <span>{children}</span>
          return <TaskLink href={href} internal={internal.has(href ?? '')}>{children}</TaskLink>
        } } : {}),
        ...(document ? { img: ({ src, alt }: { src?: unknown; alt?: string | undefined }) => {
          if (typeof src === 'string' && resolvedImages.has(src)) return <img src={src} alt={alt ?? ''} loading="lazy" />
          return <span className="text-muted-foreground">[Image: {alt || 'embedded image'}]</span>
        } } : {}),
      },
    }
  }, [fileContext, breaks, document, imageSrc])
  return (
    <Streamdown
      className={inline ? 'thread-markdown thread-markdown-inline' : 'thread-markdown'}
      plugins={{ code: shikiPlugin }}
      shikiTheme={[SYN_THEME, SYN_THEME]}
      {...(fileContext || (document && imageSrc) ? { remarkPlugins: contextual.remark } : breaks ? { remarkPlugins: HARD_BREAKS } : {})}
      {...(inline ? { allowedElements: INLINE_ELEMENTS } : {})}
      {...(inline ? { unwrapDisallowed: true } : {})}
      {...(inline ? { components: INLINE_COMPONENTS } : fileContext || document ? { components: contextual.components } : {})}
      linkSafety={LINK_SAFETY}
      // Copy + language chip on every fence (the deliverable); download is file-manager noise
      // in a chat, and table export dropdowns are R5-territory chrome.
      controls={{ code: { copy: true, download: false }, table: false, mermaid: false }}
      lineNumbers={false}
    >
      {children}
    </Streamdown>
  )
})
