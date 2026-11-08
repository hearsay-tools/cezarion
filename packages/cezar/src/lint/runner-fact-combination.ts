import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import type { Node } from '@babel/types';
import { lineAt, repoRoot, type SourceRule } from './source-rule.ts';

/**
 * Shared parity rows run on a derived set of runners that shows every value of each turn-path
 * fact once, not every combination of values (hearsay-tools/cezarion#2991). That holds only while
 * no function above the seam combines two declared runner facts: such a function needs a
 * combination row on every runner.
 *
 * The rule over-approximates, so it fails closed. It tracks no value. It flags a function in a
 * non-test `workflows/` source when both hold, counting the function's nested callbacks as part
 * of it:
 *
 * (a) it touches a fact source anywhere: a `.inputDelivery`, `.facts` or `.systemPromptOnResume`
 *     property, the `RUNNER_FACTS` or `inputDeliveryOf` name, a destructuring key `inputDelivery`,
 *     `facts` or `systemPromptOnResume`, or the type `InputDelivery` or `RunnerFacts`;
 * (b) it reads two or more different fact keys, by property name or destructuring key, from any
 *     object. The keys come from the declared types (`RunnerFacts` in `core/runner-facts.ts`,
 *     `InputDelivery` in `core/agent-runner.ts`), so a new fact joins the rule by itself.
 *
 * Aliases, block scopes, `??`, ternaries, reassignment, rest elements and parameter defaults are
 * all covered because no value is followed. A reported function is either a real combination,
 * which needs a parity row on every runner, or a false positive: an unrelated object with a
 * same-named key. Both go in `COMBINATION_ROWS` with a reason; a real combination also names its
 * row. The rule reports the innermost function that qualifies, and an outer one only when none
 * inside it does. It does not see a fact read inside a helper function that the reported function
 * calls; that helper is checked on its own.
 */

/** Declared keys that are no fact: each reason says why. */
const NOT_FACTS: Readonly<Record<string, string>> = {
  inputDelivery: 'the container of the delivery facts; reading it is a fact source',
  via: 'prose naming the native mechanism for the docs; no code decides on it',
};

const TYPE_FILES = { RunnerFacts: 'packages/cezar/src/core/runner-facts.ts', InputDelivery: 'packages/cezar/src/core/agent-runner.ts' } as const;

/** Every property key of the type literals and interfaces a type names, followed through `&`, `|`, parentheses and local interfaces. */
function typeKeys(program: Extract<Node, { type: 'Program' }>, name: string): string[] {
  const declarations = new Map<string, Node>();
  for (const statement of program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' && statement.declaration ? statement.declaration : statement;
    if (declaration.type === 'TSInterfaceDeclaration' || declaration.type === 'TSTypeAliasDeclaration') declarations.set(declaration.id.name, declaration);
  }
  const keysOf = (node: Node): string[] => {
    if (node.type === 'TSInterfaceDeclaration') return node.body.body.flatMap(keysOf);
    if (node.type === 'TSTypeAliasDeclaration') return keysOf(node.typeAnnotation);
    if (node.type === 'TSTypeLiteral') return node.members.flatMap(keysOf);
    if (node.type === 'TSIntersectionType' || node.type === 'TSUnionType') return node.types.flatMap(keysOf);
    if (node.type === 'TSParenthesizedType') return keysOf(node.typeAnnotation);
    if (node.type === 'TSTypeReference' && node.typeName.type === 'Identifier') {
      const local = declarations.get(node.typeName.name);
      return local ? keysOf(local) : [];
    }
    if (node.type === 'TSPropertySignature' && node.key.type === 'Identifier') return [node.key.name];
    return [];
  };
  const declaration = declarations.get(name);
  if (!declaration) throw new Error(`runner-fact-combination: ${name} is not declared where the rule reads it`);
  return keysOf(declaration);
}

/** The fact keys of the declared types, without the keys `NOT_FACTS` names. */
export function declaredFactKeys(read: (path: string) => string = path => readFileSync(join(repoRoot, path), 'utf8')): Set<string> {
  const keys = Object.entries(TYPE_FILES).flatMap(([name, path]) =>
    typeKeys(parse(read(path), { sourceType: 'module', plugins: ['typescript'] }).program, name));
  return new Set(keys.filter(key => !Object.hasOwn(NOT_FACTS, key)));
}

let factKeys: Set<string> | undefined;
const FACT_KEYS = () => (factKeys ??= declaredFactKeys());

/** Property names and destructuring keys that make a function touch a fact source. */
const SOURCE_KEYS = new Set(['inputDelivery', 'facts', 'systemPromptOnResume']);
const SOURCE_NAMES = new Set(['RUNNER_FACTS', 'inputDeliveryOf']);
const SOURCE_TYPES = new Set(Object.keys(TYPE_FILES));

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ClassMethod', 'ClassPrivateMethod', 'ObjectMethod']);

/** The static key of a member's property or an object pattern's property: `a.b`, `a['b']`, `{ b }`, `{ 'b': c }`. */
function staticKey(key: Node, computed: boolean): string | undefined {
  if (!computed && key.type === 'Identifier') return key.name;
  if (key.type === 'StringLiteral') return key.value;
  return undefined;
}

