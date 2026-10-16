import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * A source scan of the server unit tests for the two ways a test waits on the wall clock instead
 * of on the product: a bare awaited sleep standing in for a condition nobody named, and a wait
 * bounded under SHORT_BOUND_MS. The last three load flakes under hearsay-tools/cezarion#902 had
 * that one cause (hearsay-tools/cezarion#1144, hearsay-tools/cezarion#1145,
 * hearsay-tools/cezarion#1146): a fixed bound on a fixture's own startup, or one bound for a
 * whole sequence of steps, which a loaded host overruns. The rule for authors is in AGENTS.md
 * § Validation.
 *
 * It is a heuristic over source text, not a parser: TypeScript 7 has no JS parser API, and the
 * tests are regular enough that each form fits a pattern. Strings, template literals and
 * comments are blanked first, so the sleeps inside fake-CLI scripts (template literals written
 * to disk as mock binaries) are not this scan's business. A false positive costs one
 * `// bound: <reason>` comment at the site, which is what the rule asks of a real bound anyway.
 *
 * `test-wait-discipline.test.ts` runs it against every `*.test.ts` and `*.testkit.ts` under
 * `packages/cezar/src` and compares the tally with a checked-in baseline that can only shrink, so
 * today's sites stay where they are and no new one lands without a reason.
 */

export type Rule = 'sleep' | 'short-bound';

export interface Site {
  file: string;
  rule: Rule;
  /** The site's first line, trimmed: a call moves with it, a line number does not. */
  site: string;
  line: number;
}

export interface BaselineEntry {
  file: string;
  rule: Rule;
  site: string;
  count: number;
}

/** A wait bounded by a numeric literal under this is short. Vitest's own default is 1 s. */
export const SHORT_BOUND_MS = 10_000;

export const srcDir = resolve(import.meta.dirname);
export const baselinePath = resolve(import.meta.dirname, 'test-wait-discipline.baseline.json');
const ownFiles = new Set(['test-wait-discipline.testkit.ts', 'test-wait-discipline.test.ts']);

export type Construct = 'string' | 'template' | 'substitution' | 'comment';

export interface ScanError {
  file: string;
  line: number;
  construct: Construct;
  /** The line the construct opens on, trimmed. */
  text: string;
}

export interface BlankedSource {
  code: string;
  /** Where each `//` comment starts. Each runs to the end of its line. */
  lineComments: number[];
  /** Where each construct that never closes opens, in source order. */
  unterminated: Array<{ construct: Construct; offset: number }>;
}

/** The blanked copy alone; see `blankSource`. */
export function blank(source: string): string {
  return blankSource(source).code;
}

/**
 * The source with the contents of every string, template literal and regex literal, and every
 * comment, replaced by spaces. Newlines stay, so a line and column in the copy are the same line
 * and column in the original. A `${…}` substitution is code and stays, nested templates included;
 * the delimiters (quotes, backticks, `${`, `}`) stay too, so braces still balance.
 *
 * A regex literal is told from a division by the token before the `/`. After a `)` that is a
 * regex only when the parenthesis closes an `if`, `while`, `for` or `with` head. A regex the
 * heuristic misses is read as code, so a sleep written inside it would be a false hit.
 *
 * A construct that never closes is reported in `unterminated`, never swallowed in silence: a
 * misread quote or backtick would otherwise hide every site after it. A string stops at its line
 * end, so the next line is read again; a template, a substitution or a block comment runs to the
 * end of the file. The whole-suite test asserts that no scanned file has one.
 */
export function blankSource(source: string): BlankedSource {
  const parts: string[] = [];
  let copied = 0;
  const wipe = (from: number, to: number): void => {
    if (to <= from) return;
    parts.push(source.slice(copied, from), source.slice(from, to).replace(/[^\n]/g, ' '));
    copied = to;
  };
  const lineComments: number[] = [];
  // Every comment so far as [start, end), so the head test can step back over one.
  const comments: Array<[number, number]> = [];
  const unterminated: BlankedSource['unterminated'] = [];
  // What encloses the cursor: a template's literal part, or a `${…}` slot counting its own braces.
  const stack: Array<{ kind: 'template'; offset: number } | { kind: 'slot'; offset: number; depth: number }> = [];
  // For each open parenthesis in code, whether it heads a statement (`if (…)`): a `/` after its
  // `)` starts a regex, where after any other `)` it divides.
  const parens: boolean[] = [];
  let closedHead = false;
  // The last character of code seen, for telling a regex literal from a division.
  let last = -1;
  const n = source.length;
  let i = 0;
  while (i < n) {
    const ch = source[i];
    const top = stack.at(-1);
    if (top?.kind === 'template') {
      let j = i;
      while (j < n && source[j] !== '`' && !(source[j] === '$' && source[j + 1] === '{')) j += source[j] === '\\' ? 2 : 1;
      wipe(i, Math.min(j, n));
      if (j >= n) break;
      if (source[j] === '`') {
        stack.pop();
        last = j;
        i = j + 1;
      } else {
        stack.push({ kind: 'slot', offset: j, depth: 0 });
        last = j + 1;
        i = j + 2;
      }
      continue;
    }
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      lineComments.push(i);
      const end = source.indexOf('\n', i);
      comments.push([i, end === -1 ? n : end]);
      wipe(i, end === -1 ? n : end);
      i = end === -1 ? n : end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      if (close === -1) unterminated.push({ construct: 'comment', offset: i });
      const end = close === -1 ? n : close + 2;
      comments.push([i, end]);
      wipe(i, end);
      i = end;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < n && source[j] !== ch && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      j = Math.min(j, n);
      wipe(i + 1, j);
      if (source[j] === ch) {
        last = j;
        i = j + 1;
      } else {
        unterminated.push({ construct: 'string', offset: i });
        last = i;
        i = j;
      }
      continue;
    }
    if (ch === '`') {
      stack.push({ kind: 'template', offset: i });
      i += 1;
      continue;
    }
    if (ch === '/' && regexMayStart(source, last, closedHead)) {
      const end = regexEnd(source, i);
      if (end !== -1) {
        wipe(i + 1, end);
        let j = end + 1;
        while (j < n && /[a-z]/.test(source[j] ?? '')) j += 1;
        last = j - 1;
        i = j;
        continue;
      }
    }
    if (ch === '(') parens.push(headsStatement(source, i, comments));
    else if (ch === ')') closedHead = parens.pop() ?? false;
    if (top?.kind === 'slot') {
      if (ch === '{') top.depth += 1;
      else if (ch === '}') {
        if (top.depth === 0) {
          stack.pop();
          i += 1;
          continue;
        }
        top.depth -= 1;
      }
    }
    if (ch !== undefined && !/\s/.test(ch)) last = i;
    i += 1;
  }
  const open = stack.at(-1);
  if (open) unterminated.push({ construct: open.kind === 'template' ? 'template' : 'substitution', offset: open.offset });
  parts.push(source.slice(copied));
  return { code: parts.join(''), lineComments, unterminated: unterminated.sort((a, b) => a.offset - b.offset) };
}

