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
const TEST_FILE = /\.(?:test|testkit)\.[cm]?[jt]sx?$/;

export function readHomeReaders(path = join(repoRoot, homeReadersFile)): HomeReader[] {
  return (JSON.parse(readFileSync(path, 'utf8')) as { entries: HomeReader[] }).entries;
}

function visit(node: Node, accept: (node: Node) => void): void {
  accept(node);
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child === 'object' && typeof child.type === 'string') visit(child as Node, accept);
    }
  }
}

function name(node: Node | null | undefined): string | undefined {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type === 'StringLiteral') return node.value;
  return undefined;
}

function property(node: Node | null | undefined): string | undefined {
  if (node?.type !== 'MemberExpression' && node?.type !== 'OptionalMemberExpression') return name(node);
  return !node.computed || node.property.type === 'StringLiteral' ? name(node.property) : undefined;
}

function unwrapped(node: Node): Node {
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

function homeEnv(node: Node): boolean {
  const target = unwrapped(node);
  if (target.type !== 'MemberExpression' || property(target) !== 'CEZ_HOME') return false;
  const env = unwrapped(target.object);
  return env.type === 'MemberExpression' && property(env) === 'env' && name(env.object) === 'process';
}

function selectsHome(node: Node): boolean {
  if (node.type === 'AssignmentExpression') return homeEnv(node.left);
  if (node.type === 'UpdateExpression') return homeEnv(node.argument);
  if (node.type === 'UnaryExpression' && node.operator === 'delete') return homeEnv(node.argument);
  return node.type === 'CallExpression' && property(node.callee) === 'stubEnv' && name(node.arguments[0]) === 'CEZ_HOME';
}

/** Parse failures propagate to lint. Strings and comments cannot hide or create sites. */
export function homeSites(source: string, file = 'file.ts'): HomeSite[] {
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript', ...(file.endsWith('.tsx') ? ['jsx' as const] : [])] });
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
  applies: file => file !== SHARED_SETUP && /^packages\/cezar\/(?:src|test)\/.*\.[cm]?[jt]sx?$/.test(file),
  check: (file, source) => scanHomeBoundary(file, source).map(site => ({
    line: lineAt(source, site.offset),
    message: `${site.kind}: pass an explicit Home from an entry point; tests select Home.sandbox through shared setup. OS-user readers belong to shrink-only home-readers.baseline.json (hearsay-tools/cezarion#2810).`,
  })),
};
