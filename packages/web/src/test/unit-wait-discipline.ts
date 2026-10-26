import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { parse } from '@babel/parser'
import type { AwaitExpression, BinaryExpression, CallExpression, Comment, File, Node } from '@babel/types'

/**
 * A scan of the cockpit unit tests for the three ways a test waits on a clock instead of on the
 * product (hearsay-tools/cezarion#1203). The server's twin is `packages/cezar/src/test-wait-discipline.testkit.ts`;
 * this one reads a syntax tree, since the cockpit tests are TSX and a wait can span many lines.
 *
 * - `short-bound`: Vitest's `vi.waitFor`, `vi.waitUntil` or `expect.poll` with no bound (they give up
 *   after 1 s) or a literal under the floor, and a Testing Library wait (`waitFor`, `findBy*`,
 *   `findAllBy*`, `waitForElementToBeRemoved`) with a literal `timeout` under the floor. A Testing
 *   Library wait with no `timeout` is covered: `vitest.setup.ts` configures `asyncUtilTimeout`.
 * - `sleep`: an awaited timer outside a poll loop, which stands in for a condition nobody named.
 * - `poll-deadline`: a sleep inside a `for`, `while` or `do` loop is a poll interval, so the loop is judged
 *   by its deadline, once per loop however many sleeps it holds. It is reported when nothing bounds it
 *   (no clock read, no attempt count) or when the bound resolves to a literal under the floor. A bound
 *   the scan cannot read (a caller-sized parameter, a count it cannot resolve) is left alone, and a
 *   loop whose only bound is an attempt count counts when the count and every delay are literals.
 *
 * `// bound: <reason>` on the line of a site, or in the comment block directly above it, accepts it.
 * That is for a wait that asserts something does NOT happen within a window, which keeps a short
 * timeout on purpose (`vitest.setup.ts` says so), and for a timer that is not a wait on the product.
 *
 * `unit-wait-discipline.test.ts` runs it over every cockpit unit test and compares the tally with a
 * checked-in baseline that can only shrink.
 */

export type Rule = 'short-bound' | 'sleep' | 'poll-deadline'

export interface Site {
  file: string
  rule: Rule
  /** The line the site is keyed by, trimmed: a line number moves with an edit, the text does not. */
  site: string
  line: number
}

export interface BaselineEntry {
  file: string
  rule: Rule
  site: string
  count: number
}

/** The cockpit's own floor. Testing Library gives up after `asyncUtilTimeout` (3 s) and Vitest ends a test
 *  at 5 s, so a wait below the first is shorter than the host's own bound. A test pins this against the setup. */
export const FLOOR_MS = 3_000
/** What Vitest's own waits use when given no bound. */
const VITEST_DEFAULT_MS = 1_000

export const srcDir = resolve(import.meta.dirname, '..')
export const baselinePath = resolve(import.meta.dirname, 'unit-wait-discipline.baseline.json')

type Visit = (node: Node, ancestors: readonly Node[]) => void

function walk(node: Node, ancestors: Node[], visit: Visit): void {
  visit(node, ancestors)
  ancestors.push(node)
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child === 'object' && typeof (child as Node).type === 'string') walk(child as Node, ancestors, visit)
    }
  }
  ancestors.pop()
}

const isFunction = (node: Node) =>
  node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression' ||
  node.type === 'ObjectMethod' || node.type === 'ClassMethod'
const isPollLoop = (node: Node) => node.type === 'ForStatement' || node.type === 'WhileStatement' || node.type === 'DoWhileStatement'

/** Names bound to a numeric literal (or `a * b` of literals) anywhere in the file; a name bound twice to different values is unreadable. */
function numericConsts(ast: File): Map<string, number | undefined> {
  const consts = new Map<string, number | undefined>()
  walk(ast.program, [], node => {
    const value = node.type === 'VariableDeclarator' && node.id.type === 'Identifier' ? numberOf(node.init, new Map()) : undefined
    if (node.type !== 'VariableDeclarator' || node.id.type !== 'Identifier' || value === undefined) return
    const known = consts.has(node.id.name) && consts.get(node.id.name) !== value
    consts.set(node.id.name, known ? undefined : value)
  })
  return consts
}

