import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import type { Node } from '@babel/types';
import { lineAt, repoRoot, type SourceRule } from './source-rule.ts';

export const homeReadersFile = 'packages/cezar/src/lint/home-readers.baseline.json';
export interface HomeReader { file: string; kind: 'homedir'; calls: number; reason: string }
export interface HomeSite { kind: 'cezarHomeDir' | 'resolveHome' | 'homedir' | 'test-selection'; offset: number }
const ENTRY_POINTS = new Set(['packages/cezar/src/index.ts', 'packages/cezar/src/subcommands.ts']);
const SHARED_SETUP = 'packages/cezar/vitest.setup.ts';
const HOME_DIR = 'packages/cezar/src/home/';
export const TEST_FILE = /\.(?:test|testkit)\.[cm]?[jt]sx?$/;

export function readHomeReaders(path = join(repoRoot, homeReadersFile)): HomeReader[] {
  return (JSON.parse(readFileSync(path, 'utf8')) as { entries: HomeReader[] }).entries;
}

export function visit(node: Node, accept: (node: Node) => void): void {
  accept(node);
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child === 'object' && typeof child.type === 'string') visit(child as Node, accept);
    }
  }
}

function staticKey(node: Node | null | undefined): string | undefined {
  if (!node) return undefined;
  const target = unwrapped(node);
  if (target.type === 'StringLiteral') return target.value;
  if (target.type === 'TemplateLiteral' && target.expressions.length === 0) return target.quasis[0]?.value.cooked ?? undefined;
  if (target.type === 'BinaryExpression' && target.operator === '+') {
    const left = staticKey(target.left);
    const right = staticKey(target.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

function name(node: Node | null | undefined): string | undefined {
  return node?.type === 'Identifier' ? node.name : staticKey(node);
}

export function property(node: Node | null | undefined): string | undefined {
  if (node?.type !== 'MemberExpression' && node?.type !== 'OptionalMemberExpression') return name(node);
  return node.computed ? staticKey(node.property) : name(node.property);
}

export function unwrapped(node: Node): Node {
  if (node.type === 'TSAsExpression' || node.type === 'TSNonNullExpression' || node.type === 'TSTypeAssertion' || node.type === 'ParenthesizedExpression') return unwrapped(node.expression);
  return node;
}

function homedirRef(node: Node | null | undefined, aliases: Set<string>): boolean {
  if (!node) return false;
  const target = unwrapped(node);
  if (target.type === 'SequenceExpression') return homedirRef(target.expressions.at(-1), aliases);
  if (target.type === 'Identifier') return aliases.has(target.name);
  if (target.type === 'CallExpression' || target.type === 'OptionalCallExpression') {
    const callee = unwrapped(target.callee);
    return (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression')
      && property(callee) === 'bind' && homedirRef(callee.object, aliases);
  }
  if (target.type !== 'MemberExpression' && target.type !== 'OptionalMemberExpression') return false;
  const member = property(target);
  return member === 'homedir' || ((member === 'call' || member === 'apply') && homedirRef(target.object, aliases));
}

function callsHomedir(node: Node, aliases: Set<string>): boolean {
  if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return false;
  const callee = unwrapped(node.callee);
  if ((callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression')
    && property(callee) === 'apply' && name(callee.object) === 'Reflect') return homedirRef(node.arguments[0], aliases);
  return homedirRef(callee, aliases);
}

function processEnv(node: Node | null | undefined): boolean {
  if (!node) return false;
  const env = unwrapped(node);
  return (env.type === 'MemberExpression' || env.type === 'OptionalMemberExpression')
    && property(env) === 'env' && name(unwrapped(env.object)) === 'process';
}

function homeWriteTarget(node: Node | null): boolean {
  if (!node) return false;
  const target = unwrapped(node);
  if (target.type === 'ArrayPattern') return target.elements.some(homeWriteTarget);
  if (target.type === 'ObjectPattern') return target.properties.some(field => {
    return homeWriteTarget(field.type === 'RestElement' ? field.argument : field.value);
  });
  if (target.type === 'AssignmentPattern') return homeWriteTarget(target.left);
  if (target.type === 'RestElement') return homeWriteTarget(target.argument);
  return (target.type === 'MemberExpression' || target.type === 'OptionalMemberExpression')
    && property(target) === 'CEZ_HOME' && processEnv(target.object);
}

function homeProperty(node: Node): boolean {
  const source = unwrapped(node);
  return source.type === 'ObjectExpression' && source.properties.some(field => {
    return (field.type === 'ObjectProperty' || field.type === 'ObjectMethod')
      && (field.computed ? staticKey(field.key) : name(field.key)) === 'CEZ_HOME';
  });
}

function selectsHomeCall(node: Node): boolean {
  if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return false;
  const callee = unwrapped(node.callee);
  const method = property(callee);
  if (method === 'stubEnv') return staticKey(node.arguments[0]) === 'CEZ_HOME';
  if (callee.type !== 'MemberExpression' && callee.type !== 'OptionalMemberExpression') return false;
  if (!processEnv(node.arguments[0])) return false;
  const owner = name(unwrapped(callee.object));
  if (owner === 'Object' && method === 'assign') return node.arguments.slice(1).some(homeProperty);
  return ['Reflect.set', 'Reflect.defineProperty', 'Object.defineProperty'].includes(`${owner}.${method}`)
    && staticKey(node.arguments[1]) === 'CEZ_HOME';
}

function selectsHome(node: Node): boolean {
  if (node.type === 'AssignmentExpression' || node.type === 'ForInStatement' || node.type === 'ForOfStatement') return homeWriteTarget(node.left);
  if (node.type === 'UpdateExpression') return homeWriteTarget(node.argument);
  if (node.type === 'UnaryExpression' && node.operator === 'delete') return homeWriteTarget(node.argument);
  return selectsHomeCall(node);
}

/** Parse failures propagate to lint. Strings and comments cannot hide or create sites. */
export function homeSites(source: string, file = 'file.ts'): HomeSite[] {
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript', ...(/\.[cm]?[jt]sx$/.test(file) ? ['jsx' as const] : [])] });
  const aliases = new Set(['homedir']);
  visit(ast, node => {
    if (node.type === 'ImportSpecifier' && name(node.imported) === 'homedir') aliases.add(node.local.name);
    if (node.type === 'VariableDeclarator' && node.id.type === 'ObjectPattern') {
      for (const field of node.id.properties) {
        if (field.type === 'ObjectProperty' && name(field.key) === 'homedir' && field.value.type === 'Identifier') aliases.add(field.value.name);
      }
    }
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && homedirRef(node.init, aliases)) aliases.add(node.id.name);
  });
  const sites: HomeSite[] = [];
  visit(ast, node => {
    const id = name(node);
    if (node.type === 'Identifier' && (id === 'cezarHomeDir' || id === 'resolveHome')) sites.push({ kind: id, offset: node.start ?? 0 });
    if ((node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') && node.computed) {
      const member = property(node);
      if (member === 'cezarHomeDir' || member === 'resolveHome') sites.push({ kind: member, offset: node.start ?? 0 });
    }
    if (callsHomedir(node, aliases)) sites.push({ kind: 'homedir', offset: node.start ?? 0 });
    if (selectsHome(node)) sites.push({ kind: 'test-selection', offset: node.start ?? 0 });
  });
  return sites.sort((a, b) => a.offset - b.offset);
}

function testFile(file: string): boolean { return TEST_FILE.test(file) || file.startsWith('packages/cezar/test/'); }
function productFile(file: string): boolean { return file.startsWith('packages/cezar/src/') && !testFile(file); }

let readers: HomeReader[] | undefined;
export function scanHomeBoundary(file: string, source: string, exemptions = (readers ??= readHomeReaders())): HomeSite[] {
  const sites = homeSites(source, file);
  if (testFile(file)) return sites.filter(site => site.kind === 'test-selection');
  if (!productFile(file)) return [];
  const allowed = exemptions.find(entry => entry.file === file)?.calls ?? 0;
  let calls = 0;
  return sites.filter(site => {
    if (site.kind === 'cezarHomeDir') return true;
    if (site.kind === 'resolveHome') return !file.startsWith(HOME_DIR) && !ENTRY_POINTS.has(file);
    if (site.kind === 'homedir') return ++calls > allowed && !file.startsWith(HOME_DIR);
    return false;
  });
}

/** Counts must still name actual calls. CI's baseline-growth gate permits only shrinking entries. */
export function staleHomeReaders(root = repoRoot): string[] {
  const seen = new Set<string>();
  return readHomeReaders(join(root, homeReadersFile)).flatMap(entry => {
    const path = join(root, entry.file);
    const count = existsSync(path) ? homeSites(readFileSync(path, 'utf8'), entry.file).filter(site => site.kind === 'homedir').length : 0;
    const valid = productFile(entry.file) && !entry.file.startsWith(HOME_DIR) && entry.kind === 'homedir'
      && entry.reason.trim() && Number.isInteger(entry.calls) && entry.calls > 0 && !seen.has(entry.file);
    seen.add(entry.file);
    return valid && count >= entry.calls ? [] : [`${homeReadersFile} cez/home-boundary: stale or invalid entry ${entry.file}; remove or lower the exemption (hearsay-tools/cezarion#2810).`];
  });
}

export const homeBoundary: SourceRule = {
  name: 'home-boundary',
  description: 'Resolve cockpit homes at entry points; tests select Home.sandbox (hearsay-tools/cezarion#2810).',
  applies: file => file !== SHARED_SETUP && (TEST_FILE.test(file) || /^packages\/cezar\/(?:src|test)\/.*\.[cm]?[jt]sx?$/.test(file)),
  check: (file, source) => scanHomeBoundary(file, source).map(site => ({
    line: lineAt(source, site.offset),
    message: `${site.kind}: pass an explicit Home from an entry point; tests select Home.sandbox through shared setup. OS-user readers belong to shrink-only home-readers.baseline.json (hearsay-tools/cezarion#2810).`,
  })),
};
