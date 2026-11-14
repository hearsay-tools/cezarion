import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import type { Node } from '@babel/types';
import { lineAt, repoRoot, type SourceRule } from './source-rule.ts';

/**
 * Shared parity rows run on one runner, and unit tests drive every other value of each turn-path
 * fact once, not every combination of values (hearsay-tools/cezarion#2991, docs/adr/0063-one-scenario-runner.md). That holds only while
 * no function above the seam combines two declared runner facts: such a function needs a
 * combination row on every runner.
 *
 * The rule over-approximates, so it fails closed. It tracks no value. It flags a function in a
 * non-test `workflows/` source when both hold, counting the function's nested callbacks as part
 * of it:
 *
 * (a) it touches a fact source: a `.inputDelivery`, `.facts` or `.systemPromptOnResume` property,
 *     the `RUNNER_FACTS` or `inputDeliveryOf` value, a destructuring key `inputDelivery`, `facts`
 *     or `systemPromptOnResume`, or the type `InputDelivery` or `RunnerFacts`. A name imported
 *     under another name, a namespace import's member and a local type alias of a source type
 *     count as the source. A source touched at module level, outside every function, counts as
 *     touched by every function in the file;
 * (b) it reads two or more different fact keys, by property name, static computed key (`d['mode']`,
 *     `` d[`mode`] ``) or destructuring key, from any object. The keys come from the declared types
 *     (`RunnerFacts` in `core/runner-facts.ts`, `InputDelivery` in `core/agent-runner.ts`), so a new
 *     fact joins the rule by itself.
 *
 * Aliases, block scopes, `??`, ternaries, reassignment, rest elements and parameter defaults are
 * all covered because no value is followed. Every qualifying function is reported, an outer
 * function with the reads of its nested callbacks, under a name qualified by its enclosing classes
 * and functions (`Runner>settle>inner`; repeats are numbered). A reported function is either a real
 * combination, which needs a parity row on every runner, or a false positive: an unrelated object
 * with a same-named key. Both go in `COMBINATION_ROWS` with a reason; a real combination also names
 * its row. An exception clears only the function it names.
 *
 * Limits: the rule does not see
 * - a fact read inside a helper function that the reported function calls, or a fact returned by
 *   one (each helper is checked on its own);
 * - a fact key read through a dynamic computed key (`d[key]`);
 * - a fact source carried in another object's property and read in a function that touches no
 *   source itself (`state.policy.mode` where `state.policy` was set elsewhere);
 * - a fact source imported from a module that re-exports it under another name, or passed in from
 *   another module.
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
/** The canonical value and type names of the fact sources, as their modules export them. */
const SOURCE_NAMES = new Set(['RUNNER_FACTS', 'inputDeliveryOf']);
const SOURCE_TYPES = new Set(Object.keys(TYPE_FILES));

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ClassMethod', 'ClassPrivateMethod', 'ObjectMethod']);
const CLASS_TYPES = new Set(['ClassDeclaration', 'ClassExpression']);

/**
 * The static key of a member's property or a pattern's property: `a.b`, `a['b']`, `` a[`b`] ``,
 * `{ b }`, `{ 'b': c }`. A dynamic computed key is undefined.
 */
function staticKey(key: Node, computed: boolean): string | undefined {
  if (!computed && key.type === 'Identifier') return key.name;
  if (key.type === 'StringLiteral') return key.value;
  if (key.type === 'TemplateLiteral' && key.expressions.length === 0) return key.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}

/** The local names the file binds to a fact source: its imports (renamed or not, namespaces too)
 *  and its type aliases of a source type, so a renamed source is still a source. */
interface Names { values: Set<string>; types: Set<string>; namespaces: Set<string> }

