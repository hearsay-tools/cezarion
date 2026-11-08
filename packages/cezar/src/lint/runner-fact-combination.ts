import { parse } from '@babel/parser';
import type { Node } from '@babel/types';
import { lineAt, type SourceRule } from './source-rule.ts';

/**
 * Shared parity rows run on a derived set of runners that shows every value of each turn-path
 * fact once, not every combination of values (hearsay-tools/cezarion#2991). That holds only while
 * no function above the seam combines two declared runner facts: such a function needs a
 * combination row on every runner. This rule names each function in `workflows/` that reads two
 * different facts: `RUNNER_FACTS[id].<fact>`, `<runner>.facts.<fact>`, `<x>.inputDelivery.<field>`,
 * `inputDeliveryOf(runner).<field>` and `<x>.systemPromptOnResume`, with or without optional
 * chaining. It follows a fact row or a delivery into a local (`const`, `let`, a later assignment
 * or an alias of that local), and reads through destructuring of a fact row, a delivery or any
 * other object such as a runner, in a declaration, an assignment or a parameter. A read inside a
 * nested callback counts for the function around it too. It does not follow a fact through a
 * helper call, a return value or a property of another object.
 */

/** `RunnerFacts` keys outside `inputDelivery`, and the `InputDelivery` fields that decide behaviour. */
const ROW_FACTS = new Set(['systemPromptOnResume', 'nativeAsk', 'nativeSubagents', 'nativeTimerTool', 'costReport']);
const DELIVERY_FIELDS = new Set(['mode', 'consumption', 'acknowledgement', 'humanInputAtTurnEnd']);

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ClassMethod', 'ClassPrivateMethod', 'ObjectMethod']);

type Member = Extract<Node, { type: 'MemberExpression' | 'OptionalMemberExpression' }>;
const isMember = (node: Node | null | undefined): node is Member => node?.type === 'MemberExpression' || node?.type === 'OptionalMemberExpression';

/** The static name of a member's property: `a.b` and `a['b']`. */
function propertyName(node: Member): string | undefined {
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  if (node.property.type === 'StringLiteral') return node.property.value;
  return undefined;
}

/** What a local binding holds: one runner's fact row, or its `InputDelivery`. */
type Source = 'row' | 'delivery';
/** The names each open function scope binds, innermost last: to a fact source, or to `null`
 *  when the name holds something else and so hides an outer binding of the same name. */
type Bindings = Array<Map<string, Source | null>>;

/** `node` without parentheses, `as`, `satisfies`, type assertions and non-null assertions. */
function unwrap(node: Node): Node {
  let current = node;
  while (current.type === 'TSAsExpression' || current.type === 'TSSatisfiesExpression' || current.type === 'TSNonNullExpression'
    || current.type === 'ParenthesizedExpression' || current.type === 'TSTypeAssertion') current = current.expression;
  return current;
}

/** The innermost scope that binds `name`, if any. */
const bindingScope = (bindings: Bindings, name: string) => [...bindings].reverse().find(scope => scope.has(name));

/**
 * The fact source `node` evaluates to: a fact row (`RUNNER_FACTS[id]`, `RUNNER_FACTS.claude`,
 * `<x>.facts`, or a local bound to one) or a delivery (`<x>.inputDelivery`, `inputDeliveryOf(…)`,
 * or a local bound to one).
 */
function sourceOf(node: Node, bindings: Bindings): Source | undefined {
  const expr = unwrap(node);
  if (expr.type === 'Identifier') return bindingScope(bindings, expr.name)?.get(expr.name) ?? undefined;
  if (expr.type === 'CallExpression' || expr.type === 'OptionalCallExpression') {
    return expr.callee.type === 'Identifier' && expr.callee.name === 'inputDeliveryOf' ? 'delivery' : undefined;
  }
  if (!isMember(expr)) return undefined;
  const name = propertyName(expr);
  if (name === 'inputDelivery') return 'delivery';
  if (name === 'facts') return 'row';
  const object = unwrap(expr.object);
  return object.type === 'Identifier' && object.name === 'RUNNER_FACTS' ? 'row' : undefined;
}

/** The declared fact a member read names, or undefined when it reads none. */
function factOf(node: Member, bindings: Bindings): string | undefined {
  const name = propertyName(node);
  if (name === undefined) return undefined;
  if (name === 'systemPromptOnResume') return name;
  const source = sourceOf(node.object, bindings);
  if (source === 'delivery' && DELIVERY_FIELDS.has(name)) return `inputDelivery.${name}`;
  if (source === 'row' && ROW_FACTS.has(name)) return name;
  return undefined;
}

/**
 * Bind or read through a pattern whose value comes from `source`: a fact row, a delivery, or any
 * other object, such as a runner, whose `inputDelivery`, `facts` and `systemPromptOnResume` are
 * fact sources too. A plain name binds the source, or `null` for any other value.
 * Returns the facts the pattern reads.
 */
