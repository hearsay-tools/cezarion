import { sizedOutside } from './test-wait-discipline.ts';
import { blank, skipSpaceBack, skipSpaceForward } from './blank.ts';
import { closeOf, argsOf, namedNumbers, literalMs, type PollLoop, type Entry, track, paramsStart } from './server-wait-syntax.ts';

/** `Date.now()`, `performance.now()` and `process.hrtime()`, the clocks a deadline is read from. */
export const clockCall = String.raw`(?:Date\s*\.\s*now|performance\s*\.\s*now|process\s*\.\s*hrtime(?:\s*\.\s*bigint)?)\s*\(\s*\)`;

export const comparator = String.raw`(?:<=?|>=?)`;

/** What a clock comparison measures against: a literal sum of products (`5 * 1_000`, `2_000 + 500`) or one name or path. Anything else is a shape the scan does not read. */
export const limitToken = String.raw`(?:\d[\w.]*(?:\s*[-+*/]\s*\d[\w.]*)*|[A-Za-z_$][\w$.]*)`;

/** `Date.now() - start > 15_000` and `15_000 < Date.now() - start`: the start and the bound, in either form. */
export const elapsedBounds = new RegExp(String.raw`${clockCall}\s*-\s*([A-Za-z_$][\w$.]*)\s*${comparator}\s*(${limitToken})|(${limitToken})\s*${comparator}\s*${clockCall}\s*-\s*([A-Za-z_$][\w$.]*)`, 'g');

/** `Date.now() < start + 15_000` and `start + 15_000 > Date.now()`: the start and the term added to it, in either form. */
export const sumBounds = new RegExp(String.raw`${clockCall}\s*${comparator}\s*([A-Za-z_$][\w$.]*)\s*\+\s*(${limitToken})|([A-Za-z_$][\w$.]*)\s*\+\s*(${limitToken})\s*${comparator}\s*${clockCall}`, 'g');

/** `Date.now() < deadline` or `deadline < Date.now()`: the deadline's name. */
export const deadlineNames = new RegExp(String.raw`${clockCall}\s*${comparator}\s*([A-Za-z_$][\w$]*)|\b([A-Za-z_$][\w$]*)\s*${comparator}\s*${clockCall}`, 'g');

export type Deadline = 'none' | 'unreadable' | number;

export const inFunction = (stack: Entry[], free: number): boolean => stack.filter((entry) => entry.kind === 'function' || entry.kind === 'arrow').length > free;

/**
 * The code between two offsets with the functions nested in it blanked: what a helper compares, counts
 * or declares is its own, and says nothing about the loop. `free` is the number of function frames
 * that are the text's own surroundings, such as the body of the function a scope starts at.
 */
