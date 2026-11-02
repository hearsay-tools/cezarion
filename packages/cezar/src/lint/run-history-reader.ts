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

/** A bare extension fragment can build a transcript; a fixed filename has its own stem. */
function pathFragment(node: Node): boolean {
  const fragment = /(?:^|[^A-Za-z0-9_-])[.]ndjson/;
  if (node.type === 'StringLiteral') return fragment.test(node.value);
  return node.type === 'TemplateElement' && fragment.test(node.value.cooked ?? node.value.raw);
}

/** Literal syntax supplies ownership sites regardless of the surrounding call or expression. */
function pathNodes(node: Node, offsets: Set<number>, parent?: Node): void {
  if (pathFragment(node)) offsets.add((node.type === 'TemplateElement' ? parent?.start : node.start) ?? 0);
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child === 'object' && typeof child.type === 'string') pathNodes(child as Node, offsets, node);
    }
  }
}

/** Parse failures propagate to lint; a malformed source must never hide an ownership finding. */
function dynamicPaths(source: string): HistorySite[] {
  // The old guard searched raw source too; oxlint still refuses malformed files outside this prefilter.
  if (!source.includes('ndjson')) return [];
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript'], allowReturnOutsideFunction: true });
  const offsets = new Set<number>();
  pathNodes(ast, offsets);
  return [...offsets].map((offset) => ({ kind: 'dynamic-path', offset }));
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
