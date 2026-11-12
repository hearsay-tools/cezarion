/**
 * Reads a stylesheet as rules, so a test can ask what a rule declares instead of matching
 * source text. Whitespace, quote style and selector-list order do not change the result, so a
 * respaced rule cannot slip past an absence check. jsdom's CSSOM drops Tailwind at-rules
 * (`@theme`, `@custom-variant`), which would make an absence check on `index.css` vacuous;
 * this reader keeps every block it can balance and throws on one it cannot.
 */
export type CssRule = {
  /** One selector of the rule's list, whitespace-normalized, with single quotes. */
  readonly selector: string
  /** The at-rule preludes around the rule, outermost first, e.g. `@media (max-width: 767px)`. */
  readonly at: readonly string[]
  readonly declarations: Readonly<Record<string, string>>
}

const normalize = (text: string) =>
  text
    .replace(/"/g, "'")
    .replace(/\s*([>+~,])(?!=)\s*/g, ' $1 ')
    .replace(/\s+/g, ' ')
    // `[data-slot = 'x' ]` reads as `[data-slot='x']`.
    .replace(/\[ ?([\w-]+) ?([~|^$*]?=) ?/g, '[$1$2')
    .replace(/ \]/g, ']')
    .replace(/ , /g, ', ')
    .trim()

/** Splits a selector list on its top-level commas, leaving `:is(a, b)` whole. */
export function splitSelectorList(list: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < list.length; i++) {
    const ch = list[i]
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (ch === ',' && depth === 0) {
      out.push(list.slice(start, i).trim())
      start = i + 1
    }
  }
  out.push(list.slice(start).trim())
  return out.filter(Boolean)
}

/** Drops comments, leaving strings such as `@source "dist/*.js"` intact. */
const stripComments = (css: string) => css.replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|\/\*[\s\S]*?\*\//g, (_, string?: string) => string ?? '')

/**
 * Nested rules resolve against their parents: `.a { &:focus { … } }` reads as `.a:focus`,
 * `.a { .b { … } }` as `.a .b`, and `.a { @media (…) { border: 0 } }` as a `.a` rule inside
 * that `@media`. Statements such as `@apply` and `@import` carry no declaration.
 */
export function cssRules(css: string): CssRule[] {
  const src = stripComments(css)
  const rules: CssRule[] = []
  const declare = (into: Record<string, string> | null, text: string) => {
    const colon = text.indexOf(':')
    if (!into || colon < 0 || text.trim().startsWith('@')) return
    const prop = text.slice(0, colon).trim().toLowerCase()
    const value = normalize(text.slice(colon + 1)).replace(/ ?! ?important$/i, ' !important')
    // A later normal declaration does not beat an earlier important one.
    if (prop && !(into[prop]?.endsWith(' !important') && !value.endsWith(' !important'))) into[prop] = value
  }
  const open = (selectors: readonly string[], at: readonly string[]) => {
    const own: Record<string, string> = {}
    for (const selector of selectors) rules.push({ selector, at, declarations: own })
    return own
  }
  const resolve = (parents: readonly string[] | null, prelude: string) => {
    const selectors = splitSelectorList(prelude)
    if (!parents) return selectors
    return parents.flatMap((parent) => selectors.map((selector) => (selector.includes('&') ? selector.replaceAll('&', parent) : `${parent} ${selector}`)))
  }
  // Reads one block body from `from`; returns the index of its closing brace (or src.length at the top level).
  const block = (from: number, at: readonly string[], parents: readonly string[] | null, declarations: Record<string, string> | null): number => {
    let token = from
    for (let i = from; i < src.length; i++) {
      const ch = src[i]
      if (ch === '"' || ch === "'") {
        const close = src.indexOf(ch, i + 1)
        if (close < 0) throw new Error(`unterminated string at offset ${i}`)
        i = close
      } else if (ch === ';' || ch === '}') {
        declare(declarations, src.slice(token, i))
        token = i + 1
        if (ch === '}') {
          if (from === 0) throw new Error(`unbalanced "}" at offset ${i}`)
          return i
        }
      } else if (ch === '{') {
        const prelude = normalize(src.slice(token, i))
        if (prelude.startsWith('@')) {
          const inner = [...at, prelude]
          i = block(i + 1, inner, parents, parents ? open(parents, inner) : null)
        } else {
          const selectors = resolve(parents, prelude)
          i = block(i + 1, at, selectors, open(selectors, at))
        }
        if (i >= src.length) throw new Error(`unclosed block "${prelude}"`)
        token = i + 1
      }
    }
    return src.length
  }
  block(0, [], null, null)
  return rules
}

/** Escapes `text` for a RegExp source. */
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The last compound of `selector`, split at top-level combinators only: `:has(> b)` and `:is(a, b)` stay whole. */
function subjectOf(selector: string): string {
  const text = normalize(selector)
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === "'") {
      const close = text.indexOf("'", i + 1)
      i = close < 0 ? text.length : close
    } else if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (ch === ' ' && depth === 0) start = i + 1
  }
  if (depth !== 0) throw new Error(`unbalanced selector "${selector}"`)
  return text.slice(start)
}

/**
 * True when `selector`'s subject (its last compound) contains `compound` as a whole token.
 * `.a .b` targets `.b`, not `.a`; `.a:has(> b)` targets `.a`.
 */
export function targets(selector: string, compound: string): boolean {
  return new RegExp(`${literal(normalize(compound))}(?![\\w-])`).test(subjectOf(selector))
}

/** True when `selector` puts a `::before` (or legacy `:before`) on a subject whose compound contains `compound`. */
export function paintsBefore(selector: string, compound: string): boolean {
  const subject = subjectOf(selector)
  return subject.includes(normalize(compound)) && /::?before$/.test(subject)
}
