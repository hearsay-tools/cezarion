import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { parse } from '@babel/parser'
import type { AwaitExpression, BinaryExpression, BlockStatement, CallExpression, Comment, DoWhileStatement, File, ForStatement, Identifier, MemberExpression, Node, ObjectExpression, UnaryExpression, WhileStatement } from '@babel/types'
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
 * - `poll-deadline`: a sleep inside a `for`, `while` or `do` loop is a poll interval, so the loop is judged by its deadline,
 *   once per loop however many sleeps it holds. It is reported when the list below gives it no deadline, or when the earliest
 *   exit resolves to a literal under the floor.
 *
 * What `poll-deadline` reads as a deadline is this list and nothing else. Both scans implement it, and both test every line of it.
 * A loop is as long as its earliest exit, and only these exits count:
 *   1. The loop's own condition: the test of a `while`, a `do … while` or a `for`.
 *   2. `if (<condition>) break`, `return` or `throw`, written as a statement of the loop body itself (the branch is the leave,
 *      or a block with the leave among its own statements), before any statement that holds a `continue`. An `if` inside
 *      another `if`, an `else`, a `switch`, a `try`, a block or an inner loop may never be reached, and the `else` of an
 *      `if` is not an exit on its test.
 * A condition is read from these parts, joined by `&&` (it ends once either part does), `||` (once both do) and `!`. A counted
 * condition is a pure read: no write (`=`, `+=`, `++`, `--`) and no call in it, but the clock, or the part is no bound.
 *   - a clock comparison with `<`, `<=`, `>` or `>=`, never `==` or `!=`, and as the whole part: `now - start` against a limit,
 *     `now` against `start + limit` or a deadline, or a name the loop sets from the clock (`const elapsed = Date.now() - start`).
 *     `now` is `Date.now()`, `performance.now()` or `process.hrtime()`. A limit is a literal sum of products (`5 * 1_000`) or one
 *     name or path. A start is a read of the clock, a deadline a read of the clock plus a limit. A name set to any other
 *     expression is no start, deadline or limit. The loop never declares them again,
 *     writes them or leaves them to a closure that writes. A name it sets from the clock is set once, as a statement of the body
 *     itself before any `continue`: a write in a branch may keep an old value.
 *   - the counter of a `for (let|var i = <literal>; i < limit; i++)` header: one declarator, `<` or `<=` against a limit the loop
 *     never changes, and a step of `i++`, `++i` or `i += <positive literal>`. A count down, a step in the test (`i++ < 20`) or a
 *     write in the body is no bound. It gives the iterations times the sleeps every pass reaches.
 * Numbers are evaluated, not matched: literals with separators and other bases, unary `+` and `-`, parentheses, `as`, `satisfies`
 * and non-null wrappers, `+ - * / % **`, and, for a wait bound or a delay, `Math.max`, `min`, `abs`, `floor`, `ceil`, `round` and
 * `trunc` of those. A name is looked up in the function around its use and in every function around that one, up to the module,
 * at the use: the nearest declaration hides the ones further out, and a `const` of an outer scope counts wherever it sits, since a
 * function runs after the module has loaded. A `let` or `var` of an outer scope is read only when nothing writes it after its declaration. A wait bound
 * that is negative, zero, `NaN`, infinite or past a timer's limit is below the floor.
 * A part on the list is left alone only for a value that comes from outside the file or from the function's parameters (a
 * parameter, an import, a global, a property of an argument): the caller sizes it. A value the file declares and the scan cannot
 * evaluate (a call, a ternary, a destructured binding, a `let` written after its declaration, a name set to one of those) is never
 * left alone: as a limit, start, deadline or delay it bounds nothing, and as a wait bound it is below the floor. Any other shape
 * has no bound: a ternary, `??`, a call, arithmetic on the clock, an equality, a counter the body steps, a start the loop
 * resets, a flag set in a branch. A loop with no bound on the list is reported, unless `// bound: <reason>` accepts it. A count
 * of passes that sleep nothing says nothing in milliseconds.
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
    case 'MemberExpression': return targetNames(target.object)
    default: return []
  }
}
const namesWritten = (node: Node): string[] => (node.type === 'AssignmentExpression' ? targetNames(node.left) : node.type === 'UpdateExpression' ? targetNames(node.argument) : [])

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

/** A name's value where it is read, or undefined when the scan cannot say. */
type Read = (name: string) => number | undefined