/** Words after which a `/` starts an expression, not a division. */
const beforeExpression = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void', 'yield', 'await', 'delete', 'instanceof', 'new', 'throw']);
/** Statements whose parenthesised head is followed by a statement, which may open with a regex. */
const statementHeads = new Set(['if', 'while', 'for', 'with']);

function regexMayStart(source: string, last: number, closedHead: boolean): boolean {
  if (last < 0) return true;
  const ch = source[last] ?? '';
  if (ch === ')') return closedHead;
  if (/[\w$]/.test(ch)) return beforeExpression.has(wordEndingAt(source, last));
  return !/[\]}'"`]/.test(ch);
}

/** Whether the `(` at `open` heads an `if`, `while`, `for` (or `for await`) or `with` statement.
 *  Steps back over whitespace and the comments seen so far, so a comment before the `(` or
 *  after a `.` does not hide the keyword. */
function headsStatement(source: string, open: number, comments: Array<[number, number]>): boolean {
  let c = comments.length - 1;
  const back = (from: number): number => {
    let k = skipSpaceBack(source, from);
    for (; c >= 0 && (comments[c]?.[0] ?? 0) <= k; c -= 1) {
      if (k >= (comments[c]?.[1] ?? 0)) break;
      k = skipSpaceBack(source, (comments[c]?.[0] ?? 0) - 1);
    }
    return k;
  };
  const end = back(open - 1);
  let word = wordEndingAt(source, end);
  let start = end - word.length;
  if (word === 'await') {
    const before = back(start);
    word = wordEndingAt(source, before);
    start = before - word.length;
  }
  // `Symbol.for(…)` is a call.
  return statementHeads.has(word) && source[back(start)] !== '.';
}

