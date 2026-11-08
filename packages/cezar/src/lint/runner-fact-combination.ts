import { parse } from '@babel/parser';
import type { Node } from '@babel/types';
import { lineAt, type SourceRule } from './source-rule.ts';

/**
 * Shared parity rows run on a derived set of runners that shows every value of each turn-path
 * fact once, not every combination of values (hearsay-tools/cezarion#2991). That holds only while
 * no function above the seam combines two declared runner facts: such a function needs a
 * combination row on every runner. This rule names each function in `workflows/` that reads two
 * different facts directly: `RUNNER_FACTS[id].<fact>`, `<runner>.facts.<fact>`,
 * `<x>.inputDelivery.<field>`, `inputDeliveryOf(runner).<field>` and `<x>.systemPromptOnResume`.
 * A read inside a nested callback counts for the function around it too. It does not follow a
 * fact through a helper call.
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

/** Whether `node` evaluates to one runner's whole fact row: `RUNNER_FACTS[id]`, `RUNNER_FACTS.claude` or `<x>.facts`. */
function isFactRow(node: Node): boolean {
  if (!isMember(node)) return false;
  if (node.object.type === 'Identifier' && node.object.name === 'RUNNER_FACTS') return true;
  return propertyName(node) === 'facts';
}

/** Whether `node` evaluates to an `InputDelivery`: `<x>.inputDelivery` or `inputDeliveryOf(…)`. */
function isDelivery(node: Node): boolean {
  if (isMember(node)) return propertyName(node) === 'inputDelivery';
  return (node.type === 'CallExpression' || node.type === 'OptionalCallExpression')
    && node.callee.type === 'Identifier' && node.callee.name === 'inputDeliveryOf';
}

/** The declared fact a member read names, or undefined when it reads none. */
function factOf(node: Member): string | undefined {
  const name = propertyName(node);
  if (name === undefined) return undefined;
  if (name === 'systemPromptOnResume') return name;
  if (DELIVERY_FIELDS.has(name) && isDelivery(node.object)) return `inputDelivery.${name}`;
  if (isFactRow(node.object)) {
    if (ROW_FACTS.has(name)) return name;
    // `RUNNER_FACTS[id].inputDelivery` alone is the whole delivery; its field read is counted above.
  }
  return undefined;
}

/** Facts read by destructuring a fact row or a delivery: `const { nativeAsk } = RUNNER_FACTS[id]`. */
function destructuredFacts(node: Node): string[] {
  if (node.type !== 'VariableDeclarator' || node.id.type !== 'ObjectPattern' || !node.init) return [];
  const row = isFactRow(node.init), delivery = isDelivery(node.init);
  if (!row && !delivery) return [];
  return node.id.properties.flatMap(property => {
    if (property.type !== 'ObjectProperty' || property.computed || property.key.type !== 'Identifier') return [];
    const key = property.key.name;
    if (delivery && DELIVERY_FIELDS.has(key)) return [`inputDelivery.${key}`];
    if (row && ROW_FACTS.has(key)) return [key];
    return [];
  });
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

function walk(node: Node, parent: Node | undefined, scopes: Scope[], roots: Scope[]): void {
  let scope: Scope | undefined;
  if (FUNCTION_TYPES.has(node.type)) {
    scope = { node, name: functionName(node, parent), facts: new Set(), reported: false, children: [] };
    (scopes.at(-1)?.children ?? roots).push(scope);
    scopes.push(scope);
  }
  const facts = isMember(node) ? [factOf(node)].filter((fact): fact is string => fact !== undefined) : destructuredFacts(node);
  for (const fact of facts) for (const open of scopes) open.facts.add(fact);
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child === 'object' && typeof (child as Node).type === 'string') walk(child as Node, node, scopes, roots);
    }
  }
  if (scope) scopes.pop();
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
  if (!/RUNNER_FACTS|\.facts\b|inputDelivery|systemPromptOnResume/.test(source)) return [];
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] });
  const roots: Scope[] = [];
  walk(ast.program, undefined, [], roots);
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