function destructure(pattern: Node, source: Source | 'object', scope: Map<string, Source | null>): string[] {
  const target = pattern.type === 'AssignmentPattern' ? pattern.left : pattern;
  if (target.type === 'Identifier') {
    scope.set(target.name, source === 'object' ? null : source);
    return [];
  }
  if (target.type === 'RestElement') return destructure(target.argument, 'object', scope);
  if (target.type === 'ArrayPattern') return target.elements.flatMap(element => element ? destructure(element, 'object', scope) : []);
  if (target.type !== 'ObjectPattern') return [];
  return target.properties.flatMap(property => {
    if (property.type === 'RestElement') return destructure(property.argument, 'object', scope);
    if (property.type !== 'ObjectProperty' || property.computed) return [];
    const key = property.key.type === 'Identifier' ? property.key.name : property.key.type === 'StringLiteral' ? property.key.value : undefined;
    const value = property.value as Node;
    if (key === undefined) return [];
    if (source === 'delivery') return DELIVERY_FIELDS.has(key) ? [`inputDelivery.${key}`] : [];
    if (key === 'systemPromptOnResume') return [key];
    if (key === 'inputDelivery') return destructure(value, 'delivery', scope);
    if (source === 'row') return ROW_FACTS.has(key) ? [key] : [];
    return key === 'facts' ? destructure(value, 'row', scope) : destructure(value, 'object', scope);
  });
}

/** Facts read, and sources bound, by a declaration, an assignment or a function's parameters. */
function bindingFacts(node: Node, bindings: Bindings): string[] {
  const scope = bindings.at(-1)!;
  if (node.type === 'VariableDeclarator' && node.init) return destructure(node.id, sourceOf(node.init, bindings) ?? 'object', scope);
  if (node.type === 'AssignmentExpression' && node.operator === '=') {
    const owner = node.left.type === 'Identifier' ? bindingScope(bindings, node.left.name) ?? scope : scope;
    return destructure(node.left, sourceOf(node.right, bindings) ?? 'object', owner);
  }
  if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression'
    || node.type === 'ClassMethod' || node.type === 'ClassPrivateMethod' || node.type === 'ObjectMethod') {
    return node.params.flatMap(param => destructure(param.type === 'TSParameterProperty' ? param.parameter : param, 'object', scope));
  }
  return [];
}

interface Scope { node: Node; name: string; facts: Set<string>; reported: boolean; children: Scope[] }

function functionName(node: Node, parent: Node | undefined): string {
  if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') && node.id) return node.id.name;
  if ((node.type === 'ClassMethod' || node.type === 'ObjectMethod') && node.key.type === 'Identifier') return node.key.name;
  if (node.type === 'ClassPrivateMethod') return `#${node.key.id.name}`;
  if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') return parent.id.name;
  if ((parent?.type === 'ObjectProperty' || parent?.type === 'ClassProperty') && parent.key.type === 'Identifier') return parent.key.name;
  return '(anonymous function)';
}

function walk(node: Node, parent: Node | undefined, scopes: Scope[], roots: Scope[], bindings: Bindings): void {
  let scope: Scope | undefined;
  if (FUNCTION_TYPES.has(node.type)) {
    scope = { node, name: functionName(node, parent), facts: new Set(), reported: false, children: [] };
    (scopes.at(-1)?.children ?? roots).push(scope);
    scopes.push(scope);
    bindings.push(new Map());
  }
  const facts = isMember(node) ? [factOf(node, bindings)].filter((fact): fact is string => fact !== undefined) : bindingFacts(node, bindings);
  for (const fact of facts) for (const open of scopes) open.facts.add(fact);
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child === 'object' && typeof (child as Node).type === 'string') walk(child as Node, node, scopes, roots, bindings);
    }
  }
  if (scope) { scopes.pop(); bindings.pop(); }
}

/** Report the innermost functions that combine two facts; an outer function only when no inner one was named. */
function combinations(scope: Scope, found: Scope[]): boolean {
  let inner = false;
  for (const child of scope.children) inner = combinations(child, found) || inner;
  if (inner || scope.facts.size < 2) return inner;
  found.push(scope);
  return true;
}

export interface FactCombination { name: string; line: number; facts: string[] }

export function factCombinations(source: string): FactCombination[] {
  if (!/RUNNER_FACTS|\bfacts\b|inputDelivery|systemPromptOnResume/.test(source)) return [];
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] });
  const roots: Scope[] = [];
  walk(ast.program, undefined, [], roots, [new Map()]);
  const found: Scope[] = [];
  for (const root of roots) combinations(root, found);
  return found
    .map(scope => ({ name: scope.name, line: lineAt(source, scope.node.start ?? 0), facts: [...scope.facts].sort() }))
    .sort((a, b) => a.line - b.line);
}

/**
 * Functions allowed to combine facts, as `<file>#<function>` → `<family> <row>`, the parity row that runs the
 * combination on every runner. Empty today: no shared function combines two facts.
 */
export const COMBINATION_ROWS: Readonly<Record<string, string>> = {};

const isTest = (file: string) => /\.(?:test|e2e)\.tsx?$|\.testkit\.tsx?$/.test(file);

export const runnerFactCombination: SourceRule = {
  name: 'runner-fact-combination',
  description: 'A function above the runner seam reads at most one declared runner fact (hearsay-tools/cezarion#2991).',
  applies: file => /^packages\/cezar\/src\/workflows\/.+\.ts$/.test(file) && !isTest(file),
  check: (file, source) => factCombinations(source).filter(({ name }) => COMBINATION_ROWS[`${file}#${name}`] === undefined).map(({ name, line, facts }) => ({
    line,
    message: `${name} reads ${facts.join(' and ')}. Shared parity rows run on a derived runner set that shows each fact value once, not each combination: `
      + 'split the function so each part reads one fact, or add a parity row for the combination that runs on every runner and name it in COMBINATION_ROWS (hearsay-tools/cezarion#2991).',
  })),
};
