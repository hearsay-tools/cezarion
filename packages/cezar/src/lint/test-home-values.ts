import type { Node } from '@babel/types';
import { property, unwrapped } from './home-boundary.ts';
import { bindingFor, type Binding, type Bindings, type BindingSource, type Projection } from './test-home-bindings.ts';

type Namespace = 'fs' | 'fs/promises' | 'os' | 'path';
type Atom = { kind: 'home' | 'defined' | 'undefined' | 'unknown' } | { kind: 'function'; name: string }
  | { kind: 'namespace'; name: Namespace; omitted: Set<string> }
  | { kind: 'object'; fields: Map<string, Value> };
export type Value = Atom[];
interface Context { bindings: Bindings; seen: Set<Binding> }
const WRITES = /^(?:writeFile|appendFile|mkdir|rm|rmdir|unlink|rename|copyFile|cp|symlink|link|truncate|chmod|chown|utimes)(?:Sync)?$|^createWriteStream$/;
const PATH_HELPERS = new Set(['join', 'resolve', 'normalize', 'dirname', 'basename', 'relative']);
const fn = (name: string): Value => [{ kind: 'function', name }];
const namespace = (name: Namespace): Value => [{ kind: 'namespace', name, omitted: new Set() }];
const object = (fields: Map<string, Value>): Value => [{ kind: 'object', fields }];

function namespaceMember(atom: Extract<Atom, { kind: 'namespace' }>, key: string): Value {
  if (atom.omitted.has(key)) return [];
  if (atom.name === 'fs' && key === 'promises') return namespace('fs/promises');
  if ((atom.name === 'fs' || atom.name === 'fs/promises') && WRITES.test(key)) return fn(`write:${key}`);
  if (atom.name === 'os' && key === 'homedir') return fn('home');
  if (atom.name === 'path' && PATH_HELPERS.has(key)) return fn('path');
  if (atom.name === 'path' && (key === 'posix' || key === 'win32')) return namespace('path');
  return [];
}

function member(value: Value, key: string): Value {
  return value.flatMap(atom => {
    if (atom.kind === 'object') return atom.fields.get(key) ?? [{ kind: 'undefined' }];
    if (atom.kind === 'unknown' || atom.kind === 'undefined') return [atom];
    return atom.kind === 'namespace' ? namespaceMember(atom, key) : [];
  });
}

function moduleValue(module: string): Value {
  const name = module.replace(/^node:/, '');
  return ['fs', 'fs/promises', 'os', 'path'].includes(name) ? namespace(name as Namespace) : [];
}

function imported(source: Extract<BindingSource, { kind: 'import' }>): Value {
  if (source.name === 'cezarHomeDir') return fn('home');
  const value = moduleValue(source.module);
  return source.name === 'default' ? value : member(value, source.name);
}

function implicit(name: string): Value {
  if (name === 'undefined') return [{ kind: 'undefined' }];
  if (name === 'homedir' || name === 'cezarHomeDir') return fn('home');
  if (name === 'fs' || name === 'os' || name === 'path') return namespace(name);
  if (PATH_HELPERS.has(name)) return fn('path');
  return WRITES.test(name) ? fn(`write:${name}`) : [];
}

function without(value: Value, keys: string[]): Value {
  return value.flatMap((atom): Value => {
    if (atom.kind === 'namespace') return [{ ...atom, omitted: new Set([...atom.omitted, ...keys]) }];
    if (atom.kind === 'object') return object(new Map([...atom.fields].filter(([key]) => !keys.includes(key))));
    return [];
  });
}

function arrayRest(value: Value, start: number): Value {
  const fields = new Map<string, Value>();
  for (const atom of value) {
    if (atom.kind !== 'object') continue;
    for (const [key, field] of atom.fields) {
      if (/^\d+$/.test(key) && Number(key) >= start) {
        const index = String(Number(key) - start);
        fields.set(index, [...(fields.get(index) ?? []), ...field]);
      }
    }
  }
  return object(fields);
}

function project(value: Value, step: Projection, context: Context): Value {
  if (step.kind === 'member') return member(value, step.key);
  if (step.kind === 'object-rest') return without(value, step.keys);
  if (step.kind === 'array-rest') return arrayRest(value, step.start);
  const missing = value.length === 0 || value.some(atom => atom.kind === 'undefined' || atom.kind === 'unknown');
  return missing ? [...value.filter(atom => atom.kind !== 'undefined'), ...evaluate(step.node, context)] : value;
}

function sourceValue(source: BindingSource, context: Context): Value {
  if (source.kind === 'import') return imported(source);
  return source.steps.reduce((value, step) => project(value, step, context), evaluate(source.node, context));
}

function identifier(node: Extract<Node, { type: 'Identifier' }>, context: Context): Value {
  const binding = bindingFor(node, context.bindings);
  if (!binding) return implicit(node.name);
  if (context.seen.has(binding)) return [];
  const next = { ...context, seen: new Set([...context.seen, binding]) };
  return binding.sources.flatMap(source => sourceValue(source, next));
}

