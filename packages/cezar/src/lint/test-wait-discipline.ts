import type { SourceRule } from './source-rule.ts';
import { baselines, compareToBaseline, readBaseline, tally } from './server-wait-baseline.ts';
import { type ScanError, blankSource } from './blank.ts';
import { closeOf, type Item, argsOf, numericLiteral, numeric, literalMs, VITEST_DEFAULT_MS, isShort, isShortDeadline, type PollLoop, pollLoops, type Entry, track, paramsStart } from './server-wait-syntax.ts';
import { iterations, isNumber, earliest, UNREAD, heldValues, declaredHere, valueText, literalBound, type LoopSleep, runsEveryPass, pollDeadline } from './server-wait-deadlines.ts';

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

/** Local sleep helpers in this tree go by these names. */
export const namedSleep = /\bawait\s+(?:delay|sleep|wait|pause)\s*\(/g;

/** `node:timers/promises`. */
export const promisedTimer = /\bawait\s+(?:timers\s*\.\s*)?setTimeout\s*\(/g;

/** `await new Promise(r => setTimeout(r, …))`, with a `globalThis.`/`global.` receiver or a
 *  `realSetTimeout`-style alias, as an expression body or a block that calls or returns it; the
 *  last group is the timer's name. */
export const promiseSleep =
  /\bawait\s+new\s+Promise\s*(?:<[^<>()]*>)?\s*\(\s*(?:\(\s*([A-Za-z_$][\w$]*)\s*(?::[^()]*)?\)|([A-Za-z_$][\w$]*))\s*=>\s*(?:\{\s*(?:return\s+)?)?(?:(?:globalThis|global)\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(/g;

/** Vitest's waits; each defaults to a 1 s bound. */
export const vitestWait = /\b(?:vi\s*\.\s*(?:waitFor|waitUntil)|expect\s*\.\s*poll)\s*\(/g;

/** The same waits written with a bracketed name, `vi['waitFor'](…)`: the receiver, and the names it takes. */
export const vitestReceiver = /\b(vi|expect)\s*\[/g;

export const vitestNames: Record<string, ReadonlySet<string>> = { vi: new Set(['waitFor', 'waitUntil']), expect: new Set(['poll']) };

export const helperNames = 'waitFor|waitUntil|until|eventually|waitForCondition';

/** A call to a local wait helper, not a method of something else. */
export const helperCall = new RegExp(`(?<!\\.\\s*)(?<![\\w$])(?:${helperNames})\\s*\\(`, 'g');

export const helperFunction = new RegExp(`\\bfunction\\s*\\*?\\s*(?:${helperNames})\\s*(?:<[^<>()]*>)?\\s*\\(`, 'g');

export const helperArrow = new RegExp(`\\b(?:const|let|var)\\s+(?:${helperNames})\\s*(?::[^=;]*)?=\\s*(?:async\\s*)?(?:<[^<>()]*>)?\\s*\\(`, 'g');

/** A `//` comment that accepts a site: `// bound: <reason>`, with a reason. */
export const boundComment = /^\/\/\s*bound:\s*\S/;

export function scanSource(file: string, source: string): Site[] {
  return scanFile(file, source).sites;
}

/** One rule's hit: the offset of the call (or loop) it is keyed on. */
export interface Found {
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
export function awaitedSleeps(code: string): Array<{ offset: number; delay: string | undefined }> {
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
export function sleepSites(code: string): Found[] {
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
export function placeAt(code: string, at: number): PollLoop {
  const stack: Entry[] = [];
  for (let i = 0; i < at; i += 1) track(code, stack, i);
  const frame = stack.reverse().find((entry) => entry.kind === 'function' || entry.kind === 'arrow');
  return { keyword: at, body: [at, at], scope: frame ? paramsStart(code, frame.open) : 0, wait: true };
}

/** Names that stand for the same value in every file: JavaScript's own, which a bound may use without declaring. */
export const ownNames = new Set(['Math', 'Number', 'Date', 'Infinity', 'NaN', 'undefined', 'null', 'true', 'false']);

/** Whether the expression reads a name or path from outside the file: a parameter, an import or a global, so a value the caller sizes. */
export function sizedOutside(code: string, place: PollLoop, text: string, at: number): boolean {
  // The `$` of a template's `${` opens a slot; it is no name.
  const names = text.replace(/\b(?:as|satisfies)\s+[\w$.]+|<[\w$.[\]| ]+>|\$(?=\{)/g, ' ').match(/(?<![\w$.])[A-Za-z_$][\w$]*/g) ?? [];
  return names.some((name) => !ownNames.has(name) && !declaredHere(code, place, name, at));
}

/**
 * What a wait bound written at `at` stands for: a number, with a name read through the scopes around it. `undefined` is Vitest's
 * default and `null` is none. `undefined` for a value that comes from outside the file, which the caller sizes. Given the file's
 * `source`, the position is a Vitest timeout: a name held an options object is read as one, and an expression made only of what
 * the file declares, which the scan cannot evaluate, is `NaN`: it may be any bound, so it counts as below the floor. A helper's
 * argument is not a bound by its position, so it is read without the source.
 */
export function waitMs(code: string, at: number, text: string | undefined, source?: string, depth = 0): number | undefined {
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

/** Every Vitest wait: where its call starts and the `(` that opens its arguments. A bracketed name is read as a property key is. */
export function vitestWaits(code: string, source: string): Array<{ index: number; open: number }> {
  const waits = [...code.matchAll(vitestWait)].map((match) => ({ index: match.index, open: match.index + match[0].length - 1 }));
  for (const match of code.matchAll(vitestReceiver)) {
    const bracket = match.index + match[0].length - 1;
    const close = closeOf(code, bracket);
    const call = /^\s*\(/.exec(code.slice(close + 1));
    const name = keyText(code, source, source.slice(bracket + 1, close), bracket);
    if (call && name !== undefined && vitestNames[match[1] ?? '']?.has(name)) waits.push({ index: match.index, open: close + call[0].length });
  }
  return waits;
}

/** Rule `short-bound`: a Vitest wait with no bound (1 s), or with a literal one under 10 s, and the local helpers alike. */
export function boundSites(code: string, source: string): Found[] {
  const found: Found[] = [];
  for (const { index, open } of vitestWaits(code, source)) {
    const bound = argsOf(code, open, closeOf(code, open))[1];
    const ms = bound === undefined ? VITEST_DEFAULT_MS : bound.text.startsWith('{') ? optionsBound(code, source, bound) : waitMs(code, bound.start, bound.text, source);
    if (isShort(ms)) found.push({ rule: 'short-bound', offset: index });
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
export function boundAccepted(
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
export function optionsBound(code: string, source: string, arg: Item, depth = 0): number | undefined {
  const close = arg.start + arg.text.length - 1;
  if (closeOf(code, arg.start) !== close) return undefined;
  let bound: number | undefined = VITEST_DEFAULT_MS;
  for (const property of argsOf(code, arg.start, close)) {
    const key = propertyKey(code, source, property);
    if (key === undefined) bound = entryBound(code, property);
    else if (key.name === 'timeout') bound = waitMs(code, property.start, key.value ?? key.name, source, depth);
  }
  return bound;
}

/** What an entry that may set any key (a spread, a computed key, a quoted key with an escape) leaves of the bound: the caller's, or `NaN` when it reads only what the file declares. */
export function entryBound(code: string, property: Item): number | undefined {
  const text = property.text.trim();
  const expression = text.startsWith('...') ? text.slice(3) : /^\[([^\]]*)\]/.exec(text)?.[1] ?? text;
  return sizedOutside(code, placeAt(code, property.start), expression, property.start) ? undefined : NaN;
}

/** A quoted key with its `\uXXXX`, `\u{X}` and `\xXX` escapes decoded: `"\u0074imeout"` is `timeout`. `undefined` when another escape is left. */
export function unescaped(key: string): string | undefined {
  const decoded = key.replace(/\\u\{([\da-fA-F]+)\}|\\u([\da-fA-F]{4})|\\x([\da-fA-F]{2})/g, (_, braced?: string, four?: string, two?: string) => {
    const code = Number.parseInt(braced ?? four ?? two ?? '0', 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : '\\';
  });
  return decoded.includes('\\') ? undefined : decoded;
}

/**
 * A text without the wrappers that change its type and not its value: parentheses, a trailing `as X`, `satisfies X` or `!`, and a
 * leading `<X>`.
 */
export function unwrapped(text: string): string {
  let inner = text.trim();
  for (;;) {
    const next = inner
      .replace(/^\(([\s\S]*)\)$/, '$1')
      .replace(/\s+(?:as|satisfies)\s+[\w$.]+(?:<[^<>]*>)?$/, '')
      .replace(/!$/, '')
      .replace(/^<[\w$.|\s]+>/, '')
      .trim();
    if (next === inner) return inner;
    inner = next;
  }
}

/** The value of a string literal, or of a template without substitutions, written as `text`; `undefined` for anything else, and for an escape other than `\u` and `\x`. */
export function stringLiteral(text: string): string | undefined {
  const quoted = /^(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\$]|\\.|\$(?!\{))*)`)$/.exec(unwrapped(text));
  const body = quoted?.[1] ?? quoted?.[2] ?? quoted?.[3];
  return body === undefined ? undefined : unescaped(body);
}

/**
 * The one reader of a key written between brackets (`{ [key]: 1 }`, `vi[key](…)`), so that no reader of the scan compares a name the
 * others cannot spell. The name is the string of a literal or of a template without substitutions, a number as it is written, or a
 * name that every value the file gives it spells as one string, each with `as`, `satisfies`, `!` and parentheses taken off. The code
 * has its strings blanked, so the text is read from the `source` at the same offsets. Anything else is `undefined`: the scan cannot
 * say which key it is.
 */
export function keyText(code: string, source: string, text: string, at: number, depth = 0): string | undefined {
  const literal = stringLiteral(text);
  if (literal !== undefined) return literal;
  const inner = unwrapped(text);
  if (numericLiteral.test(inner)) return inner;
  if (depth > 3 || !/^[A-Za-z_$][\w$]*$/.test(inner)) return undefined;
  const names = heldValues(code, placeAt(code, at), inner, at).map((held) =>
    held.value === UNREAD ? undefined : keyText(code, source, source.slice(held.at, held.at + valueText(held.value).length), held.at, depth + 1));
  return names.length > 0 && names.every((name) => name !== undefined && name === names[0]) ? names[0] : undefined;
}

/**
 * A property's key and value text. A quoted key is blanked in the code, so its name is read from the original source at the same
 * offsets: `{ "timeout": 100 }` names `timeout`. A bracketed key is read by `keyText`. A spread, a bracketed key `keyText` cannot
 * resolve or a quoted key with an escape other than `\u` and `\x` is `undefined`; a method or a numeric key gets an empty name.
 */
export function propertyKey(code: string, source: string, property: Item): { name: string; value?: string } | undefined {
  const { text, start } = property;
  if (text.startsWith('...')) return undefined;
  if (text.startsWith('[')) {
    const close = closeOf(code, start);
    const name = keyText(code, source, source.slice(start + 1, close), start);
    if (name === undefined) return undefined;
    const colon = /^\s*:/.exec(text.slice(close - start + 1));
    return colon ? { name, value: text.slice(close - start + 1 + colon[0].length).trim() } : { name: '' };
  }
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
export function shortDefault(code: string, param: Item): boolean {
  const parsed = /^(?:\.\.\.)?([\w$]+)\s*\??\s*(?::[^=]*)?=([\s\S]*)$/.exec(param.text);
  return parsed !== null && !/interval/i.test(parsed[1] ?? '') && isShort(waitMs(code, param.start, parsed[2]));
}

/** The server scanner's original traversal scope, expressed for oxlint paths. */
export const scannedServerFile = (file: string): boolean => file.startsWith('packages/cezar/src/')
  && /\.(?:test|testkit)\.ts$/.test(file)
  && !file.split('/').some(part => part === '__fixtures__' || part === 'node_modules')
  && !['test-wait-discipline.test.ts', 'test-wait-discipline.testkit.ts'].includes(file.slice('packages/cezar/src/'.length));

export const testWaitDiscipline: SourceRule = {
  name: 'test-wait-discipline',
  description: 'Wait on the product signal, with a reason for a wall-clock bound.',
  applies: scannedServerFile,
  check(file, source) {
    const relative = file.slice('packages/cezar/src/'.length);
    const { sites, errors } = scanFile(relative, source);
    const findings = baselines.flatMap(baseline => {
      const mine = sites.filter(site => baseline.rules.includes(site.rule));
      const { added } = compareToBaseline(tally(mine), readBaseline(baseline.path));
      return added.flatMap(entry => mine.filter(site => site.rule === entry.rule && site.site === entry.site).map(site => ({
        line: site.line,
        message: `[${site.rule}] ${site.site}. ${waitRemedy(site.rule)}. Never add a site to ${baseline.path}`,
      })));
    });
    return [...findings, ...errors.map(error => ({ line: error.line, message: `Unterminated ${error.construct}: ${error.text}. Fix the scan's blanking in packages/cezar/src/lint/blank.ts; everything after this went unread (AGENTS.md § Validation)` }))];
  },
};

export const waitRemedy = (rule: Rule): string => rule === 'poll-deadline'
  ? 'A poll loop needs a deadline of 10 s or more, read from the clock in the loop or its function (or attempts x interval with literals). Add one, or state why the loop ends as a `// bound: <reason>` comment on its first line (AGENTS.md § Validation)'
  : "Wait on the product's own signal, or state the bound's reason at the site as a `// bound: <reason>` comment (AGENTS.md § Validation)";
