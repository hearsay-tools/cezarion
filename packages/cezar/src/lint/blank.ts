
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
export const beforeExpression = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void', 'yield', 'await', 'delete', 'instanceof', 'new', 'throw']);

/** Statements whose parenthesised head is followed by a statement, which may open with a regex. */
export const statementHeads = new Set(['if', 'while', 'for', 'with']);

export function regexMayStart(source: string, last: number, closedHead: boolean): boolean {
  if (last < 0) return true;
  const ch = source[last] ?? '';
  if (ch === ')') return closedHead;
  if (/[\w$]/.test(ch)) return beforeExpression.has(wordEndingAt(source, last));
  return !/[\]}'"`]/.test(ch);
}

/** Whether the `(` at `open` heads an `if`, `while`, `for` (or `for await`) or `with` statement.
 *  Steps back over whitespace and the comments seen so far, so a comment before the `(` or
 *  after a `.` does not hide the keyword. */
export function headsStatement(source: string, open: number, comments: Array<[number, number]>): boolean {
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
export function regexEnd(source: string, open: number): number {
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

export function wordEndingAt(code: string, end: number): string {
  let start = end;
  while (start >= 0 && /[\w$]/.test(code[start] ?? '')) start -= 1;
  return code.slice(start + 1, end + 1);
}

export function skipSpaceBack(code: string, from: number): number {
  let k = from;
  while (k >= 0 && /\s/.test(code[k] ?? '')) k -= 1;
  return k;
}

export function skipSpaceForward(code: string, from: number): number {
  let k = from;
  while (k < code.length && /\s/.test(code[k] ?? '')) k += 1;
  return k;
}