function sourceNames(program: Extract<Node, { type: 'Program' }>): Names {
  const names: Names = { values: new Set(SOURCE_NAMES), types: new Set(SOURCE_TYPES), namespaces: new Set() };
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier') names.namespaces.add(specifier.local.name);
      if (specifier.type !== 'ImportSpecifier') continue;
      const imported = specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value;
      if (SOURCE_NAMES.has(imported)) names.values.add(specifier.local.name);
      if (SOURCE_TYPES.has(imported)) names.types.add(specifier.local.name);
    }
  }
  // A local `type X = InputDelivery` (or one built on another alias) names a source type too.
  for (let grew = true; grew;) {
    grew = false;
    for (const statement of program.body) {
      const declaration = statement.type === 'ExportNamedDeclaration' && statement.declaration ? statement.declaration : statement;
      if (declaration.type !== 'TSTypeAliasDeclaration' || names.types.has(declaration.id.name)) continue;
      if (typeNames(declaration.typeAnnotation).some(name => names.types.has(name))) { names.types.add(declaration.id.name); grew = true; }
    }
  }
  return names;
}

/** Every type name a type annotation references. */
function typeNames(node: Node): string[] {
  const found: string[] = [];
  const visit = (current: Node) => {
    if (current.type === 'TSTypeReference') found.push(typeRefName(current) ?? '');
    for (const value of Object.values(current)) for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child === 'object' && typeof (child as Node).type === 'string') visit(child as Node);
    }
  };
  visit(node);
  return found;
}

/** The name a type reference uses: `T` or the right side of `ns.T`. */
function typeRefName(node: Extract<Node, { type: 'TSTypeReference' }>): string | undefined {
  if (node.typeName.type === 'Identifier') return node.typeName.name;
  return node.typeName.type === 'TSQualifiedName' ? node.typeName.right.name : undefined;
}

type Contribution = { source: boolean; key?: string | undefined };

/** A property read or destructuring key: a source when it names one, a fact when it names one. */
function keyContribution(key: string | undefined, keys: Set<string>, namespaced = false): Contribution {
  return { source: namespaced || (key !== undefined && SOURCE_KEYS.has(key)), key: key !== undefined && keys.has(key) ? key : undefined };
}

/** What one node contributes: whether it touches a fact source, and the fact key it reads. */
function inspect(node: Node, parent: Node | undefined, keys: Set<string>, names: Names): Contribution {
  if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
    const key = staticKey(node.property, node.computed);
    const namespaced = node.object.type === 'Identifier' && names.namespaces.has(node.object.name) && key !== undefined && SOURCE_NAMES.has(key);
    return keyContribution(key, keys, namespaced);
  }
  if (node.type === 'ObjectProperty' && parent?.type === 'ObjectPattern') return keyContribution(staticKey(node.key, node.computed), keys);
  if (node.type === 'Identifier') return { source: names.values.has(node.name) };
  if (node.type === 'TSTypeReference') {
    const name = typeRefName(node);
    return { source: name !== undefined && names.types.has(name) };
  }
  return { source: false };
}

interface Scope { node: Node; name: string; source: boolean; facts: Set<string>; children: Scope[] }

/** A function's own name: its id, its method key, or the binding or property that holds it. */
function ownName(node: Node, parent: Node | undefined): string | undefined {
  if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') && node.id) return node.id.name;
  if ((node.type === 'ClassMethod' || node.type === 'ObjectMethod') && node.key.type === 'Identifier') return node.key.name;
  if (node.type === 'ClassPrivateMethod') return `#${node.key.id.name}`;
  if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') return parent.id.name;
  if ((parent?.type === 'ObjectProperty' || parent?.type === 'ClassProperty') && parent.key.type === 'Identifier') return parent.key.name;
  return undefined;
}

/** Walk state: the open function scopes, the qualified-name path, and the module-level touch. */
interface Walk { scopes: Scope[]; roots: Scope[]; path: string[]; seen: Map<string, number>; moduleSource: boolean; keys: Set<string>; names: Names }

/**
 * A function's name qualified by its enclosing classes and functions (`Runner>settle>inner`), so
 * an exception names one function. An unnamed function or a repeated name is numbered in order.
 */
function qualifiedName(state: Walk, own: string | undefined): string {
  const base = [...state.path, own ?? '(anonymous function)'].join('>');
  const count = (state.seen.get(base) ?? 0) + 1;
  state.seen.set(base, count);
  return count === 1 ? base : `${base}#${count}`;
}