function spreadObject(left: Value, right: Value): Value {
  const keys = right.flatMap(atom => atom.kind === 'object' ? [...atom.fields.keys()] : []);
  const remaining = without(left, keys);
  const fields = new Map<string, Value>();
  for (const atom of remaining) {
    if (atom.kind === 'object') for (const key of atom.fields.keys()) fields.set(key, member(remaining, key));
  }
  for (const key of keys) fields.set(key, member(right, key));
  const others = [...remaining, ...right].filter(atom => atom.kind !== 'object');
  return fields.size || others.length === 0 ? [...object(fields), ...others] : others;
}

function objectExpression(node: Extract<Node, { type: 'ObjectExpression' }>, context: Context): Value {
  let value: Value = object(new Map());
  for (const field of node.properties) {
    if (field.type === 'SpreadElement') value = spreadObject(value, evaluate(field.argument, context));
    if (field.type !== 'ObjectProperty') continue;
    const key = field.computed && field.key.type === 'Identifier' ? undefined : property(field.key);
    if (key !== undefined) value = spreadObject(value, object(new Map([[key, evaluate(field.value, context)]])));
  }
  return value;
}

function arrayExpression(node: Extract<Node, { type: 'ArrayExpression' }>, context: Context): Value {
  const fields = new Map<string, Value>();
  let index = 0;
  for (const element of node.elements) {
    if (element?.type === 'SpreadElement') {
      const spread = evaluate(element.argument, context);
      for (const atom of spread) {
        if (atom.kind === 'object') for (const value of atom.fields.values()) fields.set(String(index++), value);
      }
    } else fields.set(String(index++), evaluate(element ?? undefined, context));
  }
  return object(fields);
}

export function hasHome(value: Value): boolean { return value.some(atom => atom.kind === 'home'); }

function spreadHasHome(value: Value): boolean {
  return hasHome(value) || value.some(atom => atom.kind === 'object' && [...atom.fields.values()].some(spreadHasHome));
}

function callExpression(node: Extract<Node, { type: 'CallExpression' | 'OptionalCallExpression' }>, context: Context): Value {
  if (node.callee.type === 'Identifier' && node.callee.name === 'require' && !bindingFor(node.callee, context.bindings)) {
    const module = node.arguments[0];
    return module?.type === 'StringLiteral' ? moduleValue(module.value) : [];
  }
  const callee = evaluate(node.callee, context);
  if (callee.some(atom => atom.kind === 'function' && atom.name === 'home')) return [{ kind: 'home' }];
  if (!callee.some(atom => atom.kind === 'function' && atom.name === 'path')) return [];
  return node.arguments.some(arg => spreadHasHome(evaluate(arg, context))) ? [{ kind: 'home' }] : [];
}

function combinedExpression(node: Node, context: Context): Value {
  if (node.type === 'BinaryExpression' && node.operator === '+') return hasHome([...evaluate(node.left, context), ...evaluate(node.right, context)]) ? [{ kind: 'home' }] : [];
  if (node.type === 'TemplateLiteral') return node.expressions.some(part => hasHome(evaluate(part, context))) ? [{ kind: 'home' }] : [];
  if (node.type === 'ConditionalExpression') return [...branchValue(node.consequent, context), ...branchValue(node.alternate, context)];
  if (node.type === 'LogicalExpression') return [...branchValue(node.left, context), ...branchValue(node.right, context)];
  return [];
}

function branchValue(node: Node, context: Context): Value {
  const value = evaluate(node, context);
  return value.length ? value : [{ kind: 'unknown' }];
}

/** Flow-insensitive within one binding; lexical scopes never share a binding by name. */
function evaluate(node: Node | undefined, context: Context): Value {
  if (!node) return [];
  const target = unwrapped(node);
  if (target.type === 'Identifier') return identifier(target, context);
  if (target.type === 'MemberExpression' || target.type === 'OptionalMemberExpression') {
    const key = target.computed && target.property.type === 'NumericLiteral' ? String(target.property.value) : property(target);
    const owner = evaluate(target.object, context);
    if (key === 'cezarHomeDir' && owner.length === 0) return fn('home');
    return key === undefined ? [] : member(owner, key);
  }
  if (target.type === 'ObjectExpression') return objectExpression(target, context);
  if (target.type === 'ArrayExpression') return arrayExpression(target, context);
  if (target.type === 'CallExpression' || target.type === 'OptionalCallExpression') return callExpression(target, context);
  return evaluateOther(target, context);
}

function evaluateOther(node: Node, context: Context): Value {
  if (['StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral', 'BigIntLiteral'].includes(node.type)) return [{ kind: 'defined' }];
  if (node.type === 'UnaryExpression' && node.operator === 'void') return [{ kind: 'undefined' }];
  if (node.type === 'AwaitExpression' || node.type === 'SpreadElement') return evaluate(node.argument, context);
  if (node.type === 'SequenceExpression') return evaluate(node.expressions.at(-1), context);
  if (node.type === 'AssignmentExpression') return evaluate(node.right, context);
  if (node.type === 'ImportExpression' && node.source.type === 'StringLiteral') return moduleValue(node.source.value);
  return combinedExpression(node, context);
}

export function valueOf(node: Node, bindings: Bindings): Value { return evaluate(node, { bindings, seen: new Set() }); }
export function writeFunctions(value: Value): string[] {
  return value.flatMap(atom => atom.kind === 'function' && atom.name.startsWith('write:') ? [atom.name.slice(6)] : []);
}
