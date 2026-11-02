import { SHORT_BOUND_MS } from './test-wait-discipline.ts';
import { wordEndingAt, skipSpaceBack, skipSpaceForward } from './blank.ts';
import { pollDeadline } from './server-wait-deadlines.ts';

/** The bracket matching the `(`, `[` or `{` at `open`, in blanked code; the end of the source when unbalanced. */
export function closeOf(code: string, open: number): number {
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
export function openOf(code: string, close: number): number {
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
export interface Item {
  text: string;
  start: number;
}

/** The items between the brackets at `open` and `close`, split at top-level commas, a trailing comma dropped. */
export function argsOf(code: string, open: number, close: number): Item[] {
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
export const numericLiteral =
  /^(?:0[xX][\da-fA-F](?:_?[\da-fA-F])*|0[oO][0-7](?:_?[0-7])*|0[bB][01](?:_?[01])*|(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?)$/;

export const numeric = (text: string | undefined): number | undefined => (text !== undefined && numericLiteral.test(text.trim()) ? Number(text.trim().replace(/_/g, '')) : undefined);

/** The names of JavaScript's own numbers that the evaluator reads. */
export const namedNumbers = new Map<string, number>([
  ['NaN', NaN], ['Infinity', Infinity], ['Number.NaN', NaN], ['Number.POSITIVE_INFINITY', Infinity], ['Number.NEGATIVE_INFINITY', -Infinity],
  ['Number.MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER], ['Number.MIN_SAFE_INTEGER', Number.MIN_SAFE_INTEGER], ['Number.MAX_VALUE', Number.MAX_VALUE],
]);

export const numberToken = /\s*(0[xXoObB][\da-fA-F_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)/y;

export const wordToken = /\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/y;

export const operatorToken = /\s*(\*\*|[-+*/%()!,])/y;

/** The functions of `Math` that the evaluator reads, on numbers it can read. */
export const mathFunctions = new Map<string, (...values: number[]) => number>([
  ['Math.max', Math.max], ['Math.min', Math.min], ['Math.abs', Math.abs], ['Math.floor', Math.floor], ['Math.ceil', Math.ceil], ['Math.round', Math.round], ['Math.trunc', Math.trunc],
]);

export const angleAssertion = /\s*<[\w$.[\]| ]+>/y;

/**
 * The value of a numeric expression: number literals (`_` separators, exponents, hex), `NaN`, `Infinity`, unary `+` and `-`,
 * parentheses, `as` / `satisfies` / non-null wrappers, `+ - * / % **` of those, and `Math.max`, `min`, `abs`, `floor`, `ceil`,
 * `round` and `trunc` of those. `undefined` for anything else, which is an expression the scan cannot read. A name is read through
 * `names`, when given. Every rule reads bounds through this, so a bound written as arithmetic is judged like its result.
 */
export function literalMs(text: string | undefined, names?: (name: string) => number | undefined): number | undefined {
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
export const VITEST_DEFAULT_MS = 1_000;

/** The longest delay a timer keeps: a larger one fires after 1 ms. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** A wait bound is short unless it is a finite number of 10 s or more that a timer keeps: a negative, zero, `NaN`, infinite or overflowing one fires at once. */
export const isShort = (ms: number | undefined): boolean => ms !== undefined && !(ms >= SHORT_BOUND_MS && ms <= MAX_TIMER_MS);

/** A poll loop's deadline is short unless it is a finite number of 10 s or more. */
export const isShortDeadline = (ms: number): boolean => !(ms >= SHORT_BOUND_MS && Number.isFinite(ms));

export type Frame = 'loop' | 'function' | 'block';

/** What the `{` at `open` opens: a loop body, a function body, or any other block. */
export function frameOf(code: string, open: number): Frame {
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
export interface PollLoop {
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

export function startOfWord(code: string, end: number): number {
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
export function pollLoops(code: string, offsets: number[]): Map<number, PollLoop> {
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
export interface Entry {
  kind: Frame | 'group' | 'arrow';
  open: number;
}

/** The innermost loop the code at `at` sits in, when no function body lies between them. */
export function loopAround(code: string, stack: Entry[], at: number): PollLoop | undefined {
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
export function track(code: string, stack: Entry[], i: number): void {
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
export function bracedLoop(code: string, open: number, scope: number): PollLoop {
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
export function bracelessLoop(code: string, offset: number, scope: number): PollLoop | undefined {
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
export function paramsStart(code: string, open: number): number {
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
