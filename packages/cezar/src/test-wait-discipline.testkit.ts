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
 * What `poll-deadline` reads as a deadline is this list and nothing else. Both scans implement it, and both test every line of it.
 * A loop is as long as its earliest exit, and only these exits count:
 *   1. The loop's own condition: the test of a `while`, a `do … while` or a `for`.
 *   2. `if (<condition>) break`, `return` or `throw`, written as a statement of the loop body itself (the branch is the leave,
 *      or a block with the leave among its own statements), before any statement that holds a `continue`. An `if` inside
 *      another `if`, an `else`, a `switch`, a `try`, a block or an inner loop may never be reached, and the `else` of an
 *      `if` is not an exit on its test.
 * A condition is read from these parts, joined by `&&` (it ends once either part does), `||` (once both do) and `!`. A counted
 * condition is a pure read: no write (`=`, `+=`, `++`, `--`) and no call in it, but the clock, or the part is no bound.
 *   - a clock comparison with `<`, `<=`, `>` or `>=`, never `==` or `!=`, and as the whole part: `now - start` against a limit,
 *     `now` against `start + limit` or a deadline, or a name the loop sets from the clock (`const elapsed = Date.now() - start`).
 *     `now` is `Date.now()`, `performance.now()` or `process.hrtime()`. A limit is a literal sum of products (`5 * 1_000`) or one
 *     name or path. A start is a read of the clock, a deadline a read of the clock plus a limit. A name set to any other
 *     expression is no start, deadline or limit. The loop never declares them again,
 *     writes them or leaves them to a closure that writes. A name it sets from the clock is set once, as a statement of the body
 *     itself before any `continue`: a write in a branch may keep an old value.
 *   - the counter of a `for (let|var i = <literal>; i < limit; i++)` header: one declarator, `<` or `<=` against a limit the loop
 *     never changes, and a step of `i++`, `++i` or `i += <positive literal>`. A count down, a step in the test (`i++ < 20`) or a
 *     write in the body is no bound. It gives the iterations times the sleeps every pass reaches.
 * Numbers are evaluated, not matched: literals with separators and other bases, unary `+` and `-`, parentheses, `as`, `satisfies`
 * and non-null wrappers, `+ - * / % **`, and, for a wait bound or a delay, `Math.max`, `min`, `abs`, `floor`, `ceil`, `round` and
 * `trunc` of those. A name is looked up in the function around its use and in every function around that one, up to the module,
 * at the use: the nearest declaration hides the ones further out, and a `const` of an outer scope counts wherever it sits, since a
 * function runs after the module has loaded. A `let` or `var` of an outer scope is read only when nothing writes it after its declaration. A wait bound
 * that is negative, zero, `NaN`, infinite or past a timer's limit is below the floor.
 * A part on the list is left alone only for a value that comes from outside the file or from the function's parameters (a
 * parameter, an import, a global, a property of an argument): the caller sizes it. A value the file declares and the scan cannot
 * evaluate (a call, a ternary, a destructured binding, a `let` written after its declaration, a name set to one of those) is never
 * left alone: as a limit, start, deadline or delay it bounds nothing, and as a wait bound it is below the floor. Any other shape
 * has no bound: a ternary, `??`, a call, arithmetic on the clock, an equality, a counter the body steps, a start the loop
 * resets, a flag set in a branch. A loop with no bound on the list is reported, unless `// bound: <reason>` accepts it. A loop
 * over a collection or a stream ends with it, and a count of passes that sleep nothing says nothing in milliseconds.
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

