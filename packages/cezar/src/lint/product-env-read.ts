import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import type { Node } from '@babel/types';
import { property, unwrapped, visit } from './home-boundary.ts';
import { lineAt, repoRoot, type SourceRule } from './source-rule.ts';
import { productEnvCalls, scannedEnvFile } from './undocumented-env-name.ts';

export const productEnvBaselineFile = 'packages/cezar/src/lint/product-env-read.baseline.json';
const ACCESSOR = 'packages/cezar/src/core/product-env.ts';
export interface EnvRead { form: 'dot' | 'bracket' | 'computed' | 'destructure' | 'helper-dynamic'; name: string; offset: number }
export interface EnvReadAllowance { file: string; form: EnvRead['form']; name: string; reads: number }

export const productEnvFile = (file: string): boolean => file !== ACCESSOR && scannedEnvFile(file);
export function readProductEnvBaseline(path = join(repoRoot, productEnvBaselineFile)): EnvReadAllowance[] {
  return (JSON.parse(readFileSync(path, 'utf8')) as { entries: EnvReadAllowance[] }).entries;
}

const productName = (name: string | undefined): boolean => /^(CEZ|HSQ)_[A-Z0-9_]+$/.test(name ?? '');
const member = (node: Node): boolean => node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression';

type EnvReference = 'global' | 'process' | 'env';
type EnvBindings = Map<string, EnvReference>;

function childReference(owner: EnvReference | undefined, key: string | undefined): EnvReference | undefined {
  if (owner === 'global' && key === 'process') return 'process';
  // As with member reads, an env property is conservatively treated as an env source.
  if (key === 'env') return 'env';
  return undefined;
}

function reference(node: Node | null | undefined, aliases: EnvBindings): EnvReference | undefined {
  if (!node) return undefined;
  const target = unwrapped(node);
  if (target.type === 'Identifier') {
    if (aliases.has(target.name)) return aliases.get(target.name);
    if (target.name === 'process') return 'process';
    if (target.name === 'globalThis') return 'global';
    if (/env$/i.test(target.name)) return 'env';
  }
  if (target.type === 'MemberExpression' || target.type === 'OptionalMemberExpression') {
    return childReference(reference(target.object, aliases), property(target));
  }
  return undefined;
}

function typedReference(node: Node): EnvReference | undefined {
  if (!('typeAnnotation' in node) || node.typeAnnotation?.type !== 'TSTypeAnnotation') return undefined;
  const type = node.typeAnnotation.typeAnnotation;
  if (type.type === 'TSTypeQuery') return reference(type.exprName, new Map());
  if (type.type !== 'TSTypeReference' || type.typeName.type !== 'TSQualifiedName') return undefined;
  if (type.typeName.right.name === 'ProcessEnv') return 'env';
  return type.typeName.right.name === 'Process' ? 'process' : undefined;
}

/** Walk the pattern with its source, including defaults and copies made by rest bindings. */
function patternReads(pattern: Node, owner: EnvReference | undefined, aliases: EnvBindings, bind = false): EnvRead[] {
  if (pattern.type === 'AssignmentPattern') return patternReads(pattern.left, owner ?? reference(pattern.right, aliases), aliases, bind);
  if (pattern.type === 'Identifier') {
    if (bind && owner) aliases.set(pattern.name, owner);
    return [];
  }
  if (pattern.type !== 'ObjectPattern') return [];
  return pattern.properties.flatMap(field => {
    if (field.type === 'RestElement') {
      const reads: EnvRead[] = owner === 'env' ? [{ form: 'computed', name: '*', offset: field.start ?? 0 }] : [];
      return [...reads, ...patternReads(field.argument, owner, aliases, bind)];
    }
    const name = field.computed && field.key.type === 'Identifier' ? undefined : property(field.key);
    const reads: EnvRead[] = (owner === 'env' && productName(name)) || (owner !== undefined && name === undefined)
      ? [{ form: name === undefined ? 'computed' : 'destructure', name: name ?? '*', offset: field.start ?? 0 }] : [];
    return [...reads, ...patternReads(field.value, childReference(owner, name), aliases, bind)];
  });
}

function bindingReads(node: Node, aliases: EnvBindings, bind = false): EnvRead[] {
  if (node.type === 'VariableDeclarator') return patternReads(node.id, reference(node.init, aliases), aliases, bind);
  if (node.type === 'AssignmentExpression') return patternReads(node.left, reference(node.right, aliases), aliases, bind);
  if (node.type === 'ForOfStatement' || node.type === 'ForInStatement') return patternReads(node.left, undefined, aliases, bind);
  if (!('params' in node) || !Array.isArray(node.params)) return [];
  return node.params.flatMap(param => {
    const pattern = param.type === 'AssignmentPattern' ? param.left : param;
    return patternReads(param, typedReference(pattern), aliases, bind);
  });
}