const namedNumbers = new Map([['NaN', NaN], ['Infinity', Infinity]])
/** The functions of `Math` that the evaluator reads, on numbers it can read. */
const mathFunctions = new Map<string, (...values: number[]) => number>([
  ['max', Math.max], ['min', Math.min], ['abs', Math.abs], ['floor', Math.floor], ['ceil', Math.ceil], ['round', Math.round], ['trunc', Math.trunc],
])
const numberMembers = new Map([
  ['NaN', NaN], ['POSITIVE_INFINITY', Infinity], ['NEGATIVE_INFINITY', -Infinity],
  ['MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER], ['MIN_SAFE_INTEGER', Number.MIN_SAFE_INTEGER], ['MAX_VALUE', Number.MAX_VALUE],
])

/**
 * The value of a numeric expression the scan can read: number literals, `NaN`, `Infinity`, unary `+` and `-`, parentheses,
 * `as` / `satisfies` / non-null wrappers, a name `read` knows, and `+ - * / % **` of those. Anything else is undefined: an
 * expression the scan cannot read.
 */
function numberOf(node: Node | null | undefined, read: Read): number | undefined {
  if (!node) return undefined
  switch (node.type) {
    case 'NumericLiteral': return node.value
    case 'Identifier': return namedNumbers.has(node.name) ? namedNumbers.get(node.name) : read(node.name)
    case 'MemberExpression': return memberNumber(node)
    case 'ParenthesizedExpression': case 'TSAsExpression': case 'TSSatisfiesExpression': case 'TSNonNullExpression': case 'TSTypeAssertion':
      return numberOf(node.expression, read)
    case 'UnaryExpression': return unaryNumber(node, read)
    case 'BinaryExpression': return binaryNumber(node, read)
    default: return undefined
  }
}

/** `Number.POSITIVE_INFINITY` and the other numbers `Number` holds. */
const memberNumber = (node: MemberExpression): number | undefined =>
  node.object.type === 'Identifier' && node.object.name === 'Number' && !node.computed && node.property.type === 'Identifier' ? numberMembers.get(node.property.name) : undefined

function unaryNumber(node: UnaryExpression, read: Read): number | undefined {
  const value = node.operator === '-' || node.operator === '+' ? numberOf(node.argument, read) : undefined
  return value === undefined ? undefined : node.operator === '-' ? -value : value
}

/**
 * The value of a wait bound or a delay: a number `numberOf` reads, or `Math.max`, `min`, `abs`, `floor`, `ceil`, `round` or
 * `trunc` of such numbers. A limit is not read this way: it is a literal sum of products or one name or path.
 */
function sizeNumber(node: Node | null | undefined, read: Read): number | undefined {
  if (node?.type !== 'CallExpression') return numberOf(node, read)
  const callee = calleeOf(node.callee)
  const fn = callee?.object === 'Math' ? mathFunctions.get(callee.name) : undefined
  const args = node.arguments.map(argument => numberOf(argument, read))
  return fn && args.length > 0 && args.every(isNumber) ? fn(...args) : undefined
}

function binaryNumber(node: BinaryExpression, read: Read): number | undefined {
  const left = numberOf(node.left, read)
  const right = numberOf(node.right, read)
  if (left === undefined || right === undefined) return undefined
  const operations: Record<string, number> = { '*': left * right, '/': left / right, '+': left + right, '-': left - right, '%': left % right, '**': left ** right }
  return operations[node.operator]
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

/** Where a wait bound is read: the function around it and the nodes above it, and what a name holds there. */
interface Place {
  view: View
  use: Use
  read: Read
}

/** Names that stand for the same value in every file: JavaScript's own, which a bound may use without declaring. */
const ownNames = new Set(['Math', 'Number', 'Date', 'Infinity', 'NaN', 'undefined'])

/** Whether the file binds `name` other than by a plain declaration: as a function or class, or as part of a destructuring. */
function boundApart(root: Node | undefined, name: string): boolean {
  let found = false
  if (root) {
    walk(root, [], node => {
      found ||= ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id?.name === name) ||
        (node.type === 'VariableDeclarator' && node.id.type !== 'Identifier' && targetNames(node.id).includes(name))
    })
  }
  return found
}

/** Whether the file declares `name` itself: a `const`, `let`, `var`, function or class, a destructured binding or a loop variable. A parameter and an import are the caller's. */
function declaredHere(view: View, use: Use, name: string): boolean {
  const declared = definition(view, use, name)
  return declared ? declared.kind !== 'param' : boundApart(view.above[0], name)
}

/** The names an expression reads: a called function's, the start of a path, not a property, a type or a function's own. */
function rootsOf(root: Node): string[] {
  const found: string[] = []
  walk(root, [], (node, ancestors) => {
    if (isFunction(node) || (node.type.startsWith('TS') && !/^TS(?:As|Satisfies|NonNull)Expression$|^TSTypeAssertion$/.test(node.type))) return false
    const parent = ancestors.at(-1)
    const property = (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) || (parent?.type === 'ObjectProperty' && parent.key === node && !parent.computed)
    if (node.type === 'Identifier' && !property) found.push(node.name)
  })
  return found
}

/** A value that only passes another on: a name or path, or a read of the clock plus one (`Date.now() + ms`). */
const passesOn = (value: Node): boolean => isPath(value) || (value.type === 'BinaryExpression' && value.operator === '+' && clockCall(value.left) && isPath(value.right))

/**
 * Whether the expression reads a name or path that comes from outside the file, so the caller sizes it: a parameter, an import or a
 * global. A name the file declares is the caller's when every value it holds only passes on one that is.
 */
function sizedOutside(node: Node, view: View, use: Use, depth = 0): boolean {
  return rootsOf(node).some(name => {
    if (ownNames.has(name)) return false
    if (!declaredHere(view, use, name)) return true
    const held = depth < 3 ? heldBy(view, use, name) : []
    return held.length > 0 && held.every(each => passesOn(each.value)) && held.some(each => sizedOutside(each.value, view, each.use, depth + 1))
  })
}

/**
 * What a wait bound stands for: a number, `undefined` when the caller sizes it (a parameter, an import), and `NaN` for an expression
 * made only of what the file declares that the scan cannot evaluate. It may be any bound, so it counts as below the floor.
 */
const sizeOf = (node: Node, place: Place): number | undefined => sizeNumber(node, place.read) ?? (sizedOutside(node, place.view, place.use) ? undefined : NaN)

/** What a Vitest wait is given as its bound: `undefined` is its default, `null` is none, and any other value is read. */
function vitestMs(node: Node, place: Place): number | undefined {
  if (node.type === 'Identifier' && node.name === 'undefined') return VITEST_DEFAULT_MS
  return node.type === 'NullLiteral' ? 0 : sizeOf(node, place)
}

const placeFor = (view: View, use: Use): Place => ({ view, use, read: nameReader(view, use, 1, true) })

/** The options objects an argument stands for: the literal itself, or the ones a name holds, each with the place its own names are read from. */
function optionObjects(node: Node, place: Place): Array<{ object: Node; place: Place }> {
  if (node.type === 'ObjectExpression') return [{ object: node, place }]
  if (node.type !== 'Identifier') return []
  return heldBy(place.view, place.use, node.name, true).flatMap(held => (held.value.type === 'ObjectExpression' ? [{ object: held.value, place: placeFor(place.view, held.use) }] : []))
}

/** Vitest's `vi.waitFor`, `vi.waitUntil` and `expect.poll`: the bound in force, or undefined when the caller sizes it. */
function vitestBound(call: CallExpression, place: Place): number | undefined {
  const callee = calleeOf(call.callee)
  const isWait = (callee?.object === 'vi' && (callee.name === 'waitFor' || callee.name === 'waitUntil')) ||
    (callee?.object === 'expect' && callee.name === 'poll')
  if (!isWait) return undefined
  const options = call.arguments[1]
  if (!options) return VITEST_DEFAULT_MS
  const objects = optionObjects(options, place)
  if (objects.length === 0) return vitestMs(options, place)
  return smallest(objects.map(({ object, place: at }) => optionsMs(object as ObjectExpression, at)))
}

/**
 * The bound an options object leaves, read in order as the language does: Vitest's default until a `timeout` names one. A spread or
 * a computed key may set any key, so after one the bound is the caller's (`undefined`) when it reads a name from outside the file,
 * and `NaN` when it reads only what the file declares, until a later explicit `timeout`.
 */
function optionsMs(object: ObjectExpression, place: Place): number | undefined {
  let bound: number | undefined = VITEST_DEFAULT_MS
  for (const property of object.properties) {
    if (property.type === 'ObjectProperty' && !property.computed && property.key.type === 'Identifier' && property.key.name === 'timeout') bound = vitestMs(property.value, place)
    else if (property.type === 'SpreadElement' || (property.type !== 'ObjectMethod' && property.computed)) {
      const source = property.type === 'SpreadElement' ? property.argument : property.key
      bound = sizedOutside(source, place.view, place.use) ? undefined : NaN
    }
  }
  return bound
}

/** A Testing Library wait whose `timeout` is given: that bound, or undefined when it has none or the caller sizes it. */
function testingLibraryBound(call: CallExpression, ctx: Ctx, place: Place): number | undefined {
  const callee = calleeOf(call.callee)
  if (!callee) return undefined
  const query = /^find(?:All)?By[A-Z]/.test(callee.name)
  const wait = callee.object === undefined ? ctx.tlWaits.has(callee.name) : ctx.tlNamespaces.has(callee.object) && /^waitFor(?:ElementToBeRemoved)?$/.test(callee.name)
  if (!query && !wait) return undefined
  // The wait's own options come last (`findBy*(text, queryOptions, waitForOptions)`), so the last `timeout` is the one in force.
  const timeouts = call.arguments.flatMap(argument => optionObjects(argument, place).flatMap(({ object, place: at }) => {
    const timeout = timeoutOf(object)
    return timeout ? [{ timeout, place: at }] : []
  }))
  const last = timeouts.at(-1)
  return last ? sizeOf(last.timeout, last.place) : undefined
}

/** The longest delay a timer keeps: a larger one fires after 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1

/** A wait bound is short unless it is a finite number of at least the floor that a timer keeps: a negative, zero, `NaN`, infinite or overflowing one fires at once. */
const isShortBound = (ms: number): boolean => !(ms >= FLOOR_MS && ms <= MAX_TIMER_MS)

function shortBound(call: CallExpression, ctx: Ctx, ancestors: readonly Node[]): boolean {
  const place = placeAt(ancestors, call.start ?? 0)
  const bound = place ? vitestBound(call, place) ?? testingLibraryBound(call, ctx, place) : undefined
  return bound !== undefined && isShortBound(bound)
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
    if (sizeNumber(sleep.delay, readerFor(ancestors, node.start ?? 0)) !== 0) report(ctx, 'sleep', node)
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
  kind: 'const' | 'let' | 'var' | 'param'
  /** The block, loop or function the name belongs to. */
  owner: Node
  /** The function (or the module) the name is declared in. */
  scope: Node
  /** The nodes above the declaration, outermost first: where its initializer looks names up. */
  chain: readonly Node[]
  start: number
}

const blockScopes = new Set(['BlockStatement', 'Program', 'StaticBlock', 'ForStatement', 'ForInStatement', 'ForOfStatement'])

/** What `node` declares under `name` in `scope`: a variable, a parameter or a parameter's default. */
function declaredAs(node: Node, ancestors: readonly Node[], scope: Node, name: string): Pick<Declaration, 'init' | 'owner' | 'kind'> | undefined {
  const parent = ancestors.at(-1)
  if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.id.name === name && parent?.type === 'VariableDeclaration') {
    const owner = parent.kind === 'var' ? scope : [...ancestors].reverse().find(ancestor => blockScopes.has(ancestor.type)) ?? scope
    return { init: node.init ?? undefined, owner, kind: parent.kind === 'var' || parent.kind === 'let' ? parent.kind : 'const' }
  }
  const param = 'params' in scope && (scope.params as readonly Node[]).includes(node)
  if (param && node.type === 'Identifier' && node.name === name) return { init: undefined, owner: scope, kind: 'param' }
  if (param && node.type === 'AssignmentPattern' && node.left.type === 'Identifier' && node.left.name === name) return { init: node.right, owner: scope, kind: 'param' }
  return undefined
}

