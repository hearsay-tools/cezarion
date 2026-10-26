import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { parse } from '@babel/parser'
import type { AwaitExpression, BinaryExpression, CallExpression, Comment, File, Node } from '@babel/types'
import { type BaselineEntry as Entry, waitBaseline } from './wait-baseline'

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

export type BaselineEntry = Entry<Rule>

/** The cockpit's own floor. Testing Library gives up after `asyncUtilTimeout` (3 s) and Vitest ends a test
 *  at 5 s, so a wait below the first is shorter than the host's own bound. A test pins this against the setup. */
export const FLOOR_MS = 3_000
/** What Vitest's own waits use when given no bound. */
const VITEST_DEFAULT_MS = 1_000

export const srcDir = resolve(import.meta.dirname, '..')
export const baselinePath = resolve(import.meta.dirname, 'unit-wait-discipline.baseline.json')

/** Returns `false` to leave a node's children unvisited. */
type Visit = (node: Node, ancestors: readonly Node[]) => void | false

function walk(node: Node, ancestors: Node[], visit: Visit): void {
  if (visit(node, ancestors) === false) return
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

/** The local names of Testing Library's `waitFor` and `waitForElementToBeRemoved`, and of a namespace import of the library (`rtl` in `rtl.waitFor`). */
function testingLibrary(ast: File): { tlWaits: Set<string>; tlNamespaces: Set<string> } {
  const tlWaits = new Set<string>()
  const tlNamespaces = new Set<string>()
  for (const node of ast.program.body) {
    if (node.type !== 'ImportDeclaration' || !node.source.value.startsWith('@testing-library/')) continue
    for (const specifier of node.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier') tlNamespaces.add(specifier.local.name)
      const imported = specifier.type === 'ImportSpecifier' && specifier.imported.type === 'Identifier' ? specifier.imported.name : ''
      if (imported === 'waitFor' || imported === 'waitForElementToBeRemoved') tlWaits.add(specifier.local.name)
    }
  }
  return { tlWaits, tlNamespaces }
}

interface Ctx {
  file: string
  lines: string[]
  consts: ReadonlyMap<string, number | undefined>
  tlWaits: ReadonlySet<string>
  tlNamespaces: ReadonlySet<string>
  accepted: (line: number) => boolean
  sites: Site[]
  /** Each poll loop with the delays of the sleeps inside it, and where it sits. */
  loops: Map<Node, { delays: Array<Node | undefined>; where: Where }>
}

function report(ctx: Ctx, rule: Rule, node: Node): void {
  const line = node.loc?.start.line ?? 0
  if (ctx.accepted(line)) return
  ctx.sites.push({ file: ctx.file, rule, line, site: ctx.lines[line - 1]?.trim() ?? '' })
}

/** The value of a numeric expression the scan can read: a literal, a same-file constant, or `a * b`, `a / b`, `a + b`, `a - b` of those. */
function numberOf(node: Node | null | undefined, consts: ReadonlyMap<string, number | undefined>): number | undefined {
  if (!node) return undefined
  if (node.type === 'NumericLiteral') return node.value
  if (node.type === 'Identifier') return consts.get(node.name)
  if (node.type !== 'BinaryExpression') return undefined
  const left = numberOf(node.left, consts)
  const right = numberOf(node.right, consts)
  if (left === undefined || right === undefined) return undefined
  return { '*': left * right, '/': left / right, '+': left + right, '-': left - right }[node.operator as '*' | '/' | '+' | '-']
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
  const wait = callee.object === undefined ? ctx.tlWaits.has(callee.name) : ctx.tlNamespaces.has(callee.object) && /^waitFor(?:ElementToBeRemoved)?$/.test(callee.name)
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

/** Where a poll loop sits: the nodes above it, and the function (or program) a name in it is looked up in. */
interface Where {
  loop: Node
  scope: Node
  /** Every node above the loop, outermost first. */
  above: readonly Node[]
}

/** The innermost `for`, `while` or `do` loop around a node, within its own function. */
function loopAround(ancestors: readonly Node[]): Where | undefined {
  let loop: Node | undefined
  let at = -1
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    const ancestor = ancestors[i]!
    if (isFunction(ancestor)) return loop ? { loop, scope: ancestor, above: ancestors.slice(0, at) } : undefined
    if (!loop && isPollLoop(ancestor)) {
      loop = ancestor
      at = i
    }
  }
  return loop ? { loop, scope: ancestors[0]!, above: ancestors.slice(0, at) } : undefined
}

function visitAwait(node: AwaitExpression, ancestors: readonly Node[], ctx: Ctx): void {
  const sleep = awaitedSleep(node.argument)
  if (!sleep) return
  const around = loopAround(ancestors)
  if (!around) {
    // A zero delay outside a loop only yields to the event loop. In a loop it is the poll interval of a spin.
    if (numberOf(sleep.delay, ctx.consts) !== 0) report(ctx, 'sleep', node)
    return
  }
  const known = ctx.loops.get(around.loop)
  if (known) known.delays.push(sleep.delay)
  else ctx.loops.set(around.loop, { delays: [sleep.delay], where: around })
}

const clockCall = (node: Node): boolean => {
  if (node.type !== 'CallExpression') return false
  const callee = calleeOf(node.callee)
  return (callee?.object === 'Date' && callee.name === 'now') || (callee?.object === 'performance' && callee.name === 'now') ||
    (callee?.object === 'process' && callee.name === 'hrtime')
}

/** Whether any node under `root` passes, leaving out the functions nested in it: what a helper does is not what the loop does. */
function contains(root: Node, test: (node: Node) => boolean): boolean {
  let found = false
  walk(root, [], node => {
    found ||= test(node)
    return node !== root && isFunction(node) ? false : undefined
  })
  return found
}

/** A name declared in a function: its initializer (none for a parameter without a default) and where it is in view. */
interface Declaration {
  init: Node | undefined
  /** The block, loop or function the name belongs to. */
  owner: Node
  insideLoop: boolean
  start: number
}

const blockScopes = new Set(['BlockStatement', 'Program', 'StaticBlock', 'ForStatement', 'ForInStatement', 'ForOfStatement'])

/** What `node` declares under `name` in `scope`: a variable, a parameter or a parameter's default. */
function declaredAs(node: Node, ancestors: readonly Node[], scope: Node, name: string): Pick<Declaration, 'init' | 'owner'> | undefined {
  const parent = ancestors.at(-1)
  if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.id.name === name && parent?.type === 'VariableDeclaration') {
    const owner = parent.kind === 'var' ? scope : [...ancestors].reverse().find(ancestor => blockScopes.has(ancestor.type)) ?? scope
    return { init: node.init ?? undefined, owner }
  }
  const param = 'params' in scope && (scope.params as readonly Node[]).includes(node)
  if (param && node.type === 'Identifier' && node.name === name) return { init: undefined, owner: scope }
  if (param && node.type === 'AssignmentPattern' && node.left.type === 'Identifier' && node.left.name === name) return { init: node.right, owner: scope }
  return undefined
}

