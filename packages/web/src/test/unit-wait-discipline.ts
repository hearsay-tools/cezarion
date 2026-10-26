import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { parse } from '@babel/parser'
import type { AwaitExpression, BinaryExpression, CallExpression, Comment, DoWhileStatement, File, ForStatement, Identifier, Node, WhileStatement } from '@babel/types'
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
 *   by its deadline, once per loop however many sleeps it holds. The loop runs until the first of its exits:
 *   its head condition, or an `if` in its body that returns, throws or breaks. Each exit is read as a clock
 *   comparison or an attempt count (`a && b` ends once either part does, `a || b` once both do), and the
 *   loop is as long as its earliest exit. It is reported when no exit bounds it, or when the earliest
 *   resolves to a literal under the floor. A bound the scan cannot read (a caller-sized parameter, a
 *   count it cannot resolve, a counter the body writes) is left alone. An attempt count times the
 *   delays of the sleeps every pass reaches, when the count and those delays are literals. A name is
 *   read where the comparison sits and, when it can hold several values, at the smallest.
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
type Loop = ForStatement | WhileStatement | DoWhileStatement
const isPollLoop = (node: Node): node is Loop => node.type === 'ForStatement' || node.type === 'WhileStatement' || node.type === 'DoWhileStatement'

/** The names a write targets: `x = …`, `x++`, `[x, y] = …`, `({ x } = …)`. */
function targetNames(target: Node): string[] {
  switch (target.type) {
    case 'Identifier': return [target.name]
    case 'ArrayPattern': return target.elements.flatMap(element => (element ? targetNames(element) : []))
    case 'ObjectPattern': return target.properties.flatMap(property => targetNames(property.type === 'RestElement' ? property.argument : property.value))
    case 'AssignmentPattern': return targetNames(target.left)
    case 'RestElement': return targetNames(target.argument)
    default: return []
  }
}
const namesWritten = (node: Node): string[] => (node.type === 'AssignmentExpression' ? targetNames(node.left) : node.type === 'UpdateExpression' ? targetNames(node.argument) : [])

/**
 * Names bound to a numeric literal (or `a * b` of literals) anywhere in the file. A name bound twice to different values is
 * unreadable, and so is one that is assigned again after its declaration: its value where it is read is not the literal.
 */