/** The closing `/` of a regex literal opened at `open`, or -1 when the line ends first. */
function regexEnd(source: string, open: number): number {
  let inClass = false;
  for (let j = open + 1; j < source.length; j += 1) {
    const ch = source[j];
    if (ch === '\n') return -1;
    if (ch === '\\') j += 1;
    else if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) return j;
  }
  return -1;
}

function wordEndingAt(code: string, end: number): string {
  let start = end;
  while (start >= 0 && /[\w$]/.test(code[start] ?? '')) start -= 1;
  return code.slice(start + 1, end + 1);
}

function skipSpaceBack(code: string, from: number): number {
  let k = from;
  while (k >= 0 && /\s/.test(code[k] ?? '')) k -= 1;
  return k;
}

/** The bracket matching the `(`, `[` or `{` at `open`, in blanked code; the end of the source when unbalanced. */
function closeOf(code: string, open: number): number {
  const opener = code[open];
  const closer = opener === '{' ? '}' : opener === '[' ? ']' : ')';
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === opener) depth += 1;
    else if (code[i] === closer) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return code.length;
}

/** The `(` matching the `)` at `close`, in blanked code; -1 when unbalanced. */
function openOf(code: string, close: number): number {
  let depth = 0;
  for (let i = close; i >= 0; i -= 1) {
    if (code[i] === ')') depth += 1;
    else if (code[i] === '(') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** An argument or a property: its trimmed text in the blanked code, and where that text starts. */
interface Item {
  text: string;
  start: number;
}

/** The items between the brackets at `open` and `close`, split at top-level commas, a trailing comma dropped. */
function argsOf(code: string, open: number, close: number): Item[] {
  const items: Item[] = [];
  const push = (from: number, to: number): void => {
    const raw = code.slice(from, to);
    items.push({ text: raw.trim(), start: from + raw.length - raw.trimStart().length });
  };
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < close; i += 1) {
    const ch = code[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) {
      push(start, i);
      start = i + 1;
    }
  }
  push(start, close);
  if (items.at(-1)?.text === '') items.pop();
  return items;
}

/** A JavaScript numeric literal: `_` separators, decimals, exponents, hex, octal and binary. */
const numericLiteral =
  /^(?:0[xX][\da-fA-F](?:_?[\da-fA-F])*|0[oO][0-7](?:_?[0-7])*|0[bB][01](?:_?[01])*|(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?)$/;

/** The value of a numeric literal, or undefined for anything else. Every rule reads bounds through this. */
function literalMs(text: string | undefined): number | undefined {
  return text !== undefined && numericLiteral.test(text) ? Number(text.replace(/_/g, '')) : undefined;
}

/** What Vitest's `vi.waitFor`, `vi.waitUntil` and `expect.poll` wait when given no `timeout`. */
const VITEST_DEFAULT_MS = 1_000;

const isShort = (ms: number | undefined): boolean => ms !== undefined && ms < SHORT_BOUND_MS;

type Frame = 'loop' | 'function' | 'block';

/** What the `{` at `open` opens: a loop body, a function body, or any other block. */
function frameOf(code: string, open: number): Frame {
  const k = skipSpaceBack(code, open - 1);
  if (code[k] === '>' && code[k - 1] === '=') return 'function';
  if (code[k] === ')') {
    const paren = openOf(code, k);
    const headEnd = skipSpaceBack(code, paren - 1);
    const head = wordEndingAt(code, headEnd);
    if (head === 'for' || head === 'while') return 'loop';
    if (head === 'await' && wordEndingAt(code, skipSpaceBack(code, headEnd - head.length)) === 'for') return 'loop';
    if (head === 'if' || head === 'switch' || head === 'catch' || head === 'with') return 'block';
    // `name(…) {` and `function (…) {`: a method or function body.
    return 'function';
  }
  if (wordEndingAt(code, k) === 'do') return 'loop';
  // `function f(): T {` and `method(): T {`: a return type sits between the `)` and the `{`.
  const lineStart = code.lastIndexOf('\n', open) + 1;
  return /\)\s*:[^;{}()=]*$/.test(code.slice(lineStart, open)) ? 'function' : 'block';
}

/**
 * The offsets in `offsets` that sit in a loop body: inside a `for`/`while`/`do` block with no
 * function body between, or the brace-less body of a loop header (`while (!ready()) await …`).
 * A loop's own deadline is out of this scan's reach, so a sleep in one is read as a poll interval.
 */
function inLoopBody(code: string, offsets: number[]): Set<number> {
  const found = new Set<number>();
  for (const offset of offsets) if (bracelessLoopBody(code, offset)) found.add(offset);
  const queue = [...offsets].sort((a, b) => a - b);
  const stack: Frame[] = [];
  let q = 0;
  for (let i = 0; i < code.length && q < queue.length; i += 1) {
    while (queue[q] === i) {
      for (let f = stack.length - 1; f >= 0; f -= 1) {
        if (stack[f] === 'function') break;
        if (stack[f] === 'loop') {
          found.add(i);
          break;
        }
      }
      q += 1;
    }
    if (code[i] === '{') stack.push(frameOf(code, i));
    else if (code[i] === '}') stack.pop();
  }
  return found;
}

/** Whether the statement at `offset` is the brace-less body of a loop, through any `if (…)` heads. */
function bracelessLoopBody(code: string, offset: number): boolean {
  let k = skipSpaceBack(code, offset - 1);
  if (wordEndingAt(code, k) === 'do') return true;
  while (code[k] === ')') {
    const paren = openOf(code, k);
    if (paren === -1) return false;
    const headEnd = skipSpaceBack(code, paren - 1);
    const head = wordEndingAt(code, headEnd);
    if (head === 'for' || head === 'while') return true;
    if (head === 'await' && wordEndingAt(code, skipSpaceBack(code, headEnd - head.length)) === 'for') return true;
    if (head !== 'if') return false;
    k = skipSpaceBack(code, headEnd - head.length);
  }
  return false;
}

/** Local sleep helpers in this tree go by these names. */
const namedSleep = /\bawait\s+(?:delay|sleep|wait|pause)\s*\(/g;
/** `node:timers/promises`. */
const promisedTimer = /\bawait\s+(?:timers\s*\.\s*)?setTimeout\s*\(/g;
/** `await new Promise(r => setTimeout(r, …))`, with a `globalThis.`/`global.` receiver or a
 *  `realSetTimeout`-style alias, as an expression body or a block that calls or returns it; the
 *  last group is the timer's name. */
const promiseSleep =
  /\bawait\s+new\s+Promise\s*(?:<[^<>()]*>)?\s*\(\s*(?:\(\s*([A-Za-z_$][\w$]*)\s*(?::[^()]*)?\)|([A-Za-z_$][\w$]*))\s*=>\s*(?:\{\s*(?:return\s+)?)?(?:(?:globalThis|global)\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(/g;

/** Vitest's waits; each defaults to a 1 s bound. */
const vitestWait = /\b(?:vi\s*\.\s*(?:waitFor|waitUntil)|expect\s*\.\s*poll)\s*\(/g;
const helperNames = 'waitFor|waitUntil|until|eventually|waitForCondition';
/** A call to a local wait helper, not a method of something else. */
const helperCall = new RegExp(`(?<!\\.\\s*)(?<![\\w$])(?:${helperNames})\\s*\\(`, 'g');
const helperFunction = new RegExp(`\\bfunction\\s*\\*?\\s*(?:${helperNames})\\s*(?:<[^<>()]*>)?\\s*\\(`, 'g');
const helperArrow = new RegExp(`\\b(?:const|let|var)\\s+(?:${helperNames})\\s*(?::[^=;]*)?=\\s*(?:async\\s*)?(?:<[^<>()]*>)?\\s*\\(`, 'g');

/** A `//` comment that accepts a site: `// bound: <reason>`, with a reason. */
const boundComment = /^\/\/\s*bound:\s*\S/;

export function scanSource(file: string, source: string): Site[] {
  return scanFile(file, source).sites;
}

export function scanFile(file: string, source: string): { sites: Site[]; errors: ScanError[] } {
  const { code, lineComments, unterminated } = blankSource(source);
  const lines = source.split('\n');
  const lineStarts = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const found: Array<{ rule: Rule; offset: number }> = [];

  // Rule `sleep`: an awaited timer with any delay but a literal 0 (one event-loop turn).
  const sleeps: number[] = [];
  for (const pattern of [namedSleep, promisedTimer]) {
    for (const match of code.matchAll(pattern)) {
      const open = match.index + match[0].length - 1;
      if (literalMs(argsOf(code, open, closeOf(code, open))[0]?.text) !== 0) sleeps.push(match.index);
    }
  }
  for (const match of code.matchAll(promiseSleep)) {
    const resolver = match[1] ?? match[2];
    if (!/(?:setTimeout|SetTimeout)$/.test(match[3] ?? '')) continue;
    const open = match.index + match[0].length - 1;
    const [callback, delay] = argsOf(code, open, closeOf(code, open));
    if (callback?.text === resolver && delay !== undefined && literalMs(delay.text) !== 0) sleeps.push(match.index);
  }
  const polls = inLoopBody(code, sleeps);
  for (const offset of sleeps) if (!polls.has(offset)) found.push({ rule: 'sleep', offset });

  // Rule `short-bound`: a Vitest wait with no bound (1 s), or with a literal one under 10 s.
  for (const match of code.matchAll(vitestWait)) {
    const open = match.index + match[0].length - 1;
    const bound = argsOf(code, open, closeOf(code, open))[1];
    const ms = bound === undefined ? VITEST_DEFAULT_MS : bound.text.startsWith('{') ? optionsBound(code, source, bound) : literalMs(bound.text);
    if (isShort(ms)) found.push({ rule: 'short-bound', offset: match.index });
  }
  // A local wait helper called with a short literal anywhere after its condition.
  for (const match of code.matchAll(helperCall)) {
    if (/\bfunction\s*\*?\s*$/.test(code.slice(Math.max(0, match.index - 12), match.index))) continue;
    const open = match.index + match[0].length - 1;
    if (argsOf(code, open, closeOf(code, open)).slice(1).some((arg) => isShort(literalMs(arg.text)))) {
      found.push({ rule: 'short-bound', offset: match.index });
    }
  }
  // A local wait helper whose bound parameter defaults to a short literal.
  for (const pattern of [helperFunction, helperArrow]) {
    for (const match of code.matchAll(pattern)) {
      const open = match.index + match[0].length - 1;
      const close = closeOf(code, open);
      if (pattern === helperArrow && !/^\s*(?::[^;{]*?)?=>/.test(code.slice(close + 1))) continue;
      if (argsOf(code, open, close).some(shortDefault)) found.push({ rule: 'short-bound', offset: match.index });
    }
  }

  // Acceptance reads only the `//` comments blanking found, so `// bound:` written inside a string
  // or a template accepts nothing.
  const commentOn = new Map<number, string>();
  const commentOnly = new Set<number>();
  for (const start of lineComments) {
    const end = source.indexOf('\n', start);
    const line = lineOf(start);
    commentOn.set(line, source.slice(start, end === -1 ? undefined : end));
    // Only whitespace before the `//` in the original: `/* x */ // y` is not a comment line.
    if (source.slice(lineStarts[line], start).trim() === '') commentOnly.add(line);
  }
  const commentLine = (index: number): boolean => commentOnly.has(index);
  const accepted = (index: number): boolean => {
    if (boundComment.test(commentOn.get(index) ?? '')) return true;
    for (let j = index - 1; j >= 0 && commentLine(j); j -= 1) if (boundComment.test(commentOn.get(j) ?? '')) return true;
    return false;
  };

  const sites: Site[] = [];
  for (const { rule, offset } of found) {
    const line = lineOf(offset);
    if (accepted(line)) continue;
    sites.push({ file, rule, line: line + 1, site: lines[line]?.trim() ?? '' });
  }
  const errors = unterminated.map(({ construct, offset }) => {
    const line = lineOf(offset);
    return { file, line: line + 1, construct, text: lines[line]?.trim() ?? '' };
  });
  return { sites: sites.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule)), errors };
}

/**
 * The bound an options object literal gives a Vitest wait, read from its own top-level properties
 * in order: Vitest's 1 s default until a `timeout` names one, then that literal. A spread or a
 * computed key may carry any bound, so after one the bound is unreadable until a later explicit
 * `timeout`. `undefined` is unreadable, and so is anything but a plain object literal.
 */
function optionsBound(code: string, source: string, arg: Item): number | undefined {
  const close = arg.start + arg.text.length - 1;
  if (closeOf(code, arg.start) !== close) return undefined;
  let bound: number | undefined = VITEST_DEFAULT_MS;
  for (const property of argsOf(code, arg.start, close)) {
    const key = propertyKey(source, property);
    if (key === undefined) bound = undefined;
    else if (key.name === 'timeout') bound = literalMs(key.value);
  }
  return bound;
}

/**
 * A property's key and value text. A quoted key is blanked in the code, so its name is read from
 * the original source at the same offsets: `{ "timeout": 100 }` names `timeout`. A spread, a
 * computed key or a quoted key with an escape is `undefined`; a method or a numeric key gets an
 * empty name.
 */
function propertyKey(source: string, property: Item): { name: string; value?: string } | undefined {
  const { text, start } = property;
  if (text.startsWith('...') || text.startsWith('[')) return undefined;
  const quoted = /^(['"])( *)\1\s*:/.exec(text);
  if (quoted) {
    const name = source.slice(start + 1, start + 1 + (quoted[2] ?? '').length);
    // An escape is not decoded: `"\u0074imeout"` may name anything, so it reads like a computed key.
    if (name.includes('\\')) return undefined;
    return { name, value: text.slice(quoted[0].length).trim() };
  }
  const named = /^([A-Za-z_$][\w$]*)\s*(:|$)/.exec(text);
  if (!named) return { name: '' };
  return { name: named[1] ?? '', ...(named[2] === ':' ? { value: text.slice(named[0].length).trim() } : {}) };
}

/** A parameter like `timeoutMs = 5_000`. A poll interval is not a bound, so `intervalMs = 25` is not one. */
function shortDefault(param: Item): boolean {
  const parsed = /^(?:\.\.\.)?([\w$]+)\s*\??\s*(?::[^=]*)?=([\s\S]*)$/.exec(param.text);
  return parsed !== null && !/interval/i.test(parsed[1] ?? '') && isShort(literalMs(parsed[2]?.trim()));
}

/** Every `*.test.ts` and `*.testkit.ts` under `dir`, relative to it, sorted, the scan's own excluded. */
export function scannedFiles(dir = srcDir): string[] {
  const files: string[] = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '__fixtures__') walk(path);
      } else if (/\.(?:test|testkit)\.ts$/.test(entry.name) && !ownFiles.has(path)) files.push(path);
    }
  };
  walk('');
  return files.sort();
}

export function scanSuite(dir = srcDir): { sites: Site[]; errors: ScanError[] } {
  const sites: Site[] = [];
  const errors: ScanError[] = [];
  for (const file of scannedFiles(dir)) {
    const scanned = scanFile(file, readFileSync(join(dir, file), 'utf8'));
    sites.push(...scanned.sites);
    errors.push(...scanned.errors);
  }
  return { sites, errors };
}

/** Sites folded to `(file, rule, site) → count`, sorted for a stable file. */
export function tally(sites: Site[]): BaselineEntry[] {
  const counts = new Map<string, BaselineEntry>();
  for (const { file, rule, site } of sites) {
    const key = JSON.stringify([file, rule, site]);
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { file, rule, site, count: 1 });
  }
  return [...counts.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule) || a.site.localeCompare(b.site),
  );
}

/**
 * `added`: sites the baseline does not cover — a new key, or a known key seen more often than
 * recorded. `stale`: baseline entries the suite no longer has as many of — a fixed site, which
 * the baseline must shrink to match so the ratchet holds at the new level.
 */
export function compareToBaseline(
  actual: BaselineEntry[],
  baseline: BaselineEntry[],
): { added: BaselineEntry[]; stale: BaselineEntry[] } {
  const key = (e: BaselineEntry) => JSON.stringify([e.file, e.rule, e.site]);
  const recorded = new Map(baseline.map((e) => [key(e), e]));
  const seen = new Map(actual.map((e) => [key(e), e]));
  const added = actual
    .filter((e) => (recorded.get(key(e))?.count ?? 0) < e.count)
    .map((e) => ({ ...e, count: e.count - (recorded.get(key(e))?.count ?? 0) }));
  const stale = baseline.filter((e) => (seen.get(key(e))?.count ?? 0) < e.count);
  return { added, stale };
}

interface BaselineFile {
  $comment: string;
  sites: BaselineEntry[];
}

export function readBaseline(path = baselinePath): BaselineEntry[] {
  if (!existsSync(path)) return [];
  return (JSON.parse(readFileSync(path, 'utf8')) as BaselineFile).sites;
}

/**
 * Shrink the baseline to what the suite has now. Never grows it: a site the baseline does not
 * cover stays a failure, so the only way to land one is to wait on the product's signal or give
 * the bound a reason. Run through
 * `TEST_WAIT_DISCIPLINE_UPDATE=1 npm test -- packages/cezar/src/test-wait-discipline.test.ts`.
 */
export function shrinkBaseline(actual: BaselineEntry[], path = baselinePath): void {
  const baseline = readBaseline(path);
  const key = (e: BaselineEntry) => JSON.stringify([e.file, e.rule, e.site]);
  const seen = new Map(actual.map((e) => [key(e), e]));
  const sites = baseline
    .map((e) => ({ ...e, count: Math.min(e.count, seen.get(key(e))?.count ?? 0) }))
    .filter((e) => e.count > 0);
  writeBaseline(sites, path);
}

export function writeBaseline(sites: BaselineEntry[], path = baselinePath): void {
  const file: BaselineFile = {
    $comment:
      'Bare sleeps and short wait bounds the server unit tests carried when the ratchet landed (hearsay-tools/cezarion#1155). ' +
      'Keyed by file, rule and the line text so a moved line does not churn it. ' +
      'This list only shrinks: fix a site, then run TEST_WAIT_DISCIPLINE_UPDATE=1 npm test -- packages/cezar/src/test-wait-discipline.test.ts. ' +
      'Rules: AGENTS.md § Validation.',
    sites,
  };
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
}