/** Where a name is looked up from: the function (or module) around the use, and every node above it, outermost first. */
interface View {
  scope: Node
  above: readonly Node[]
}

/**
 * Every declaration of a name in the function around the use and in every function around that one, up to the module, leaving
 * out the functions nested in each: their names are theirs.
 */
function declarationsOf(view: View, name: string): Declaration[] {
  const found: Declaration[] = []
  for (const scope of view.above.filter(node => isFunction(node) || node.type === 'Program')) {
    const base = view.above.slice(0, view.above.indexOf(scope))
    walk(scope, [], (node, ancestors) => {
      if (node !== scope && isFunction(node)) return false
      const declared = declaredAs(node, ancestors, scope, name)
      if (declared) found.push({ ...declared, scope, chain: [...base, ...ancestors], start: node.start ?? 0 })
    })
  }
  return found
}

/** Where a name is read: the nodes above the use, outermost first, and its offset. */
interface Use {
  chain: readonly Node[]
  at: number
}

/**
 * What a loop is judged by: where it sits, what a name means at its head, and the time one pass of its sleeps takes (0 when it has
 * none, `unreadable` when a delay comes from outside the file, `undefined` when a delay is one the scan does not read).
 */
interface Probe {
  where: Where
  read: Read
  interval: Bound
  /** Whether a name or path read at a use comes from outside the file, so the caller sizes it. */
  outside: (node: Node, use: Use) => boolean
}