/** The names of JavaScript's own numbers that the evaluator reads. */
const namedNumbers = new Map<string, number>([
  ['NaN', NaN], ['Infinity', Infinity], ['Number.NaN', NaN], ['Number.POSITIVE_INFINITY', Infinity], ['Number.NEGATIVE_INFINITY', -Infinity],
  ['Number.MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER], ['Number.MIN_SAFE_INTEGER', Number.MIN_SAFE_INTEGER], ['Number.MAX_VALUE', Number.MAX_VALUE],
]);

const numberToken = /\s*(0[xXoObB][\da-fA-F_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)/y;
const wordToken = /\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/y;
const operatorToken = /\s*(\*\*|[-+*/%()!,])/y;

/** The functions of `Math` that the evaluator reads, on numbers it can read. */
const mathFunctions = new Map<string, (...values: number[]) => number>([
  ['Math.max', Math.max], ['Math.min', Math.min], ['Math.abs', Math.abs], ['Math.floor', Math.floor], ['Math.ceil', Math.ceil], ['Math.round', Math.round], ['Math.trunc', Math.trunc],
]);
const angleAssertion = /\s*<[\w$.[\]| ]+>/y;

/**
 * The value of a numeric expression: number literals (`_` separators, exponents, hex), `NaN`, `Infinity`, unary `+` and `-`,
 * parentheses, `as` / `satisfies` / non-null wrappers, `+ - * / % **` of those, and `Math.max`, `min`, `abs`, `floor`, `ceil`,
 * `round` and `trunc` of those. `undefined` for anything else, which is an expression the scan cannot read. A name is read through
 * `names`, when given. Every rule reads bounds through this, so a bound written as arithmetic is judged like its result.
 */
function literalMs(text: string | undefined, names?: (name: string) => number | undefined): number | undefined {
  if (text === undefined) return undefined;
  let at = 0;
  const next = (pattern: RegExp): string | undefined => {
    pattern.lastIndex = at;
    const found = pattern.exec(text);
    if (!found) return undefined;
    at = pattern.lastIndex;
    return found[1];
  };
  const peek = (): string | undefined => {
    const saved = at;
    const token = next(operatorToken) ?? next(wordToken);
    at = saved;
    return token;
  };
  // `500 as number`, `500 as const`, `500 satisfies number` and `500!`: a wrapper changes the type, not the value.
  const wrapped = (value: number | undefined): number | undefined => {
    for (;;) {
      const token = peek();
      if (token === 'as' || token === 'satisfies') {
        next(wordToken);
        if (next(wordToken) === undefined) return undefined;
      } else if (token === '!' && text[text.indexOf('!', at) + 1] !== '=') next(operatorToken);
      else return value;
    }
  };
  const primary = (): number | undefined => {
    if (peek() === '(') {
      next(operatorToken);
      const inner = sum();
      return next(operatorToken) === ')' ? wrapped(inner) : undefined;
    }
    const literal = next(numberToken);
    if (literal !== undefined) return wrapped(numeric(literal));
    const word = next(wordToken);
    if (word === undefined) return undefined;
    const fn = mathFunctions.get(word);
    if (fn !== undefined && peek() === '(') return wrapped(call(fn));
    return wrapped(namedNumbers.has(word) ? namedNumbers.get(word) : names?.(word));
  };
  const call = (fn: (...values: number[]) => number): number | undefined => {
    next(operatorToken);
    const args: number[] = [];
    let token: string | undefined;
    do {
      const arg = sum();
      if (arg === undefined) return undefined;
      args.push(arg);
      token = next(operatorToken);
    } while (token === ',');
    return token === ')' ? fn(...args) : undefined;
  };
  const unary = (): number | undefined => {
    // `<number>500`: a type assertion changes the type, not the value.
    angleAssertion.lastIndex = at;
    if (angleAssertion.test(text)) at = angleAssertion.lastIndex;
    const sign = peek();
    if (sign !== '-' && sign !== '+') return primary();
    next(operatorToken);
    const value = unary();
    return value === undefined ? undefined : sign === '-' ? -value : value;
  };
  const power = (): number | undefined => {
    const base = unary();
    if (peek() !== '**') return base;
    next(operatorToken);
    const exponent = power();
    return base === undefined || exponent === undefined ? undefined : base ** exponent;
  };
  const product = (): number | undefined => {
    let value = power();
    for (let operator = peek(); value !== undefined && (operator === '*' || operator === '/' || operator === '%'); operator = peek()) {
      next(operatorToken);
      const right = power();
      value = right === undefined ? undefined : operator === '*' ? value * right : operator === '/' ? value / right : value % right;
    }
    return value;
  };
  function sum(): number | undefined {
    let value = product();
    for (let operator = peek(); value !== undefined && (operator === '+' || operator === '-'); operator = peek()) {
      next(operatorToken);
      const right = product();
      value = right === undefined ? undefined : operator === '+' ? value + right : value - right;
    }
    return value;
  }
  const value = sum();
  return value !== undefined && /^\s*$/.test(text.slice(at)) ? value : undefined;
}

/** What Vitest's `vi.waitFor`, `vi.waitUntil` and `expect.poll` wait when given no `timeout`. */
const VITEST_DEFAULT_MS = 1_000;

/** The longest delay a timer keeps: a larger one fires after 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** A wait bound is short unless it is a finite number of 10 s or more that a timer keeps: a negative, zero, `NaN`, infinite or overflowing one fires at once. */
const isShort = (ms: number | undefined): boolean => ms !== undefined && !(ms >= SHORT_BOUND_MS && ms <= MAX_TIMER_MS);

/** A poll loop's deadline is short unless it is a finite number of 10 s or more. */
const isShortDeadline = (ms: number): boolean => !(ms >= SHORT_BOUND_MS && Number.isFinite(ms));

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
  /** A stand-in for a wait: a parameter's default is not its bound, since the helper that declares the parameter is judged on its own. */
  wait?: true;
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
const comparator = String.raw`(?:<=?|>=?)`;
/** What a clock comparison measures against: a literal sum of products (`5 * 1_000`, `2_000 + 500`) or one name or path. Anything else is a shape the scan does not read. */
const limitToken = String.raw`(?:\d[\w.]*(?:\s*[-+*/]\s*\d[\w.]*)*|[A-Za-z_$][\w$.]*)`;
/** `Date.now() - start > 15_000` and `15_000 < Date.now() - start`: the start and the bound, in either form. */
const elapsedBounds = new RegExp(String.raw`${clockCall}\s*-\s*([A-Za-z_$][\w$.]*)\s*${comparator}\s*(${limitToken})|(${limitToken})\s*${comparator}\s*${clockCall}\s*-\s*([A-Za-z_$][\w$.]*)`, 'g');
/** `Date.now() < start + 15_000` and `start + 15_000 > Date.now()`: the start and the term added to it, in either form. */
const sumBounds = new RegExp(String.raw`${clockCall}\s*${comparator}\s*([A-Za-z_$][\w$.]*)\s*\+\s*(${limitToken})|([A-Za-z_$][\w$.]*)\s*\+\s*(${limitToken})\s*${comparator}\s*${clockCall}`, 'g');
/** `Date.now() < deadline` or `deadline < Date.now()`: the deadline's name. */
const deadlineNames = new RegExp(String.raw`${clockCall}\s*${comparator}\s*([A-Za-z_$][\w$]*)|\b([A-Za-z_$][\w$]*)\s*${comparator}\s*${clockCall}`, 'g');
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
    // The bracket or separator that ends a concise arrow belongs to the code around it: blanking it would unbalance the text.
    const endsArrow = stack.at(-1)?.kind === 'arrow' && ')]},;'.includes(code[i] ?? '');
    track(code, stack, i);
    const blank = inFunction(stack, free) || (before && !endsArrow);
    text += blank && code[i] !== '\n' ? ' ' : (code[i] ?? '');
  }
  return text;
}

/** The functions nested in the code between two offsets, with everything else blanked: where a closure can write a name. */
function closureText(code: string, from: number, to: number, free = 0): string {
  const own = ownText(code, from, to, free);
  let text = '';
  for (let i = from; i < to; i += 1) text += own[i - from] === ' ' && code[i] !== ' ' && code[i] !== '\n' ? (code[i] ?? '') : code[i] === '\n' ? '\n' : ' ';
  return text;
}

/** The starts of the functions around the one that starts at `scope`, outermost first, then `scope` itself: where each lexical scope begins. */
function scopeChain(code: string, scope: number): number[] {
  const stack: Entry[] = [];
  for (let i = 0; i < scope; i += 1) track(code, stack, i);
  const around = stack.filter((entry) => entry.kind === 'function' || entry.kind === 'arrow').map((entry) => paramsStart(code, entry.open));
  return scope === 0 ? [] : [...around, scope];
}

let outerCache: { code: string; scope: number; text: string; bounds: number[] } | undefined;

/**
 * The text before a loop's function, as each scope around it sees it: the module, and every function around the loop, with the
 * functions that sit beside the loop's own blanked. A name used in the loop is looked up in it after the loop's own function.
 * `bounds` are where each scope starts, outermost first, ending with the loop's own function.
 */
function outerOf(code: string, scope: number): { text: string; bounds: number[] } {
  if (outerCache?.code === code && outerCache.scope === scope) return outerCache;
  const bounds = [0, ...scopeChain(code, scope)];
  let text = '';
  for (let i = 0; i + 1 < bounds.length; i += 1) text += ownText(code, bounds[i] ?? 0, bounds[i + 1] ?? 0, i === 0 ? 0 : 1);
  outerCache = { code, scope, text, bounds };
  return outerCache;
}

/**
 * The text up to `upto` that the code at `upto` reads names from, at the same offsets as `code`: the module and the functions
 * around the loop's, then the loop's own function, each without the functions nested in it.
 */
const scopeBefore = (code: string, loop: PollLoop, upto: number): string => outerOf(code, loop.scope).text + ownText(code, loop.scope, upto, loop.scope === 0 ? 0 : 1);

const compare = String.raw`(?<!=)(?:<=?|>=?)`;
const escapeName = (name: string): string => name.replace(/\$/g, '\\$');

/** A bound on how long a loop runs, in milliseconds: `unreadable` when one exists the scan cannot evaluate, `undefined` when there is none. */
type Bound = number | 'unreadable' | undefined;

