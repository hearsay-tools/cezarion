import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * A source scan of the cockpit e2e specs for the four ways a spec samples instead of waiting
 * (#409). It is a heuristic over lines and call spans, not a parser: the specs are regular
 * enough that a rule fits in a regex, and a false positive costs one wait — the thing the rule
 * asks for anyway. The rules are spelled out for authors in `packages/web/e2e/README.md`.
 *
 * `e2e-wait-discipline.test.ts` runs it against every spec and compares the tally with a
 * checked-in baseline that can only shrink, so today's sites stay where they are and no new
 * one lands without a wait.
 */

export type Rule = 'one-shot-read' | 'hover-in-wait' | 'mutating-predicate' | 'sleep'

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

  return sites.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule))
}

interface CallSpan {
  name: string
  start: number
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
    spans.push({ name: match[1] ?? '', start: match.index, text: source.slice(open + 1, close) })
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