/**
 * What a name means where it is read, the way the language scopes it: of the declarations whose block still holds the use, the
 * one in the innermost block, the latest there. In the use's own function a declaration counts only when it comes before the use;
 * in a function or the module around it, wherever it sits, since the inner function runs after they have loaded. A block that
 * closed earlier, a block of the loop body that the loop head cannot see, and a helper function declaring the same name are not
 * in view. The result has no `init` for a parameter without a default, which hides a constant of that name.
 */
function definition(view: View, use: Use, name: string): Declaration | undefined {
  const depth = (declaration: Declaration) => use.chain.indexOf(declaration.owner)
  const inView = declarationsOf(view, name).filter(declaration => depth(declaration) >= 0 && (declaration.scope !== view.scope || declaration.start < use.at))
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
 * writes it (`name += 1`): the scan cannot say which value is in force, so it reads none of them. A `let`, `var` or parameter of
 * a function around the use is read only when nothing writes it after its declaration: which value is in force depends on which
 * hook or helper ran first. A `strict` read does the same for the use's own function: a wait or a sleep is not a loop, which runs
 * many times and so can take any value the name holds.
 */
function valuesOf(view: View, declared: Declaration, name: string, strict = false): Node[] {
  const { values, other } = writes(declared.scope, name)
  if (other || ((strict || declared.scope !== view.scope) && declared.kind !== 'const' && values.length > 0)) return []
  return declared.init ? [declared.init, ...values] : values
}

const isNumber = (value: unknown): value is number => typeof value === 'number'

/** The values a name holds where it is read, each with the place its own names are read from. */
function heldBy(view: View, use: Use, name: string, strict = false): Array<{ value: Node; use: Use }> {
  const declared = definition(view, use, name)
  return declared ? valuesOf(view, declared, name, strict).map(value => ({ value, use: { chain: declared.chain, at: declared.start } })) : []
}

const smallest = (values: readonly (number | undefined)[]): number | undefined => {
  const known = values.filter(isNumber)
  return known.length > 0 ? Math.min(...known) : undefined
}

/** What a name means where it is read, as a number: the smallest value it can hold, so a long value never hides a short one. */
function nameValue(name: string, view: View, use: Use, depth: number, strict: boolean): number | undefined {
  return depth > 3 ? undefined : smallest(heldBy(view, use, name, strict).map(held => numberOf(held.value, nameReader(view, held.use, depth + 1, strict))))
}

const nameReader = (view: View, use: Use, depth = 0, strict = false): Read => name => nameValue(name, view, use, depth, strict)

/** Where a bound written at `at` is read: the function around it and the nodes above it. Strict: a wait or a sleep is not a loop, so a name written after its declaration is read as none of its values. */
function placeAt(ancestors: readonly Node[], at: number): Place | undefined {
  const scope = [...ancestors].reverse().find(isFunction) ?? ancestors[0]
  if (!scope) return undefined
  const view = { scope, above: ancestors }
  const use = { chain: ancestors, at }
  return { view, use, read: nameReader(view, use, 0, true) }
}

const readerFor = (ancestors: readonly Node[], at: number): Read => placeAt(ancestors, at)?.read ?? (() => undefined)

/**
 * The literal an expression stands for where it is read: a number, a name for one, or a sum with a term of those. A name that can
 * hold several values gives the smallest it can read, so a long value never hides a short one.
 */
function valueOf(node: Node, cx: Probe, use: Use, depth = 0): number | undefined {
  if (depth > 3) return undefined
  if (node.type === 'Identifier' && !namedNumbers.has(node.name)) return smallest(heldBy(cx.where, use, node.name).map(held => valueOf(held.value, cx, held.use, depth + 1)))
  const direct = numberOf(node, nameReader(cx.where, use, depth))
  if (direct !== undefined) return direct
  return node.type === 'BinaryExpression' && node.operator === '+' && isLimit(node, cx) ? valueOf(node.left, cx, use, depth) ?? valueOf(node.right, cx, use, depth) : undefined
}

/** A bound on how long a loop runs, in milliseconds: `unreadable` when one exists the scan cannot evaluate, `undefined` when there is none. */
type Bound = number | 'unreadable' | undefined

/** A name or a dotted path of names: `deadline`, `state.t0`. */
const isPath = (node: Node): boolean => node.type === 'Identifier' || (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' && isPath(node.object))

const impure = new Set(['AssignmentExpression', 'UpdateExpression', 'CallExpression', 'NewExpression', 'TaggedTemplateExpression', 'AwaitExpression', 'YieldExpression'])

/** Whether a condition only reads: no write, no call but a read of the clock, no `delete`, `await` or `new`. */
function isPure(root: Node): boolean {
  let pure = true
  walk(root, [], node => {
    if (clockCall(node)) return false
    if (impure.has(node.type) || (node.type === 'UnaryExpression' && node.operator === 'delete')) pure = false
    return isFunction(node) ? false : undefined
  })
  return pure
}

/** The names a comparison reads: not what a clock read holds, a called function's name, or a property name. */
function references(root: Node): Identifier[] {
  const found: Identifier[] = []
  walk(root, [], (node, ancestors) => {
    if (clockCall(node)) return false
    const parent = ancestors.at(-1)
    const skipped = (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) || (parent?.type === 'ObjectProperty' && parent.key === node && !parent.computed)
    if (node.type === 'Identifier' && !skipped && !(parent?.type === 'CallExpression' && parent.callee === node) && !globalNames.has(node.name)) found.push(node)
  })
  return found
}
const globalNames = new Set(['Math', 'Number', 'Date', 'performance', 'process', 'undefined', 'Infinity', 'NaN'])

const isWritten = (root: Node, name: string): boolean => {
  const written = writes(root, name)
  return written.other || written.values.length > 0
}

/** Whether a function nested in the loop's function writes the name: it can run in any pass. */
function closureWrites(scope: Node, name: string): boolean {
  let found = false
  walk(scope, [], node => {
    if (node === scope || !isFunction(node)) return
    found ||= isWritten(node, name)
    return false
  })
  return found
}

/**
 * Whether a pass of the loop changes the name a comparison reads: the declaration in view sits in the loop body (it runs again
 * every pass; one in a `for` header runs once), or the loop writes the name (a member write too), or a closure does.
 */
function movesIn(cx: Probe, name: string, use: Use): boolean {
  const { loop, scope } = cx.where
  return definition(cx.where, use, name)?.chain.includes(loop.body) === true || isWritten(loop, name) || closureWrites(scope, name)
}

/** What the loop sets a name to on every pass, and where that value is read from. */
interface PerPass {
  value: Node
  use: Use
}

/**
 * What the loop sets a name to on every pass: its only write, a plain assignment or a declaration with a value, written as a
 * statement of the loop body itself before any statement that holds a `continue`. A write in a branch, a closure, the header
 * or after a `continue` may not run in a pass, so the name may keep an old value and the comparison against it ends nothing.
 */
function perPass(cx: Probe, name: string): PerPass | undefined {
  const { loop, above, scope } = cx.where
  const block = loop.body.type === 'BlockStatement'
  const written = writes(loop, name)
  if (written.other || closureWrites(scope, name)) return undefined
  for (const statement of block ? (loop.body as BlockStatement).body : [loop.body]) {
    const use = { chain: [...above, loop, ...(block ? [loop.body] : [])], at: statement.start ?? 0 }
    const assigned = statement.type === 'ExpressionStatement' && statement.expression.type === 'AssignmentExpression' && statement.expression.operator === '=' && isNamed(statement.expression.left, name) ? statement.expression.right : undefined
    const declared = statement.type === 'VariableDeclaration' ? statement.declarations.find(declarator => isNamed(declarator.id, name))?.init ?? undefined : undefined
    const value = assigned ?? declared
    if (value && (assigned ? written.values.length === 1 : written.values.length === 0)) return { value, use }
    if (contains(statement, node => node.type === 'ContinueStatement')) return undefined
  }
  return undefined
}

/** A clock read, or one minus a start: the values a name holds that the loop samples the clock into (`const now = Date.now()`, `elapsed = Date.now() - start`). */
const isMeasure = (node: Node): boolean => clockCall(node) || (node.type === 'BinaryExpression' && node.operator === '-' && clockCall(node.left) && isPath(node.right))

/**
 * The values a name a comparison reads may hold: a literal, a name or path, or a read of the clock. A deadline may also be a read
 * of the clock plus a limit. A name set to any other expression (`Date.now() + 1e9` as a start, `Date.now() + 15_000 * scale` as a
 * deadline, a call) is not a start, a limit or a deadline the scan reads.
 */
function isListed(value: Node, cx: Probe, deadline: boolean): boolean {
  const limit = (side: Node): boolean => numberOf(side, cx.read) !== undefined || isPath(side)
  return limit(value) || clockCall(value) || (deadline && value.type === 'BinaryExpression' && value.operator === '+' && clockCall(value.left) && limit(value.right))
}

/**
 * Whether a comparison measures the clock against something fixed. -1 when it reads a name the loop changes that is not a sample
 * of the clock, or a name whose value is not one the scan reads (a limit or a start that moves or is an expression of its own),
 * 0 when it has no fixed anchor (a start, a deadline, a limit the caller sized), 1 when it has one. A name the loop sets from the
 * clock on every pass is a sample: its own value is judged the same way, so `elapsed = Date.now() - start` is anchored by `start`.
 */
function anchored(root: Node, cx: Probe, use: Use, deadlines: readonly Node[], depth = 0): -1 | 0 | 1 {
  let found: -1 | 0 | 1 = 0
  for (const ref of references(root)) {
    if (!movesIn(cx, ref.name, use)) {
      const declared = definition(cx.where, use, ref.name)
      const values = declared ? valuesOf(cx.where, declared, ref.name) : []
      if (!values.every(value => isListed(value, cx, deadlines.some(each => each.type === 'Identifier' && each.name === ref.name)))) return -1
      if (values.some(value => contains(value, clockCall)) || valueOf(ref, cx, use) === undefined) found = 1
      continue
    }
    const pass = depth < 3 ? perPass(cx, ref.name) : undefined
    if (!pass || !isMeasure(pass.value)) return -1
    const inner = anchored(pass.value, cx, pass.use, [], depth + 1)
    if (inner === -1) return -1
    if (inner === 1) found = 1
  }
  return found
}

/** What a clock comparison measures against: a literal sum of products, a name or path, or `start + limit` of those. Any other expression is a shape the scan does not read. */
function isLimit(node: Node, cx: Probe): boolean {
  const operand = (inner: Node): boolean => isPath(inner) || clockCall(inner) || numberOf(inner, cx.read) !== undefined
  return numberOf(node, cx.read) !== undefined || isPath(node) || (node.type === 'BinaryExpression' && node.operator === '+' && operand(node.left) && operand(node.right))
}

/** A read of the clock: the call itself, or a name the loop sets from one on every pass (`const now = Date.now()`). */
const sampled = (node: Node, cx: Probe): boolean => clockCall(node) || (node.type === 'Identifier' && isMeasure(perPass(cx, node.name)?.value ?? node))

/** The side of a clock comparison that measures time: a read of the clock, or one minus a start (`Date.now() - start`). */
const measures = (node: Node, cx: Probe): boolean =>
  sampled(node, cx) || (node.type === 'BinaryExpression' && node.operator === '-' && sampled(node.left, cx) && isPath(node.right))

/**
 * What a comparison says about the clock: the smallest literal it measures against, `unreadable` when the limit is one the caller
 * sizes (from outside the file), `undefined` when the file declares it and the scan cannot read it, or when it is not a clock comparison the scan reads: one side must be a read of the clock or one minus a start,
 * and the other a limit, a deadline, or a start plus a limit, with a start or deadline the loop never changes.
 */
function clockBound(comparison: BinaryExpression, cx: Probe, use: Use): Bound {
  const measuring = ([[comparison.left, comparison.right], [comparison.right, comparison.left]] as const).filter(([measured, limit]) => measures(measured, cx) && isLimit(limit, cx))
  if (measuring.length === 0 || anchored(comparison, cx, use, measuring.map(([, limit]) => limit)) !== 1) return undefined
  const values = measuring.map(([, limit]) => valueOf(limit, cx, use)).filter(isNumber)
  if (values.length > 0) return Math.min(...values)
  return measuring.some(([, limit]) => sizedOutside(limit, cx.where, use)) ? 'unreadable' : undefined
}

const compares = new Set(['<', '<=', '>', '>='])
/** The comparisons a deadline is read from: an ordering. `==`, `===`, `!=` and `!==` can miss the value, so they bound nothing. */
const isCompare = (node: Node): node is BinaryExpression => node.type === 'BinaryExpression' && compares.has(node.operator)

const isNamed = (node: Node, name: string): boolean => node.type === 'Identifier' && node.name === name

/** What an update adds to the counter `name`: `name++`, `++name` or `name += <positive literal>`. `unreadable` when the amount is a name or path from outside the file; any other update is `undefined`. */
function stepOf(update: Node, name: string, cx: Probe, use: Use): number | 'unreadable' | undefined {
  if (update.type === 'UpdateExpression') return isNamed(update.argument, name) && update.operator === '++' ? 1 : undefined
  if (update.type !== 'AssignmentExpression' || update.operator !== '+=' || !isNamed(update.left, name)) return undefined
  const size = numberOf(update.right, cx.read)
  if (size === undefined) return cx.outside(update.right, use) ? 'unreadable' : undefined
  return size > 0 ? size : undefined
}

/**
 * How many times `for (let i = a; i < b; i++)` runs, or `<=`, or `i += c`: a count when `a`, `b` and `c` are literals,
 * `unreadable` when `b` or `c` is a name or path from outside the file (`a` is a literal or no bound), `undefined` for any other header.
 */
function iterations(loop: ForStatement, test: BinaryExpression, cx: Probe, use: Use): Bound {
  const { read } = cx
  if (test.left.type !== 'Identifier' || !loop.update || !['<', '<='].includes(test.operator)) return undefined
  const name = test.left.name
  const init = loop.init?.type === 'VariableDeclaration' && loop.init.kind !== 'const' && loop.init.declarations.length === 1 ? loop.init.declarations[0] : undefined
  const declared = init && isNamed(init.id, name) ? init : undefined
  const start = numberOf(declared?.init, read)
  const step = stepOf(loop.update, name, cx, use)
  if (start === undefined || step === undefined) return undefined
  const limit = numberOf(test.right, read)
  if (limit === undefined) return cx.outside(test.right, use) ? 'unreadable' : undefined
  if (step === 'unreadable') return 'unreadable'
  const span = limit - start
  return Math.max(0, test.operator === '<=' ? Math.floor(span / step) + 1 : Math.ceil(span / step))
}

/** The counter a comparison names: `i` in `i < 20`. A side that steps it (`i++ < 20`) changes the count the header's update gives, so it names none. */
const counterOf = (side: Node): string => (side.type === 'Identifier' ? side.name : '')

/** Whether evaluating the expression writes a name: `i++ < 20`, `(n += 1) < 20`. */
const hasSideEffects = (root: Node): boolean => contains(root, node => namesWritten(node).length > 0)

/** How long `count` passes take when one pass sleeps `interval`. Passes that sleep nothing take no time to count, so the count says nothing in milliseconds: `unreadable`. */
function timeOf(count: number, interval: Bound): Bound {
  if (interval === undefined) return undefined
  return isNumber(interval) && interval > 0 ? count * interval : 'unreadable'
}

/**
 * What a comparison with a counter says about how long the loop runs. Only the counter of a `for` header counts: its update runs
 * every pass. It gives its iteration count times the time one pass sleeps, when nothing in the body writes the counter.
 * `unreadable` is a count, a step or an interval that comes from outside the file, and a count of passes that sleep nothing. A counter the loop steps in its body (`tries++`), one the body
 * writes or the test steps (`i++ < 20`), a limit or step the loop changes, one that is only named, and a comparison with `==` or
 * `!=` bound nothing: a step in a branch may never run.
 */
function counterBound(test: BinaryExpression, name: string, cx: Probe, use: Use): Bound {
  const { loop } = cx.where
  const counts = loop.type === 'ForStatement' && loop.init?.type === 'VariableDeclaration' && loop.init.declarations.some(declaration => isNamed(declaration.id, name))
  if (loop.type !== 'ForStatement' || !counts || isWritten(loop.body, name) || hasSideEffects(test)) return undefined
  // A limit or a step the loop changes is not the one the header names.
  const limits = [test.left, test.right, ...(loop.update ? [loop.update] : [])].flatMap(references).filter(ref => ref.name !== name)
  if (limits.some(ref => movesIn(cx, ref.name, use))) return undefined
  const count = iterations(loop, test, cx, use)
  return isNumber(count) ? timeOf(count, cx.interval) : count
}

/** A clock or counter comparison's bound; a comparison of anything else bounds nothing. */
function comparisonBound(test: BinaryExpression, cx: Probe, use: Use): Bound {
  return clockBound(test, cx, use) ?? earliest([test.left, test.right].map(counterOf).filter(Boolean).map(name => counterBound(test, name, cx, use)))
}

/** A loop ends at the first of its exits that fires: the smallest bound, or `unreadable` when only unreadable ones exist. */
function earliest(bounds: readonly Bound[]): Bound {
  const known = bounds.filter(isNumber)
  if (known.length > 0) return Math.min(...known)
  return bounds.includes('unreadable') ? 'unreadable' : undefined
}

/**
 * A condition of several parts holds once every part does: the largest of their bounds. A part with no bound may never hold, so
 * it leaves the whole with none; a part with a bound the scan cannot read leaves it `unreadable`.
 */
function latest(bounds: readonly Bound[]): Bound {
  if (bounds.includes(undefined)) return undefined
  return bounds.every(isNumber) ? Math.max(...bounds) : 'unreadable'
}

/** The bound a name gives a condition that is true or false by the value the loop sets it to on every pass (`const timedOut = Date.now() - t0 > 5_000`). */
function aliasBound(name: Identifier, want: boolean, cx: Probe, depth: number): Bound {
  // A flag the loop does not set on every pass keeps an old value, so it ends nothing.
  const pass = depth < 3 ? perPass(cx, name.name) : undefined
  return pass ? ends(pass.value, want, cx, pass.use, depth + 1) : undefined
}

/**
 * The time by which a condition is certain to be `want`, as the loop's clock or counter sees it. For the loop head, `want` is
 * false (the loop runs while it holds); for the test of an `if` that leaves the loop, it is true. `a && b` is false once either
 * part is, and true once both are; `a || b` is the other way round. A condition of any other shape (a call, a ternary, `??`, an
 * equality) has no bound.
 */
function ends(test: Node, want: boolean, cx: Probe, use: Use, depth = 0): Bound {
  if (test.type === 'LogicalExpression' && test.operator !== '??') {
    const parts = [test.left, test.right].map(part => ends(part, want, cx, use, depth))
    return (test.operator === '&&') === want ? latest(parts) : earliest(parts)
  }
  if (test.type === 'UnaryExpression' && test.operator === '!') return ends(test.argument, !want, cx, use, depth)
  if (isCompare(test)) return isPure(test) ? comparisonBound(test, cx, use) : undefined
  return test.type === 'Identifier' ? aliasBound(test, want, cx, depth) : undefined
}

const exits = new Set(['BreakStatement', 'ReturnStatement', 'ThrowStatement'])

/** Whether a statement ends the loop by itself: a `break`, `return` or `throw`, or a block with one among its own statements that no `continue` comes before. */
function leavesDirectly(statement: Node): boolean {
  if (statement.type !== 'BlockStatement') return exits.has(statement.type)
  for (const inner of statement.body) {
    if (exits.has(inner.type)) return true
    if (contains(inner, node => node.type === 'ContinueStatement')) return false
  }
  return false
}

/**
 * The bounds of the exits in the loop's own body: `if (<condition>) break`, `return` or `throw`, written as a statement of the body
 * itself, before any statement that holds a `continue`. An `if` inside another `if`, an `else`, a `switch`, a `try`, a block or
 * an inner loop may never be reached, and a branch that leaves only inside another `if` may never leave, so neither counts.
 */
function exitBounds(cx: Probe): Bound[] {
  const { loop, above } = cx.where
  const block = loop.body.type === 'BlockStatement'
  const found: Bound[] = []
  for (const statement of block ? (loop.body as BlockStatement).body : [loop.body]) {
    if (statement.type === 'IfStatement' && leavesDirectly(statement.consequent)) {
      found.push(ends(statement.test, true, cx, { chain: [...above, loop, ...(block ? [loop.body] : [])], at: statement.test.start ?? 0 }))
    }
    if (contains(statement, node => node.type === 'ContinueStatement')) break
  }
  return found
}

type Deadline = 'none' | 'unreadable' | number

/**
 * How long a poll loop can run, as the first of its exits to fire: the smallest bound among its head and every `if` in its
 * body that leaves it. `none` when no exit reads the clock or counts attempts; `unreadable` when the exits that do are ones the
 * scan cannot evaluate.
 */
function pollDeadline(where: Where, sleeps: readonly Sleep[]): Deadline {
  // One pass takes the sum of the delays it cannot skip. A loop whose sleeps a pass may skip has no interval to count by.
  const { loop, above } = where
  const inLoop = [...above, loop, ...(loop.body.type === 'BlockStatement' ? [loop.body] : [])]
  const delays = sleeps.filter(sleep => sleep.always).map((sleep): Bound => {
    const use = { chain: inLoop, at: sleep.delay?.start ?? loop.start ?? 0 }
    if (!sleep.delay) return undefined
    return sizeNumber(sleep.delay, nameReader(where, use)) ?? (sizedOutside(sleep.delay, where, use) ? 'unreadable' : undefined)
  })
  const interval: Bound = delays.includes(undefined) ? undefined : delays.every(isNumber) ? delays.reduce((sum, each) => sum + each, 0) : 'unreadable'
  const outside = (node: Node, use: Use): boolean => isPath(node) && sizedOutside(node, where, use)
  const cx: Probe = { where, read: nameReader(where, { chain: [...above, loop], at: loop.start ?? 0 }), interval, outside }
  const head = loop.test ? ends(loop.test, false, cx, { chain: [...above, loop], at: loop.test.start ?? 0 }) : undefined
  return earliest([head, ...exitBounds(cx)]) ?? 'none'
}

function visit(node: Node, ancestors: readonly Node[], ctx: Ctx): void {
  if (node.type === 'CallExpression' && shortBound(node, ctx, ancestors)) report(ctx, 'short-bound', node)
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
    file, lines, ...testingLibrary(ast), accepted: acceptance(lines, ast.comments ?? []),
    sites: [], loops: new Map(),
  }
  walk(ast.program, [], (node, ancestors) => visit(node, ancestors, ctx))
  for (const [loop, { sleeps, where }] of ctx.loops) {
    const deadline = pollDeadline(where, sleeps)
    if (deadline === 'none' || (typeof deadline === 'number' && !(deadline >= FLOOR_MS && Number.isFinite(deadline)))) report(ctx, 'poll-deadline', loop)
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
