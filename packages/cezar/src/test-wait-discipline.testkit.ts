import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * A source scan of the server unit tests for the three ways a test waits on the wall clock instead
 * of on the product: a bare awaited sleep standing in for a condition nobody named, a wait
 * bounded under SHORT_BOUND_MS, and a poll loop with no deadline or a deadline under
 * SHORT_BOUND_MS. The last three load flakes under hearsay-tools/cezarion#902 had that one cause
 * (hearsay-tools/cezarion#1144, hearsay-tools/cezarion#1145, hearsay-tools/cezarion#1146): a
 * fixed bound on a fixture's own startup, or one bound for a whole sequence of steps, which a
 * loaded host overruns. The rule for authors is in AGENTS.md § Validation.
 *
 * It is a heuristic over source text, not a parser: TypeScript 7 has no JS parser API, and the
 * tests are regular enough that each form fits a pattern. Strings, template literals and
 * comments are blanked first, so the sleeps inside fake-CLI scripts (template literals written
 * to disk as mock binaries) are not this scan's business. A false positive costs one
 * `// bound: <reason>` comment at the site, which is what the rule asks of a real bound anyway.
 *
 * `test-wait-discipline.test.ts` runs it against every `*.test.ts` and `*.testkit.ts` under
 * `packages/cezar/src` and compares the tally with two checked-in baselines that can only shrink,
 * so today's sites stay where they are and no new one lands without a reason. The poll loops have
 * a baseline of their own, so a change to one list never conflicts with a change to the other.
 */

export type Rule = 'sleep' | 'short-bound' | 'poll-deadline';

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
export const pollsBaselinePath = resolve(import.meta.dirname, 'test-wait-discipline-polls.baseline.json');
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

function skipSpaceForward(code: string, from: number): number {
  let k = from;
  while (k < code.length && /\s/.test(code[k] ?? '')) k += 1;
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

const numeric = (text: string | undefined): number | undefined => (text !== undefined && numericLiteral.test(text.trim()) ? Number(text.trim().replace(/_/g, '')) : undefined);

/** `a * b / c` of literals. */
function product(term: string): number | undefined {
  const [first, ...rest] = term.split(/([*/])/);
  let value = numeric(first);
  for (let i = 0; i < rest.length; i += 2) {
    const next = numeric(rest[i + 1]);
    value = value === undefined || next === undefined ? undefined : rest[i] === '*' ? value * next : value / next;
  }
  return value;
}

/**
 * The value of a numeric literal, or of a sum of products of them (`5 * 1000`, `2 * 60 * 1000`), or undefined for
 * anything else. Every rule reads bounds through this, so a bound written as arithmetic is judged like its result.
 */
function literalMs(text: string | undefined): number | undefined {
  const whole = numeric(text);
  if (whole !== undefined || text === undefined) return whole;
  const terms = text.split('+').map(product);
  return terms.every((term) => term !== undefined) ? terms.reduce<number>((sum, term) => sum + (term ?? 0), 0) : undefined;
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

/** A loop that holds a poll sleep, as offsets into the blanked code. */
interface PollLoop {
  /** The loop's `for`, `while` or `do`: the site is the line this sits on. */
  keyword: number;
  /** The header's parentheses; for a `do`, those of its trailing `while (…)`; absent for `for (;;)`-less `do`. */
  head?: [number, number];
  /** The body's first and last character; a brace-less body runs to the `;` that ends its statement. */
  body: [number, number];
  /** Where the nearest enclosing function's parameter list starts, or 0: how far back a deadline may be defined. */
  scope: number;
}

function startOfWord(code: string, end: number): number {
  return end - wordEndingAt(code, end).length + 1;
}

/**
 * The innermost loop each offset in `offsets` sits in, for the offsets that sit in one: inside a
 * `for`/`while`/`do` block with no function body between, or the brace-less body of a loop header
 * (`while (!ready()) await …`). A sleep in a loop is a poll interval, not a bare sleep; the loop's
 * own deadline is judged by `pollDeadline`.
 *
 * A concise arrow's body is a function body too (`it(r, async () => await sleep(300))`). It opens
 * at a `=>` not followed by `{` and ends at the `,` or `;` that ends its expression, or at the
 * bracket that closes the one it sits in; `(` and `[` are tracked for that alone. Without its `;`,
 * a concise arrow statement runs to the enclosing `}`: that only flags more, never exempts more.
 */
function pollLoops(code: string, offsets: number[]): Map<number, PollLoop> {
  const found = new Map<number, PollLoop>();
  const queue = [...offsets].sort((a, b) => a - b);
  const stack: Entry[] = [];
  let q = 0;
  for (let i = 0; i < code.length && q < queue.length; i += 1) {
    for (; queue[q] === i; q += 1) {
      const loop = loopAround(code, stack, i);
      if (loop) found.set(i, loop);
    }
    track(code, stack, i);
  }
  return found;
}

/** A `{` frame, a `(`/`[` group, or a concise arrow's body; `open` is where it began. */
interface Entry {
  kind: Frame | 'group' | 'arrow';
  open: number;
}

/** The innermost loop the code at `at` sits in, when no function body lies between them. */
function loopAround(code: string, stack: Entry[], at: number): PollLoop | undefined {
  let scope = 0;
  let open: number | undefined;
  for (let f = stack.length - 1; f >= 0; f -= 1) {
    const frame = stack[f];
    if (frame?.kind === 'function' || frame?.kind === 'arrow') {
      scope = paramsStart(code, frame.open);
      break;
    }
    if (frame?.kind === 'loop' && open === undefined) open = frame.open;
  }
  return bracelessLoop(code, at, scope) ?? (open === undefined ? undefined : bracedLoop(code, open, scope));
}

/** Update the frames for the character at `i`. */
function track(code: string, stack: Entry[], i: number): void {
  const ch = code[i];
  const endArrows = (): void => {
    while (stack.at(-1)?.kind === 'arrow') stack.pop();
  };
  if (ch === '{') stack.push({ kind: frameOf(code, i), open: i });
  else if (ch === '(' || ch === '[') stack.push({ kind: 'group', open: i });
  else if (ch === '}' || ch === ')' || ch === ']') {
    endArrows();
    stack.pop();
  } else if (ch === ',' || ch === ';') endArrows();
  else if (ch === '=' && code[i + 1] === '>' && code[skipSpaceForward(code, i + 2)] !== '{') stack.push({ kind: 'arrow', open: i });
}

/** The loop whose `{` is at `open`. */
function bracedLoop(code: string, open: number, scope: number): PollLoop {
  const body: [number, number] = [open, closeOf(code, open)];
  const k = skipSpaceBack(code, open - 1);
  if (code[k] === ')') {
    const paren = openOf(code, k);
    let keyword = startOfWord(code, skipSpaceBack(code, paren - 1));
    if (code.startsWith('await', keyword)) keyword = startOfWord(code, skipSpaceBack(code, keyword - 1));
    return { keyword, head: [paren, k], body, scope };
  }
  // `do { … } while (…)`: the trailing condition is the loop's header.
  const keyword = startOfWord(code, k);
  const after = skipSpaceForward(code, body[1] + 1);
  const paren = code.startsWith('while', after) ? skipSpaceForward(code, after + 'while'.length) : -1;
  return code[paren] === '(' ? { keyword, head: [paren, closeOf(code, paren)], body, scope } : { keyword, body, scope };
}

/** The loop the statement at `offset` is the brace-less body of, through any `if (…)` heads. */
function bracelessLoop(code: string, offset: number, scope: number): PollLoop | undefined {
  const semicolon = code.indexOf(';', offset);
  const body: [number, number] = [offset, semicolon === -1 ? code.length : semicolon];
  let k = skipSpaceBack(code, offset - 1);
  if (wordEndingAt(code, k) === 'do') return { keyword: startOfWord(code, k), body, scope };
  while (code[k] === ')') {
    const paren = openOf(code, k);
    if (paren === -1) return undefined;
    const headEnd = skipSpaceBack(code, paren - 1);
    const head = wordEndingAt(code, headEnd);
    const before = skipSpaceBack(code, headEnd - head.length);
    if (head === 'for' || head === 'while') return { keyword: startOfWord(code, headEnd), head: [paren, k], body, scope };
    if (head === 'await' && wordEndingAt(code, before) === 'for') return { keyword: startOfWord(code, before), head: [paren, k], body, scope };
    if (head !== 'if') return undefined;
    k = before;
  }
  return undefined;
}

/** Where the parameter list of the function whose body opens at `open` starts; `open` itself when it has none to read. */
function paramsStart(code: string, open: number): number {
  let k = skipSpaceBack(code, open - 1);
  if (code[k] === '>' && code[k - 1] === '=') k = skipSpaceBack(code, k - 2);
  if (code[k] !== ')') {
    // `): T {`: a return type sits between the `)` and the `{`.
    const lineStart = code.lastIndexOf('\n', open) + 1;
    const typed = /\)\s*:[^;{}()=]*$/.exec(code.slice(lineStart, open));
    if (!typed) return open;
    k = lineStart + typed.index;
  }
  const paren = openOf(code, k);
  return paren === -1 ? open : paren;
}

/** `Date.now()`, `performance.now()` and `process.hrtime()`, the clocks a deadline is read from. */
const clockCall = String.raw`(?:Date\s*\.\s*now|performance\s*\.\s*now|process\s*\.\s*hrtime(?:\s*\.\s*bigint)?)\s*\(\s*\)`;
const clockRead = new RegExp(clockCall);
const comparator = String.raw`(?:<=?|>=?)`;
/** `Date.now() - start > 15_000`: the bound is the last group, up to the end of the expression. */
const elapsedBounds = new RegExp(String.raw`${clockCall}\s*-\s*[\w$.]+\s*${comparator}\s*([^;)&|{,]+)`, 'g');
/** `Date.now() < deadline` or `deadline < Date.now()`: the deadline's name. */
const deadlineNames = new RegExp(String.raw`${clockCall}\s*${comparator}\s*([A-Za-z_$][\w$]*)|\b([A-Za-z_$][\w$]*)\s*${comparator}\s*${clockCall}`, 'g');
/** An attempt counter by its name, compared with a limit (`tries++ > 20`, `retries < 5`): a count the scan cannot turn into time. A counter that is only stepped bounds nothing. */
const counterName = /\b\w*(?:attempt|retry|retries|tries|count|iteration|remaining)\w*\s*(?:\+\+|--)?\s*(?<!=)(?:<=?|>=?)|(?<!=)(?:<=?|>=?)\s*(?:\+\+|--)?\s*\w*(?:attempt|retry|retries|tries|count|iteration|remaining)/i;

type Deadline = 'none' | 'unreadable' | number;

const inFunction = (stack: Entry[], free: number): boolean => stack.filter((entry) => entry.kind === 'function' || entry.kind === 'arrow').length > free;

/**
 * The code between two offsets with the functions nested in it blanked: what a helper compares, counts
 * or declares is its own, and says nothing about the loop. `free` is the number of function frames
 * that are the text's own surroundings, such as the body of the function a scope starts at.
 */
function ownText(code: string, from: number, to: number, free = 0): string {
  const stack: Entry[] = [];
  let text = '';
  for (let i = from; i < to; i += 1) {
    const before = inFunction(stack, free);
    track(code, stack, i);
    const blank = before || inFunction(stack, free);
    text += blank && code[i] !== '\n' ? ' ' : (code[i] ?? '');
  }
  return text;
}

/** The text of a loop's function up to `upto`, without the functions nested in it. */
const scopeBefore = (code: string, loop: PollLoop, upto: number): string => ownText(code, loop.scope, upto, loop.scope === 0 ? 0 : 1);

const compare = String.raw`(?<!=)(?:<=?|>=?)`;
const clockCompared = new RegExp(String.raw`${clockCall}[^;{}]*${compare}|${compare}[^;{}]*${clockCall}`);
const clockAssigned = new RegExp(String.raw`\b([A-Za-z_$][\w$]*)\s*=\s*[^;=]*${clockCall}`, 'g');

/** Whether a loop compares the clock with anything, directly or through a name assigned from it (`elapsed = Date.now() - t0`). */
function comparesClock(region: string): boolean {
  if (clockCompared.test(region)) return true;
  return [...region.matchAll(clockAssigned)].some(([, name]) => {
    const escaped = (name ?? '').replace(/\$/g, '\\$');
    return new RegExp(String.raw`(?<![\w$.])${escaped}\s*${compare}|${compare}\s*${escaped}(?![\w$])`).test(region);
  });
}

/**
 * The time a poll loop gives its sleeps before it gives up, in milliseconds. `none`: the loop reads
 * no clock and counts no attempt, so only the test's own timeout ends it. `unreadable`: a bound
 * exists but is held where this scan does not look (a caller's argument, a module constant, an
 * expression), which it leaves alone like every other rule's bound it cannot read.
 *
 * It reads three forms: the elapsed time against a literal (`Date.now() - start > 15_000`); a
 * deadline held in a name, defined as the clock plus a literal in the loop's own function
 * (`const deadline = Date.now() + 15_000`); and an attempt count where the count and each sleep's
 * delay are literals, whose product is the time (`attempt < 20` with `sleep(100)` is 2 s). A literal
 * may also stand behind a name: a parameter's default, or a constant of the same function.
 * A loop over a collection or a stream is bounded by it. A clock the loop reads but never compares
 * bounds nothing, and the functions nested in the loop are not read at all.
 */
function pollDeadline(code: string, loop: PollLoop, delays: Array<string | undefined>): Deadline {
  const header = loop.head ? code.slice(loop.head[0] + 1, loop.head[1]) : '';
  if (!header.includes(';') && /\s(?:of|in)\s/.test(header)) return 'unreadable';
  const region = ownText(code, loop.keyword, Math.max(loop.body[1], loop.head?.[1] ?? 0) + 1);
  if (!clockRead.test(region) || !comparesClock(region)) return attemptDeadline(code, loop, header, region, delays);
  // The scan cannot tell a comparison that ends the loop from one that does not, so the loop has the largest bound it reads.
  const bounds = [
    ...[...region.matchAll(elapsedBounds)].map((match) => literalBound(code, loop, (match[1] ?? '').trim())),
    ...[...region.matchAll(deadlineNames)].map((match) => definedBound(code, loop, match[1] ?? match[2] ?? '')),
  ].filter((bound): bound is number => typeof bound === 'number');
  return bounds.length > 0 ? Math.max(...bounds) : 'unreadable';
}

/** A deadline held in a name: the last `name = Date.now() + <bound>` before the loop, or in its own header. */
function definedBound(code: string, loop: PollLoop, deadline: string): Deadline {
  const upto = loop.head ? Math.min(loop.head[1], loop.body[0]) : loop.keyword;
  const definition = new RegExp(String.raw`\b${deadline.replace(/\$/g, '\\$')}\s*=\s*${clockCall}\s*\+\s*([^;,)]+)`, 'g');
  const defined = [...scopeBefore(code, loop, upto).matchAll(definition)].at(-1);
  return defined ? literalBound(code, loop, (defined[1] ?? '').trim()) : 'unreadable';
}

/** The loop's bound `text` in milliseconds: a literal, or a name for one in the same function. */
function literalBound(code: string, loop: PollLoop, text: string): Deadline {
  const direct = literalMs(text);
  if (direct !== undefined) return direct;
  if (!/^[A-Za-z_$][\w$]*$/.test(text)) return 'unreadable';
  const name = text.replace(/\$/g, '\\$');
  const scope = scopeBefore(code, loop, loop.keyword);
  const parameter = new RegExp(String.raw`\b${name}\s*(?::[^=,);]*)?=\s*([^,);]+?)\s*[,)]`).exec(scope);
  const constant = [...scope.matchAll(new RegExp(String.raw`\b(?:const|let)\s+${name}\s*(?::[^=;]*)?=\s*([^;,\n]+)`, 'g'))].at(-1);
  return literalMs(parameter?.[1]?.trim()) ?? literalMs(constant?.[1]?.trim()) ?? 'unreadable';
}

const escapeName = (name: string): string => name.replace(/\$/g, '\\$');

/** Where a counter starts, from `let name = 0`. */
function counterStart(init: string, name: string, read: (text: string) => number | undefined): number | undefined {
  const started = new RegExp(String.raw`^\s*(?:(?:let|var|const)\s+)?${escapeName(name)}\s*(?::[^=]*)?=\s*([^,;]+?)\s*$`).exec(init);
  return read(started?.[1] ?? '');
}

/** What an update adds to a counter, signed: `name++`, `++name`, `name += 5`, `name = name + 5`, and the same with `-`. */
function counterStep(update: string, name: string, read: (text: string) => number | undefined): number | undefined {
  const n = escapeName(name);
  const stepped = new RegExp(String.raw`^\s*(?:${n}\s*(\+\+|--)|(\+\+|--)\s*${n}|${n}\s*([+-])=\s*([^,;]+?)|${n}\s*=\s*${n}\s*([+-])\s*([^,;]+?))\s*$`).exec(update);
  if (!stepped) return undefined;
  const amount = stepped[4] ?? stepped[6];
  const size = amount === undefined ? 1 : read(amount);
  const down = (stepped[1] ?? stepped[2] ?? stepped[3] ?? stepped[5])?.startsWith('-');
  return size === undefined ? undefined : down ? -size : size;
}

/**
 * How many times `for (init; name <op> limit; update)` runs, when `init` starts the counter at a literal, `limit` is a
 * literal and `update` moves it by a literal toward the limit (up for `<` and `<=`, down for `>` and `>=`).
 */
function iterations(init: string, update: string, name: string, operator: string, limit: number | undefined, read: (text: string) => number | undefined): number | undefined {
  const start = counterStart(init, name, read);
  const step = counterStep(update, name, read);
  const up = operator.startsWith('<');
  if (start === undefined || limit === undefined || step === undefined || step === 0 || up !== step > 0) return undefined;
  const span = up ? limit - start : start - limit;
  return Math.max(0, operator.endsWith('=') ? Math.floor(span / Math.abs(step)) + 1 : Math.ceil(span / Math.abs(step)));
}

/** A loop with no clock: an attempt count times the sleep's delay, when both are literals (or names for them). */
function attemptDeadline(code: string, loop: PollLoop, header: string, region: string, delays: Array<string | undefined>): Deadline {
  const read = (text: string): number | undefined => {
    const bound = literalBound(code, loop, text.trim());
    return typeof bound === 'number' ? bound : undefined;
  };
  const clauses = header.split(';');
  if (clauses.length === 3) {
    const test = /^\s*([A-Za-z_$][\w$]*)\s*(<=?|>=?)\s*([^&|]+?)\s*(?:&&|\|\||$)/.exec(clauses[1] ?? '');
    const intervals = delays.map((delay) => read(delay ?? ''));
    const delay = intervals.every((interval) => interval !== undefined) ? intervals.reduce<number>((sum, interval) => sum + (interval ?? 0), 0) : undefined;
    if (test) {
      const count = iterations(clauses[0] ?? '', clauses[2] ?? '', test[1] ?? '', test[2] ?? '', read(test[3] ?? ''), read);
      return count === undefined || !delay ? 'unreadable' : count * delay;
    }
    // `for (…; test; step)` counts something this scan does not read.
    if ((clauses[1] ?? '').trim() !== '' && (clauses[2] ?? '').trim() !== '') return 'unreadable';
  }
  return counterName.test(region) ? 'unreadable' : 'none';
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

/** One rule's hit: the offset of the call (or loop) it is keyed on. */
interface Found {
  rule: Rule;
  offset: number;
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
  const accepted = boundAccepted(source, lineComments, lineStarts, lineOf);

  const sites: Site[] = [];
  for (const { rule, offset } of [...sleepSites(code), ...boundSites(code, source)]) {
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

/** Every awaited timer with any delay but a literal 0 (one event-loop turn), with its delay's text. */
function awaitedSleeps(code: string): Array<{ offset: number; delay: string | undefined }> {
  const sleeps: Array<{ offset: number; delay: string | undefined }> = [];
  for (const pattern of [namedSleep, promisedTimer]) {
    for (const match of code.matchAll(pattern)) {
      const open = match.index + match[0].length - 1;
      const delay = argsOf(code, open, closeOf(code, open))[0]?.text;
      sleeps.push({ offset: match.index, delay });
    }
  }
  for (const match of code.matchAll(promiseSleep)) {
    const resolver = match[1] ?? match[2];
    if (!/(?:setTimeout|SetTimeout)$/.test(match[3] ?? '')) continue;
    const open = match.index + match[0].length - 1;
    const [callback, delay] = argsOf(code, open, closeOf(code, open));
    if (callback?.text === resolver && delay !== undefined) sleeps.push({ offset: match.index, delay: delay.text });
  }
  return sleeps;
}

/**
 * Rule `sleep`: an awaited timer outside a loop. Rule `poll-deadline`: a sleep in a loop is a poll
 * interval, so the loop is judged by its own deadline instead, once per loop however many sleeps it holds.
 */
function sleepSites(code: string): Found[] {
  const sleeps = awaitedSleeps(code);
  const loops = pollLoops(code, sleeps.map((sleep) => sleep.offset));
  const found: Found[] = [];
  const delaysOf = new Map<number, { loop: PollLoop; delays: Array<string | undefined> }>();
  for (const { offset, delay } of sleeps) {
    const loop = loops.get(offset);
    // A zero delay outside a loop only yields to the event loop. In a loop it is the poll interval of a spin.
    if (!loop) {
      if (literalMs(delay) !== 0) found.push({ rule: 'sleep', offset });
    } else delaysOf.set(loop.keyword, { loop, delays: [...(delaysOf.get(loop.keyword)?.delays ?? []), delay] });
  }
  for (const { loop, delays } of delaysOf.values()) {
    const deadline = pollDeadline(code, loop, delays);
    if (deadline === 'none' || (typeof deadline === 'number' && isShort(deadline))) found.push({ rule: 'poll-deadline', offset: loop.keyword });
  }
  return found;
}

/** Rule `short-bound`: a Vitest wait with no bound (1 s), or with a literal one under 10 s, and the local helpers alike. */
function boundSites(code: string, source: string): Found[] {
  const found: Found[] = [];
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
  return found;
}

/**
 * Whether the line at an index holds a `// bound: <reason>`, or sits under a block of comment lines
 * that does. Acceptance reads only the `//` comments blanking found, so `// bound:` written inside
 * a string or a template accepts nothing.
 */
function boundAccepted(
  source: string,
  lineComments: number[],
  lineStarts: number[],
  lineOf: (offset: number) => number,
): (index: number) => boolean {
  const commentOn = new Map<number, string>();
  const commentOnly = new Set<number>();
  for (const start of lineComments) {
    const end = source.indexOf('\n', start);
    const line = lineOf(start);
    commentOn.set(line, source.slice(start, end === -1 ? undefined : end));
    // Only whitespace before the `//` in the original: `/* x */ // y` is not a comment line.
    if (source.slice(lineStarts[line], start).trim() === '') commentOnly.add(line);
  }
  return (index) => {
    if (boundComment.test(commentOn.get(index) ?? '')) return true;
    for (let j = index - 1; j >= 0 && commentOnly.has(j); j -= 1) if (boundComment.test(commentOn.get(j) ?? '')) return true;
    return false;
  };
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

/** One checked-in baseline: the rules whose sites it holds, and the comment its file opens with. */
export interface Baseline {
  /** What its sites are, for the failure message. */
  what: string;
  path: string;
  comment: string;
  rules: readonly Rule[];
}

const baselineTail =
  'Keyed by file, rule and the line text so a moved line does not churn it. ' +
  'This list only shrinks: fix a site, then run TEST_WAIT_DISCIPLINE_UPDATE=1 npm test -- packages/cezar/src/test-wait-discipline.test.ts. ' +
  'Rules: AGENTS.md § Validation.';

export const baselines: readonly Baseline[] = [
  {
    what: 'bare sleep or short wait bound',
    path: baselinePath,
    comment: `Bare sleeps and short wait bounds the server unit tests carried when the ratchet landed (hearsay-tools/cezarion#1155). ${baselineTail}`,
    rules: ['sleep', 'short-bound'],
  },
  {
    what: 'poll loop with no deadline or one under 10 s',
    path: pollsBaselinePath,
    comment: `Poll loops the server unit tests carried when the deadline rule landed (hearsay-tools/cezarion#1203). ${baselineTail}`,
    rules: ['poll-deadline'],
  },
];

export function readBaseline(path = baselinePath): BaselineEntry[] {
  if (!existsSync(path)) return [];
  return (JSON.parse(readFileSync(path, 'utf8')) as BaselineFile).sites;
}

/**
 * Shrink the baseline to what the suite has now. Never grows it: a site the baseline does not
 * cover stays a failure, so the only way to land one is to wait on the product's signal or give
 * the bound a reason. A baseline that does not exist yet is written once from `actual`, which is
 * how a new rule lands its first list. Run through
 * `TEST_WAIT_DISCIPLINE_UPDATE=1 npm test -- packages/cezar/src/test-wait-discipline.test.ts`.
 */
export function shrinkBaseline(actual: BaselineEntry[], baseline: Baseline = baselines[0]!): void {
  if (!existsSync(baseline.path)) {
    writeBaseline(actual, baseline);
    return;
  }
  const key = (e: BaselineEntry) => JSON.stringify([e.file, e.rule, e.site]);
  const seen = new Map(actual.map((e) => [key(e), e]));
  const sites = readBaseline(baseline.path)
    .map((e) => ({ ...e, count: Math.min(e.count, seen.get(key(e))?.count ?? 0) }))
    .filter((e) => e.count > 0);
  writeBaseline(sites, baseline);
}

export function writeBaseline(sites: BaselineEntry[], baseline: Baseline = baselines[0]!): void {
  const file: BaselineFile = { $comment: baseline.comment, sites };
  // `\u` escapes keep the checked-in files ASCII, so two runs on two branches write the same bytes.
  const json = JSON.stringify(file, null, 2).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  writeFileSync(baseline.path, `${json}\n`);
}