/** The AST nodes directly under a node, in source order. */
function childNodes(node: Node): Node[] {
  const out: Node[] = [];
  for (const value of Object.values(node)) for (const child of Array.isArray(value) ? value : [value]) {
    if (child && typeof child === 'object' && typeof (child as Node).type === 'string') out.push(child as Node);
  }
  return out;
}

/** Open a function scope or a class name segment for a node; neither for any other node. */
function enter(node: Node, parent: Node | undefined, state: Walk): { scope?: Scope | undefined; segment?: string | undefined } {
  if (FUNCTION_TYPES.has(node.type)) {
    const scope: Scope = { node, name: qualifiedName(state, ownName(node, parent)), source: false, facts: new Set(), children: [] };
    (state.scopes.at(-1)?.children ?? state.roots).push(scope);
    state.scopes.push(scope);
    return { scope, segment: scope.name.split('>').at(-1) };
  }
  if (!CLASS_TYPES.has(node.type)) return {};
  const id = (node as Extract<Node, { type: 'ClassDeclaration' }>).id;
  const held = parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier' ? parent.id.name : '(anonymous class)';
  return { segment: id?.name ?? held };
}

/** Credit what one node contributes to every open function scope, or to the module level. */
function record(node: Node, parent: Node | undefined, state: Walk): void {
  const { source, key } = inspect(node, parent, state.keys, state.names);
  if (source && !state.scopes.length) state.moduleSource = true;
  for (const open of state.scopes) {
    if (source) open.source = true;
    if (key) open.facts.add(key);
  }
}

function walk(node: Node, parent: Node | undefined, state: Walk): void {
  // An import binds names only; sourceNames resolves them, so the walk skips its subtree.
  if (node.type === 'ImportDeclaration') return;
  const { scope, segment } = enter(node, parent, state);
  record(node, parent, state);
  if (segment !== undefined) state.path.push(segment);
  for (const child of childNodes(node)) walk(child, node, state);
  if (segment !== undefined) state.path.pop();
  if (scope) state.scopes.pop();
}

/** Every function that qualifies, outer functions included: their nested reads count for them. */
function qualifying(scope: Scope, moduleSource: boolean, found: Scope[]): void {
  if ((scope.source || moduleSource) && scope.facts.size >= 2) found.push(scope);
  for (const child of scope.children) qualifying(child, moduleSource, found);
}

export interface FactCombination { name: string; line: number; facts: string[] }

export function factCombinations(source: string, keys: Set<string> = FACT_KEYS()): FactCombination[] {
  // A cheap pre-filter: a fact source is spelled by one of these words, or reached through a module import.
  if (!/RUNNER_FACTS|\bfacts\b|inputDelivery|systemPromptOnResume|RunnerFacts|\bimport\b/i.test(source)) return [];
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] });
  const state: Walk = { scopes: [], roots: [], path: [], seen: new Map(), moduleSource: false, keys, names: sourceNames(ast.program) };
  walk(ast.program, undefined, state);
  const found: Scope[] = [];
  for (const root of state.roots) qualifying(root, state.moduleSource, found);
  return found
    .map(scope => ({ name: scope.name, line: lineAt(source, scope.node.start ?? 0), facts: [...scope.facts].sort() }))
    .sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
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
    message: `${name} touches a runner fact source and reads ${facts.join(' and ')}. Shared parity rows run on one runner and unit tests drive each other fact value once, not each combination: `
      + 'split the function so each part reads one fact, or add it to COMBINATION_ROWS with a reason and, for a real combination, a parity row that runs on every runner (hearsay-tools/cezarion#2991).',
  }));
}

export const runnerFactCombination: SourceRule = {
  name: 'runner-fact-combination',
  description: 'A function above the runner seam that touches a fact source reads at most one declared runner fact key (hearsay-tools/cezarion#2991).',
  applies: file => /^packages\/cezar\/src\/workflows\/.+\.ts$/.test(file) && !isTest(file),
  check: (file, source) => combinationFindings(file, source),
};