/** Where a counter starts, from `let name = 0` or `var name = 0`: the only declaration of the header, with a literal. */
function counterStart(init: string, name: string, { read }: Reader): number | undefined {
  const started = new RegExp(String.raw`^\s*(?:let|var)\s+${escapeName(name)}\s*(?::[^=,]*)?=\s*([^,;]+?)\s*$`).exec(init);
  return read(started?.[1] ?? '');
}

/**
 * What an update adds to a counter: `name++`, `++name` or `name += <positive literal>`. `unreadable` when the amount is a name;
 * any other update is `undefined`.
 */
function counterStep(update: string, name: string, { read, outside }: Reader): number | 'unreadable' | undefined {
  const n = escapeName(name);
  const stepped = new RegExp(String.raw`^\s*(?:${n}\s*\+\+|\+\+\s*${n}|${n}\s*\+=\s*([^,;]+?))\s*$`).exec(update);
  if (!stepped) return undefined;
  if (stepped[1] === undefined) return 1;
  const size = read(stepped[1]);
  if (size === undefined) return outside(stepped[1].trim()) ? 'unreadable' : undefined;
  return size > 0 ? size : undefined;
}

/**
 * How many times `for (let|var name = a; name < limit; name++)` runs, or `<=`, or `name += c`: a count when `a`, `limit` and `c` are
 * literals, `unreadable` when `limit` or `c` is a name or path from outside the file, `undefined` for any other header.
 */
function iterations(init: string, update: string, name: string, operator: string, limit: number | 'name' | undefined, reader: Reader): Bound {
  const start = counterStart(init, name, reader);
  const step = counterStep(update, name, reader);
  if (start === undefined || step === undefined || limit === undefined) return undefined;
  if (limit === 'name' || step === 'unreadable') return 'unreadable';
  const span = limit - start;
  return Math.max(0, operator === '<=' ? Math.floor(span / step) + 1 : Math.ceil(span / step));
}

const isNumber = (value: unknown): value is number => typeof value === 'number';

/** A loop ends at the first of its exits that fires: the smallest bound, or `unreadable` when only unreadable ones exist. */
function earliest(bounds: readonly Bound[]): Bound {
  const known = bounds.filter(isNumber);
  if (known.length > 0) return Math.min(...known);
  return bounds.includes('unreadable') ? 'unreadable' : undefined;
}

/**
 * A condition of several parts holds once every part does: the largest of their bounds. A part with no bound may never hold, so
 * it leaves the whole with none; a part with a bound the scan cannot read leaves it `unreadable`.
 */
function latest(bounds: readonly Bound[]): Bound {
  if (bounds.includes(undefined)) return undefined;
  return bounds.every(isNumber) ? Math.max(...bounds) : 'unreadable';
}

/**
 * The matches of a pattern in the loop's function, before `at`, that the code at `at` can see: those whose `{…}` block is
 * still open there. A block that closed earlier, or one the use is not in, declares nothing the use can read.
 */
function visibleMatches(code: string, loop: PollLoop, at: number, pattern: RegExp): RegExpMatchArray[] {
  const text = scopeBefore(code, loop, at);
  const matches = [...text.matchAll(pattern)];
  const starts = new Set(matches.map((match) => match.index));
  const open: number[] = [];
  const enclosing = new Map<number, number>();
  for (let i = 0; i < text.length; i += 1) {
    if (starts.has(i)) enclosing.set(i, open.at(-1) ?? -1);
    if (text[i] === '{') open.push(i);
    else if (text[i] === '}') open.pop();
  }
  const stillOpen = new Set(open);
  return matches.filter((match) => {
    const block = enclosing.get(match.index) ?? -1;
    return block === -1 || stillOpen.has(block);
  });
}

const compound = String.raw`(?:[-+*/%&|^]|<<|>>>?|\*\*|&&|\|\||\?\?)=(?![=>])`;

/**
 * Whether `text` writes `name`: `name++`, `name += 1`, a destructuring target, and with `plain` also `name = …`. A closure counts,
 * since it can reassign the name; a read in a comparison does not (`name <= 5`, `name == 5`), nor does a declaration (`let name = …`).
 */
function writesName(text: string, name: string, plain: boolean): boolean {
  const n = escapeName(name);
  const write = plain ? String.raw`(?:${compound}|=(?![=>]))` : compound;
  const bare = String.raw`(?<![\w$.])${n}(?![\w$])`;
  const declared = String.raw`(?<!\b(?:let|const|var)\s+)`;
  return new RegExp(String.raw`${declared}(?<![\w$.])${n}\s*(?:\+\+|--|${write})|(?:\+\+|--)\s*${n}(?![\w$])|\[[^\]]*${bare}[^\]]*\]\s*=(?![=>])|\{[^}]*${bare}[^}]*\}\s*=(?![=>])`).test(text);
}

/** Whether the loop's function writes `name` other than by a plain assignment, up to the end of the loop: the scan cannot say which value is in force. */
function writtenOtherwise(code: string, loop: PollLoop, name: string): boolean {
  return writesName(code.slice(loop.scope, Math.max(loop.body[1], loop.head?.[1] ?? 0) + 1), name, false);
}

/** What may follow a value in the text: the end of its statement, or of the list it sits in. */
const valueEnd = String.raw`(?=\s*(?:[;,)\n]|$))`;
const pathOnly = new RegExp(String.raw`^[A-Za-z_$][\w$.]*${valueEnd}`);

/** A value the scan cannot read: a name of an outer scope that is written after its declaration. */
const UNREAD = '\u0000';

/** One value a name can hold, as the text that follows its `=`, where that text starts in the code, and whether it is a parameter's default. */
interface Held {
  value: string;
  at: number;
  param: boolean;
}

let moduleCache: { code: string; text: string } | undefined;

/** The module's own text: everything outside a function, at the same offsets as `code`. */
function moduleText(code: string): string {
  if (moduleCache?.code !== code) moduleCache = { code, text: ownText(code, 0, code.length, 0) };
  return moduleCache.text;
}

/** The depths of the scopes whose parameter list binds `name`, with or without a default: a parameter hides the same name of the scopes around it. */
function paramDepths(code: string, bounds: number[], name: string): number[] {
  const bound = new RegExp(String.raw`(?<![\w$.])${escapeName(name)}(?![\w$])`);
  const binds = (param: string): boolean => (/^(?:\.\.\.)?\s*[A-Za-z_$]/.test(param) ? /^(?:\.\.\.)?\s*([A-Za-z_$][\w$]*)/.exec(param)?.[1] === name : bound.test(param));
  return bounds.flatMap((start, depth) => (depth > 0 && code[start] === '(' && argsOf(code, start, closeOf(code, start)).some((param) => binds(param.text)) ? [depth] : []));
}

/**
 * The values the code at `at` can see assigned to, declared with or defaulted for `name`, as the text that follows each `=`. A
 * declaration in a scope hides the name in the scopes around it. The loop's own function gives every value the name can hold
 * there. A name of an outer scope holds one value: a `const`, or a parameter's default; a `let` or `var` is read only when nothing
 * in the file writes it after its declaration, else it is `UNREAD`. A `const` at the top of the module counts wherever it sits,
 * since a function runs after the module has loaded, unless a nearer scope declares the name.
 */