/** The local names of Testing Library's `waitFor` and `waitForElementToBeRemoved`. */
function testingLibraryWaits(ast: File): Set<string> {
  const names = new Set<string>()
  for (const node of ast.program.body) {
    if (node.type !== 'ImportDeclaration' || !node.source.value.startsWith('@testing-library/')) continue
    for (const specifier of node.specifiers) {
      const imported = specifier.type === 'ImportSpecifier' && specifier.imported.type === 'Identifier' ? specifier.imported.name : ''
      if (imported === 'waitFor' || imported === 'waitForElementToBeRemoved') names.add(specifier.local.name)
    }
  }
  return names
}

interface Ctx {
  file: string
  lines: string[]
  consts: ReadonlyMap<string, number | undefined>
  tlWaits: ReadonlySet<string>
  accepted: (line: number) => boolean
  sites: Site[]
  /** Each poll loop with the delays of the sleeps inside it, and the function (or program) around it. */
  loops: Map<Node, { delays: Array<Node | undefined>; scope: Node }>
}

function report(ctx: Ctx, rule: Rule, node: Node): void {
  const line = node.loc?.start.line ?? 0
  if (ctx.accepted(line)) return
  ctx.sites.push({ file: ctx.file, rule, line, site: ctx.lines[line - 1]?.trim() ?? '' })
}

/** The value of a numeric expression the scan can read: a literal, a same-file constant, or `a * b`, `a + b`, `a - b` of those. */
function numberOf(node: Node | null | undefined, consts: ReadonlyMap<string, number | undefined>): number | undefined {
  if (!node) return undefined
  if (node.type === 'NumericLiteral') return node.value
  if (node.type === 'Identifier') return consts.get(node.name)
  if (node.type !== 'BinaryExpression') return undefined
  const left = numberOf(node.left, consts)
  const right = numberOf(node.right, consts)
  if (left === undefined || right === undefined) return undefined
  return { '*': left * right, '+': left + right, '-': left - right }[node.operator as '*' | '+' | '-']
}

/** The `.name` of a callee, and the identifier it is called on (`vi` in `vi.waitFor`), when there is one. */
function calleeOf(node: Node): { object?: string; name: string } | undefined {
  if (node.type === 'Identifier') return { name: node.name }
  if (node.type !== 'MemberExpression' || node.computed || node.property.type !== 'Identifier') return undefined
  return node.object.type === 'Identifier' ? { object: node.object.name, name: node.property.name } : { name: node.property.name }
}

/** The value of the `timeout` property of an options object. */
function timeoutOf(options: Node | undefined): Node | undefined {
  if (options?.type !== 'ObjectExpression') return undefined
  for (const property of options.properties) {
    if (property.type === 'ObjectProperty' && !property.computed && property.key.type === 'Identifier' && property.key.name === 'timeout') return property.value
  }
  return undefined
}

/** Vitest's `vi.waitFor`, `vi.waitUntil` and `expect.poll`: the bound in force, or undefined when the scan cannot read it. */
function vitestBound(call: CallExpression, consts: ReadonlyMap<string, number | undefined>): number | undefined {
  const callee = calleeOf(call.callee)
  const isWait = (callee?.object === 'vi' && (callee.name === 'waitFor' || callee.name === 'waitUntil')) ||
    (callee?.object === 'expect' && callee.name === 'poll')
  if (!isWait) return undefined
  const options = call.arguments[1]
  if (!options) return VITEST_DEFAULT_MS
  if (options.type !== 'ObjectExpression') return numberOf(options, consts)
  const timeout = timeoutOf(options)
  return timeout ? numberOf(timeout, consts) : VITEST_DEFAULT_MS
}

/** A Testing Library wait whose literal `timeout` is given: that bound, or undefined when it has none or is unreadable. */
function testingLibraryBound(call: CallExpression, ctx: Ctx): number | undefined {
  const callee = calleeOf(call.callee)
  if (!callee) return undefined
  const query = /^find(?:All)?By[A-Z]/.test(callee.name)
  const wait = callee.object === undefined && ctx.tlWaits.has(callee.name)
  if (!query && !wait) return undefined
  for (const argument of call.arguments) {
    const timeout = timeoutOf(argument)
    if (timeout) return numberOf(timeout, ctx.consts)
  }
  return undefined
}

