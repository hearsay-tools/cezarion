import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import type { Node } from '@babel/types';
import { blankOnce, lineAt, repoRoot, type SourceRule } from './source-rule.ts';

export type HistoryAccess = 'historyPaths' | 'eventsPath-declaration' | 'eventsPath-append' | 'eventsPath' | 'dynamic-path';
export interface HistoryReader { file: string; kind: HistoryAccess; reason: string }
export interface HistorySite { kind: HistoryAccess; offset: number }
export const historyReadersFile = 'packages/cezar/src/lint/run-history-readers.json';

export function readHistoryReaders(path = join(repoRoot, historyReadersFile)): HistoryReader[] {
  return (JSON.parse(readFileSync(path, 'utf8')) as { entries: HistoryReader[] }).entries;
}

/** The AST expression forms that preserve a path's literal operands. */
function pathExpression(node: Node): boolean {
  return (node.type === 'BinaryExpression' && node.operator === '+') || node.type === 'TemplateLiteral' ||
    node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' ||
    node.type === 'TSNonNullExpression' || node.type === 'ParenthesizedExpression';
}

/** Fixed-only expressions stay legal in assignments, returns and arguments alike. */
function fixedPathExpression(node: Node): boolean {
  if (node.type === 'StringLiteral') return true;
  if (node.type === 'TemplateLiteral') return node.expressions.every(fixedPathExpression);
  if (node.type === 'BinaryExpression' && node.operator === '+') return fixedPathExpression(node.left) && fixedPathExpression(node.right);
  if (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'TSNonNullExpression' || node.type === 'ParenthesizedExpression') {
    return fixedPathExpression(node.expression);
  }
  return false;
}

function pathLiteral(node: Node): boolean {
  if (node.type === 'StringLiteral') return node.value.includes('.ndjson');
  return node.type === 'TemplateElement' && (node.value.cooked ?? node.value.raw).includes('.ndjson');
}

/** Index parents once, including literals inside template substitutions. Comments are not paths. */
function pathNodes(node: Node, parents: Map<Node, Node>, literals: Node[]): void {
  if (pathLiteral(node)) literals.push(node);
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child === 'object' && typeof child.type === 'string') {
        parents.set(child as Node, node);
        pathNodes(child as Node, parents, literals);
      }
    }
  }
}

/** Parse failures propagate to lint; a malformed source must never hide an ownership finding. */
function dynamicPaths(source: string): HistorySite[] {
  // The old guard searched raw source too; oxlint still refuses malformed files outside this prefilter.
  if (!source.includes('ndjson')) return [];
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript'], createParenthesizedExpressions: true, allowReturnOutsideFunction: true });
  const parents = new Map<Node, Node>();
  const literals: Node[] = [];
  pathNodes(ast, parents, literals);
  const expressions = new Set<Node>();
  for (const literal of literals) {
    let expression = literal;
    let parent = parents.get(expression);
    while (parent && pathExpression(parent)) {
      expression = parent;
      parent = parents.get(expression);
    }
    if (!fixedPathExpression(expression)) expressions.add(expression);
  }
  return [...expressions].map((expression) => ({ kind: 'dynamic-path', offset: expression.start ?? 0 }));
}

/** Raw path access, before exceptions: also used to refuse stale exception entries. */
export function historyAccesses(source: string): HistorySite[] {
  const code = blankOnce(source);
  const sites = dynamicPaths(source);
  const aliases = [...code.matchAll(/\bhistoryPaths\s+as\s+([\w$]+)/g)].map((match) => match[1]!);
  for (const match of code.matchAll(/\b([\w$]+)\s*\(/g)) {
    if (match[1] !== 'historyPaths' && match[1] !== 'eventsPath' && !aliases.includes(match[1]!)) continue;
    let kind: HistoryAccess = match[1] === 'eventsPath' ? 'eventsPath' : 'historyPaths';
    if (kind === 'eventsPath') {
      const before = code.slice(code.lastIndexOf('\n', match.index) + 1, match.index);
      if (/private\s+$/.test(before)) kind = 'eventsPath-declaration';
      else if (/appendFileSync\s*\(\s*this\.$/.test(before)) kind = 'eventsPath-append';
    }
    sites.push({ kind, offset: match.index });
  }
  return sites.sort((a, b) => a.offset - b.offset);
}

let listed: HistoryReader[] | undefined;

export function scanHistoryReaders(file: string, source: string, readers = (listed ??= readHistoryReaders())): HistorySite[] {
  return historyAccesses(source).filter((site) => !readers.some((entry) => entry.file === file && entry.kind === site.kind));
}

export const runHistoryReader: SourceRule = {
  name: 'run-history-reader',
  description: 'Keep raw transcript paths in their listed owners (hearsay-tools/cezarion#2420).',
  applies: (file) => file.startsWith('packages/cezar/src/') && file.endsWith('.ts') && !/\.(?:test|testkit)\.ts$/.test(file),
  check: (file, source) => scanHistoryReaders(file, source).map((site) => ({
    line: lineAt(source, site.offset),
    message: `${site.kind}: use compression-aware history-file.ts APIs; raw transcript paths belong to the reasoned run-history-readers.json owners (hearsay-tools/cezarion#2420).`,
  })),
};