/** Track env, process and global aliases, including aliases nested in destructuring. */
function envBindings(ast: Node): EnvBindings {
  const aliases: EnvBindings = new Map();
  visit(ast, node => {
    const typed = typedReference(node);
    if (node.type === 'Identifier' && typed) aliases.set(node.name, typed);
    bindingReads(node, aliases, true);
  });
  return aliases;
}

function markWriteTarget(node: Node | null, targets: Set<Node>): void {
  if (!node) return;
  const target = unwrapped(node);
  if (member(target)) { targets.add(target); return; }
  if (target.type === 'ObjectPattern') {
    for (const field of target.properties) markWriteTarget(field.type === 'RestElement' ? field.argument : field.value, targets);
  }
  if (target.type === 'ArrayPattern') for (const item of target.elements) markWriteTarget(item, targets);
  if (target.type === 'AssignmentPattern') markWriteTarget(target.left, targets);
  if (target.type === 'RestElement') markWriteTarget(target.argument, targets);
}

/** Only assignment without a read and delete are exempt. += and ++ read the old value. */
function writeTargets(ast: Node): Set<Node> {
  const targets = new Set<Node>();
  const mark = (node: Node) => markWriteTarget(node, targets);
  visit(ast, node => {
    if (node.type === 'AssignmentExpression' && node.operator === '=') mark(node.left);
    if (node.type === 'UnaryExpression' && node.operator === 'delete') mark(node.argument);
    if (node.type === 'ForOfStatement' || node.type === 'ForInStatement') mark(node.left);
  });
  return targets;
}

function memberRead(node: Node, aliases: EnvBindings, writes: Set<Node>): EnvRead[] {
  if ((node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') || writes.has(node)) return [];
  const name = property(node);
  if (!productName(name) && !(node.computed && name === undefined && reference(node.object, aliases) === 'env')) return [];
  return [{ form: node.computed ? name === undefined ? 'computed' : 'bracket' : 'dot', name: name ?? '*', offset: node.start ?? 0 }];
}

/** AST scanning avoids strings/comments, supports env arguments, brackets, aliases and destructuring. */
export function productEnvReads(source: string, file = 'file.ts'): EnvRead[] {
  const ast = parse(source, { sourceType: 'unambiguous', plugins: ['typescript', ...(/\.[cm]?[jt]sx$/.test(file) ? ['jsx' as const] : [])] });
  const aliases = envBindings(ast);
  const writes = writeTargets(ast);
  const reads: EnvRead[] = [];
  visit(ast, node => {
    reads.push(...memberRead(node, aliases, writes));
    reads.push(...bindingReads(node, aliases));
  });
  for (const call of productEnvCalls(ast)) {
    if (call.suffix === undefined) reads.push({ form: 'helper-dynamic', name: '*', offset: call.offset });
  }
  return reads.sort((a, b) => a.offset - b.offset);
}

const key = (site: Pick<EnvRead, 'form' | 'name'>) => `${site.form}:${site.name}`;
let baseline: EnvReadAllowance[] | undefined;
export function scanProductEnvReads(file: string, source: string, allowances = (baseline ??= readProductEnvBaseline())): EnvRead[] {
  if (!productEnvFile(file)) return [];
  const counts = new Map(allowances.filter(entry => entry.file === file).map(entry => [key(entry), entry.reads]));
  return productEnvReads(source, file).filter(site => {
    const remaining = counts.get(key(site)) ?? 0;
    counts.set(key(site), remaining - 1);
    return remaining <= 0;
  });
}

/** Entries only shrink; CI checks growth against the committed baseline at the merge base. */
export function staleProductEnvReads(root = repoRoot): string[] {
  const entries = readProductEnvBaseline(join(root, productEnvBaselineFile));
  const sources = new Map<string, EnvRead[]>();
  const seen = new Set<string>();
  return entries.flatMap(entry => {
    if (!sources.has(entry.file)) {
      const path = join(root, entry.file);
      sources.set(entry.file, existsSync(path) ? productEnvReads(readFileSync(path, 'utf8'), entry.file) : []);
    }
    const count = sources.get(entry.file)!.filter(site => key(site) === key(entry)).length;
    const id = `${entry.file}:${key(entry)}`;
    const valid = productEnvFile(entry.file) && Number.isInteger(entry.reads) && entry.reads > 0 && !seen.has(id) && count >= entry.reads;
    seen.add(id);
    return valid ? [] : [`${productEnvBaselineFile}: stale or invalid ${id}; remove or lower the entry. Never increase allowances.`];
  });
}

export const productEnvRead: SourceRule = {
  name: 'product-env-read',
  description: 'Read product settings through core/product-env.ts; remaining shipped reads use a shrink-only inventory.',
  applies: productEnvFile,
  check: (file, source) => scanProductEnvReads(file, source).map(site => ({
    line: lineAt(source, site.offset),
    message: `${site.form} ${site.name}: use productEnv with a literal suffix or the dedicated home accessor. Never add an allowance to product-env-read.baseline.json (hearsay-tools/cezarion#2970).`,
  })),
};