/** Every declaration of a name in the loop's function, leaving out the functions nested in it: their names are theirs. */
function declarationsOf(where: Where, name: string): Declaration[] {
  const found: Declaration[] = []
  walk(where.scope, [], (node, ancestors) => {
    if (node !== where.scope && isFunction(node)) return false
    const declared = declaredAs(node, ancestors, where.scope, name)
    if (declared) found.push({ ...declared, insideLoop: ancestors.includes(where.loop), start: node.start ?? 0 })
  })
  return found
}

/**
 * What a name means at a poll loop, the way the language scopes it: a declaration inside the loop first, else the
 * one in the nearest block that holds the loop (the latest there, before the loop). A sibling block that closed
 * earlier, or a helper function declaring the same name, is not in view. The result has no `init` for a parameter
 * without a default, which hides a same-file constant of that name.
 */
function definition(where: Where, name: string): { init: Node | undefined } | undefined {
  const inView = declarationsOf(where, name).filter(declaration => declaration.insideLoop || where.above.includes(declaration.owner))
  const inside = inView.find(declaration => declaration.insideLoop)
  if (inside) return inside
  const depth = (declaration: Declaration) => where.above.indexOf(declaration.owner)
  const before = inView.filter(declaration => declaration.start < (where.loop.start ?? 0))
  return before.reduce<Declaration | undefined>((nearest, declaration) => (!nearest || depth(declaration) >= depth(nearest) ? declaration : nearest), undefined)
}

/** Whether a node reads the clock, directly or through a name declared from it (`elapsed = Date.now() - start`). */
function readsClock(node: Node, where: Where): boolean {
  if (contains(node, clockCall)) return true
  const init = node.type === 'Identifier' ? definition(where, node.name)?.init : undefined
  return init !== undefined && contains(init, clockCall)
}

