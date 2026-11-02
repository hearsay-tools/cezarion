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

interface PathLiteral { start: number; end: number; dynamic: boolean; containsPath: boolean }

/** Only literal segments count; substitution code is scanned separately. */
function templateLiterals(source: string, code: string): PathLiteral[] {
  const stack: Array<{ start: number; depth: number; dynamic: boolean; literalStart: number; containsPath: boolean }> = [];
  const literals: PathLiteral[] = [];
  for (const token of code.matchAll(/`|\$\{|[{}]/g)) {
    const top = stack.at(-1);
    if (token[0] === '`') {
      if (!top || top.depth > 0) stack.push({ start: token.index, depth: 0, dynamic: false, literalStart: token.index + 1, containsPath: false });
      else {
        stack.pop();
        literals.push({ start: top.start, end: token.index + 1, dynamic: top.dynamic,
          containsPath: top.containsPath || source.slice(top.literalStart, token.index).includes('.ndjson') });
      }
    } else if (top) {
      if (token[0] === '${') {
        top.containsPath ||= source.slice(top.literalStart, token.index).includes('.ndjson');
        top.depth++; top.dynamic = true;
      } else if (token[0] === '{') top.depth++;
      else if (--top.depth === 0) top.literalStart = token.index + 1;
    }
  }
  return literals;
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

/** The forward counterpart of fixedExpressionStart, for the right side of a + chain. */
function fixedExpressionEnd(code: string, start: number): number {
  const rest = code.slice(start);
  const space = /^\s*/.exec(rest)![0].length;
  start += space;
  const literal = /^(['"])[ \n\r\t]*\1|^`[ \n\r\t]*`/.exec(code.slice(start));
  let end: number;
  if (literal) end = start + literal[0].length;
  else if (code[start] === '(') {
    const inner = fixedExpressionEnd(code, start + 1);
    if (inner < 0 || code[inner] !== ')') return -1;
    end = inner + 1;
  } else return -1;
  end += /^\s*/.exec(code.slice(end))![0].length;
  return code[end] === '+' ? fixedExpressionEnd(code, end + 1) : end;
}

/** Parentheses and blanked comments do not break a + chain; calls remain separate arguments. */
function dynamicChain(code: string, literal: PathLiteral): boolean {
  let { start, end } = literal;
  while (true) {
    const before = code.slice(0, start).trimEnd();
    const afterSpace = /^\s*/.exec(code.slice(end))![0].length;
    end += afterSpace;
    if (before.endsWith('(') && code[end] === ')' && !/[\w$)\]`]$/.test(before.slice(0, -1).trimEnd())) {
      start = before.length - 1; end++;
      continue;
    }
    let changed = false;
    if (before.endsWith('+')) {
      const left = fixedExpressionStart(code, before.length - 1);
      if (left < 0) return true;
      start = left; changed = true;
    }
    if (code[end] === '+') {
      const right = fixedExpressionEnd(code, end + 1);
      if (right < 0) return true;
      end = right; changed = true;
    }
    if (!changed) return false;
  }
}

/** Dynamic paths contain .ndjson, even before another suffix or substitution. */
function dynamicPaths(source: string, code: string): HistorySite[] {
  const literals = templateLiterals(source, code);
  for (const match of code.matchAll(/(['"])[ \n\r\t]*\1/g)) {
    literals.push({ start: match.index, end: match.index + match[0].length, dynamic: false,
      containsPath: source.slice(match.index, match.index + match[0].length).includes('.ndjson') });
  }
  const sites = literals.filter((literal) => literal.containsPath && (literal.dynamic || dynamicChain(code, literal)));
  return sites.map((literal) => ({ kind: 'dynamic-path', offset: literal.start }));
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