function heldValues(code: string, loop: PollLoop, name: string, at: number): Held[] {
  const { bounds } = outerOf(code, loop.scope);
  const assigned = new RegExp(String.raw`(?<![\w$.])${escapeName(name)}\s*(?::[^=;,()]*)?=(?![=>])\s*`, 'g');
  const text = scopeBefore(code, loop, at);
  const found = visibleMatches(code, loop, at, assigned).map((match) => {
    const index = match.index ?? 0;
    const before = text.slice(0, index).trimEnd();
    const param = !/\bconst$/.test(before) && /[(,]$/.test(before);
    const constant = param || /\bconst$/.test(before);
    return {
      depth: bounds.filter((start) => start <= index).length - 1,
      declares: constant || /\b(?:let|var)$/.test(before),
      constant,
      param,
      at: index + match[0].length,
    };
  });
  const innermost = Math.max(-1, ...found.filter((each) => each.declares).map((each) => each.depth), ...paramDepths(code, bounds, name));
  const values = found.filter((each) => each.depth >= innermost && !(loop.wait && each.param)).map((each) => {
    const readable = each.constant || (each.depth === bounds.length - 1 && !loop.wait) || (each.declares && !writesName(code, name, true));
    return { value: readable ? text.slice(each.at) : UNREAD, at: each.at, param: each.param };
  });
  if (innermost !== -1 || loop.scope === 0) return values;
  const module = moduleText(code);
  const late = [...module.matchAll(new RegExp(String.raw`\bconst\s+${escapeName(name)}\s*(?::[^=;,()]*)?=(?![=>])\s*`, 'g'))]
    .filter((match) => (match.index ?? 0) >= at)
    .map((match) => ({ value: module.slice((match.index ?? 0) + match[0].length), at: (match.index ?? 0) + match[0].length, param: false }));
  return [...values, ...late];
}

const valuesBefore = (code: string, loop: PollLoop, name: string, at: number): string[] => heldValues(code, loop, name, at).map((each) => each.value);

/** Whether the file declares `name` itself: a `const`, `let`, `var`, function or class, a destructured binding or a loop variable. A parameter and an import are the caller's. */
function declaredHere(code: string, loop: PollLoop, name: string, at: number): boolean {
  return heldValues(code, loop, name, at).some((each) => !each.param) || declaredApart(code, name);
}

/** Whether `text` is a name or path that the file does not declare: a parameter, an import or a global, so a value the caller sizes. */
function isOutside(code: string, loop: PollLoop, text: string, at: number): boolean {
  const root = /^([A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)*$/.exec(text.trim())?.[1];
  return root !== undefined && !declaredHere(code, loop, root, at);
}

/** The text of the value that starts the string: up to the first `;`, `,` or newline outside a bracket, or the bracket that closes the list it sits in. */
function valueText(text: string): string {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return text.slice(0, i);
      depth -= 1;
    } else if (depth === 0 && (ch === ';' || ch === ',' || ch === '\n')) return text.slice(0, i);
  }
  return text;
}

/** Whether the file declares `name` where a plain `name = value` cannot be read: a function or class, destructuring, or the variable of a `for … of` or `for … in`. */
function declaredApart(code: string, name: string): boolean {
  const n = escapeName(name);
  return new RegExp(String.raw`\b(?:function\s*\*?|class)\s+${n}(?![\w$])|\b(?:let|const|var)\s*[\[{][^;=]*(?<![\w$.])${n}(?![\w$])[^;=]*[\]}]\s*=|\bfor\s*(?:await\s*)?\(\s*(?:let|const|var)\s+${n}(?![\w$])`).test(code);
}

/** What a name the scan cannot follow stands for: a value the caller sizes when the file does not declare it, else a shape the scan does not read: no bound. */
function unfollowed(code: string, loop: PollLoop, name: string, at: number): Bound {
  return declaredHere(code, loop, name, at) ? undefined : 'unreadable';
}

/**
 * What a name stands for where the code at `at` reads it: the smallest number it can hold. `unreadable` for a value that comes from
 * outside the file (a parameter without a default, an import, a global, a property of either). `undefined` for a name the file
 * declares and the scan cannot evaluate: one set to an expression it does not read (a call, a ternary, a destructured binding), one
 * written some other way (`name += 1`, an outer `let` written after its declaration) and one that leads to such a name.
 */
function nameBound(code: string, loop: PollLoop, name: string, at: number, depth = 0): Bound {
  const values = valuesBefore(code, loop, name, at);
  if (depth > 3 || values.includes(UNREAD) || writtenOtherwise(code, loop, name)) return unfollowed(code, loop, name, at);
  const resolve = (inner: string): number | undefined => {
    const bound = /^[A-Za-z_$][\w$]*$/.test(inner) ? nameBound(code, loop, inner, at, depth + 1) : undefined;
    return isNumber(bound) ? bound : undefined;
  };
  const read = values.map((value) => literalMs(valueText(value), resolve));
  if (values.some((value, index) => read[index] === undefined && !pathOnly.test(value))) return undefined;
  if (values.length === 0 && declaredApart(code, name)) return undefined;
  // A value that is another name or path is the caller's only when the file does not declare it.
  if (values.some((value, index) => read[index] === undefined && !aliasOutside(code, loop, valueText(value).trim(), at, depth))) return undefined;
  const known = read.filter(isNumber);
  return known.length > 0 ? Math.min(...known) : 'unreadable';
}

/** Whether the name or path `target`, the value of another name, comes from outside the file. */
function aliasOutside(code: string, loop: PollLoop, target: string, at: number, depth: number): boolean {
  if (!/^[A-Za-z_$][\w$]*$/.test(target)) return isOutside(code, loop, target, at);
  return nameBound(code, loop, target, at, depth + 1) !== undefined;
}

/**
 * The loop's bound `text` in milliseconds as the code at `at` reads it: a number written out, or an expression of numbers and names
 * for them (`POLL_MS * 2`). A name is read through every scope around the use. A name or path from outside the file is `unreadable`.
 * Any other expression, and a name the file sets to one, is a shape the scan does not read: no bound.
 */
function literalBound(code: string, loop: PollLoop, text: string, at: number): Bound {
  const trimmed = text.trim();
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed) && !namedNumbers.has(trimmed)) return nameBound(code, loop, trimmed, at);
  const direct = literalMs(trimmed, (name) => {
    const bound = nameBound(code, loop, name, at, 1);
    return isNumber(bound) ? bound : undefined;
  });
  if (direct !== undefined) return direct;
  return /^[A-Za-z_$][\w$]*(?:\.[\w$]+)+$/.test(trimmed) && isOutside(code, loop, trimmed, at) ? 'unreadable' : undefined;
}