type Consts = ReadonlyMap<string, number | undefined>

/** The literal a clock comparison measures against: `Date.now() - start > N`, `Date.now() < start + N`, `Date.now() < deadline`. */
function limitValue(limit: Node, where: Where, consts: Consts): number | undefined {
  const own = (name: string) => {
    const declared = definition(where, name)
    return declared ? numberOf(declared.init, consts) : consts.get(name)
  }
  const value = (node: Node): number | undefined => (node.type === 'Identifier' ? own(node.name) : numberOf(node, consts))
  const direct = value(limit)
  if (direct !== undefined) return direct
  const sum = limit.type === 'BinaryExpression' && limit.operator === '+' ? limit : undefined
  if (sum) return value(sum.left) ?? value(sum.right)
  const declared = limit.type === 'Identifier' ? definition(where, limit.name)?.init : undefined
  return declared?.type === 'BinaryExpression' && declared.operator === '+' ? value(declared.left) ?? value(declared.right) : undefined
}

/** What a comparison says about the clock: the literal it measures against, `unreadable` when it measures the clock against something else, `undefined` when it does not measure the clock. */
function clockBound(comparison: BinaryExpression, where: Where, consts: Consts): number | 'unreadable' | undefined {
  const measuring = ([[comparison.left, comparison.right], [comparison.right, comparison.left]] as const).filter(([measured]) => readsClock(measured, where))
  for (const [, limit] of measuring) {
    const value = limitValue(limit, where, consts)
    if (value !== undefined) return value
  }
  return measuring.length > 0 ? 'unreadable' : undefined
}

const compares = new Set(['<', '<=', '>', '>='])
const isCompare = (node: Node): node is BinaryExpression => node.type === 'BinaryExpression' && compares.has(node.operator)
/** A comparison that can end a counted loop: an ordering, or `i !== 20`. */
const limitOperators = new Set([...compares, '==', '===', '!=', '!=='])
const isLimit = (node: Node): node is BinaryExpression => node.type === 'BinaryExpression' && limitOperators.has(node.operator)

/**
 * The deadline a loop's clock comparisons give it: the largest literal they measure against (the scan cannot tell a
 * comparison that ends the loop from one that does not), `unreadable` when the clock is compared with nothing it reads,
 * and `undefined` when the clock is never compared. A clock that is only read, logged or stored, bounds nothing.
 */
function clockDeadline(where: Where, consts: Consts): number | 'unreadable' | undefined {
  const bounds: number[] = []
  let compared = false
  walk(where.loop, [], node => {
    if (node !== where.loop && isFunction(node)) return false
    if (!isCompare(node)) return
    const bound = clockBound(node, where, consts)
    compared ||= bound !== undefined
    if (typeof bound === 'number') bounds.push(bound)
  })
  return bounds.length ? Math.max(...bounds) : compared ? 'unreadable' : undefined
}

/** The operands of an `&&` chain: `i < 20 && !ready()` bounds the loop by `i < 20`. */
const conjuncts = (test: Node): Node[] => (test.type === 'LogicalExpression' && test.operator === '&&' ? [...conjuncts(test.left), ...conjuncts(test.right)] : [test])

const isNamed = (node: Node, name: string): boolean => node.type === 'Identifier' && node.name === name

/** The signed literal an operator and its operand add: `+= 5` adds 5, `- 5` adds -5. */
function signed(operator: string, operand: Node, consts: Consts): number | undefined {
  const size = numberOf(operand, consts)
  if (size === undefined) return undefined
  return operator === '+' || operator === '+=' ? size : operator === '-' || operator === '-=' ? -size : undefined
}

/** What an update adds to the counter `name`, signed: `name++`, `--name`, `name += 5`, `name = name - 5`. */
function stepOf(update: Node, name: string, consts: Consts): number | undefined {
  if (update.type === 'UpdateExpression') return isNamed(update.argument, name) ? (update.operator === '++' ? 1 : -1) : undefined
  if (update.type !== 'AssignmentExpression' || !isNamed(update.left, name)) return undefined
  const sum = update.operator === '=' && update.right.type === 'BinaryExpression' && isNamed(update.right.left, name) ? update.right : undefined
  return sum ? signed(sum.operator, sum.right, consts) : signed(update.operator, update.right, consts)
}