/** What one node contributes: whether it touches a fact source, and the fact key it reads. */
function inspect(node: Node, parent: Node | undefined, keys: Set<string>): { source: boolean; key?: string | undefined } {
  if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
    const key = staticKey(node.property, node.computed);
    return { source: key !== undefined && SOURCE_KEYS.has(key), key: key !== undefined && keys.has(key) ? key : undefined };
  }
  if (node.type === 'ObjectProperty' && parent?.type === 'ObjectPattern') {
    const key = staticKey(node.key, node.computed);
    return { source: key !== undefined && SOURCE_KEYS.has(key), key: key !== undefined && keys.has(key) ? key : undefined };
  }
  if (node.type === 'Identifier') return { source: SOURCE_NAMES.has(node.name) };
  if (node.type === 'TSTypeReference') {
    const name = node.typeName.type === 'Identifier' ? node.typeName.name : node.typeName.type === 'TSQualifiedName' ? node.typeName.right.name : undefined;
    return { source: name !== undefined && SOURCE_TYPES.has(name) };
  }
  return { source: false };
}

interface Scope { node: Node; name: string; source: boolean; facts: Set<string>; children: Scope[] }

function functionName(node: Node, parent: Node | undefined): string {
  if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') && node.id) return node.id.name;
  if ((node.type === 'ClassMethod' || node.type === 'ObjectMethod') && node.key.type === 'Identifier') return node.key.name;
  if (node.type === 'ClassPrivateMethod') return `#${node.key.id.name}`;
  if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') return parent.id.name;
  if ((parent?.type === 'ObjectProperty' || parent?.type === 'ClassProperty') && parent.key.type === 'Identifier') return parent.key.name;
  return '(anonymous function)';
}

function walk(node: Node, parent: Node | undefined, scopes: Scope[], roots: Scope[], keys: Set<string>): void {
  let scope: Scope | undefined;
  if (FUNCTION_TYPES.has(node.type)) {
    scope = { node, name: functionName(node, parent), source: false, facts: new Set(), children: [] };
    (scopes.at(-1)?.children ?? roots).push(scope);
    scopes.push(scope);
  }
  const { source, key } = inspect(node, parent, keys);
  for (const open of scopes) {
    if (source) open.source = true;
    if (key) open.facts.add(key);
  }
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child === 'object' && typeof (child as Node).type === 'string') walk(child as Node, node, scopes, roots, keys);
    }
  }
  if (scope) scopes.pop();
}

/** Report the innermost functions that qualify; an outer function only when no inner one was named. */
function combinations(scope: Scope, found: Scope[]): boolean {
  let inner = false;
  for (const child of scope.children) inner = combinations(child, found) || inner;
  if (inner || !scope.source || scope.facts.size < 2) return inner;
  found.push(scope);
  return true;
}

export interface FactCombination { name: string; line: number; facts: string[] }

export function factCombinations(source: string, keys: Set<string> = FACT_KEYS()): FactCombination[] {
  // A cheap pre-filter: every fact source spells one of these words.
  if (!/RUNNER_FACTS|\bfacts\b|inputDelivery|systemPromptOnResume|RunnerFacts/i.test(source)) return [];
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] });
  const roots: Scope[] = [];
  walk(ast.program, undefined, [], roots, keys);
  const found: Scope[] = [];
  for (const root of roots) combinations(root, found);
  return found
    .map(scope => ({ name: scope.name, line: lineAt(source, scope.node.start ?? 0), facts: [...scope.facts].sort() }))
    .sort((a, b) => a.line - b.line);
}

/**
 * A reported function the rule lets pass, as `<file>#<function>`. `reason` says why. A real
 * combination also names `row`, `<family> <row>`: a registered parity row that runs the combination
 * on every runner (`core/parity-classes.test.ts` checks it). A false positive, an unrelated object
 * with a same-named key, has no row.
 */
export interface CombinationException { readonly reason: string; readonly row?: string }

export const COMBINATION_ROWS: Readonly<Record<string, CombinationException>> = {};

const isTest = (file: string) => /\.(?:test|e2e)\.tsx?$|\.testkit\.tsx?$/.test(file);

/** The rule's findings in one file, after the exceptions. */
export function combinationFindings(file: string, source: string, exceptions: Readonly<Record<string, CombinationException>> = COMBINATION_ROWS) {
  return factCombinations(source).filter(({ name }) => exceptions[`${file}#${name}`] === undefined).map(({ name, line, facts }) => ({
    line,
    message: `${name} touches a runner fact source and reads ${facts.join(' and ')}. Shared parity rows run on a derived runner set that shows each fact value once, not each combination: `
      + 'split the function so each part reads one fact, or add it to COMBINATION_ROWS with a reason and, for a real combination, a parity row that runs on every runner (hearsay-tools/cezarion#2991).',
  }));
}

export const runnerFactCombination: SourceRule = {
  name: 'runner-fact-combination',
  description: 'A function above the runner seam that touches a fact source reads at most one declared runner fact key (hearsay-tools/cezarion#2991).',
  applies: file => /^packages\/cezar\/src\/workflows\/.+\.ts$/.test(file) && !isTest(file),
  check: (file, source) => combinationFindings(file, source),
};