function shortBound(call: CallExpression, ctx: Ctx): boolean {
  const bound = vitestBound(call, ctx.consts) ?? testingLibraryBound(call, ctx)
  return bound !== undefined && bound < FLOOR_MS
}

const sleepNames = new Set(['delay', 'sleep', 'wait', 'pause'])

/** Whether a function body calls a timer on its resolver: `(resolve) => setTimeout(resolve, 50)`. Returns the delay argument. */
function timerDelay(fn: Node, resolver: string): { delay: Node | undefined } | undefined {
  let found: { delay: Node | undefined } | undefined
  walk(fn, [], node => {
    if (found || node.type !== 'CallExpression') return
    const callee = calleeOf(node.callee)
    if (!callee || !/(?:setTimeout|SetTimeout)$/.test(callee.name)) return
    const first = node.arguments[0]
    if (first?.type === 'Identifier' && first.name === resolver) found = { delay: node.arguments[1] }
  })
  return found
}

/** The delay of an awaited timer (`undefined` inside when the delay is not an argument), or undefined for any other await. */
function awaitedSleep(argument: Node): { delay: Node | undefined } | undefined {
  if (argument.type === 'CallExpression') {
    const callee = calleeOf(argument.callee)
    const timers = callee?.name === 'setTimeout' && (callee.object === undefined || callee.object === 'timers')
    return callee && (timers || (callee.object === undefined && sleepNames.has(callee.name))) ? { delay: argument.arguments[0] } : undefined
  }
  if (argument.type !== 'NewExpression' || argument.callee.type !== 'Identifier' || argument.callee.name !== 'Promise') return undefined
  const executor = argument.arguments[0]
  if (executor?.type !== 'ArrowFunctionExpression' && executor?.type !== 'FunctionExpression') return undefined
  const param = executor.params[0]
  return param?.type === 'Identifier' ? timerDelay(executor, param.name) : undefined
}

/** The innermost `for`, `while` or `do` loop around a node, within its own function. */
function loopAround(ancestors: readonly Node[]): { loop: Node; scope: Node } | undefined {
  let loop: Node | undefined
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    const ancestor = ancestors[i]!
    if (isFunction(ancestor)) return loop ? { loop, scope: ancestor } : undefined
    if (!loop && isPollLoop(ancestor)) loop = ancestor
  }
  return loop ? { loop, scope: ancestors[0]! } : undefined
}

function visitAwait(node: AwaitExpression, ancestors: readonly Node[], ctx: Ctx): void {
  const sleep = awaitedSleep(node.argument)
  if (!sleep || numberOf(sleep.delay, ctx.consts) === 0) return
  const around = loopAround(ancestors)
  if (!around) {
    report(ctx, 'sleep', node)
    return
  }
  const known = ctx.loops.get(around.loop)
  if (known) known.delays.push(sleep.delay)
  else ctx.loops.set(around.loop, { delays: [sleep.delay], scope: around.scope })
}

const clockCall = (node: Node): boolean => {
  if (node.type !== 'CallExpression') return false
  const callee = calleeOf(node.callee)
  return (callee?.object === 'Date' && callee.name === 'now') || (callee?.object === 'performance' && callee.name === 'now') ||
    (callee?.object === 'process' && callee.name === 'hrtime')
}

function contains(root: Node, test: (node: Node) => boolean): boolean {
  let found = false
  walk(root, [], node => { found ||= test(node) })
  return found
}

/** The initializer of a name declared inside a scope (`const deadline = Date.now() + 5_000`), or its parameter default. */
function definition(scope: Node, name: string): Node | undefined {
  let found: Node | undefined
  walk(scope, [], node => {
    if (found) return
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.id.name === name && node.init) found = node.init
    if (node.type === 'AssignmentPattern' && node.left.type === 'Identifier' && node.left.name === name) found = node.right
  })
  return found
}

/** Whether a node reads the clock, directly or through a name declared from it (`elapsed = Date.now() - start`). */
function readsClock(node: Node, scope: Node): boolean {
  if (contains(node, clockCall)) return true
  const init = node.type === 'Identifier' ? definition(scope, node.name) : undefined
  return init !== undefined && contains(init, clockCall)
}