/** How many times `for (let i = a; i < b; i += c)` runs, when `a`, `b` and `c` are readable and `c` moves `i` toward `b`. */
function iterations(loop: Extract<Node, { type: 'ForStatement' }>, consts: Consts): number | undefined {
  const declarations = loop.init?.type === 'VariableDeclaration' ? loop.init.declarations : []
  for (const test of conjuncts(loop.test!)) {
    if (!isCompare(test) || test.left.type !== 'Identifier') continue
    const name = test.left.name
    const start = numberOf(declarations.find(declaration => declaration.id.type === 'Identifier' && declaration.id.name === name)?.init, consts)
    const limit = numberOf(test.right, consts)
    const step = stepOf(loop.update!, name, consts)
    const up = test.operator.startsWith('<')
    if (start === undefined || limit === undefined || step === undefined || step === 0 || up !== step > 0) return undefined
    const span = up ? limit - start : start - limit
    return Math.max(0, test.operator.endsWith('=') ? Math.floor(span / Math.abs(step)) + 1 : Math.ceil(span / Math.abs(step)))
  }
  return undefined
}

/** Whether a loop steps a counter and compares it with something (`tries++ > 20`, `retries < 5`): a limit the scan cannot turn into time. */
function comparesCounter(loop: Node): boolean {
  const stepped = new Set<string>()
  const comparisons: BinaryExpression[] = []
  walk(loop, [], node => {
    if (node !== loop && isFunction(node)) return false
    if (node.type === 'UpdateExpression' && node.argument.type === 'Identifier') stepped.add(node.argument.name)
    if (node.type === 'AssignmentExpression' && node.operator !== '=' && node.left.type === 'Identifier') stepped.add(node.left.name)
    if (isLimit(node)) comparisons.push(node)
  })
  const nameOf = (side: Node) => (side.type === 'Identifier' ? side.name : side.type === 'UpdateExpression' && side.argument.type === 'Identifier' ? side.argument.name : '')
  return comparisons.some(comparison => stepped.has(nameOf(comparison.left)) || stepped.has(nameOf(comparison.right)))
}

/**
 * An attempt count: how many times a `for` loop with a readable counter runs, `unreadable` when a counter is compared with a
 * limit the scan cannot evaluate, and `undefined` when nothing counts or a counter is only stepped.
 */
function attemptCount(loop: Node, consts: Consts): number | 'unreadable' | undefined {
  if (loop.type === 'ForStatement' && loop.test && loop.update && conjuncts(loop.test).some(isLimit)) return iterations(loop, consts) ?? 'unreadable'
  return comparesCounter(loop) ? 'unreadable' : undefined
}

type Deadline = 'none' | 'unreadable' | number

function pollDeadline(where: Where, delays: ReadonlyArray<Node | undefined>, consts: ReadonlyMap<string, number | undefined>): Deadline {
  const clock = clockDeadline(where, consts)
  if (typeof clock === 'number') return clock
  const attempts = attemptCount(where.loop, consts)
  if (typeof attempts === 'number') {
    const intervals = delays.map(delay => numberOf(delay, consts))
    const interval = intervals.every(each => each !== undefined) ? intervals.reduce<number>((sum, each) => sum + each!, 0) : 0
    return interval > 0 ? attempts * interval : 'unreadable'
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
    file, lines, consts: numericConsts(ast), ...testingLibrary(ast), accepted: acceptance(lines, ast.comments ?? []),
    sites: [], loops: new Map(),
  }
  walk(ast.program, [], (node, ancestors) => visit(node, ancestors, ctx))
  for (const [loop, { delays, where }] of ctx.loops) {
    const deadline = pollDeadline(where, delays, ctx.consts)
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

export { compareToBaseline, tally } from './wait-baseline'

/** Shrink the baseline through `UNIT_WAIT_DISCIPLINE_UPDATE=1 npm test -- unit-wait-discipline`: a site it does not
 *  cover stays a failure. The first shrink writes the baseline from the sites the tests carry the day the ratchet lands. */
export const {
  read: readBaseline,
  write: writeBaseline,
  shrink: shrinkBaseline,
} = waitBaseline<Rule>({
  path: baselinePath,
  seedWhenMissing: true,
  comment:
    'Bare sleeps, short wait bounds and unbounded poll loops the cockpit unit tests carried when the ratchet landed (hearsay-tools/cezarion#1203). ' +
    'Keyed by file, rule and the line text so a moved line does not churn it. ' +
    'This list only shrinks: fix a site, then run UNIT_WAIT_DISCIPLINE_UPDATE=1 npm test -- unit-wait-discipline. ' +
    'Rules: AGENTS.md § Validation.',
})
