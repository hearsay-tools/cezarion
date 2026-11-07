import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import type { Node } from '@babel/types';
import { property, unwrapped, visit } from './home-boundary.ts';
import { lineAt, repoRoot, type SourceRule } from './source-rule.ts';
import { productEnvHelpers, scannedEnvFile } from './undocumented-env-name.ts';

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

function envReference(node: Node | null | undefined, aliases: Set<string>): boolean {
  if (!node) return false;
  const target = unwrapped(node);
  if (target.type === 'Identifier') return aliases.has(target.name) || /env$/i.test(target.name);
  return member(target) && property(target) === 'env';
}

/** Track simple aliases and typed env parameters. Dynamic env indexing remains an inventoried read. */
function envBindings(ast: Node): Set<string> {
  const aliases = new Set<string>();
  visit(ast, node => {
    if (node.type === 'Identifier' && node.typeAnnotation?.type === 'TSTypeAnnotation') {
      const type = node.typeAnnotation.typeAnnotation;
      if (type.type === 'TSTypeReference' && type.typeName.type === 'TSQualifiedName' && type.typeName.right.name === 'ProcessEnv') aliases.add(node.name);
    }
    if (node.type !== 'VariableDeclarator') return;
    if (node.id.type === 'Identifier' && envReference(node.init, aliases)) aliases.add(node.id.name);
    if (node.id.type === 'ObjectPattern' && node.init?.type === 'Identifier' && node.init.name === 'process') {
      for (const field of node.id.properties) {
        if (field.type === 'ObjectProperty' && property(field.key) === 'env' && field.value.type === 'Identifier') aliases.add(field.value.name);
      }
    }
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

function destructuredReads(pattern: Node, source: Node | null | undefined, aliases: Set<string>): EnvRead[] {
  if (pattern.type !== 'ObjectPattern' || !envReference(source, aliases)) return [];
  return pattern.properties.flatMap(field => {
    if (field.type !== 'ObjectProperty') return [];
    const name = property(field.key);
    return productName(name) ? [{ form: 'destructure' as const, name: name!, offset: field.start ?? 0 }] : [];
  });
}

function memberRead(node: Node, aliases: Set<string>, writes: Set<Node>): EnvRead[] {
  if ((node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') || writes.has(node)) return [];
  const name = property(node);
  if (!productName(name) && !(node.computed && name === undefined && envReference(node.object, aliases))) return [];
  return [{ form: node.computed ? name === undefined ? 'computed' : 'bracket' : 'dot', name: name ?? '*', offset: node.start ?? 0 }];
}

function parameterReads(node: Node, aliases: Set<string>): EnvRead[] {
  if (!('params' in node) || !Array.isArray(node.params)) return [];
  return node.params.flatMap(param => {
    if (param.type !== 'ObjectPattern' || param.typeAnnotation?.type !== 'TSTypeAnnotation') return [];
    const type = param.typeAnnotation.typeAnnotation;
    return type.type === 'TSTypeReference' && type.typeName.type === 'TSQualifiedName' && type.typeName.right.name === 'ProcessEnv'
      ? destructuredReads(param, { type: 'Identifier', name: 'env' }, aliases) : [];
  });
}

/** AST scanning avoids strings/comments, supports env arguments, brackets, aliases and destructuring. */
export function productEnvReads(source: string, file = 'file.ts'): EnvRead[] {
  const ast = parse(source, { sourceType: 'unambiguous', plugins: ['typescript', ...(/\.[cm]?[jt]sx$/.test(file) ? ['jsx' as const] : [])] });
  const aliases = envBindings(ast);
  const writes = writeTargets(ast);
  const helpers = productEnvHelpers(source);
  const reads: EnvRead[] = [];
  visit(ast, node => {
    reads.push(...memberRead(node, aliases, writes));
    if (node.type === 'VariableDeclarator') reads.push(...destructuredReads(node.id, node.init, aliases));
    if (node.type === 'AssignmentExpression') reads.push(...destructuredReads(node.left, node.right, aliases));
    reads.push(...parameterReads(node, aliases));
    if ((node.type === 'CallExpression' || node.type === 'OptionalCallExpression') && helpers.has(property(node.callee) ?? '') && node.arguments[0]?.type !== 'StringLiteral') {
      reads.push({ form: 'helper-dynamic', name: '*', offset: node.start ?? 0 });
    }
  });
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