/** The literal a clock comparison measures against: `Date.now() - start > N`, `Date.now() < start + N`, `Date.now() < deadline`. */
function clockBound(comparison: BinaryExpression, scope: Node, consts: ReadonlyMap<string, number | undefined>): number | undefined {
  const own = (name: string) => numberOf(definition(scope, name), consts) ?? consts.get(name)
  for (const [measured, limit] of [[comparison.left, comparison.right], [comparison.right, comparison.left]] as const) {
    if (!readsClock(measured, scope)) continue
    const value = (node: Node): number | undefined => (node.type === 'Identifier' ? own(node.name) : numberOf(node, consts))
    const direct = value(limit)
    if (direct !== undefined) return direct
    const sum = limit.type === 'BinaryExpression' && limit.operator === '+' ? limit : undefined
    if (sum) return value(sum.left) ?? value(sum.right)
    const declared = limit.type === 'Identifier' ? definition(scope, limit.name) : undefined
    if (declared?.type === 'BinaryExpression' && declared.operator === '+') return value(declared.left) ?? value(declared.right)
  }
  return undefined
}

const compares = new Set(['<', '<=', '>', '>='])

function clockDeadline(loop: Node, scope: Node, consts: ReadonlyMap<string, number | undefined>): number | 'unreadable' | undefined {
  if (!contains(loop, node => clockCall(node)) && !contains(loop, node => node.type === 'Identifier' && readsClock(node, scope))) return undefined
  const bounds: number[] = []
  walk(loop, [], node => {
    if (node.type !== 'BinaryExpression' || !compares.has(node.operator)) return
    const bound = clockBound(node, scope, consts)
    if (bound !== undefined) bounds.push(bound)
  })
  return bounds.length ? Math.max(...bounds) : 'unreadable'
}

/** An attempt count: a `for` loop with a test and an update. Readable only as `i < N` or `i <= N` from a literal start. */
function attemptCount(loop: Node, consts: ReadonlyMap<string, number | undefined>): number | 'unreadable' | undefined {
  if (loop.type === 'ForStatement') {
    if (!loop.test || !loop.update) return undefined
    const { test, init } = loop
    const declared = init?.type === 'VariableDeclaration' ? init.declarations[0] : undefined
    const start = declared?.id.type === 'Identifier' ? numberOf(declared.init, consts) : undefined
    if (test.type !== 'BinaryExpression' || (test.operator !== '<' && test.operator !== '<=') || start === undefined) return 'unreadable'
    const limit = numberOf(test.right, consts)
    return limit === undefined ? 'unreadable' : limit - start + (test.operator === '<=' ? 1 : 0)
  }
  const counted = (node: Node) => node.type === 'UpdateExpression' || (node.type === 'AssignmentExpression' && node.operator !== '=')
  return contains(loop, counted) ? 'unreadable' : undefined
}

type Deadline = 'none' | 'unreadable' | number

function pollDeadline(loop: Node, delays: ReadonlyArray<Node | undefined>, scope: Node, consts: ReadonlyMap<string, number | undefined>): Deadline {
  const clock = clockDeadline(loop, scope, consts)
  if (typeof clock === 'number') return clock
  const attempts = attemptCount(loop, consts)
  if (typeof attempts === 'number') {
    const intervals = delays.map(delay => numberOf(delay, consts))
    return intervals.every(interval => interval !== undefined) ? attempts * intervals.reduce<number>((sum, interval) => sum + interval!, 0) : 'unreadable'
  }
  return clock === 'unreadable' || attempts === 'unreadable' ? 'unreadable' : 'none'
}

function visit(node: Node, ancestors: readonly Node[], ctx: Ctx): void {
  if (node.type === 'CallExpression' && shortBound(node, ctx)) report(ctx, 'short-bound', node)
  else if (node.type === 'AwaitExpression') visitAwait(node, ancestors, ctx)
}

