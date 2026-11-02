import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blankOnce, lineAt, repoRoot, type SourceRule } from './source-rule.ts';

export type HistoryAccess = 'historyPaths' | 'eventsPath-declaration' | 'eventsPath-append' | 'eventsPath' | 'dynamic-path';
export interface HistoryReader { file: string; kind: HistoryAccess; reason: string }
export interface HistorySite { kind: HistoryAccess; offset: number }
export const historyReadersFile = 'packages/cezar/src/lint/run-history-readers.json';

export function readHistoryReaders(path = join(repoRoot, historyReadersFile)): HistoryReader[] {
  return (JSON.parse(readFileSync(path, 'utf8')) as { entries: HistoryReader[] }).entries;
}

/** Track nested templates and substitution braces using the delimiters blanking preserves. */
function templatePaths(source: string, code: string): HistorySite[] {
  const stack: Array<{ start: number; depth: number; dynamic: boolean }> = [];
  const sites: HistorySite[] = [];
  for (const token of code.matchAll(/`|\$\{|[{}]/g)) {
    const top = stack.at(-1);
    if (token[0] === '`') {
      if (!top || top.depth > 0) stack.push({ start: token.index, depth: 0, dynamic: false });
      else {
        stack.pop();
        if (top.dynamic && /[.]ndjson(?:[.]br)?$/.test(source.slice(top.start, token.index))) {
          sites.push({ kind: 'dynamic-path', offset: top.start });
        }
      }
    } else if (top) {
      if (token[0] === '${') { top.depth++; top.dynamic = true; }
      else if (token[0] === '{') top.depth++;
      else top.depth--;
    }
  }
  return sites;
}

/** Literal delimiters survive blanking at their original offsets. Comments do not. */
function dynamicPaths(source: string, code: string): HistorySite[] {
  const sites: HistorySite[] = [];
  sites.push(...templatePaths(source, code));
  for (const match of code.matchAll(/\+\s*(['"])[^'"]*\1/g)) {
    const quote = match.index + match[0].indexOf(match[1]!);
    const literal = source.slice(quote + 1, match.index + match[0].length - 1);
    // A literal + literal is a fixed name, not a run-dependent path.
    const before = code.slice(0, match.index).split(/[=;,\n{}]/).at(-1)!;
    const dynamic = before.replace(/(['"])[^'"]*\1|`[^`]*`/g, '').replace(/[+()\s]/g, '');
    if (/[.]ndjson(?:[.]br)?$/.test(literal) && dynamic.length > 0) {
      sites.push({ kind: 'dynamic-path', offset: match.index });
    }
  }
  return sites;
}

/** Raw path access, before exceptions: also used to refuse stale exception entries. */
export function historyAccesses(source: string): HistorySite[] {
  const code = blankOnce(source);
  const sites = dynamicPaths(source, code);
  for (const match of code.matchAll(/\b(historyPaths|eventsPath)\s*\(/g)) {
    let kind: HistoryAccess = match[1] as 'historyPaths' | 'eventsPath';
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
