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
        if (top.dynamic && !/^\s*\+/.test(code.slice(token.index + 1)) && /[.]ndjson(?:[.]br)?$/.test(source.slice(top.start, token.index))) {
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

/** Start of a fixed literal immediately before `end`, ignoring surrounding call/return syntax. */
function fixedOperandStart(code: string, end: number): number {
  const before = code.slice(0, end).trimEnd();
  const literal = /(['"])[ \n\r\t]*\1$|`[ \n\r\t]*`$/.exec(before);
  if (literal) return literal.index;
  if (!before.endsWith(')')) return -1;
  const open = matchingOpen(before);
  if (open < 0 || /[\w$)\]`]$/.test(before.slice(0, open).trimEnd())) return -1;
  const inner = fixedExpressionStart(before, before.length - 1);
  return inner >= 0 && before.slice(open + 1, inner).trim() === '' ? open : -1;
}

/** The opening parenthesis paired with a final closing parenthesis. */
function matchingOpen(code: string): number {
  let depth = 0;
  for (let i = code.length - 1; i >= 0; i--) {
    if (code[i] === ')') depth++;
    else if (code[i] === '(' && --depth === 0) return i;
  }
  return -1;
}

/** Start of an all-literal concatenation, or -1 if one operand depends on code. */
function fixedExpressionStart(code: string, end: number): number {
  const start = fixedOperandStart(code, end);
  if (start < 0) return -1;
  const before = code.slice(0, start).trimEnd();
  return before.endsWith('+') ? fixedExpressionStart(code, before.length - 1) : start;
}

/** Read the final fixed-literal tail of a + chain as one suffix, across lines. */
function concatenationTail(source: string, code: string, plus: number): { suffix: string; end: number } {
  let end = plus;
  // A dynamic template can supply the first part of the suffix: `${id}.ndjson` + '.br'.
  const prefix = /([^`}]*)(?:`|['"])\s*$/.exec(source.slice(0, plus));
  let suffix = prefix?.[1] ?? '';
  const next = /\+\s*(['"])[ \n\r\t]*\1|\+\s*`[ \n\r\t]*`/y;
  while (true) {
    next.lastIndex = end;
    const match = next.exec(code);
    if (!match) return { suffix, end };
    const quote = match[0].search(/['"`]/);
    suffix += source.slice(match.index + quote + 1, next.lastIndex - 1);
    end = next.lastIndex;
    const space = /^\s*/.exec(code.slice(end))![0].length;
    end += space;
  }
}

/** Literal delimiters survive blanking at their original offsets. Comments do not. */
function dynamicPaths(source: string, code: string): HistorySite[] {
  const sites = templatePaths(source, code);
  let consumed = -1;
  for (const match of code.matchAll(/\+\s*(?:['"`])/g)) {
    if (match.index < consumed) continue;
    const tail = concatenationTail(source, code, match.index);
    consumed = tail.end;
    // A later + operand replaces this candidate's suffix; inspect the chain's final tail instead.
    if (code[tail.end] === '+') continue;
    if (/[.]ndjson(?:[.]br)?$/.test(tail.suffix) && fixedExpressionStart(code, match.index) < 0) {
      sites.push({ kind: 'dynamic-path', offset: match.index });
    }
  }
  return sites;
}

/** Raw path access, before exceptions: also used to refuse stale exception entries. */
export function historyAccesses(source: string): HistorySite[] {
  const code = blankOnce(source);
  const sites = dynamicPaths(source, code);
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