/** A deadline held in a name: the smallest `name = Date.now() + <bound>` that the code at `at` can see in the loop's function. Any other value it holds is a shape the scan does not read. */
function definedBound(code: string, loop: PollLoop, name: string, at: number): Bound {
  if (writtenOtherwise(code, loop, name)) return unfollowed(code, loop, name, at);
  const sum = new RegExp(String.raw`^${clockCall}\s*\+\s*(${limitToken})${valueEnd}`);
  const bounds = valuesBefore(code, loop, name, at).map((value) => {
    const limit = sum.exec(value)?.[1];
    return limit !== undefined ? literalBound(code, loop, limit.trim(), at) : pathOnly.test(value) && aliasOutside(code, loop, valueText(value).trim(), at, 0) ? 'unreadable' : undefined;
  });
  return bounds.includes(undefined) ? undefined : earliest(bounds) ?? 'unreadable';
}

/** Whether every value the code at `at` can see for the start `name` is one the scan reads: a read of the clock, or a name or path of the caller's. */
function startsAtClock(cx: Probe, name: string, at: number): boolean {
  const clock = new RegExp(String.raw`^${clockCall}${valueEnd}`);
  return name.includes('.') || valuesBefore(cx.code, cx.loop, name, at).every((value) => clock.test(value) || pathOnly.test(value));
}

/** What one poll loop is judged by. */
interface Probe {
  code: string;
  loop: PollLoop;
  /** The loop's own text, from its keyword to the end of its body or header, without the functions nested in it. */
  region: string;
  /** What runs again every pass: the body, and the header without a `for`'s first clause. Functions nested in it are kept, since they can write a name. */
  again: string;
  /** The three clauses of a `for` header, or none. */
  clauses: string[];
  /** The time one pass of the loop's sleeps takes, 0 when it has none: `unreadable` when a delay comes from outside the file, `undefined` when a delay is one the scan does not read. */
  interval: Bound;
  /** A literal (a bound in milliseconds, or a count), read where the loop starts. */
  read: (text: string) => number | undefined;
  /** Whether a name or path comes from outside the file, so the caller sizes it. */
  outside: (text: string) => boolean;
}

/** What a counter header reads its numbers with. */
type Reader = Pick<Probe, 'read' | 'outside'>;

/**
 * Whether a pass of the loop changes the name the code at `at` reads: the declaration in view sits in the loop body (it runs again
 * every pass; one before the loop, or in a `for` header, runs once), or anything in the loop writes the name (a closure too).
 */
function movesIn(cx: Probe, name: string, at: number): boolean {
  // A path (`state.deadline`) moves when the path or the name it starts from does.
  const root = name.split('.')[0] ?? '';
  const declaration = new RegExp(String.raw`\b(?:let|const|var)\s+${escapeName(root)}(?![\w$])`, 'g');
  const nearest = visibleMatches(cx.code, cx.loop, at, declaration).at(-1);
  const closures = closureText(cx.code, cx.loop.scope, Math.max(cx.loop.body[1], cx.loop.head?.[1] ?? 0) + 1, cx.loop.scope === 0 ? 0 : 1);
  const written = (text: string): boolean => writesName(text, name, true) || writesName(text, root, true);
  return (nearest?.index !== undefined && nearest.index >= cx.loop.body[0]) || written(cx.again) || written(closures);
}

/** Whether the loop changes any name or path the text reads. */
const movesAny = (cx: Probe, text: string, at: number): boolean => (text.match(/(?<![\w$.])[A-Za-z_$][\w$.]*/g) ?? []).some((name) => movesIn(cx, name, at));

/** Whether a condition only reads: no write, no call but a read of the clock, no `new`, `await` or `delete`. */
function isPure(text: string): boolean {
  const reads = text.replace(new RegExp(clockCall, 'g'), 'NOW');
  return !/(?<![=!<>])=(?![=>])|(?:<<|>>>?|\*\*|&&|\|\||\?\?)=|\+\+|--|\b(?:new|await|delete)\b|[\w$\])]\s*(?:\?\.)?\(/.test(reads);
}

/** The matches that are the whole text: a form the scan reads must be the condition itself, not a part of a larger expression. */
const wholly = (text: string, pattern: RegExp): RegExpMatchArray[] => [...text.matchAll(pattern)].filter((match) => match[0].trim() === text.trim());

/**
 * What the loop sets `name` to on every pass: its only write, a plain assignment or a declaration with a value, written as a
 * statement of the loop body itself before any statement that holds a `continue`. A write in a branch, a closure, the header or
 * after a `continue` may not run in a pass, so the name may keep an old value and a comparison against it ends nothing. The value
 * is read where the statement is, since the body can declare a name of its own for it.
 */
function perPass(cx: Probe, name: string): { value: string; at: number } | undefined {
  const { loop, region } = cx;
  const n = escapeName(name);
  const closures = closureText(cx.code, loop.scope, Math.max(loop.body[1], loop.head?.[1] ?? 0) + 1, loop.scope === 0 ? 0 : 1);
  const written = [...cx.again.matchAll(new RegExp(String.raw`(?<![\w$.])${n}\s*(?::[^=;,()]*)?=(?![=>])`, 'g'))];
  if (written.length !== 1 || writesName(cx.again, name, false) || writesName(closures, name, true)) return undefined;
  const write = new RegExp(String.raw`(?:(?:let|const|var)\s+)?${n}\s*(?::[^=;,()]*)?=(?![=>])\s*([^;\n]+)`, 'y');
  const from = loop.body[0] - loop.keyword;
  const to = loop.body[1] - loop.keyword + 1;
  const own = region[from] === '{' ? 1 : 0;
  const stack: Entry[] = [];
  for (let i = from; i < to; i += 1) {
    if (stack.length === own && startsStatement(region, from, i)) {
      if (/\bcontinue\b/.test(region.slice(from, i))) return undefined;
      write.lastIndex = i;
      const found = write.exec(region);
      if (found) return { value: (found[1] ?? '').trim(), at: loop.keyword + i };
    }
    track(region, stack, i);
  }
  return undefined;
}

const identifier = String.raw`[A-Za-z_$][\w$]*`;

/** What a comparison of a name with the clock says when the loop sets the name from the clock on every pass (`elapsed = Date.now() - t0`, `elapsed > 5_000`; `now = Date.now()`, `now > deadline`). */
function aliasLeaf(text: string, cx: Probe, at: number): Bound {
  const sides = [
    ...[new RegExp(String.raw`^\s*(${identifier})\s*${compare}\s*([^;]+?)\s*$`).exec(text)].map((found) => ({ name: found?.[1], other: found?.[2] })),
    ...[new RegExp(String.raw`^\s*([^;]+?)\s*${compare}\s*(${identifier})\s*$`).exec(text)].map((found) => ({ name: found?.[2], other: found?.[1] })),
  ];
  for (const { name, other = '' } of sides) {
    const pass = name === undefined ? undefined : perPass(cx, name);
    const sample = new RegExp(String.raw`^${clockCall}(?:\s*-\s*([\w$.]+))?$`).exec(pass?.value ?? '');
    if (!sample || !pass) continue;
    const start = sample[1];
    if (!new RegExp(`^${limitToken}$`).test(other.trim()) || movesAny(cx, other, at)) return undefined;
    if (start !== undefined) return movesIn(cx, start, pass.at) || !startsAtClock(cx, start, pass.at) ? undefined : literalBound(cx.code, cx.loop, other.trim(), at);
    return /^[A-Za-z_$][\w$]*$/.test(other.trim()) ? definedBound(cx.code, cx.loop, other.trim(), at) : undefined;
  }
  return undefined;
}

