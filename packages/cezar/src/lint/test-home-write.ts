import { parse } from '@babel/parser';
import type { Node } from '@babel/types';
import { homeSites, property, unwrapped, visit } from './home-boundary.ts';
import { lineAt, type SourceRule } from './source-rule.ts';

const WRITES = /^(?:writeFile|appendFile|mkdir|rm|rmdir|unlink|rename|copyFile|cp|symlink|link|truncate|chmod|chown|utimes)(?:Sync)?$|^createWriteStream$/;
const TWO_PATHS = /^(?:rename|copyFile|cp|symlink|link)(?:Sync)?$/;

function children(node: Node): Node[] {
  return Object.values(node).flatMap(value => {
    return (Array.isArray(value) ? value : [value]).filter((child): child is Node => {
      return child && typeof child === 'object' && typeof child.type === 'string';
    });
  });
}

function ref(node: Node): string | undefined {
  const target = unwrapped(node);
  if (target.type === 'SequenceExpression') return target.expressions.at(-1) && ref(target.expressions.at(-1)!);
  return property(target);
}

function isFunction(node: Node): boolean {
  return ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod'].includes(node.type);
}

/** Expressions propagate paths; a function body produces a path only when called. */
function hasHome(node: Node, values: Set<string>, factories: Set<string>, reads: Set<number>): boolean {
  const target = unwrapped(node);
  if (isFunction(target)) return false;
  if (target.type === 'Identifier') return values.has(target.name);
  if ((target.type === 'MemberExpression' || target.type === 'OptionalMemberExpression') && !target.computed) return hasHome(target.object, values, factories, reads);
  if (target.type === 'ObjectProperty' && !target.computed) return hasHome(target.value, values, factories, reads);
  if (target.type === 'CallExpression' || target.type === 'OptionalCallExpression') {
    if (reads.has(target.start ?? -1) || factories.has(ref(target.callee) ?? '')) return true;
    return target.arguments.some(arg => hasHome(arg, values, factories, reads));
  }
  return children(target).some(child => hasHome(child, values, factories, reads));
}

function returnsHome(node: Node, values: Set<string>, factories: Set<string>, reads: Set<number>): boolean {
  if (node.type === 'ArrowFunctionExpression' && node.body.type !== 'BlockStatement') return hasHome(node.body, values, factories, reads);
  return children(node).some(child => {
    if (isFunction(child)) return false;
    if (child.type === 'ReturnStatement') return !!child.argument && hasHome(child.argument, values, factories, reads);
    return returnsHome(child, values, factories, reads);
  });
}

function aliases(node: Node): Array<[string, Node]> {
  if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier') return [[node.left.name, node.right]];
  if (node.type === 'VariableDeclarator' && node.init && node.id.type === 'Identifier') return [[node.id.name, node.init]];
  return [];
}

function importedAliases(nodes: Node[], names: Map<string, string>): void {
  for (const node of nodes) {
    if (node.type === 'ImportSpecifier' && names.has(property(node.imported) ?? '')) names.set(node.local.name, names.get(property(node.imported)!)!);
    if (node.type !== 'VariableDeclarator' || node.id.type !== 'ObjectPattern') continue;
    for (const field of node.id.properties) {
      if (field.type === 'ObjectProperty' && names.has(property(field.key) ?? '') && field.value.type === 'Identifier') names.set(field.value.name, names.get(property(field.key)!)!);
    }
  }
}

function localFunctions(nodes: Node[]): Map<string, Node[]> {
  const functions = new Map<string, Node[]>();
  for (const node of nodes) {
    if (node.type === 'FunctionDeclaration' && node.id) functions.set(node.id.name, node.params);
    for (const [id, init] of aliases(node)) {
      if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') functions.set(id, init.params);
    }
  }
  return functions;
}

function propagateArguments(node: Node, functions: Map<string, Node[]>, values: Set<string>, factories: Set<string>, reads: Set<number>): void {
  if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return;
  const params = functions.get(ref(node.callee) ?? '');
  if (!params) return;
  node.arguments.forEach((arg, index) => {
    const param = params[index];
    if (param?.type === 'Identifier' && hasHome(arg, values, factories, reads)) values.add(param.name);
  });
}

function propagate(nodes: Node[], reads: Set<number>, factories: Set<string>, writers: Map<string, string>): Set<string> {
  const values = new Set<string>();
  const functions = localFunctions(nodes);
  let size = -1;
  while (size !== values.size + factories.size + writers.size) {
    size = values.size + factories.size + writers.size;
    for (const node of nodes) {
      propagateArguments(node, functions, values, factories, reads);
      for (const [id, init] of aliases(node)) {
        if (hasHome(init, values, factories, reads)) values.add(id);
        if (factories.has(ref(init) ?? '') || (isFunction(init) && returnsHome(init, values, factories, reads))) factories.add(id);
        const writer = writers.get(ref(init) ?? '');
        if (writer) writers.set(id, writer);
      }
      if (node.type === 'FunctionDeclaration' && node.id && returnsHome(node, values, factories, reads)) factories.add(node.id.name);
    }
  }
  return values;
}

/** No baseline: a test may write to an explicit sandbox, never a derived ambient home. */
export function unsafeHomeWrites(source: string, file = 'file.test.ts'): number[] {
  const ast = parse(source, { sourceType: 'unambiguous', plugins: ['typescript', ...(file.endsWith('.tsx') ? ['jsx' as const] : [])] });
  const nodes: Node[] = [];
  visit(ast, node => nodes.push(node));
  const reads = new Set(homeSites(source, file).filter(site => site.kind === 'homedir').map(site => site.offset));
  const homes = new Map([['cezarHomeDir', 'cezarHomeDir']]);
  const writers = new Map(nodes.flatMap(node => {
    const candidate = ref(node);
    return candidate && WRITES.test(candidate) ? [[candidate, candidate] as const] : [];
  }));
  importedAliases(nodes, homes);
  importedAliases(nodes, writers);
  const factories = new Set(homes.keys());
  const values = propagate(nodes, reads, factories, writers);
  return nodes.flatMap(node => {
    if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return [];
    const method = writers.get(ref(node.callee) ?? '');
    if (!method) return [];
    const paths = node.arguments.slice(0, TWO_PATHS.test(method) ? 2 : 1);
    return paths.some(path => hasHome(path, values, factories, reads)) ? [node.start ?? 0] : [];
  });
}

export const testHomeWrite: SourceRule = {
  name: 'test-home-write',
  description: 'Test writes use sandbox paths (hearsay-tools/cezarion#2813).',
  applies: file => /\.(?:test\.tsx?|testkit\.ts|test\.[mc]js)$/.test(file),
  check: (file, source) => unsafeHomeWrites(source, file).map(offset => ({
    line: lineAt(source, offset),
    message: 'Ambient home reaches a filesystem write; use a path from Home.sandbox (hearsay-tools/cezarion#2813).',
  })),
};