/** Acceptance by `// bound: <reason>`: on the site's line, or in the block of comment lines directly above it. */
function acceptance(lines: readonly string[], comments: readonly Comment[]): (line: number) => boolean {
  const reasoned = new Set<number>()
  for (const comment of comments) {
    if (comment.type === 'CommentLine' && /^\s*bound:\s*\S/.test(comment.value)) reasoned.add(comment.loc?.start.line ?? 0)
  }
  return line => {
    if (reasoned.has(line)) return true
    for (let above = line - 1; above >= 1 && lines[above - 1]?.trim().startsWith('//'); above -= 1) if (reasoned.has(above)) return true
    return false
  }
}

export function scanSource(file: string, source: string): Site[] {
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'], attachComment: false })
  const lines = source.split('\n')
  const ctx: Ctx = {
    file, lines, consts: numericConsts(ast), tlWaits: testingLibraryWaits(ast), accepted: acceptance(lines, ast.comments ?? []),
    sites: [], loops: new Map(),
  }
  walk(ast.program, [], (node, ancestors) => visit(node, ancestors, ctx))
  for (const [loop, { delays, scope }] of ctx.loops) {
    const deadline = pollDeadline(loop, delays, scope, ctx.consts)
    if (deadline === 'none' || (typeof deadline === 'number' && deadline < FLOOR_MS)) report(ctx, 'poll-deadline', loop)
  }
  return ctx.sites.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule))
}

/** Every cockpit unit test under a directory. */
export function scanTree(root = srcDir, dir = root): Site[] {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : scanTree(root, path)
    if (!/\.test\.tsx?$/.test(entry.name)) return []
    return scanSource(relative(root, path).replaceAll('\\', '/'), readFileSync(path, 'utf8'))
  })
}

export function tally(sites: Site[]): BaselineEntry[] {
  const counts = new Map<string, BaselineEntry>()
  for (const { file, rule, site } of sites) {
    const key = JSON.stringify([file, rule, site])
    const entry = counts.get(key)
    if (entry) entry.count += 1
    else counts.set(key, { file, rule, site, count: 1 })
  }
  return [...counts.values()].sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule) || a.site.localeCompare(b.site))
}

const keyOf = (entry: BaselineEntry) => JSON.stringify([entry.file, entry.rule, entry.site])

/**
 * `added`: sites the baseline does not cover: a new key, or a known key seen more often than recorded.
 * `stale`: baseline entries the tests no longer have as many of: a fixed site, which the baseline must
 * shrink to match so the ratchet holds at the new level.
 */
export function compareToBaseline(actual: BaselineEntry[], baseline: BaselineEntry[]): { added: BaselineEntry[]; stale: BaselineEntry[] } {
  const recorded = new Map(baseline.map(entry => [keyOf(entry), entry]))
  const seen = new Map(actual.map(entry => [keyOf(entry), entry]))
  const added = actual
    .filter(entry => (recorded.get(keyOf(entry))?.count ?? 0) < entry.count)
    .map(entry => ({ ...entry, count: entry.count - (recorded.get(keyOf(entry))?.count ?? 0) }))
  const stale = baseline.filter(entry => (seen.get(keyOf(entry))?.count ?? 0) < entry.count)
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

export function writeBaseline(sites: BaselineEntry[], path = baselinePath): void {
  const file: BaselineFile = {
    $comment:
      'Bare sleeps, short wait bounds and unbounded poll loops the cockpit unit tests carried when the ratchet landed (hearsay-tools/cezarion#1203). ' +
      'Keyed by file, rule and the line text so a moved line does not churn it. ' +
      'This list only shrinks: fix a site, then run UNIT_WAIT_DISCIPLINE_UPDATE=1 npm test -- unit-wait-discipline. ' +
      'Rules: AGENTS.md § Validation.',
    sites,
  }
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
}

/** Shrink the baseline to what the tests have now. Never grows it: a site it does not cover stays a failure.
 *  Writes the first baseline when the file is missing, from the sites the tests carry the day the ratchet lands. */
export function shrinkBaseline(actual: BaselineEntry[], path = baselinePath): void {
  if (!existsSync(path)) {
    writeBaseline(actual, path)
    return
  }
  const seen = new Map(actual.map(entry => [keyOf(entry), entry]))
  const sites = readBaseline(path)
    .map(entry => ({ ...entry, count: Math.min(entry.count, seen.get(keyOf(entry))?.count ?? 0) }))
    .filter(entry => entry.count > 0)
  writeBaseline(sites, path)
}
