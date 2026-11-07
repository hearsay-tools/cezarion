import type { Identifier, Node } from '@babel/types';
import { property, unwrapped, visit } from './home-boundary.ts';

export type Projection = { kind: 'member'; key: string }
  | { kind: 'object-rest'; keys: string[] } | { kind: 'array-rest'; start: number }
  | { kind: 'default'; node: Node };
export type BindingSource = { kind: 'expression'; node: Node | undefined; steps: Projection[] }
  | { kind: 'import'; module: string; name: string };
export interface Binding { sources: BindingSource[] }
interface Scope { parent: Scope | undefined; function: boolean; bindings: Map<string, Binding> }
export interface Bindings {
  nodes: Node[];
  scopes: Map<Node, Scope>;
  declarations: Map<Node, Binding>;
}

function children(node: Node): Node[] {
  return Object.values(node).flatMap(value => {
    return (Array.isArray(value) ? value : [value]).filter((child): child is Node => {
      return child && typeof child === 'object' && typeof child.type === 'string';
    });
  });
}

function functionNode(node: Node): boolean {
  return ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod'].includes(node.type);
}

function declare(pattern: Node, scope: Scope, declarations: Map<Node, Binding>): void {
  if (pattern.type === 'Identifier') {
    const binding = scope.bindings.get(pattern.name) ?? { sources: [] };
    scope.bindings.set(pattern.name, binding);
    declarations.set(pattern, binding);
    return;
  }
  if (pattern.type === 'AssignmentPattern') declare(pattern.left, scope, declarations);
  if (pattern.type === 'RestElement') declare(pattern.argument, scope, declarations);
  if (pattern.type === 'ArrayPattern') for (const element of pattern.elements) if (element) declare(element, scope, declarations);
  if (pattern.type === 'ObjectPattern') for (const field of pattern.properties) declare(field.type === 'RestElement' ? field.argument : field.value, scope, declarations);
}

function declarationScope(scope: Scope, parent: Node | undefined): Scope {
  if (parent?.type !== 'VariableDeclaration' || parent.kind !== 'var') return scope;
  while (!scope.function && scope.parent) scope = scope.parent;
  return scope;
}

function scopeTree(node: Node, parent: Node | undefined, inherited: Scope, result: Bindings): void {
  let scope = inherited;
  if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id) declare(node.id, scope, result.declarations);
  if (functionNode(node)) {
    scope = { parent: scope, function: true, bindings: new Map() };
    const fn = node as Node & { params: Node[]; id?: Identifier | null };
    if (node.type === 'FunctionExpression' && fn.id) declare(fn.id, scope, result.declarations);
    for (const param of fn.params) declare(param, scope, result.declarations);
  } else if (['BlockStatement', 'StaticBlock', 'CatchClause', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'SwitchStatement'].includes(node.type)) {
    scope = { parent: scope, function: false, bindings: new Map() };
  }
  result.scopes.set(node, scope);
  result.nodes.push(node);
  if (node.type === 'VariableDeclarator') declare(node.id, declarationScope(scope, parent), result.declarations);
  if (node.type === 'CatchClause' && node.param) declare(node.param, scope, result.declarations);
  if (node.type.startsWith('Import') && 'local' in node) declare(node.local as Node, scope, result.declarations);
  for (const child of children(node)) scopeTree(child, node, scope, result);
}

export function bindingFor(node: Identifier, bindings: Bindings): Binding | undefined {
  const declared = bindings.declarations.get(node);
  if (declared) return declared;
  let scope = bindings.scopes.get(node);
  while (scope) {
    const found = scope.bindings.get(node.name);
    if (found) return found;
    scope = scope.parent;
  }
  return undefined;
}

function append(source: Extract<BindingSource, { kind: 'expression' }>, step: Projection): BindingSource & { kind: 'expression' } {
  return { ...source, steps: [...source.steps, step] };
}

/** Destructuring projects the source lazily, so forward aliases and reassignments still resolve. */
function assign(pattern: Node, source: Extract<BindingSource, { kind: 'expression' }>, bindings: Bindings): void {
  const target = unwrapped(pattern);
  if (target !== pattern) { assign(target, source, bindings); return; }
  if (pattern.type === 'Identifier') { bindingFor(pattern, bindings)?.sources.push(source); return; }
  if (pattern.type === 'AssignmentPattern') { assign(pattern.left, append(source, { kind: 'default', node: pattern.right }), bindings); return; }
  if (pattern.type === 'RestElement') { assign(pattern.argument, source, bindings); return; }
  if (pattern.type === 'ArrayPattern') {
    pattern.elements.forEach((element, index) => {
      if (element) assign(element, append(source, element.type === 'RestElement'
        ? { kind: 'array-rest', start: index } : { kind: 'member', key: String(index) }), bindings);
    });
  }
  if (pattern.type === 'ObjectPattern') assignObject(pattern, source, bindings);
}

function assignObject(pattern: Extract<Node, { type: 'ObjectPattern' }>, source: Extract<BindingSource, { kind: 'expression' }>, bindings: Bindings): void {
  const keys = pattern.properties.flatMap(field => field.type === 'ObjectProperty' && property(field.key) !== undefined ? [property(field.key)!] : []);
  for (const field of pattern.properties) {
    if (field.type === 'RestElement') assign(field.argument, append(source, { kind: 'object-rest', keys }), bindings);
    else {
      const key = field.computed && field.key.type === 'Identifier' ? undefined : property(field.key);
      if (key !== undefined) assign(field.value, append(source, { kind: 'member', key }), bindings);
    }
  }
}

function importSources(node: Extract<Node, { type: 'ImportDeclaration' }>, bindings: Bindings): void {
  for (const specifier of node.specifiers) {
    const name = specifier.type === 'ImportSpecifier' ? property(specifier.imported)! : 'default';
    bindingFor(specifier.local, bindings)?.sources.push({ kind: 'import', module: node.source.value, name });
  }
}

export function collectBindings(ast: Node): Bindings {
  const result: Bindings = { nodes: [], scopes: new Map(), declarations: new Map() };
  scopeTree(ast, undefined, { parent: undefined, function: true, bindings: new Map() }, result);
  visit(ast, node => {
    if (node.type === 'VariableDeclarator') assign(node.id, { kind: 'expression', node: node.init ?? undefined, steps: [] }, result);
    if (node.type === 'AssignmentExpression') assign(node.left, { kind: 'expression', node: node.right, steps: [] }, result);
    if (node.type === 'ImportDeclaration') importSources(node, result);
    if (functionNode(node)) {
      for (const param of (node as Node & { params: Node[] }).params) assign(param, { kind: 'expression', node: undefined, steps: [] }, result);
    }
  });
  return result;
}