function numericConsts(ast: File): Map<string, number | undefined> {
  const consts = new Map<string, number | undefined>()
  const written = new Set<string>()
  walk(ast.program, [], node => {
    if (node.type === 'AssignmentExpression' || node.type === 'UpdateExpression') for (const name of namesWritten(node)) written.add(name)
    const value = node.type === 'VariableDeclarator' && node.id.type === 'Identifier' ? numberOf(node.init, new Map()) : undefined
    if (node.type !== 'VariableDeclarator' || node.id.type !== 'Identifier' || value === undefined) return
    const known = consts.has(node.id.name) && consts.get(node.id.name) !== value
    consts.set(node.id.name, known ? undefined : value)
  })
  for (const name of written) if (consts.has(name)) consts.set(name, undefined)
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
  /** Each poll loop with its sleeps (the delay, and whether every pass reaches it), and where it sits. */
  loops: Map<Node, { sleeps: Sleep[]; where: Where }>
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

/** The value of the `timeout` property of an options object. A key written twice takes the last, as the language does. */
function timeoutOf(options: Node | undefined): Node | undefined {
  if (options?.type !== 'ObjectExpression') return undefined
  const timeouts = options.properties.flatMap(property =>
    property.type === 'ObjectProperty' && !property.computed && property.key.type === 'Identifier' && property.key.name === 'timeout' ? [property.value] : [])
  return timeouts.at(-1)
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
  // The wait's own options come last (`findBy*(text, queryOptions, waitForOptions)`), so the last `timeout` is the one in force.
  const timeouts = call.arguments.flatMap(argument => timeoutOf(argument) ?? [])
  const timeout = timeouts.at(-1)
  return timeout ? numberOf(timeout, ctx.consts) : undefined
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
  loop: Loop
  scope: Node
  /** Every node above the loop, outermost first. */
  above: readonly Node[]
}

/** The innermost `for`, `while` or `do` loop around a node, within its own function. */
function loopAround(ancestors: readonly Node[]): Where | undefined {
  let loop: Loop | undefined
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

/** A sleep in a poll loop: its delay, and whether every pass of the loop reaches it. */
interface Sleep {
  delay: Node | undefined
  always: boolean
}

/** What can skip a statement that follows it: a branch, a short circuit, a `try`, a loop over a collection that may be empty. */
const skippable = new Set(['IfStatement', 'ConditionalExpression', 'LogicalExpression', 'SwitchStatement', 'TryStatement', 'ForInStatement', 'ForOfStatement'])

/**
 * Whether every pass of the loop reaches the await. Nothing between them skips it (a branch, a short circuit, a `try`, a loop over
 * a collection), and no `continue` comes first. A sleep a pass may skip is not part of the time one pass takes.
 */
function runsEveryPass(loop: Loop, sleeping: Node, ancestors: readonly Node[]): boolean {
  if (ancestors.slice(ancestors.indexOf(loop) + 1).some(ancestor => skippable.has(ancestor.type))) return false
  return !contains(loop.body, node => node.type === 'ContinueStatement' && (node.start ?? 0) < (sleeping.start ?? 0))
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
  const entry = { delay: sleep.delay, always: runsEveryPass(around.loop, node, ancestors) }
  const known = ctx.loops.get(around.loop)
  if (known) known.sleeps.push(entry)
  else ctx.loops.set(around.loop, { sleeps: [entry], where: around })
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
  /** The nodes above the declaration, outermost first: where its initializer looks names up. */
  chain: readonly Node[]
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
  const base = where.above.slice(0, where.above.indexOf(where.scope))
  walk(where.scope, [], (node, ancestors) => {
    if (node !== where.scope && isFunction(node)) return false
    const declared = declaredAs(node, ancestors, where.scope, name)
    if (declared) found.push({ ...declared, chain: [...base, ...ancestors], start: node.start ?? 0 })
  })
  return found
}

/** Where a name is read: the nodes above the use, outermost first, and its offset. */
interface Use {
  chain: readonly Node[]
  at: number
}

type Consts = ReadonlyMap<string, number | undefined>

/** What a loop is judged by: where it sits, the same-file constants, and the time one pass of its sleeps takes (0 when a delay is unreadable). */
interface Probe {
  where: Where
  consts: Consts
  interval: number
}

/**
 * What a name means where it is read, the way the language scopes it: of the declarations that come before the use and whose
 * block still holds it, the one in the innermost block, the latest there. A block that closed earlier, a block of the loop body
 * that the loop head cannot see, and a helper function declaring the same name are not in view. The result has no `init` for a
 * parameter without a default, which hides a same-file constant of that name.
 */
function definition(where: Where, use: Use, name: string): Declaration | undefined {
  const depth = (declaration: Declaration) => use.chain.indexOf(declaration.owner)
  const inView = declarationsOf(where, name).filter(declaration => declaration.start < use.at && depth(declaration) >= 0)
  const nearer = (a: Declaration, b: Declaration) => depth(a) > depth(b) || (depth(a) === depth(b) && a.start > b.start)
  return inView.reduce<Declaration | undefined>((nearest, declaration) => (!nearest || nearer(declaration, nearest) ? declaration : nearest), undefined)
}

/**
 * What writes a name inside `root`, closures included, since a closure can reassign it: the right-hand sides of `name = …`, and
 * whether anything else writes it (`name += 1`, `name++`, a destructuring target).
 */
function writes(root: Node, name: string): { values: Node[]; other: boolean } {
  const values: Node[] = []
  let other = false
  walk(root, [], node => {
    if (!namesWritten(node).includes(name)) return
    if (node.type === 'AssignmentExpression' && node.operator === '=' && isNamed(node.left, name)) values.push(node.right)
    else other = true
  })
  return { values, other }
}

/**
 * Every value a declared name can hold where it is read: its initializer and each plain assignment. None when something else
 * writes it (`name += 1`): the scan cannot say which value is in force, so it reads none of them.
 */
function valuesOf(where: Where, declared: Declaration, name: string): Node[] {
  const { values, other } = writes(where.scope, name)
  if (other) return []
  return declared.init ? [declared.init, ...values] : values
}

const isNumber = (value: unknown): value is number => typeof value === 'number'

/**
 * The literal an expression stands for where it is read: a literal, a same-file constant, or a sum with a literal term. A name
 * that can hold several values gives the smallest it can read, so a long value never hides a short one.
 */
function valueOf(node: Node, cx: Probe, use: Use, depth = 0): number | undefined {
  if (depth > 3) return undefined
  if (node.type === 'Identifier') return nameValue(node.name, cx, use, depth)
  const direct = numberOf(node, cx.consts)
  if (direct !== undefined) return direct
  return node.type === 'BinaryExpression' && node.operator === '+' ? valueOf(node.left, cx, use, depth) ?? valueOf(node.right, cx, use, depth) : undefined
}

function nameValue(name: string, cx: Probe, use: Use, depth: number): number | undefined {
  const declared = definition(cx.where, use, name)
  if (!declared) return cx.consts.get(name)
  const inner = { chain: declared.chain, at: declared.start }
  const known = valuesOf(cx.where, declared, name).map(value => valueOf(value, cx, inner, depth + 1)).filter(isNumber)
  return known.length > 0 ? Math.min(...known) : undefined
}

/** Whether a node reads the clock, directly or through a name declared or assigned from it (`elapsed = Date.now() - start`). */
function readsClock(node: Node, cx: Probe, use: Use): boolean {
  if (contains(node, clockCall)) return true
  if (node.type !== 'Identifier') return false
  const declared = definition(cx.where, use, node.name)
  return declared !== undefined && valuesOf(cx.where, declared, node.name).some(value => contains(value, clockCall))
}

/** A bound on how long a loop runs, in milliseconds: `unreadable` when one exists the scan cannot evaluate, `undefined` when there is none. */
type Bound = number | 'unreadable' | undefined

/**
 * What a comparison says about the clock: the smallest literal it measures against, `unreadable` when it measures the clock
 * against something else, `undefined` when it does not measure the clock.
 */
function clockBound(comparison: BinaryExpression, cx: Probe, use: Use): Bound {
  const measuring = ([[comparison.left, comparison.right], [comparison.right, comparison.left]] as const).filter(([measured]) => readsClock(measured, cx, use))
  const values = measuring.map(([, limit]) => valueOf(limit, cx, use)).filter(isNumber)
  if (values.length > 0) return Math.min(...values)
  return measuring.length > 0 ? 'unreadable' : undefined
}

const compares = new Set(['<', '<=', '>', '>='])
const isCompare = (node: Node): node is BinaryExpression => node.type === 'BinaryExpression' && compares.has(node.operator)
/** A comparison that can end a counted loop: an ordering, or `i !== 20`. */
const limitOperators = new Set([...compares, '==', '===', '!=', '!=='])
const isLimit = (node: Node): node is BinaryExpression => node.type === 'BinaryExpression' && limitOperators.has(node.operator)

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

/** How many times `for (let i = a; i < b; i += c)` runs up to `test`, when `a`, `b` and `c` are readable and `c` moves `i` toward `b`. */
function iterations(loop: ForStatement, test: BinaryExpression, consts: Consts): number | undefined {
  if (test.left.type !== 'Identifier' || !loop.update) return undefined
  const name = test.left.name
  const declarations = loop.init?.type === 'VariableDeclaration' ? loop.init.declarations : []
  const start = numberOf(declarations.find(declaration => isNamed(declaration.id, name))?.init, consts)
  const limit = numberOf(test.right, consts)
  const step = stepOf(loop.update, name, consts)
  const up = test.operator.startsWith('<')
  if (start === undefined || limit === undefined || step === undefined || step === 0 || up !== step > 0) return undefined
  const span = up ? limit - start : start - limit
  return Math.max(0, test.operator.endsWith('=') ? Math.floor(span / Math.abs(step)) + 1 : Math.ceil(span / Math.abs(step)))
}

/** Whether a loop steps a name (`tries++`, `retries += 1`): a counter whose limit the scan cannot turn into time. */
function steppedIn(loop: Node, name: string): boolean {
  let stepped = false
  walk(loop, [], node => {
    if (node !== loop && isFunction(node)) return false
    stepped ||= (node.type === 'UpdateExpression' && isNamed(node.argument, name)) || (node.type === 'AssignmentExpression' && node.operator !== '=' && isNamed(node.left, name))
  })
  return stepped
}

/** The counter a comparison names: `i` in `i < 20`, `retries` in `retries-- > 0`. */
const counterOf = (side: Node): string =>
  side.type === 'Identifier' ? side.name : side.type === 'UpdateExpression' && side.argument.type === 'Identifier' ? side.argument.name : ''

/**
 * What a comparison with a counter says about how long the loop runs. A `for` counter that starts, steps and ends at literals
 * gives its iteration count times the time one pass sleeps, when nothing in the body writes the counter. A counter written in
 * the body, or one the scan cannot count, is `unreadable`. A name that is not a counter at all bounds nothing.
 */
function counterBound(test: BinaryExpression, name: string, cx: Probe): Bound {
  const { loop } = cx.where
  const counts = loop.type === 'ForStatement' && loop.init?.type === 'VariableDeclaration' && loop.init.declarations.some(declaration => isNamed(declaration.id, name))
  if (loop.type !== 'ForStatement' || !counts) return steppedIn(loop, name) ? 'unreadable' : undefined
  const written = writes(loop.body, name)
  if (written.values.length > 0 || written.other) return 'unreadable'
  const count = isCompare(test) ? iterations(loop, test, cx.consts) : undefined
  return count !== undefined && cx.interval > 0 ? count * cx.interval : 'unreadable'
}

/** A clock or counter comparison's bound; a comparison of anything else bounds nothing. */
function comparisonBound(test: BinaryExpression, cx: Probe, use: Use): Bound {
  return clockBound(test, cx, use) ?? earliest([test.left, test.right].map(counterOf).filter(Boolean).map(name => counterBound(test, name, cx)))
}

/** A loop ends at the first of its exits that fires: the smallest bound, or `unreadable` when only unreadable ones exist. */
function earliest(bounds: readonly Bound[]): Bound {
  const known = bounds.filter(isNumber)
  if (known.length > 0) return Math.min(...known)
  return bounds.includes('unreadable') ? 'unreadable' : undefined
}

/**
 * A condition of several parts holds once every part does: the largest of their bounds. A part with no bound while another has
 * one leaves the whole `unreadable`, since the loop may not end by the part that has one.
 */
function latest(bounds: readonly Bound[]): Bound {
  if (bounds.every(isNumber)) return Math.max(...bounds)
  return bounds.some(bound => bound !== undefined) ? 'unreadable' : undefined
}

/** The bound a name gives a condition that is true or false by the value it holds (`const timedOut = Date.now() - t0 > 5_000`). */
function aliasBound(name: Identifier, want: boolean, cx: Probe, use: Use, depth: number): Bound {
  const declared = depth < 3 ? definition(cx.where, use, name.name) : undefined
  if (!declared) return undefined
  const inner = { chain: declared.chain, at: declared.start }
  return earliest(valuesOf(cx.where, declared, name.name).map(value => ends(value, want, cx, inner, depth + 1)))
}

/**
 * The time by which a condition is certain to be `want`, as the loop's clock or counter sees it. For the loop head, `want` is
 * false (the loop runs while it holds); for the test of an `if` that leaves the loop, it is true. `a && b` is false once either
 * part is, and true once both are; `a || b` is the other way round. A part the scan cannot parse that compares the clock is
 * `unreadable`; one that compares nothing it reads has no bound.
 */
function ends(test: Node, want: boolean, cx: Probe, use: Use, depth = 0): Bound {
  if (test.type === 'LogicalExpression' && test.operator !== '??') {
    const parts = [test.left, test.right].map(part => ends(part, want, cx, use, depth))
    return (test.operator === '&&') === want ? latest(parts) : earliest(parts)
  }
  if (test.type === 'UnaryExpression' && test.operator === '!') return ends(test.argument, !want, cx, use, depth)
  if (isLimit(test)) return comparisonBound(test, cx, use)
  if (test.type === 'Identifier') return aliasBound(test, want, cx, use, depth)
  return contains(test, node => isLimit(node) && comparisonBound(node, cx, use) !== undefined) ? 'unreadable' : undefined
}

/** What a bare `break` leaves: any loop, or a `switch`. */
const breakable = (node: Node): boolean =>
  isPollLoop(node) || node.type === 'ForInStatement' || node.type === 'ForOfStatement' || node.type === 'SwitchStatement'

/**
 * Whether a statement can end the loop around it: it returns, throws, or breaks out of it. A `break` inside a loop or a `switch`
 * of its own leaves only that (`breaks` is false when the statement already sits in one).
 */
function leaves(statement: Node, breaks: boolean): boolean {
  let found = false
  walk(statement, [], (node, ancestors) => {
    if (node !== statement && isFunction(node)) return false
    if (node.type === 'ReturnStatement' || node.type === 'ThrowStatement') found = true
    else if (node.type === 'BreakStatement') found ||= node.label != null || (breaks && !ancestors.some(breakable))
  })
  return found
}

/** The bounds of the `if` statements in the loop's own body that leave it: `if (Date.now() - start > 5_000) throw …`. */
function exitBounds(cx: Probe): Bound[] {
  const { loop, above } = cx.where
  const found: Bound[] = []
  walk(loop.body, [...above, loop], (node, ancestors) => {
    if (isFunction(node)) return false
    if (node.type !== 'IfStatement') return
    const breaks = !ancestors.slice(above.length + 1).some(breakable)
    const use = { chain: [...ancestors], at: node.test.start ?? 0 }
    if (leaves(node.consequent, breaks)) found.push(ends(node.test, true, cx, use))
    if (node.alternate && leaves(node.alternate, breaks)) found.push(ends(node.test, false, cx, use))
  })
  return found
}

type Deadline = 'none' | 'unreadable' | number

/**
 * How long a poll loop can run, as the first of its exits to fire: the smallest bound among its head and every `if` in its
 * body that leaves it. `none` when no exit reads the clock or counts attempts; `unreadable` when the exits that do are ones the
 * scan cannot evaluate.
 */
function pollDeadline(where: Where, sleeps: readonly Sleep[], consts: Consts): Deadline {
  // One pass takes the sum of the delays it cannot skip. A loop whose sleeps a pass may skip has no interval to count by.
  const intervals = sleeps.filter(sleep => sleep.always).map(sleep => numberOf(sleep.delay, consts))
  const interval = intervals.length > 0 && intervals.every(isNumber) ? intervals.reduce((sum, each) => sum + each, 0) : 0
  const cx: Probe = { where, consts, interval }
  const { loop, above } = where
  const head = loop.test ? ends(loop.test, false, cx, { chain: [...above, loop], at: loop.test.start ?? 0 }) : undefined
  return earliest([head, ...exitBounds(cx)]) ?? 'none'
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
  for (const [loop, { sleeps, where }] of ctx.loops) {
    const deadline = pollDeadline(where, sleeps, ctx.consts)
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
