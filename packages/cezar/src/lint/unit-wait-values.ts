import type { BinaryExpression, CallExpression, MemberExpression, Node, ObjectExpression, UnaryExpression } from '@babel/types';
import { VITEST_DEFAULT_MS, walk, isFunction, targetNames, namesWritten, type Ctx, type Where } from './unit-wait-discipline.ts';
import { type Bound, isPath, isLimit, isNamed } from './unit-wait-deadlines.ts';

/** A name's value where it is read, or undefined when the scan cannot say. */
export type Read = (name: string) => number | undefined

export const namedNumbers = new Map([['NaN', NaN], ['Infinity', Infinity]])

/** The functions of `Math` that the evaluator reads, on numbers it can read. */
export const mathFunctions = new Map<string, (...values: number[]) => number>([
  ['max', Math.max], ['min', Math.min], ['abs', Math.abs], ['floor', Math.floor], ['ceil', Math.ceil], ['round', Math.round], ['trunc', Math.trunc],
])

export const numberMembers = new Map([
  ['NaN', NaN], ['POSITIVE_INFINITY', Infinity], ['NEGATIVE_INFINITY', -Infinity],
  ['MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER], ['MIN_SAFE_INTEGER', Number.MIN_SAFE_INTEGER], ['MAX_VALUE', Number.MAX_VALUE],
])

/**
 * The value of a numeric expression the scan can read: number literals, `NaN`, `Infinity`, unary `+` and `-`, parentheses,
 * `as` / `satisfies` / non-null wrappers, a name `read` knows, and `+ - * / % **` of those. Anything else is undefined: an
 * expression the scan cannot read.
 */
export function numberOf(node: Node | null | undefined, read: Read): number | undefined {
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
export const memberNumber = (node: MemberExpression): number | undefined => {
  const name = node.object.type === 'Identifier' && node.object.name === 'Number' ? keyName(node.property, node.computed) : undefined
  return name === undefined ? undefined : numberMembers.get(name)
}

export function unaryNumber(node: UnaryExpression, read: Read): number | undefined {
  const value = node.operator === '-' || node.operator === '+' ? numberOf(node.argument, read) : undefined
  return value === undefined ? undefined : node.operator === '-' ? -value : value
}

/**
 * The value of a wait bound or a delay: a number `numberOf` reads, or `Math.max`, `min`, `abs`, `floor`, `ceil`, `round` or
 * `trunc` of such numbers. A limit is not read this way: it is a literal sum of products or one name or path.
 */
export function sizeNumber(node: Node | null | undefined, read: Read): number | undefined {
  if (node?.type !== 'CallExpression') return numberOf(node, read)
  const callee = calleeOf(node.callee)
  const fn = callee?.object === 'Math' ? mathFunctions.get(callee.name) : undefined
  const args = node.arguments.map(argument => numberOf(argument, read))
  return fn && args.length > 0 && args.every(isNumber) ? fn(...args) : undefined
}

export function binaryNumber(node: BinaryExpression, read: Read): number | undefined {
  const left = numberOf(node.left, read)
  const right = numberOf(node.right, read)
  if (left === undefined || right === undefined) return undefined
  const operations: Record<string, number> = { '*': left * right, '/': left / right, '+': left + right, '-': left - right, '%': left % right, '**': left ** right }
  return operations[node.operator]
}

/** A node without the wrappers that change its type and not its value: parentheses, `as`, `satisfies`, `!`. */
export function unwrap(node: Node): Node {
  const wrapper = node.type === 'ParenthesizedExpression' || node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'TSNonNullExpression' || node.type === 'TSTypeAssertion'
  return wrapper ? unwrap(node.expression) : node
}

/** The text of a string literal or of a template without substitutions, else undefined. */
export function stringOf(node: Node): string | undefined {
  const inner = unwrap(node)
  if (inner.type === 'StringLiteral') return inner.value
  return inner.type === 'TemplateLiteral' && inner.expressions.length === 0 ? inner.quasis[0]?.value.cooked ?? undefined : undefined
}

/**
 * The one reader of a property key, for an object literal's keys and for a member access alike, so that no reader of the scan
 * compares a name the others cannot spell. A plain key is an identifier, a string or a number: `timeout`, `'timeout'`, `500`.
 * A computed key is a string, a template without substitutions, a number, or a name that every `const` of the file holds as one
 * string (`[KEY]` after `const KEY = 'timeout'`), each with `as`, `satisfies`, `!` and parentheses taken off. Anything else
 * is undefined: the scan cannot say which key it is.
 */
export function keyName(key: Node, computed: boolean, place?: Place): string | undefined {
  if (computed) return expressionName(key, place, 0)
  if (key.type === 'Identifier') return key.name
  return key.type === 'StringLiteral' ? key.value : key.type === 'NumericLiteral' ? String(key.value) : undefined
}

/** The name a bracketed key spells, followed through the names that hold it (`const ALIAS = KEY`) to a depth of three. */
export function expressionName(node: Node, place: Place | undefined, depth: number): string | undefined {
  const literal = stringOf(node)
  if (literal !== undefined) return literal
  const inner = unwrap(node)
  if (inner.type === 'NumericLiteral') return String(inner.value)
  if (inner.type !== 'Identifier' || !place || depth > 3) return undefined
  const names = heldBy(place.view, place.use, inner.name, true).map(held => expressionName(held.value, placeFor(place.view, held.use), depth + 1))
  return names.length > 0 && names.every(name => name !== undefined && name === names[0]) ? names[0] : undefined
}

/** The `.name` of a callee, and the identifier it is called on (`vi` in `vi.waitFor`), when there is one. */
export function calleeOf(node: Node): { object?: string; name: string } | undefined {
  if (node.type === 'Identifier') return { name: node.name }
  const name = node.type === 'MemberExpression' ? keyName(node.property, node.computed) : undefined
  if (node.type !== 'MemberExpression' || name === undefined) return undefined
  return node.object.type === 'Identifier' ? { object: node.object.name, name } : { name }
}

/** Where a wait bound is read: the function around it and the nodes above it, and what a name holds there. */
export interface Place {
  view: View
  use: Use
  read: Read
}

/** Names that stand for the same value in every file: JavaScript's own, which a bound may use without declaring. */
export const ownNames = new Set(['Math', 'Number', 'Date', 'Infinity', 'NaN', 'undefined'])

/** Whether the file binds `name` other than by a plain declaration: as a function or class, or as part of a destructuring. */
export function boundApart(root: Node | undefined, name: string): boolean {
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
export function declaredHere(view: View, use: Use, name: string): boolean {
  const declared = definition(view, use, name)
  return declared ? declared.kind !== 'param' : boundApart(view.above[0], name)
}

/** The names an expression reads: a called function's, the start of a path, not a property, a type or a function's own. */
export function rootsOf(root: Node): string[] {
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
export const passesOn = (value: Node): boolean => isPath(value) || (value.type === 'BinaryExpression' && value.operator === '+' && clockCall(value.left) && isPath(value.right))

/**
 * Whether the expression reads a name or path that comes from outside the file, so the caller sizes it: a parameter, an import or a
 * global. A name the file declares is the caller's when every value it holds only passes on one that is.
 */
export function sizedOutside(node: Node, view: View, use: Use, depth = 0): boolean {
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
export const sizeOf = (node: Node, place: Place): number | undefined => sizeNumber(node, place.read) ?? (sizedOutside(node, place.view, place.use) ? undefined : NaN)

/** What a Vitest wait is given as its bound: `undefined` is its default, `null` is none, and any other value is read. */
export function vitestMs(node: Node, place: Place): number | undefined {
  if (node.type === 'Identifier' && node.name === 'undefined') return VITEST_DEFAULT_MS
  return node.type === 'NullLiteral' ? 0 : sizeOf(node, place)
}

export const placeFor = (view: View, use: Use): Place => ({ view, use, read: nameReader(view, use, 1, true) })

/** The options objects an argument stands for: the literal itself, or the ones a name holds, each with the place its own names are read from. */
export function optionObjects(argument: Node, place: Place): Array<{ object: ObjectExpression; place: Place }> {
  const node = unwrap(argument)
  if (node.type === 'ObjectExpression') return [{ object: node, place }]
  if (node.type !== 'Identifier') return []
  return heldBy(place.view, place.use, node.name, true).flatMap(held => {
    const value = unwrap(held.value)
    return value.type === 'ObjectExpression' ? [{ object: value, place: placeFor(place.view, held.use) }] : []
  })
}

/** Vitest's `vi.waitFor`, `vi.waitUntil` and `expect.poll`: the bound in force, or undefined when the caller sizes it. */
export function vitestBound(call: CallExpression, place: Place): number | undefined {
  const callee = calleeOf(call.callee)
  const isWait = (callee?.object === 'vi' && (callee.name === 'waitFor' || callee.name === 'waitUntil')) ||
    (callee?.object === 'expect' && callee.name === 'poll')
  if (!isWait) return undefined
  const options = call.arguments[1]
  if (!options) return VITEST_DEFAULT_MS
  const objects = optionObjects(options, place)
  if (objects.length === 0) return vitestMs(options, place)
  return smallest(objects.map(({ object, place: at }) => optionsMs(object, at, VITEST_DEFAULT_MS, vitestMs)))
}

/** What a Testing Library wait is given as its `timeout`: `undefined` is its default, which `asyncUtilTimeout` covers. */
export const testingLibraryMs = (node: Node, place: Place): number | undefined => (node.type === 'Identifier' && node.name === 'undefined' ? undefined : sizeOf(node, place))

/**
 * The bound an options object leaves, read in order as the language does, from `before` until a `timeout` names one. Every key
 * is read by `keyName`. A spread, or a computed key that `keyName` cannot resolve, may set any key, so after one the bound is the
 * caller's (`undefined`) when it reads a name from outside the file, and `NaN` when it reads only what the file declares, until
 * a later explicit `timeout`.
 */
export function optionsMs(object: ObjectExpression, place: Place, before: number | undefined, boundOf: (node: Node, place: Place) => number | undefined): number | undefined {
  let bound = before
  for (const property of object.properties) {
    const name = property.type === 'SpreadElement' ? undefined : keyName(property.key, property.computed, place)
    if (name === 'timeout' && property.type === 'ObjectProperty') bound = boundOf(property.value, place)
    else if (name === undefined) bound = sizedOutside(property.type === 'SpreadElement' ? property.argument : property.key, place.view, place.use) ? undefined : NaN
  }
  return bound
}

/** A Testing Library wait whose `timeout` is given: that bound, or undefined when it has none or the caller sizes it. */
export function testingLibraryBound(call: CallExpression, ctx: Ctx, place: Place): number | undefined {
  const callee = calleeOf(call.callee)
  if (!callee) return undefined
  const query = /^find(?:All)?By[A-Z]/.test(callee.name)
  const wait = callee.object === undefined ? ctx.tlWaits.has(callee.name) : ctx.tlNamespaces.has(callee.object) && /^waitFor(?:ElementToBeRemoved)?$/.test(callee.name)
  if (!query && !wait) return undefined
  // The wait's own options come last (`findBy*(text, queryOptions, waitForOptions)`), so the last `timeout` is the one in force.
  let bound: number | undefined
  for (const argument of call.arguments) {
    const objects = optionObjects(argument, place)
    if (objects.length > 0) bound = smallest(objects.map(({ object, place: at }) => optionsMs(object, at, bound, testingLibraryMs)))
  }
  return bound
}

export const clockCall = (node: Node): boolean => {
  if (node.type !== 'CallExpression') return false
  const callee = calleeOf(node.callee)
  return (callee?.object === 'Date' && callee.name === 'now') || (callee?.object === 'performance' && callee.name === 'now') ||
    (callee?.object === 'process' && callee.name === 'hrtime')
}

/** Whether any node under `root` passes, leaving out the functions nested in it: what a helper does is not what the loop does. */
export function contains(root: Node, test: (node: Node) => boolean): boolean {
  let found = false
  walk(root, [], node => {
    found ||= test(node)
    return node !== root && isFunction(node) ? false : undefined
  })
  return found
}

/** A name declared in a function: its initializer (none for a parameter without a default) and where it is in view. */
export interface Declaration {
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

export const blockScopes = new Set(['BlockStatement', 'Program', 'StaticBlock', 'ForStatement', 'ForInStatement', 'ForOfStatement'])

/** What `node` declares under `name` in `scope`: a variable, a parameter or a parameter's default. */
export function declaredAs(node: Node, ancestors: readonly Node[], scope: Node, name: string): Pick<Declaration, 'init' | 'owner' | 'kind'> | undefined {
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
export interface View {
  scope: Node
  above: readonly Node[]
}

/**
 * Every declaration of a name in the function around the use and in every function around that one, up to the module, leaving
 * out the functions nested in each: their names are theirs.
 */
export function declarationsOf(view: View, name: string): Declaration[] {
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
export interface Use {
  chain: readonly Node[]
  at: number
}

/**
 * What a loop is judged by: where it sits, what a name means at its head, and the time one pass of its sleeps takes (0 when it has
 * none, `unreadable` when a delay comes from outside the file, `undefined` when a delay is one the scan does not read).
 */
export interface Probe {
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
export function definition(view: View, use: Use, name: string): Declaration | undefined {
  const depth = (declaration: Declaration) => use.chain.indexOf(declaration.owner)
  const inView = declarationsOf(view, name).filter(declaration => depth(declaration) >= 0 && (declaration.scope !== view.scope || declaration.start < use.at))
  const nearer = (a: Declaration, b: Declaration) => depth(a) > depth(b) || (depth(a) === depth(b) && a.start > b.start)
  return inView.reduce<Declaration | undefined>((nearest, declaration) => (!nearest || nearer(declaration, nearest) ? declaration : nearest), undefined)
}

/**
 * What writes a name inside `root`, closures included, since a closure can reassign it: the right-hand sides of `name = …`, and
 * whether anything else writes it (`name += 1`, `name++`, a destructuring target).
 */
export function writes(root: Node, name: string): { values: Node[]; other: boolean } {
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
export function valuesOf(view: View, declared: Declaration, name: string, strict = false): Node[] {
  const { values, other } = writes(declared.scope, name)
  if (other || ((strict || declared.scope !== view.scope) && declared.kind !== 'const' && values.length > 0)) return []
  return declared.init ? [declared.init, ...values] : values
}

export const isNumber = (value: unknown): value is number => typeof value === 'number'

/** The values a name holds where it is read, each with the place its own names are read from. */
export function heldBy(view: View, use: Use, name: string, strict = false): Array<{ value: Node; use: Use }> {
  const declared = definition(view, use, name)
  return declared ? valuesOf(view, declared, name, strict).map(value => ({ value, use: { chain: declared.chain, at: declared.start } })) : []
}

export const smallest = (values: readonly (number | undefined)[]): number | undefined => {
  const known = values.filter(isNumber)
  return known.length > 0 ? Math.min(...known) : undefined
}

/** What a name means where it is read, as a number: the smallest value it can hold, so a long value never hides a short one. */
export function nameValue(name: string, view: View, use: Use, depth: number, strict: boolean): number | undefined {
  return depth > 3 ? undefined : smallest(heldBy(view, use, name, strict).map(held => numberOf(held.value, nameReader(view, held.use, depth + 1, strict))))
}

export const nameReader = (view: View, use: Use, depth = 0, strict = false): Read => name => nameValue(name, view, use, depth, strict)

/** Where a bound written at `at` is read: the function around it and the nodes above it. Strict: a wait or a sleep is not a loop, so a name written after its declaration is read as none of its values. */
export function placeAt(ancestors: readonly Node[], at: number): Place | undefined {
  const scope = [...ancestors].reverse().find(isFunction) ?? ancestors[0]
  if (!scope) return undefined
  const view = { scope, above: ancestors }
  const use = { chain: ancestors, at }
  return { view, use, read: nameReader(view, use, 0, true) }
}

export const readerFor = (ancestors: readonly Node[], at: number): Read => placeAt(ancestors, at)?.read ?? (() => undefined)

/**
 * The literal an expression stands for where it is read: a number, a name for one, or a sum with a term of those. A name that can
 * hold several values gives the smallest it can read, so a long value never hides a short one.
 */
export function valueOf(node: Node, cx: Probe, use: Use, depth = 0): number | undefined {
  if (depth > 3) return undefined
  if (node.type === 'Identifier' && !namedNumbers.has(node.name)) return smallest(heldBy(cx.where, use, node.name).map(held => valueOf(held.value, cx, held.use, depth + 1)))
  const direct = numberOf(node, nameReader(cx.where, use, depth))
  if (direct !== undefined) return direct
  return node.type === 'BinaryExpression' && node.operator === '+' && isLimit(node, cx) ? valueOf(node.left, cx, use, depth) ?? valueOf(node.right, cx, use, depth) : undefined
}