/**
 * What a comparison against the clock says: the smallest bound its forms give, `unreadable` when the limit is one the caller sizes,
 * `undefined` when it is not a clock comparison of a form the scan reads, as the whole condition (`now - start` against a limit,
 * `now` against `start + limit` or a deadline, a name the loop sets from the clock), or when its start, deadline or limit is one the
 * loop changes or an expression of its own.
 */
function clockLeaf(text: string, cx: Probe, at: number): Bound {
  const fixed = (names: Array<string | undefined>, start: string | undefined, bound: () => Bound): Bound =>
    names.some((name) => movesAny(cx, name ?? '', at)) || (start !== undefined && !startsAtClock(cx, start, at)) ? undefined : bound();
  const limit = (value: string | undefined): (() => Bound) => () => literalBound(cx.code, cx.loop, (value ?? '').trim(), at);
  const found: Bound[] = [
    ...wholly(text, elapsedBounds).map((match) => fixed([match[1] ?? match[4], match[2] ?? match[3]], match[1] ?? match[4], limit(match[2] ?? match[3]))),
    ...wholly(text, sumBounds).map((match) => fixed([match[1] ?? match[3], match[2] ?? match[4]], match[1] ?? match[3], limit(match[2] ?? match[4]))),
    ...wholly(text, deadlineNames).map((match) => fixed([match[1] ?? match[2]], undefined, () => definedBound(cx.code, cx.loop, match[1] ?? match[2] ?? '', at))),
  ];
  return found.length > 0 ? earliest(found) : aliasLeaf(text, cx, at);
}

/** How long `count` passes take when one pass sleeps `interval`. Passes that sleep nothing take no time to count, so the count says nothing in milliseconds: `unreadable`. */
function timeOf(count: number, interval: Bound): Bound {
  if (interval === undefined) return undefined;
  return isNumber(interval) && interval > 0 ? count * interval : 'unreadable';
}

/**
 * What a comparison with a counter says about how long the loop runs. Only the counter of a `for (let|var i = <literal>; i < limit;
 * i++)` header counts, since its update runs every pass: it gives its iteration count times the time one pass sleeps, when nothing
 * in the body writes the counter. `<=` and `i += <positive literal>` read the same way. `unreadable` is a limit, a step or a delay
 * that is a name or path from outside the file, and a count of passes that sleep nothing, which says nothing in milliseconds. A
 * limit, step or delay the file declares and the scan cannot read, a counter the body steps or writes or the test steps
 * (`i++ < 20`), a limit or a step the loop changes, a count down, and a comparison with `==` or `!=` bound nothing.
 */
function counterLeaf(text: string, cx: Probe, at: number): Bound {
  const compared = /^\s*([A-Za-z_$][\w$]*)\s*(<=?)\s*(\S[^&|]*?)\s*$/.exec(text);
  const [, name = '', operator = '', limit = ''] = compared ?? [];
  const declared = compared !== null && cx.clauses.length === 3 && new RegExp(String.raw`^\s*(?:let|var)\s+${escapeName(name)}\s*(?::[^=,]*)?=`).test(cx.clauses[0] ?? '');
  if (!declared || writesName(cx.code.slice(cx.loop.body[0], cx.loop.body[1] + 1), name, true)) return undefined;
  // A limit or a step the loop changes is not the one the header names.
  if (movesAny(cx, `${limit} ${cx.clauses[2] ?? ''}`.replace(new RegExp(String.raw`(?<![\w$.])${escapeName(name)}(?![\w$])`, 'g'), ''), at)) return undefined;
  const value = cx.read(limit);
  const sized = value ?? (cx.outside(limit) ? 'name' : undefined);
  const count = iterations(cx.clauses[0] ?? '', cx.clauses[2] ?? '', name, operator, sized, cx);
  return isNumber(count) ? timeOf(count, cx.interval) : count;
}

/** The bound a name gives a condition that is true or false by the value the loop sets it to on every pass (`const timedOut = Date.now() - t0 > 5_000`). */
function aliasText(name: string, want: boolean, cx: Probe, at: number, depth: number): Bound {
  // A flag the loop does not set on every pass keeps an old value, so it ends nothing.
  const pass = depth < 3 ? perPass(cx, name) : undefined;
  return pass === undefined ? undefined : endsText(pass.value, want, cx, pass.at, depth + 1);
}

/** Split text at the top-level occurrences of an operator, outside any bracket. */
function splitTop(text: string, operator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (depth === 0 && text.startsWith(operator, i)) {
      parts.push(text.slice(from, i));
      from = i + operator.length;
      i += operator.length - 1;
    }
  }
  parts.push(text.slice(from));
  return parts;
}

/** The text without the parentheses that wrap all of it. */
const unwrap = (text: string): string => (text.startsWith('(') && closeOf(text, 0) === text.length - 1 ? unwrap(text.slice(1, -1).trim()) : text);

/**
 * The time by which a condition is certain to be `want`, as the loop's clock or counter sees it. For the loop head, `want` is
 * false (the loop runs while it holds); for the test of an `if` that leaves the loop, it is true. `a && b` is false once either
 * part is, and true once both are; `a || b` is the other way round. A condition of any other shape (a ternary, `??`, a call, an
 * equality) has no bound.
 */
function endsText(raw: string, want: boolean, cx: Probe, at: number, depth = 0): Bound {
  const text = unwrap(raw.trim());
  if (text === '') return undefined;
  if (splitTop(text.replace(/\?\./g, '.'), '?').length > 1) return undefined;
  for (const [operator, any] of [['||', want], ['&&', !want]] as const) {
    const parts = splitTop(text, operator);
    if (parts.length > 1) {
      const bounds = parts.map((part) => endsText(part, want, cx, at, depth));
      return any ? earliest(bounds) : latest(bounds);
    }
  }
  if (text.startsWith('!') && text[1] !== '=') return endsText(text.slice(1), !want, cx, at, depth);
  if (/^[A-Za-z_$][\w$]*$/.test(text)) return aliasText(text, want, cx, at, depth);
  return isPure(text) ? clockLeaf(text, cx, at) ?? counterLeaf(text, cx, at) : undefined;
}

/** Whether the code at `i` starts a statement of the text that begins at `from`: only a statement boundary comes before it. */
function startsStatement(region: string, from: number, i: number): boolean {
  const k = skipSpaceBack(region, i - 1);
  return k < from || ';{}'.includes(region[k] ?? '');
}

const exitWord = /(?:break|return|throw)\b/y;

