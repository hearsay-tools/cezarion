import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * A source scan of the cockpit e2e specs for the ways a spec fakes a state or samples instead of
 * waiting (#409, #416). It is a heuristic over lines and call spans, not a parser: the specs are
 * regular enough that a rule fits in a regex, and a false positive costs one wait or one fixture
 * record — the thing the rule asks for anyway. The rules are spelled out for authors in
 * `packages/web/e2e/README.md`.
 *
 * `e2e-wait-discipline.test.ts` runs it against every spec and compares the tally with a
 * checked-in baseline that can only shrink, so today's sites stay where they are and no new
 * one lands without a wait.
 */

export type Rule =
  | 'one-shot-read'
  | 'hover-in-wait'
  | 'mutating-predicate'
  | 'sleep'
  | 'product-dom-write'
  | 'positional-row-index'

export interface Site {
  file: string
  rule: Rule
  /** The line the site is keyed by, trimmed — a selector moves with it, a line number does not. */
  site: string
  line: number
}

export interface BaselineEntry {
  file: string
  rule: Rule
  site: string
  count: number
}

export const e2eDir = resolve(import.meta.dirname, '../../e2e')
export const baselinePath = resolve(import.meta.dirname, 'e2e-wait-discipline.baseline.json')

/** The seam defines the waits and its `getJson` retry is a fetch backoff, not a browser
 *  sleep; `poll.ts` is where every spec-side HTTP poll sleeps (#416); the config drives
 *  nothing. Everything else under `e2e/` drives the browser. */
const excluded = new Set(['agent-browser.ts', 'poll.ts', 'vitest.config.ts'])

/** An action: a seam interaction, or a contrast helper that performs one. */
const action =
  /(?:\b\w+\.(?:click|hover|fill|press|goto|setViewport|moveTo|dragTo|tapAt|wheel)\(|\b(?:applyContrastQaVariant|focusWithKeyboard|hoverVisiblePoint)\()/
/** A one-shot read asserted on directly. */
const read = /\bexpect\(\(?\s*\w+\.(?:evaluate|count|isVisible|text|url)\(/
/** Anything that blocks on a page condition between an action and a read. */
const wait = /\b(?:waitFor\w*|settle\w*)\s*\(/
const sleep = /\bsetTimeout\s*\(/

export function scanSource(file: string, source: string): Site[] {
  const lines = source.split('\n')
  const sites: Site[] = []
  const at = (rule: Rule, index: number): Site => ({ rule, file, line: index + 1, site: lines[index]?.trim() ?? '' })

  // Rule 1 — a one-shot read within two lines after an action, with no wait between them.
  const flaggedReads = new Set<number>()
  lines.forEach((line, i) => {
    if (!action.test(line)) return
    for (let j = i + 1; j <= i + 2 && j < lines.length; j += 1) {
      const candidate = lines[j] ?? ''
      if (wait.test(candidate)) break
      if (read.test(candidate)) flaggedReads.add(j)
    }
  })
  for (const j of [...flaggedReads].sort((a, b) => a - b)) sites.push(at('one-shot-read', j))

  // Rules 2 and 3 — what a wait's argument contains.
  for (const call of callSpans(source, /\b(waitForFunction|waitForValue)\(/g)) {
    const line = lineOf(source, call.start)
    if (call.text.includes(':hover')) sites.push(at('hover-in-wait', line))
    if (call.name === 'waitForFunction' && call.text.includes('scrollIntoView')) sites.push(at('mutating-predicate', line))
  }

  // Rule 4 — a sleep. No exemption: a spec that must poll the server calls `e2e/poll.ts`,
  // which is excluded from this scan and is the only place a spec-side poll sleeps (#416).
  // The name-based exemption this replaces trusted any looping `waitFor…`/`poll…` function,
  // so a helper could sleep for any reason at all under a good name.
  lines.forEach((line, i) => {
    if (sleep.test(line)) sites.push(at('sleep', i))
  })

  // Rules 5 and 6 — what a spec does to the page it is measuring. Both only look inside in-page
  // code, so a node-side `rows[0]` on an array `evaluate` RETURNED is untouched: reading a result
  // by index is not addressing a row by index.
  for (const call of callSpans(source, inPage)) {
    for (const site of productDomSites(call, source)) sites.push(at(site.rule, site.line))
  }

  return sites.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule))
}

/** The calls whose argument is code that runs IN the page. */
const inPage = /\b(evaluate|waitForFunction|waitForValue)\(/g

/** A mutation of a DOM node. `classList`/`dataset` are here because theme and density are set
 *  that way, and the receiver is what tells those apart from a write into a rendered row. */
const writeOp =
  /\.(?:textContent|innerHTML|innerText)\s*=(?!=)|\.dataset\.[\w$]+\s*=(?!=)|\.(?:setAttribute|removeAttribute|replaceChildren|appendChild|append|prepend|insertBefore|replaceWith|remove)\s*\(|\.classList\.(?:add|remove|toggle)\s*\(/
/** A node the SPEC made, not React: writing to it is the point of a probe. */
const specOwned = /\b(?:const|let|var)\s+([\w$]+)\s*=\s*[^\n]*?(?:document\.createElement\(|\.cloneNode\()/g
/** The names a binding introduces — `const [adds, dels] = …` introduces both. */
const boundNames = /\b(?:const|let|var)\s+(\[[^\]]*\]|\{[^}]*\}|[\w$]+)\s*=/
/** A positional read of a live node list. */
const positional = /(?:querySelectorAll\([^\n]*?\)\s*\]?|\b[\w$]+)\s*\[\s*\d+\s*\]/g

/** The identifier a trailing expression starts from — `links` in `links[0].firstChild`, and
 *  `clone` in `clone.querySelector('…')?`. Optional chaining is part of the expression, so the
 *  trailing `?` of a `?.remove()` must not be what decides a receiver's provenance. */
const receiverHead = /([A-Za-z_$][\w$]*)(?:\s*\??\.\s*[\w$]+|\s*\[[^\]]*\]|\s*\([^()]*\))*\??$/

/**
 * A spec that writes into a node React rendered, or addresses a rendered row by its position.
 *
 * Both were how the cockpit specs used to reach a state the fixture did not have: rewrite the
 * title, the workflow cell and the status pill, then measure. `use-now.ts` re-renders those rows
 * every 30 s, so the write is racing a re-render that restores the real value under the
 * measurement, and the row being measured is not the row the product produced. Build the state
 * from fixture data instead; where the product genuinely cannot reach it, the seam belongs in
 * the product.
 *
 * Provenance, not names, decides what is exempt. A receiver rooted in `querySelector` — directly,
 * or through a variable bound to one earlier in the same in-page expression — is a rendered node.
 * A variable bound to `document.createElement` or `.cloneNode` is the spec's own and is masked,
 * whatever it is called, and so is `document.documentElement`, which is where theme, density,
 * width and accent legitimately live.
 *
 * The positional rule only applies to a spec that also addresses rows by `data-run-id`: mixing the
 * two is the inconsistency worth catching, because the file has already said which row it means.
 */
function productDomSites(call: CallSpan, source: string): { rule: Rule; line: number }[] {
  const found: { rule: Rule; line: number }[] = []
  const owned = new Set<string>()
  for (const match of call.text.matchAll(specOwned)) owned.add(match[1] as string)
  const rooted = new Set<string>()
  // Two passes, so `const cell = row.querySelector(…)` then `const link = cell.firstChild` both
  // land. A third would buy nothing the specs actually write.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const line of call.text.split('\n')) {
      const bound = boundNames.exec(line)
      if (!bound) continue
      const names = (bound[1] as string).replace(/[[\]{}.]/g, ' ').split(/[,\s]+/).filter(Boolean)
      const rhs = line.slice((bound.index ?? 0) + bound[0].length)
      const head = receiverHead.exec(rhs.trim())?.[1]
      // Rooted when the right-hand side reaches into the page: through `querySelector`, through
      // a name already known to be rooted at its head, or — for `[...chip.childNodes].find(…)` —
      // anywhere inside it. Looser than the head test on purpose: a binding that MENTIONS a
      // rendered node is one, and the cost of being wrong is one fixture record.
      const fromRooted = [...rooted].some((name) => new RegExp(`\\b${name}\\b`).test(rhs))
      if (!(rhs.includes('querySelector') || (head !== undefined && rooted.has(head)) || fromRooted)) continue
      for (const name of names) if (!owned.has(name)) rooted.add(name)
    }
  }

  const isRendered = (before: string): boolean => {
    const trimmed = before.trimEnd()
    if (trimmed.endsWith('document.documentElement')) return false
    const head = receiverHead.exec(trimmed)?.[1]
    if (head !== undefined && owned.has(head)) return false
    return trimmed.includes('querySelector') || (head !== undefined && rooted.has(head))
  }

  for (const match of call.text.matchAll(new RegExp(writeOp.source, 'g'))) {
    const lineStart = call.text.lastIndexOf('\n', match.index) + 1
    if (isRendered(call.text.slice(lineStart, match.index))) {
      found.push({ rule: 'product-dom-write', line: lineOf(source, call.textStart + match.index) })
    }
  }

  if (source.includes('data-run-id')) {
    for (const match of call.text.matchAll(positional)) {
      const name = /^[\w$]+/.exec(match[0])?.[0]
      if (match[0].includes('querySelectorAll') || (name !== undefined && rooted.has(name) && !owned.has(name))) {
        found.push({ rule: 'positional-row-index', line: lineOf(source, call.textStart + match.index) })
      }
    }
  }

  return found
}

interface CallSpan {
  name: string
  /** Offset of the call in the source. */
  start: number
  /** Offset of `text` in the source, so a match inside it can be given a real line number. */
  textStart: number
  text: string
}

/**
 * The argument text of every call `pattern` names, with strings and template literals (and
 * the `${…}` inside them) crossed rather than counted, so a parenthesis inside a selector does
 * not end the span early. Comments are skipped for the same reason.
 */
function callSpans(source: string, pattern: RegExp): CallSpan[] {
  const spans: CallSpan[] = []
  for (const match of source.matchAll(pattern)) {
    const open = match.index + match[0].length - 1
    const close = matchingParen(source, open)
    spans.push({ name: match[1] ?? '', start: match.index, textStart: open + 1, text: source.slice(open + 1, close) })
  }
  return spans
}

function matchingParen(source: string, open: number): number {
  let depth = 0
  // A stack of what encloses the cursor: a string quote, a template, or a `${` inside one.
  const context: string[] = []
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i] ?? ''
    const top = context.at(-1)
    if (top === "'" || top === '"') {
      if (ch === '\\') i += 1
      else if (ch === top) context.pop()
      continue
    }
    if (top === '`') {
      if (ch === '\\') i += 1
      else if (ch === '`') context.pop()
      else if (ch === '$' && source[i + 1] === '{') {
        context.push('${')
        i += 1
      }
      continue
    }
    // Code: either the top level or a `${…}` slot.
    if (ch === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i)
      if (i === -1) return source.length
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      if (end === -1) return source.length
      i = end + 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') context.push(ch)
    else if (ch === '{' && top === '${') context.push('{')
    else if (ch === '}' && (top === '${' || top === '{')) context.pop()
    else if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return source.length
}

function lineOf(source: string, offset: number): number {
  let line = 0
  for (let i = 0; i < offset; i += 1) if (source[i] === '\n') line += 1
  return line
}

/** Every browser-driving `.ts` under `packages/web/e2e`, scanned. */
export function scanSuite(dir = e2eDir): Site[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ts') && !excluded.has(name))
    .sort()
    .flatMap((name) => scanSource(name, readFileSync(join(dir, name), 'utf8')))
}

/** Sites folded to `(file, rule, site) → count`, sorted for a stable file. */
export function tally(sites: Site[]): BaselineEntry[] {
  const counts = new Map<string, BaselineEntry>()
  for (const { file, rule, site } of sites) {
    const key = JSON.stringify([file, rule, site])
    const entry = counts.get(key)
    if (entry) entry.count += 1
    else counts.set(key, { file, rule, site, count: 1 })
  }
  return [...counts.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule) || a.site.localeCompare(b.site),
  )
}

/**
 * `added`: sites the baseline does not cover — a new key, or a known key seen more often than
 * recorded. `stale`: baseline entries the suite no longer has as many of — a fixed site, which
 * the baseline must shrink to match so the ratchet holds at the new level.
 */
export function compareToBaseline(
  actual: BaselineEntry[],
  baseline: BaselineEntry[],
): { added: BaselineEntry[]; stale: BaselineEntry[] } {
  const key = (e: BaselineEntry) => JSON.stringify([e.file, e.rule, e.site])
  const recorded = new Map(baseline.map((e) => [key(e), e]))
  const seen = new Map(actual.map((e) => [key(e), e]))
  const added = actual
    .filter((e) => (recorded.get(key(e))?.count ?? 0) < e.count)
    .map((e) => ({ ...e, count: e.count - (recorded.get(key(e))?.count ?? 0) }))
  const stale = baseline.filter((e) => (seen.get(key(e))?.count ?? 0) < e.count)
  return { added, stale }
}

interface BaselineFile {
  $comment: string
  sites: BaselineEntry[]
}

export function readBaseline(path = baselinePath): BaselineEntry[] {
  if (!existsSync(path)) return []
  return (JSON.parse(readFileSync(path, 'utf8')) as BaselineFile).sites
}

/**
 * Shrink the baseline to what the suite has now. Never grows it: a site the baseline does not
 * cover stays a failure, so the only way to land one is to give it a wait. Run through
 * `E2E_WAIT_DISCIPLINE_UPDATE=1 npm test -- e2e-wait-discipline`.
 */
export function shrinkBaseline(actual: BaselineEntry[], path = baselinePath): void {
  const baseline = readBaseline(path)
  const key = (e: BaselineEntry) => JSON.stringify([e.file, e.rule, e.site])
  const seen = new Map(actual.map((e) => [key(e), e]))
  const sites = baseline
    .map((e) => ({ ...e, count: Math.min(e.count, seen.get(key(e))?.count ?? 0) }))
    .filter((e) => e.count > 0)
  writeBaseline(sites, path)
}

export function writeBaseline(sites: BaselineEntry[], path = baselinePath): void {
  const file: BaselineFile = {
    $comment:
      'Wait-discipline sites the cockpit e2e suite carried when the ratchet landed (issue 409). ' +
      'Keyed by file, rule and the line text so a moved line does not churn it. ' +
      'This list only shrinks: fix a site, then run E2E_WAIT_DISCIPLINE_UPDATE=1 npm test -- e2e-wait-discipline. ' +
      'Rules: packages/web/e2e/README.md.',
    sites,
  }
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
}
