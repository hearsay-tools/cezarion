import type { AwaitExpression, BinaryExpression, BlockStatement, CallExpression, Comment, DoWhileStatement, File, ForStatement, Identifier, MemberExpression, Node, ObjectExpression, UnaryExpression, WhileStatement } from '@babel/types';
import { walk, isFunction, namesWritten, type Where, type Sleep } from './unit-wait-discipline.ts';
import { numberOf, sizeNumber, keyName, sizedOutside, clockCall, contains, type Use, type Probe, definition, writes, valuesOf, isNumber, smallest, nameReader, valueOf } from './unit-wait-values.ts';

/** A bound on how long a loop runs, in milliseconds: `unreadable` when one exists the scan cannot evaluate, `undefined` when there is none. */
export type Bound = number | 'unreadable' | undefined

/** A name or a dotted path of names: `deadline`, `state.t0`. */
export const isPath = (node: Node): boolean => node.type === 'Identifier' || (node.type === 'MemberExpression' && keyName(node.property, node.computed) !== undefined && isPath(node.object))

export const impure = new Set(['AssignmentExpression', 'UpdateExpression', 'CallExpression', 'NewExpression', 'TaggedTemplateExpression', 'AwaitExpression', 'YieldExpression'])

/** Whether a condition only reads: no write, no call but a read of the clock, no `delete`, `await` or `new`. */
export function isPure(root: Node): boolean {
  let pure = true
  walk(root, [], node => {
    if (clockCall(node)) return false
    if (impure.has(node.type) || (node.type === 'UnaryExpression' && node.operator === 'delete')) pure = false
    return isFunction(node) ? false : undefined
  })
  return pure
}

/** The names a comparison reads: not what a clock read holds, a called function's name, or a property name. */
export function references(root: Node): Identifier[] {
  const found: Identifier[] = []
  walk(root, [], (node, ancestors) => {
    if (clockCall(node)) return false
    const parent = ancestors.at(-1)
    const skipped = (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) || (parent?.type === 'ObjectProperty' && parent.key === node && !parent.computed)
    if (node.type === 'Identifier' && !skipped && !(parent?.type === 'CallExpression' && parent.callee === node) && !globalNames.has(node.name)) found.push(node)
  })
  return found
}

export const globalNames = new Set(['Math', 'Number', 'Date', 'performance', 'process', 'undefined', 'Infinity', 'NaN'])

export const isWritten = (root: Node, name: string): boolean => {
  const written = writes(root, name)
  return written.other || written.values.length > 0
}