/** Whether the statement at `start` ends the loop by itself: a `break`, `return` or `throw`, or a block with one among its own statements that no `continue` comes before. */
function leavesDirectly(region: string, start: number): boolean {
  const leaves = (at: number): boolean => {
    exitWord.lastIndex = at;
    return exitWord.test(region);
  };
  if (region[start] !== '{') return leaves(start);
  const stack: Entry[] = [];
  for (let i = start; i < closeOf(region, start); i += 1) {
    if (stack.length === 1 && leaves(i) && startsStatement(region, start, i)) return !/\bcontinue\b/.test(region.slice(start, i));
    track(region, stack, i);
  }
  return false;
}

const ifHead = /if\s*\(/y;

/**
 * The bounds of the exits in the loop's own body: `if (<condition>) break`, `return` or `throw`, written as a statement of the body
 * itself, before any statement that holds a `continue`. An `if` inside another `if`, an `else`, a `switch`, a `try`, a block or
 * an inner loop may never be reached, and a branch that leaves only inside another `if` may never leave, so neither counts.
 */
function exitBounds(cx: Probe): Bound[] {
  const { loop, region } = cx;
  const from = loop.body[0] - loop.keyword;
  const to = loop.body[1] - loop.keyword + 1;
  const own = region[from] === '{' ? 1 : 0;
  const found: Bound[] = [];
  const stack: Entry[] = [];
  for (let i = from; i < to; i += 1) {
    ifHead.lastIndex = i;
    if (stack.length === own && ifHead.test(region) && startsStatement(region, from, i)) {
      if (/\bcontinue\b/.test(region.slice(from, i))) break;
      const open = region.indexOf('(', i);
      const close = closeOf(region, open);
      if (leavesDirectly(region, skipSpaceForward(region, close + 1))) found.push(endsText(region.slice(open + 1, close), true, cx, loop.keyword + i));
    }
    track(region, stack, i);
  }
  return found;
}

/** A sleep in a poll loop: its delay's text, and whether every pass of the loop reaches it. */
interface LoopSleep {
  delay: string | undefined;
  always: boolean;
}

/**
 * Whether every pass of the loop reaches the sleep at `offset`. Nothing before it in the body skips it: not a nested block (a branch,
 * a `try`, a loop), not a short circuit or a ternary, not an `if (…)` or `else` without braces, and no `continue`. A sleep a pass may
 * skip is not part of the time one pass takes.
 */
function runsEveryPass(code: string, loop: PollLoop, offset: number): boolean {
  const before = code.slice(loop.body[0] + (code[loop.body[0]] === '{' ? 1 : 0), offset);
  const depth = [...before].reduce((open, ch) => open + (ch === '{' ? 1 : ch === '}' ? -1 : 0), 0);
  const statement = before.slice(Math.max(before.lastIndexOf(';'), before.lastIndexOf('{'), before.lastIndexOf('}')) + 1).trimEnd();
  return depth <= 0 && !/\bcontinue\b/.test(before) && !/(?:\)|\belse|&&|\|\||\?\?|\?|:)$/.test(statement);
}

/**
 * How long a poll loop can run, as the first of its exits to fire: the smallest bound among its head and every `if` in its
 * body that leaves it. `none` when no exit reads the clock or counts attempts; `unreadable` when the exits that do are ones the
 * scan cannot evaluate. A loop over a collection or a stream is bounded by it.
 */
function pollDeadline(code: string, loop: PollLoop, sleeps: LoopSleep[]): Deadline {
  const header = loop.head ? code.slice(loop.head[0] + 1, loop.head[1]) : '';
  if (!header.includes(';') && /\s(?:of|in)\s/.test(header)) return 'unreadable';
  const region = ownText(code, loop.keyword, Math.max(loop.body[1], loop.head?.[1] ?? 0) + 1);
  const read = (text: string): number | undefined => {
    const bound = literalBound(code, loop, text.trim(), loop.keyword);
    return typeof bound === 'number' ? bound : undefined;
  };
  // One pass takes the sum of the delays it cannot skip. A loop whose sleeps a pass may skip has no interval to count by.
  const delays = sleeps.filter((sleep) => sleep.always).map((sleep): Bound => {
    const delay = (sleep.delay ?? '').trim();
    const bound = literalBound(code, loop, delay, loop.keyword);
    return bound === undefined && delay !== '' && sizedOutside(code, loop, delay, loop.keyword) ? 'unreadable' : bound;
  });
  const clauses = header.split(';');
  const interval: Bound = delays.includes(undefined) ? undefined : delays.every(isNumber) ? delays.reduce((sum, each) => sum + each, 0) : 'unreadable';
  const again = code.slice(loop.body[0], loop.body[1] + 1) + (clauses.length === 3 ? `;${clauses[1]};${clauses[2]}` : `;${header}`);
  const outside = (text: string): boolean => isOutside(code, loop, text, loop.keyword);
  const cx: Probe = { code, loop, region, again, clauses: clauses.length === 3 ? clauses : [], interval, read, outside };
  const head = loop.head ? endsText(clauses.length === 3 ? clauses[1] ?? '' : header, false, cx, loop.head[1]) : undefined;
  return earliest([head, ...exitBounds(cx)]) ?? 'none';
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
  const sleepsOf = new Map<number, { loop: PollLoop; sleeps: LoopSleep[] }>();
  for (const { offset, delay } of sleeps) {
    const loop = loops.get(offset);
    // A zero delay outside a loop only yields to the event loop. In a loop it is the poll interval of a spin.
    if (!loop) {
      if (literalMs(delay) !== 0) found.push({ rule: 'sleep', offset });
    } else sleepsOf.set(loop.keyword, { loop, sleeps: [...(sleepsOf.get(loop.keyword)?.sleeps ?? []), { delay, always: runsEveryPass(code, loop, offset) }] });
  }
  for (const { loop, sleeps: inLoop } of sleepsOf.values()) {
    const deadline = pollDeadline(code, loop, inLoop);
    if (deadline === 'none' || (typeof deadline === 'number' && isShortDeadline(deadline))) found.push({ rule: 'poll-deadline', offset: loop.keyword });
  }
  return found;
}

/** The function the code at `at` sits in, as a place to look names up from: a stand-in for a loop that starts and ends there. */
function placeAt(code: string, at: number): PollLoop {
  const stack: Entry[] = [];
  for (let i = 0; i < at; i += 1) track(code, stack, i);
  const frame = stack.reverse().find((entry) => entry.kind === 'function' || entry.kind === 'arrow');
  return { keyword: at, body: [at, at], scope: frame ? paramsStart(code, frame.open) : 0, wait: true };
}

/** Names that stand for the same value in every file: JavaScript's own, which a bound may use without declaring. */
const ownNames = new Set(['Math', 'Number', 'Date', 'Infinity', 'NaN', 'undefined', 'null', 'true', 'false']);