export function ownText(code: string, from: number, to: number, free = 0): string {
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
export function closureText(code: string, from: number, to: number, free = 0): string {
  const own = ownText(code, from, to, free);
  let text = '';
  for (let i = from; i < to; i += 1) text += own[i - from] === ' ' && code[i] !== ' ' && code[i] !== '\n' ? (code[i] ?? '') : code[i] === '\n' ? '\n' : ' ';
  return text;
}

/** The starts of the functions around the one that starts at `scope`, outermost first, then `scope` itself: where each lexical scope begins. */
export function scopeChain(code: string, scope: number): number[] {
  const stack: Entry[] = [];
  for (let i = 0; i < scope; i += 1) track(code, stack, i);
  const around = stack.filter((entry) => entry.kind === 'function' || entry.kind === 'arrow').map((entry) => paramsStart(code, entry.open));
  return scope === 0 ? [] : [...around, scope];
}

export let outerCache: { code: string; scope: number; text: string; bounds: number[] } | undefined;

/**
 * The text before a loop's function, as each scope around it sees it: the module, and every function around the loop, with the
 * functions that sit beside the loop's own blanked. A name used in the loop is looked up in it after the loop's own function.
 * `bounds` are where each scope starts, outermost first, ending with the loop's own function.
 */
export function outerOf(code: string, scope: number): { text: string; bounds: number[] } {
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
export const scopeBefore = (code: string, loop: PollLoop, upto: number): string => outerOf(code, loop.scope).text + ownText(code, loop.scope, upto, loop.scope === 0 ? 0 : 1);

export const compare = String.raw`(?<!=)(?:<=?|>=?)`;

export const escapeName = (name: string): string => name.replace(/\$/g, '\\$');

/** A bound on how long a loop runs, in milliseconds: `unreadable` when one exists the scan cannot evaluate, `undefined` when there is none. */
export type Bound = number | 'unreadable' | undefined;

/** Where a counter starts, from `let name = 0` or `var name = 0`: the only declaration of the header, with a literal. */
export function counterStart(init: string, name: string, { read }: Reader): number | undefined {
  const started = new RegExp(String.raw`^\s*(?:let|var)\s+${escapeName(name)}\s*(?::[^=,]*)?=\s*([^,;]+?)\s*$`).exec(init);
  return read(started?.[1] ?? '');
}

/**
 * What an update adds to a counter: `name++`, `++name` or `name += <positive literal>`. `unreadable` when the amount is a name;
 * any other update is `undefined`.
 */
export function counterStep(update: string, name: string, { read, outside }: Reader): number | 'unreadable' | undefined {
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
export function iterations(init: string, update: string, name: string, operator: string, limit: number | 'name' | undefined, reader: Reader): Bound {
  const start = counterStart(init, name, reader);
  const step = counterStep(update, name, reader);
  if (start === undefined || step === undefined || limit === undefined) return undefined;
  if (limit === 'name' || step === 'unreadable') return 'unreadable';
  const span = limit - start;
  return Math.max(0, operator === '<=' ? Math.floor(span / step) + 1 : Math.ceil(span / step));
}

export const isNumber = (value: unknown): value is number => typeof value === 'number';

/** A loop ends at the first of its exits that fires: the smallest bound, or `unreadable` when only unreadable ones exist. */
export function earliest(bounds: readonly Bound[]): Bound {
  const known = bounds.filter(isNumber);
  if (known.length > 0) return Math.min(...known);
  return bounds.includes('unreadable') ? 'unreadable' : undefined;
}

/**
 * A condition of several parts holds once every part does: the largest of their bounds. A part with no bound may never hold, so
 * it leaves the whole with none; a part with a bound the scan cannot read leaves it `unreadable`.
 */
export function latest(bounds: readonly Bound[]): Bound {
  if (bounds.includes(undefined)) return undefined;
  return bounds.every(isNumber) ? Math.max(...bounds) : 'unreadable';
}

/**
 * The matches of a pattern in the loop's function, before `at`, that the code at `at` can see: those whose `{…}` block is
 * still open there. A block that closed earlier, or one the use is not in, declares nothing the use can read.
 */
export function visibleMatches(code: string, loop: PollLoop, at: number, pattern: RegExp): RegExpMatchArray[] {
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

export const compound = String.raw`(?:[-+*/%&|^]|<<|>>>?|\*\*|&&|\|\||\?\?)=(?![=>])`;

/**
 * Whether `text` writes `name`: `name++`, `name += 1`, a destructuring target, and with `plain` also `name = …`. A closure counts,
 * since it can reassign the name; a read in a comparison does not (`name <= 5`, `name == 5`), nor does a declaration (`let name = …`).
 */
export function writesName(text: string, name: string, plain: boolean): boolean {
  const n = escapeName(name);
  const write = plain ? String.raw`(?:${compound}|=(?![=>]))` : compound;
  const bare = String.raw`(?<![\w$.])${n}(?![\w$])`;
  const declared = String.raw`(?<!\b(?:let|const|var)\s+)`;
  return new RegExp(String.raw`${declared}(?<![\w$.])${n}\s*(?:\+\+|--|${write})|(?:\+\+|--)\s*${n}(?![\w$])|\[[^\]]*${bare}[^\]]*\]\s*=(?![=>])|\{[^}]*${bare}[^}]*\}\s*=(?![=>])`).test(text);
}

/** Whether the loop's function writes `name` other than by a plain assignment, up to the end of the loop: the scan cannot say which value is in force. */
export function writtenOtherwise(code: string, loop: PollLoop, name: string): boolean {
  return writesName(code.slice(loop.scope, Math.max(loop.body[1], loop.head?.[1] ?? 0) + 1), name, false);
}

/** What may follow a value in the text: the end of its statement, or of the list it sits in. */
export const valueEnd = String.raw`(?=\s*(?:[;,)\n]|$))`;

export const pathOnly = new RegExp(String.raw`^[A-Za-z_$][\w$.]*${valueEnd}`);

/** A value the scan cannot read: a name of an outer scope that is written after its declaration. */
export const UNREAD = '\u0000';

/** One value a name can hold, as the text that follows its `=`, where that text starts in the code, and whether it is a parameter's default. */
export interface Held {
  value: string;
  at: number;
  param: boolean;
}

export let moduleCache: { code: string; text: string } | undefined;

/** The module's own text: everything outside a function, at the same offsets as `code`. */
export function moduleText(code: string): string {
  if (moduleCache?.code !== code) moduleCache = { code, text: ownText(code, 0, code.length, 0) };
  return moduleCache.text;
}

/** The depths of the scopes whose parameter list binds `name`, with or without a default: a parameter hides the same name of the scopes around it. */
export function paramDepths(code: string, bounds: number[], name: string): number[] {
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
export function heldValues(code: string, loop: PollLoop, name: string, at: number): Held[] {
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

export const valuesBefore = (code: string, loop: PollLoop, name: string, at: number): string[] => heldValues(code, loop, name, at).map((each) => each.value);

/** Whether the file declares `name` itself: a `const`, `let`, `var`, function or class, a destructured binding or a loop variable. A parameter and an import are the caller's. */
export function declaredHere(code: string, loop: PollLoop, name: string, at: number): boolean {
  return heldValues(code, loop, name, at).some((each) => !each.param) || declaredApart(code, name);
}

/** Whether `text` is a name or path that the file does not declare: a parameter, an import or a global, so a value the caller sizes. */
export function isOutside(code: string, loop: PollLoop, text: string, at: number): boolean {
  const root = /^([A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)*$/.exec(text.trim())?.[1];
  return root !== undefined && !declaredHere(code, loop, root, at);
}

/** The text of the value that starts the string: up to the first `;`, `,` or newline outside a bracket, or the bracket that closes the list it sits in. */
export function valueText(text: string): string {
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
export function declaredApart(code: string, name: string): boolean {
  const n = escapeName(name);
  return new RegExp(String.raw`\b(?:function\s*\*?|class)\s+${n}(?![\w$])|\b(?:let|const|var)\s*[\[{][^;=]*(?<![\w$.])${n}(?![\w$])[^;=]*[\]}]\s*=|\bfor\s*(?:await\s*)?\(\s*(?:let|const|var)\s+${n}(?![\w$])`).test(code);
}

/** What a name the scan cannot follow stands for: a value the caller sizes when the file does not declare it, else a shape the scan does not read: no bound. */
export function unfollowed(code: string, loop: PollLoop, name: string, at: number): Bound {
  return declaredHere(code, loop, name, at) ? undefined : 'unreadable';
}

/**
 * What a name stands for where the code at `at` reads it: the smallest number it can hold. `unreadable` for a value that comes from
 * outside the file (a parameter without a default, an import, a global, a property of either). `undefined` for a name the file
 * declares and the scan cannot evaluate: one set to an expression it does not read (a call, a ternary, a destructured binding), one
 * written some other way (`name += 1`, an outer `let` written after its declaration) and one that leads to such a name.
 */
export function nameBound(code: string, loop: PollLoop, name: string, at: number, depth = 0): Bound {
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
export function aliasOutside(code: string, loop: PollLoop, target: string, at: number, depth: number): boolean {
  if (!/^[A-Za-z_$][\w$]*$/.test(target)) return isOutside(code, loop, target, at);
  return nameBound(code, loop, target, at, depth + 1) !== undefined;
}

/**
 * The loop's bound `text` in milliseconds as the code at `at` reads it: a number written out, or an expression of numbers and names
 * for them (`POLL_MS * 2`). A name is read through every scope around the use. A name or path from outside the file is `unreadable`.
 * Any other expression, and a name the file sets to one, is a shape the scan does not read: no bound.
 */
export function literalBound(code: string, loop: PollLoop, text: string, at: number): Bound {
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
export function definedBound(code: string, loop: PollLoop, name: string, at: number): Bound {
  if (writtenOtherwise(code, loop, name)) return unfollowed(code, loop, name, at);
  const sum = new RegExp(String.raw`^${clockCall}\s*\+\s*(${limitToken})${valueEnd}`);
  const bounds = valuesBefore(code, loop, name, at).map((value) => {
    const limit = sum.exec(value)?.[1];
    return limit !== undefined ? literalBound(code, loop, limit.trim(), at) : pathOnly.test(value) && aliasOutside(code, loop, valueText(value).trim(), at, 0) ? 'unreadable' : undefined;
  });
  return bounds.includes(undefined) ? undefined : earliest(bounds) ?? 'unreadable';
}

/** Whether every value the code at `at` can see for the start `name` is one the scan reads: a read of the clock, or a name or path of the caller's. */
export function startsAtClock(cx: Probe, name: string, at: number): boolean {
  const clock = new RegExp(String.raw`^${clockCall}${valueEnd}`);
  return name.includes('.') || valuesBefore(cx.code, cx.loop, name, at).every((value) => clock.test(value) || pathOnly.test(value));
}

/** What one poll loop is judged by. */
export interface Probe {
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
export type Reader = Pick<Probe, 'read' | 'outside'>;

/**
 * Whether a pass of the loop changes the name the code at `at` reads: the declaration in view sits in the loop body (it runs again
 * every pass; one before the loop, or in a `for` header, runs once), or anything in the loop writes the name (a closure too).
 */
export function movesIn(cx: Probe, name: string, at: number): boolean {
  // A path (`state.deadline`) moves when the path or the name it starts from does.
  const root = name.split('.')[0] ?? '';
  const declaration = new RegExp(String.raw`\b(?:let|const|var)\s+${escapeName(root)}(?![\w$])`, 'g');
  const nearest = visibleMatches(cx.code, cx.loop, at, declaration).at(-1);
  const closures = closureText(cx.code, cx.loop.scope, Math.max(cx.loop.body[1], cx.loop.head?.[1] ?? 0) + 1, cx.loop.scope === 0 ? 0 : 1);
  const written = (text: string): boolean => writesName(text, name, true) || writesName(text, root, true);
  return (nearest?.index !== undefined && nearest.index >= cx.loop.body[0]) || written(cx.again) || written(closures);
}

/** Whether the loop changes any name or path the text reads. */
export const movesAny = (cx: Probe, text: string, at: number): boolean => (text.match(/(?<![\w$.])[A-Za-z_$][\w$.]*/g) ?? []).some((name) => movesIn(cx, name, at));

/** Whether a condition only reads: no write, no call but a read of the clock, no `new`, `await` or `delete`. */
export function isPure(text: string): boolean {
  const reads = text.replace(new RegExp(clockCall, 'g'), 'NOW');
  return !/(?<![=!<>])=(?![=>])|(?:<<|>>>?|\*\*|&&|\|\||\?\?)=|\+\+|--|\b(?:new|await|delete)\b|[\w$\])]\s*(?:\?\.)?\(/.test(reads);
}

/** The matches that are the whole text: a form the scan reads must be the condition itself, not a part of a larger expression. */
export const wholly = (text: string, pattern: RegExp): RegExpMatchArray[] => [...text.matchAll(pattern)].filter((match) => match[0].trim() === text.trim());

/**
 * What the loop sets `name` to on every pass: its only write, a plain assignment or a declaration with a value, written as a
 * statement of the loop body itself before any statement that holds a `continue`. A write in a branch, a closure, the header or
 * after a `continue` may not run in a pass, so the name may keep an old value and a comparison against it ends nothing. The value
 * is read where the statement is, since the body can declare a name of its own for it.
 */
export function perPass(cx: Probe, name: string): { value: string; at: number } | undefined {
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

export const identifier = String.raw`[A-Za-z_$][\w$]*`;

/** What a comparison of a name with the clock says when the loop sets the name from the clock on every pass (`elapsed = Date.now() - t0`, `elapsed > 5_000`; `now = Date.now()`, `now > deadline`). */
export function aliasLeaf(text: string, cx: Probe, at: number): Bound {
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
export function clockLeaf(text: string, cx: Probe, at: number): Bound {
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
export function timeOf(count: number, interval: Bound): Bound {
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
export function counterLeaf(text: string, cx: Probe, at: number): Bound {
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
export function aliasText(name: string, want: boolean, cx: Probe, at: number, depth: number): Bound {
  // A flag the loop does not set on every pass keeps an old value, so it ends nothing.
  const pass = depth < 3 ? perPass(cx, name) : undefined;
  return pass === undefined ? undefined : endsText(pass.value, want, cx, pass.at, depth + 1);
}

/** Split text at the top-level occurrences of an operator, outside any bracket. */
export function splitTop(text: string, operator: string): string[] {
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
export const unwrap = (text: string): string => (text.startsWith('(') && closeOf(text, 0) === text.length - 1 ? unwrap(text.slice(1, -1).trim()) : text);

/**
 * The time by which a condition is certain to be `want`, as the loop's clock or counter sees it. For the loop head, `want` is
 * false (the loop runs while it holds); for the test of an `if` that leaves the loop, it is true. `a && b` is false once either
 * part is, and true once both are; `a || b` is the other way round. A condition of any other shape (a ternary, `??`, a call, an
 * equality) has no bound.
 */
export function endsText(raw: string, want: boolean, cx: Probe, at: number, depth = 0): Bound {
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
export function startsStatement(region: string, from: number, i: number): boolean {
  const k = skipSpaceBack(region, i - 1);
  return k < from || ';{}'.includes(region[k] ?? '');
}

export const exitWord = /(?:break|return|throw)\b/y;

/** Whether the statement at `start` ends the loop by itself: a `break`, `return` or `throw`, or a block with one among its own statements that no `continue` comes before. */
export function leavesDirectly(region: string, start: number): boolean {
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

export const ifHead = /if\s*\(/y;

/**
 * The bounds of the exits in the loop's own body: `if (<condition>) break`, `return` or `throw`, written as a statement of the body
 * itself, before any statement that holds a `continue`. An `if` inside another `if`, an `else`, a `switch`, a `try`, a block or
 * an inner loop may never be reached, and a branch that leaves only inside another `if` may never leave, so neither counts.
 */
export function exitBounds(cx: Probe): Bound[] {
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
export interface LoopSleep {
  delay: string | undefined;
  always: boolean;
}

/**
 * Whether every pass of the loop reaches the sleep at `offset`. Nothing before it in the body skips it: not a nested block (a branch,
 * a `try`, a loop), not a short circuit or a ternary, not an `if (…)` or `else` without braces, and no `continue`. A sleep a pass may
 * skip is not part of the time one pass takes.
 */
export function runsEveryPass(code: string, loop: PollLoop, offset: number): boolean {
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
export function pollDeadline(code: string, loop: PollLoop, sleeps: LoopSleep[]): Deadline {
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