/** Whether a function nested in the loop's function writes the name: it can run in any pass. */
export function closureWrites(scope: Node, name: string): boolean {
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
export function movesIn(cx: Probe, name: string, use: Use): boolean {
  const { loop, scope } = cx.where
  return definition(cx.where, use, name)?.chain.includes(loop.body) === true || isWritten(loop, name) || closureWrites(scope, name)
}

/** What the loop sets a name to on every pass, and where that value is read from. */
export interface PerPass {
  value: Node
  use: Use
}

/**
 * What the loop sets a name to on every pass: its only write, a plain assignment or a declaration with a value, written as a
 * statement of the loop body itself before any statement that holds a `continue`. A write in a branch, a closure, the header
 * or after a `continue` may not run in a pass, so the name may keep an old value and the comparison against it ends nothing.
 */
export function perPass(cx: Probe, name: string): PerPass | undefined {
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
export const isMeasure = (node: Node): boolean => clockCall(node) || (node.type === 'BinaryExpression' && node.operator === '-' && clockCall(node.left) && isPath(node.right))

/**
 * The values a name a comparison reads may hold: a literal, a name or path, or a read of the clock. A deadline may also be a read
 * of the clock plus a limit. A name set to any other expression (`Date.now() + 1e9` as a start, `Date.now() + 15_000 * scale` as a
 * deadline, a call) is not a start, a limit or a deadline the scan reads.
 */
export function isListed(value: Node, cx: Probe, deadline: boolean): boolean {
  const limit = (side: Node): boolean => numberOf(side, cx.read) !== undefined || isPath(side)
  return limit(value) || clockCall(value) || (deadline && value.type === 'BinaryExpression' && value.operator === '+' && clockCall(value.left) && limit(value.right))
}

/**
 * Whether a comparison measures the clock against something fixed. -1 when it reads a name the loop changes that is not a sample
 * of the clock, or a name whose value is not one the scan reads (a limit or a start that moves or is an expression of its own),
 * 0 when it has no fixed anchor (a start, a deadline, a limit the caller sized), 1 when it has one. A name the loop sets from the
 * clock on every pass is a sample: its own value is judged the same way, so `elapsed = Date.now() - start` is anchored by `start`.
 */
export function anchored(root: Node, cx: Probe, use: Use, deadlines: readonly Node[], depth = 0): -1 | 0 | 1 {
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
export function isLimit(node: Node, cx: Probe): boolean {
  const operand = (inner: Node): boolean => isPath(inner) || clockCall(inner) || numberOf(inner, cx.read) !== undefined
  return numberOf(node, cx.read) !== undefined || isPath(node) || (node.type === 'BinaryExpression' && node.operator === '+' && operand(node.left) && operand(node.right))
}

/** A read of the clock: the call itself, or a name the loop sets from one on every pass (`const now = Date.now()`). */
export const sampled = (node: Node, cx: Probe): boolean => clockCall(node) || (node.type === 'Identifier' && isMeasure(perPass(cx, node.name)?.value ?? node))

/** The side of a clock comparison that measures time: a read of the clock, or one minus a start (`Date.now() - start`). */
export const measures = (node: Node, cx: Probe): boolean =>
  sampled(node, cx) || (node.type === 'BinaryExpression' && node.operator === '-' && sampled(node.left, cx) && isPath(node.right))

/**
 * What a comparison says about the clock: the smallest literal it measures against, `unreadable` when the limit is one the caller
 * sizes (from outside the file), `undefined` when the file declares it and the scan cannot read it, or when it is not a clock comparison the scan reads: one side must be a read of the clock or one minus a start,
 * and the other a limit, a deadline, or a start plus a limit, with a start or deadline the loop never changes.
 */
export function clockBound(comparison: BinaryExpression, cx: Probe, use: Use): Bound {
  const measuring = ([[comparison.left, comparison.right], [comparison.right, comparison.left]] as const).filter(([measured, limit]) => measures(measured, cx) && isLimit(limit, cx))
  if (measuring.length === 0 || anchored(comparison, cx, use, measuring.map(([, limit]) => limit)) !== 1) return undefined
  const values = measuring.map(([, limit]) => valueOf(limit, cx, use)).filter(isNumber)
  if (values.length > 0) return Math.min(...values)
  return measuring.some(([, limit]) => sizedOutside(limit, cx.where, use)) ? 'unreadable' : undefined
}

export const compares = new Set(['<', '<=', '>', '>='])

/** The comparisons a deadline is read from: an ordering. `==`, `===`, `!=` and `!==` can miss the value, so they bound nothing. */
export const isCompare = (node: Node): node is BinaryExpression => node.type === 'BinaryExpression' && compares.has(node.operator)

export const isNamed = (node: Node, name: string): boolean => node.type === 'Identifier' && node.name === name

/** What an update adds to the counter `name`: `name++`, `++name` or `name += <positive literal>`. `unreadable` when the amount is a name or path from outside the file; any other update is `undefined`. */
export function stepOf(update: Node, name: string, cx: Probe, use: Use): number | 'unreadable' | undefined {
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
export function iterations(loop: ForStatement, test: BinaryExpression, cx: Probe, use: Use): Bound {
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
export const counterOf = (side: Node): string => (side.type === 'Identifier' ? side.name : '')

/** Whether evaluating the expression writes a name: `i++ < 20`, `(n += 1) < 20`. */
export const hasSideEffects = (root: Node): boolean => contains(root, node => namesWritten(node).length > 0)

/** How long `count` passes take when one pass sleeps `interval`. Passes that sleep nothing take no time to count, so the count says nothing in milliseconds: `unreadable`. */
export function timeOf(count: number, interval: Bound): Bound {
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
export function counterBound(test: BinaryExpression, name: string, cx: Probe, use: Use): Bound {
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
export function comparisonBound(test: BinaryExpression, cx: Probe, use: Use): Bound {
  return clockBound(test, cx, use) ?? earliest([test.left, test.right].map(counterOf).filter(Boolean).map(name => counterBound(test, name, cx, use)))
}

/** A loop ends at the first of its exits that fires: the smallest bound, or `unreadable` when only unreadable ones exist. */
export function earliest(bounds: readonly Bound[]): Bound {
  const known = bounds.filter(isNumber)
  if (known.length > 0) return Math.min(...known)
  return bounds.includes('unreadable') ? 'unreadable' : undefined
}

/**
 * A condition of several parts holds once every part does: the largest of their bounds. A part with no bound may never hold, so
 * it leaves the whole with none; a part with a bound the scan cannot read leaves it `unreadable`.
 */
export function latest(bounds: readonly Bound[]): Bound {
  if (bounds.includes(undefined)) return undefined
  return bounds.every(isNumber) ? Math.max(...bounds) : 'unreadable'
}

/** The bound a name gives a condition that is true or false by the value the loop sets it to on every pass (`const timedOut = Date.now() - t0 > 5_000`). */
export function aliasBound(name: Identifier, want: boolean, cx: Probe, depth: number): Bound {
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
export function ends(test: Node, want: boolean, cx: Probe, use: Use, depth = 0): Bound {
  if (test.type === 'LogicalExpression' && test.operator !== '??') {
    const parts = [test.left, test.right].map(part => ends(part, want, cx, use, depth))
    return (test.operator === '&&') === want ? latest(parts) : earliest(parts)
  }
  if (test.type === 'UnaryExpression' && test.operator === '!') return ends(test.argument, !want, cx, use, depth)
  if (isCompare(test)) return isPure(test) ? comparisonBound(test, cx, use) : undefined
  return test.type === 'Identifier' ? aliasBound(test, want, cx, depth) : undefined
}

export const exits = new Set(['BreakStatement', 'ReturnStatement', 'ThrowStatement'])

/** Whether a statement ends the loop by itself: a `break`, `return` or `throw`, or a block with one among its own statements that no `continue` comes before. */
export function leavesDirectly(statement: Node): boolean {
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
export function exitBounds(cx: Probe): Bound[] {
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

export type Deadline = 'none' | 'unreadable' | number

/**
 * How long a poll loop can run, as the first of its exits to fire: the smallest bound among its head and every `if` in its
 * body that leaves it. `none` when no exit reads the clock or counts attempts; `unreadable` when the exits that do are ones the
 * scan cannot evaluate.
 */
export function pollDeadline(where: Where, sleeps: readonly Sleep[]): Deadline {
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