/** Whether the expression reads a name or path from outside the file: a parameter, an import or a global, so a value the caller sizes. */
function sizedOutside(code: string, place: PollLoop, text: string, at: number): boolean {
  const names = text.replace(/\b(?:as|satisfies)\s+[\w$.]+|<[\w$.[\]| ]+>/g, ' ').match(/(?<![\w$.])[A-Za-z_$][\w$]*/g) ?? [];
  return names.some((name) => !ownNames.has(name) && !declaredHere(code, place, name, at));
}

/**
 * What a wait bound written at `at` stands for: a number, with a name read through the scopes around it. `undefined` is Vitest's
 * default and `null` is none. `undefined` for a value that comes from outside the file, which the caller sizes. Given the file's
 * `source`, the position is a Vitest timeout: a name held an options object is read as one, and an expression made only of what
 * the file declares, which the scan cannot evaluate, is `NaN`: it may be any bound, so it counts as below the floor. A helper's
 * argument is not a bound by its position, so it is read without the source.
 */
function waitMs(code: string, at: number, text: string | undefined, source?: string, depth = 0): number | undefined {
  const trimmed = (text ?? '').trim();
  if (trimmed === 'undefined') return VITEST_DEFAULT_MS;
  if (trimmed === 'null') return 0;
  const place = placeAt(code, at);
  if (source !== undefined && depth < 3 && /^[A-Za-z_$][\w$]*$/.test(trimmed)) {
    const objects = heldValues(code, place, trimmed, at).filter((each) => each.value.startsWith('{'));
    const held = objects.map((each) => optionsBound(code, source, { start: each.at, text: code.slice(each.at, closeOf(code, each.at) + 1) }, depth + 1));
    if (held.length > 0) return held.includes(undefined) ? undefined : Math.min(...held.filter(isNumber));
  }
  const bound = literalBound(code, place, trimmed, at);
  if (bound !== undefined) return isNumber(bound) ? bound : undefined;
  return source !== undefined && !sizedOutside(code, place, trimmed, at) ? NaN : undefined;
}

/** Rule `short-bound`: a Vitest wait with no bound (1 s), or with a literal one under 10 s, and the local helpers alike. */
function boundSites(code: string, source: string): Found[] {
  const found: Found[] = [];
  for (const match of code.matchAll(vitestWait)) {
    const open = match.index + match[0].length - 1;
    const bound = argsOf(code, open, closeOf(code, open))[1];
    const ms = bound === undefined ? VITEST_DEFAULT_MS : bound.text.startsWith('{') ? optionsBound(code, source, bound) : waitMs(code, bound.start, bound.text, source);
    if (isShort(ms)) found.push({ rule: 'short-bound', offset: match.index });
  }
  // A local wait helper called with a short literal anywhere after its condition.
  for (const match of code.matchAll(helperCall)) {
    if (/\bfunction\s*\*?\s*$/.test(code.slice(Math.max(0, match.index - 12), match.index))) continue;
    const open = match.index + match[0].length - 1;
    if (argsOf(code, open, closeOf(code, open)).slice(1).some((arg) => isShort(waitMs(code, arg.start, arg.text)))) {
      found.push({ rule: 'short-bound', offset: match.index });
    }
  }
  // A local wait helper whose bound parameter defaults to a short literal.
  for (const pattern of [helperFunction, helperArrow]) {
    for (const match of code.matchAll(pattern)) {
      const open = match.index + match[0].length - 1;
      const close = closeOf(code, open);
      if (pattern === helperArrow && !/^\s*(?::[^;{]*?)?=>/.test(code.slice(close + 1))) continue;
      if (argsOf(code, open, close).some((param) => shortDefault(code, param))) found.push({ rule: 'short-bound', offset: match.index });
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
 * computed key may carry any bound, so after one the bound is the caller's (`undefined`) when it reads a name from
 * outside the file and below the floor when the file declares everything it reads, until a later explicit `timeout`.
 * `undefined` is also anything but a plain object literal.
 */
function optionsBound(code: string, source: string, arg: Item, depth = 0): number | undefined {
  const close = arg.start + arg.text.length - 1;
  if (closeOf(code, arg.start) !== close) return undefined;
  let bound: number | undefined = VITEST_DEFAULT_MS;
  for (const property of argsOf(code, arg.start, close)) {
    const key = propertyKey(source, property);
    if (key === undefined) bound = entryBound(code, property);
    else if (key.name === 'timeout') bound = waitMs(code, property.start, key.value ?? key.name, source, depth);
  }
  return bound;
}

/** What an entry that may set any key (a spread, a computed key, a quoted key with an escape) leaves of the bound: the caller's, or `NaN` when it reads only what the file declares. */
function entryBound(code: string, property: Item): number | undefined {
  const text = property.text.trim();
  const expression = text.startsWith('...') ? text.slice(3) : /^\[([^\]]*)\]/.exec(text)?.[1] ?? text;
  return sizedOutside(code, placeAt(code, property.start), expression, property.start) ? undefined : NaN;
}

/** A quoted key with its `\uXXXX`, `\u{X}` and `\xXX` escapes decoded: `"\u0074imeout"` is `timeout`. `undefined` when another escape is left. */
function unescaped(key: string): string | undefined {
  const decoded = key.replace(/\\u\{([\da-fA-F]+)\}|\\u([\da-fA-F]{4})|\\x([\da-fA-F]{2})/g, (_, braced?: string, four?: string, two?: string) => {
    const code = Number.parseInt(braced ?? four ?? two ?? '0', 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : '\\';
  });
  return decoded.includes('\\') ? undefined : decoded;
}

/**
 * A property's key and value text. A quoted key is blanked in the code, so its name is read from
 * the original source at the same offsets: `{ "timeout": 100 }` names `timeout`. A spread, a
 * computed key or a quoted key with an escape other than `\u` and `\x` is `undefined`; a method or a numeric key gets an
 * empty name.
 */
function propertyKey(source: string, property: Item): { name: string; value?: string } | undefined {
  const { text, start } = property;
  if (text.startsWith('...') || text.startsWith('[')) return undefined;
  const quoted = /^(['"])( *)\1\s*:/.exec(text);
  if (quoted) {
    const name = unescaped(source.slice(start + 1, start + 1 + (quoted[2] ?? '').length));
    // Any other escape may name anything, so it reads like a computed key.
    if (name === undefined) return undefined;
    return { name, value: text.slice(quoted[0].length).trim() };
  }
  const named = /^([A-Za-z_$][\w$]*)\s*(:|$)/.exec(text);
  if (!named) return { name: '' };
  return { name: named[1] ?? '', ...(named[2] === ':' ? { value: text.slice(named[0].length).trim() } : {}) };
}

/** A parameter like `timeoutMs = 5_000`. A poll interval is not a bound, so `intervalMs = 25` is not one. */
function shortDefault(code: string, param: Item): boolean {
  const parsed = /^(?:\.\.\.)?([\w$]+)\s*\??\s*(?::[^=]*)?=([\s\S]*)$/.exec(param.text);
  return parsed !== null && !/interval/i.test(parsed[1] ?? '') && isShort(waitMs(code, param.start, parsed[2]));
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
