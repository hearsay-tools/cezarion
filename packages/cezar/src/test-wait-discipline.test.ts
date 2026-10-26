import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type Baseline,
  baselines,
  blank,
  compareToBaseline,
  readBaseline,
  scanFile,
  scannedFiles,
  scanSource,
  scanSuite,
  shrinkBaseline,
  SHORT_BOUND_MS,
  tally,
  type Site,
} from './test-wait-discipline.testkit.ts';

/**
 * The server unit tests' wait discipline, as a source scan (hearsay-tools/cezarion#1155). A bare
 * sleep stands in for a condition nobody named; a wait bounded under 10 s puts a wall clock on a
 * fixture a loaded host can take longer than that to start; a poll loop with no deadline, or one
 * under 10 s, does the same (hearsay-tools/cezarion#1203). Each rule is pinned on a snippet here,
 * and the suite's real sites are pinned in baselines that can only shrink, the same shape
 * `packages/web/src/test/e2e-wait-discipline.test.ts` uses for the cockpit specs.
 */
const rules = (sites: Site[]) => sites.map((s) => s.rule);
const lines = (sites: Site[]) => sites.map((s) => s.line);
/** The `sleep` and `short-bound` sites of a snippet; `polls` below holds the poll loops. */
const scan = (...src: string[]) => scanSource('x.test.ts', src.join('\n')).filter((s) => s.rule !== 'poll-deadline');
const polls = (...src: string[]) => scanSource('x.test.ts', src.join('\n')).filter((s) => s.rule === 'poll-deadline');
const errors = (...src: string[]) => scanFile('x.test.ts', src.join('\n')).errors.map(({ line, construct }) => ({ line, construct }));

describe('blanking strings and comments', () => {
  it('keeps line and column positions', () => {
    const src = "const a = 'x(y'; // z\n/* p\nq */ const b = `t${c}u`;";
    const out = blank(src);
    expect(out).toHaveLength(src.length);
    expect(out.split('\n').map((l) => l.length)).toEqual(src.split('\n').map((l) => l.length));
    expect(out).toBe("const a = '   ';     \n    \n     const b = ` ${c} `;");
  });

  it('does not see a sleep inside a string, a template or a comment', () => {
    expect(scan(
      "const a = 'await sleep(100)';",
      'const b = "await new Promise(r => setTimeout(r, 100))";',
      'const script = `',
      '  await new Promise(resolve => setTimeout(resolve, 100));',
      '  await vi.waitFor(() => ready());',
      '`;',
      '// await sleep(100)',
      '/* await sleep(100)',
      '   await vi.waitFor(() => ready()) */',
    )).toEqual([]);
  });

  it('sees a sleep inside a ${} substitution, which is code, nested templates included', () => {
    const sites = scan(
      'const script = `before ${await sleep(100)} after`;',
      'const nested = `a ${`b ${await delay(5)} c`} d`;',
    );
    expect(rules(sites)).toEqual(['sleep', 'sleep']);
    expect(lines(sites)).toEqual([1, 2]);
  });

  it('crosses a regex literal holding a quote or a backtick', () => {
    const sites = scan(
      "const re = /['`]/;",
      'await sleep(100);',
      "const ok = x.replace(/[\"']/g, '');",
      'await delay(5);',
    );
    expect(lines(sites)).toEqual([2, 4]);
  });

  it('reads a / after an if, while, for or with head as a regex, not a division', () => {
    const src = [
      'if (ok) /[`]/.test(x);',
      'await sleep(50);',
      "while (more()) /['\"]/.test(y);",
      'await delay(5);',
      'for (const k of ks) /`/.test(k);',
      'await pause(5);',
      'for await (const c of cs) /`/.test(c);',
      'await wait(5);',
    ];
    expect(lines(scan(...src))).toEqual([2, 4, 6, 8]);
    expect(errors(...src)).toEqual([]);
  });

  it('reads a head with a comment before its parenthesis, and a call with one after its dot', () => {
    const src = [
      'if /*hi*/ (ok) /[`]/.test(x);',
      'await sleep(50);',
      'for await /*hi*/ (const c of cs) /`/.test(c);',
      'await delay(5);',
      'const r = Symbol./*c*/for(x) / 2 + "/";',
      'await pause(5);',
    ];
    expect(lines(scan(...src))).toEqual([2, 4, 6]);
    expect(errors(...src)).toEqual([]);
  });

  it('still reads a / after a call or a grouped expression as a division', () => {
    const src = ['const r = f(a) / 2 + "/";', 'await sleep(50);', 'const q = (a + b) / 2 + "/";', 'await sleep(50);'];
    expect(lines(scan(...src))).toEqual([2, 4]);
    expect(errors(...src)).toEqual([]);
  });

  it('reports an unterminated string, template, substitution or block comment rather than swallowing what follows', () => {
    expect(errors('const s = `abc', 'await sleep(50);')).toEqual([{ line: 1, construct: 'template' }]);
    expect(errors('const s = `a ${f(', 'await sleep(50);')).toEqual([{ line: 1, construct: 'substitution' }]);
    expect(errors("const s = 'abc", 'await sleep(50);')).toEqual([{ line: 1, construct: 'string' }]);
    expect(errors('/* never closed', 'await sleep(50);')).toEqual([{ line: 1, construct: 'comment' }]);
    // A string stops at its line end, so the code after it is still read.
    expect(lines(scan("const s = 'abc", 'await sleep(50);'))).toEqual([2]);
    expect(errors("const s = 'a\\", "b';", '`x${`y`}z`;')).toEqual([]);
  });
});

describe('rule sleep', () => {
  it('flags each awaited sleep form, whatever its argument', () => {
    const sites = scan(
      'await delay(50);',
      'await sleep(DELAY_MS);',
      'await wait(options.gate);',
      'await pause(1_000);',
      'await setTimeout(50);',
      'await timers.setTimeout(50);',
      'await new Promise(r => setTimeout(r, 50));',
      'await new Promise((resolve) => setTimeout(resolve, 50));',
      'await new Promise<void>((done) => { setTimeout(done, 50); });',
      'await new Promise(r => globalThis.setTimeout(r, 50));',
      'await new Promise(r => global.setTimeout(r, 50));',
      'await new Promise(resolve => realSetTimeout(resolve, ms));',
    );
    expect(lines(sites)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(new Set(rules(sites))).toEqual(new Set(['sleep']));
    expect(sites[6]?.site).toBe('await new Promise(r => setTimeout(r, 50));');
  });

  it('flags the block-arrow form that returns the timer', () => {
    const sites = scan(
      'await new Promise(r => { return setTimeout(r, 50); });',
      'await new Promise((resolve) => { return globalThis.setTimeout(resolve, 50); });',
    );
    expect(lines(sites)).toEqual([1, 2]);
  });

  it('leaves a literal 0 alone: that is one event-loop turn, not a wait', () => {
    expect(scan(
      'await sleep(0);',
      'await setTimeout(0);',
      'await new Promise(r => setTimeout(r, 0));',
      'await new Promise(r => setTimeout(r));',
      'await sleep(0.0);',
      'await sleep(0x0);',
    )).toEqual([]);
  });

  it('leaves a timer that is not a sleep alone', () => {
    expect(scan(
      'const timer = setTimeout(() => controller.abort(), 5_000);',
      "await new Promise((_, reject) => setTimeout(() => reject(new Error('deadline')), 5_000));",
      'await obj.sleep(100);',
    )).toEqual([]);
  });

  it('leaves a sleep in a loop body alone: it is a poll interval', () => {
    expect(scan(
      'while (!ready()) {',
      '  if (Date.now() > deadline) throw new Error("late");',
      '  await sleep(10);',
      '}',
      'for (let i = 0; i < 10; i += 1) {',
      '  if (ready()) break;',
      '  await new Promise(r => setTimeout(r, 10));',
      '}',
      'do {',
      '  await delay(10);',
      '} while (!ready());',
      'for await (const chunk of stream) {',
      '  await pause(5);',
      '}',
      'while (!ready()) await sleep(10);',
      'for (const x of xs) if (x) await sleep(10);',
      'while (!ready()) { try { await check(); } catch { await sleep(10); } }',
      'const churn = (async () => { while (on) { await delay(15); } })();',
    )).toEqual([]);
  });

  it('flags a sleep after its loop closes, and one in a test a loop defines', () => {
    const sites = scan(
      'while (!ready()) {',
      '  await sleep(10);',
      '}',
      'await sleep(300);',
      'for (const row of ROWS) {',
      "  it(row.id, async () => {",
      '    await sleep(300);',
      '  });',
      '}',
      'for (const row of ROWS) it(row.id, async () => { await sleep(300); });',
    );
    expect(lines(sites)).toEqual([4, 7, 10]);
  });

  it('flags a sleep in a concise arrow a loop defines: its body is a function body, not the loop body', () => {
    const sites = scan(
      'for (const r of rows) { it(r, async () => await sleep(300)); }',
      'for (const r of rows) it(r, async () => await sleep(300))',
      'while (x) { await Promise.all(xs.map(async x => await sleep(5))) }',
    );
    expect(lines(sites)).toEqual([1, 2, 3]);
  });

  it('still leaves a loop sleep alone after a concise arrow ends, and beside a conditional', () => {
    expect(scan(
      'while (!ready()) { await sleep(10) }',
      'for (;;) { const v = await retry(() => check(), 3); await sleep(10) }',
      'while (!ok) { ok = items.some(i => i.done); await sleep(25) }',
      'for (const x of xs) { await sleep(x ? 10 : 20) }',
    )).toEqual([]);
  });

  it('reads a multi-line loop header and a function with a return type', () => {
    expect(rules(scan(
      'for (',
      '  let i = 0;',
      '  i < 3;',
      '  i += 1',
      ') {',
      '  await sleep(10);',
      '}',
      'while (x) {',
      '  async function f(): Promise<void> {',
      '    await sleep(10);',
      '  }',
      '}',
    ))).toEqual(['sleep']);
  });
});

describe('rule short-bound', () => {
  it('pins the threshold at 10 s', () => {
    expect(SHORT_BOUND_MS).toBe(10_000);
  });

  it('flags Vitest waits left at their 1 s default', () => {
    const sites = scan(
      'await vi.waitFor(() => expect(x).toBe(1));',
      'await vi.waitUntil(() => ready());',
      'await expect.poll(() => count()).toBe(2);',
      'await vi.waitFor(() => expect(x).toBe(1), { interval: 10 });',
    );
    expect(rules(sites)).toEqual(['short-bound', 'short-bound', 'short-bound', 'short-bound']);
    expect(lines(sites)).toEqual([1, 2, 3, 4]);
  });

  it('flags a literal bound under 10 s in the number form and in an options object', () => {
    const sites = scan(
      'await vi.waitFor(() => ready(), 2_000);',
      'await vi.waitFor(() => ready(), { timeout: 5_000, interval: 20 });',
      'await vi.waitUntil(() => ready(), { timeout: 9_999 });',
      'await expect.poll(() => count(), { timeout: 3000 }).toBe(1);',
      'await vi.waitFor(() => ready(), { timeout: 10_000 });',
      'await vi.waitFor(() => ready(), 30_000);',
      'await expect.poll(() => count(), { timeout: 15_000 }).toBe(1);',
    );
    expect(lines(sites)).toEqual([1, 2, 3, 4]);
  });

  it("reads only the options object's own timeout, whatever its other properties hold", () => {
    const sites = scan(
      'await vi.waitFor(cb, { interval: fn({ timeout: 20_000 }) });',
      'await vi.waitFor(cb, { nested: { timeout: 20_000 }, timeout: 100 });',
      'await vi.waitFor(cb, { "timeout": 20_000 });',
      "await vi.waitFor(cb, { 'timeout': 100 });",
      'await vi.waitFor(cb, { timeout: /* ms */ 20_000, interval: 10 });',
    );
    expect(lines(sites)).toEqual([1, 2, 4]);
  });

  it('lets an explicit timeout after the last spread decide the bound', () => {
    const sites = scan(
      'await vi.waitFor(cb, { ...options, timeout: 100 });',
      'await vi.waitFor(cb, { timeout: 100, ...options });',
      'await vi.waitFor(cb, { ...options });',
      'await vi.waitFor(cb, { ...a, timeout: 20_000, ...b });',
      'await vi.waitFor(cb, { ...a, timeout: 20_000, interval: 5 });',
      'await vi.waitFor(cb, { [key]: 20_000 });',
      // An escaped key is not decoded: like a computed key it is unreadable, whatever it names.
      'await vi.waitFor(cb, { "\\u0074imeout": 20_000 });',
      'await vi.waitFor(cb, { "\\u0074imeout": 100 });',
    );
    expect(lines(sites)).toEqual([1]);
  });

  it('reads every numeric literal form the same way in calls, options and defaults', () => {
    const sites = scan(
      'await vi.waitFor(cb, { timeout: 5e3 });',
      'await vi.waitFor(cb, 9.999e3);',
      'await vi.waitFor(cb, 0x10);',
      'await waitFor(() => ready(), 1.5e3);',
      'async function until(check: () => boolean, timeout = 1.5) {}',
      'async function waitFor(check: () => boolean, timeout = 5e3) {}',
      'await vi.waitFor(cb, { timeout: 1e4 });',
      'await vi.waitFor(cb, 0x2710);',
      'await waitFor(() => ready(), 1E+4);',
      'async function eventually(check: () => boolean, timeout = 1e4) {}',
    );
    expect(lines(sites)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('leaves a bound it cannot read alone', () => {
    expect(scan(
      'await vi.waitFor(() => ready(), { timeout: LAUNCH_WAIT_MS });',
      'await vi.waitFor(() => ready(), waitOptions);',
      'await vi.waitFor(() => ready(), SETTLE);',
      'await vi.waitFor(() => ready(), { timeout });',
      'await vi.waitFor(() => ready(), { ...waitOptions, interval: 10 });',
      'await vi.waitFor(() => ready(), { timeout: 5_000 * 4 });',
    )).toEqual([]);
  });

  it('reads a call across lines and keys it on its first line', () => {
    const sites = scan(
      'const a = 1;',
      'await vi.waitFor(() => {',
      '  expect(store.getRun(id)?.status).toBe("done");',
      '}, {',
      '  interval: 20,',
      '  timeout: 2_000,',
      '});',
      'await expect',
      '  .poll(() => count(), { timeout: 5_000 })',
      '  .toBe(1);',
      'await vi.waitFor(() => {',
      '  expect(x).toBe(1);',
      '}, {',
      '  timeout: 20_000,',
      '});',
    );
    expect(lines(sites)).toEqual([2, 8]);
    expect(sites[0]?.site).toBe('await vi.waitFor(() => {');
  });

  it('flags a local wait helper called with a short literal after its condition', () => {
    const sites = scan(
      'await waitFor(() => ready(), 5000);',
      'await until(() => ready(), "the run to settle", 3_000);',
      'await waitUntil(id, () => {',
      '  return ready();',
      '}, 2_000);',
      'await eventually(() => ready(), 400);',
      'await waitForCondition(() => ready(), 1_000);',
      'await waitFor(() => ready(), 30_000);',
      'await waitFor(() => ready());',
      'await until(() => ready(), "label");',
    );
    expect(lines(sites)).toEqual([1, 2, 3, 6, 7]);
  });

  it('counts vi.waitFor once and leaves a method of something else alone', () => {
    expect(scan('await vi.waitFor(() => ready(), 2_000);')).toHaveLength(1);
    expect(scan('await harness.waitFor(() => ready(), 2_000);', 'await this.until(() => ready(), 100);')).toEqual([]);
  });

  it('flags a local wait helper whose bound defaults to a short literal, on its definition line', () => {
    const sites = scan(
      'async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {',
      '  await vi.waitFor(() => expect(check()).toBe(true), { timeout: timeoutMs });',
      '}',
      'const waitFor = async (predicate: () => boolean, timeoutMs: number = 4000) => {',
      '  await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: timeoutMs });',
      '};',
      'export async function eventually(cond: () => boolean, ms = 10_000): Promise<void> {}',
      'async function waitUntil(cond: () => boolean, timeoutMs = 30_000, intervalMs = 25): Promise<void> {}',
      'const until = Date.now() + 1_000;',
      'async function until(cb: () => boolean, timeout =',
      '  5000) {}',
      'const until = (cb: () => boolean, timeout =',
      '  5000) => {};',
    );
    expect(rules(sites)).toEqual(['short-bound', 'short-bound', 'short-bound', 'short-bound']);
    expect(lines(sites)).toEqual([1, 4, 10, 12]);
  });
});

describe('rule poll-deadline', () => {
  it('pins the same 10 s threshold as the short-bound rule', () => {
    expect(polls('const deadline = Date.now() + 9_999;', 'while (Date.now() < deadline) await sleep(10);')).toHaveLength(1);
    expect(polls('const deadline = Date.now() + 10_000;', 'while (Date.now() < deadline) await sleep(10);')).toEqual([]);
  });

  it('flags a loop that sleeps without a clock read or an attempt count, keyed on its first line', () => {
    const sites = polls(
      'while (!ready()) {',
      '  await sleep(10);',
      '}',
      'do {',
      '  await delay(10);',
      '} while (!ready());',
      'while (!ready()) await sleep(10);',
      'for (;;) {',
      '  if (ready()) break;',
      '  await pause(5);',
      '}',
      'const churn = (async () => { while (churning) { await delay(15); } })();',
    );
    expect(lines(sites)).toEqual([1, 4, 7, 8, 12]);
    expect(new Set(rules(sites))).toEqual(new Set(['poll-deadline']));
    expect(sites[0]?.site).toBe('while (!ready()) {');
  });

  it('leaves a loop over a collection or a stream alone: its iterable bounds it', () => {
    expect(polls(
      'for (const x of xs) await sleep(10);',
      'for (const k in obj) { await sleep(10); }',
      'for await (const chunk of stream) {',
      '  await pause(5);',
      '}',
    )).toEqual([]);
  });

  it('leaves a loop with a readable deadline of 10 s or more alone', () => {
    expect(polls(
      'const start = Date.now();',
      'while (!ready()) {',
      '  if (Date.now() - start > 15_000) throw new Error("late");',
      '  await sleep(10);',
      '}',
      'const deadline = Date.now() + 20_000;',
      'while (Date.now() < deadline) { if (ready()) break; await sleep(10); }',
      'const end = performance.now() + 10_000;',
      'while (!ready() && performance.now() < end) await sleep(10);',
      'for (const limit = Date.now() + 12_000; !ready();) { if (Date.now() > limit) break; await sleep(10); }',
      'while (Date.now() - start < 30_000) { await sleep(10); }',
    )).toEqual([]);
  });

  it('flags a literal deadline under 10 s, in each form that names one', () => {
    const sites = polls(
      'const start = Date.now();',
      'while (!ready()) {',
      '  if (Date.now() - start > 9_000) throw new Error("late");',
      '  await sleep(10);',
      '}',
      'const deadline = Date.now() + 5_000;',
      'while (Date.now() < deadline) { await sleep(10); }',
      'const end = performance.now() + 1_500;',
      'while (!ready() && performance.now() < end) await sleep(10);',
      'for (const limit = Date.now() + 8_000; !ready();) { if (Date.now() > limit) break; await sleep(10); }',
      'while (Date.now() - start < 2_000) { await sleep(10); }',
      'let until = Date.now() + 400;',
      'do { await delay(20); } while (until > Date.now());',
    );
    expect(lines(sites)).toEqual([2, 7, 9, 10, 11, 13]);
  });

  it('reads a deadline held in a parameter through its default, or in a constant of the same function', () => {
    const sites = polls(
      'async function until(check: () => boolean, ms = 5_000): Promise<void> {',
      '  const deadline = Date.now() + ms;',
      '  while (!check()) {',
      '    if (Date.now() > deadline) throw new Error("late");',
      '    await sleep(10);',
      '  }',
      '}',
      'const waitHere = async (check: () => boolean, timeoutMs: number = 15_000) => {',
      '  const end = Date.now() + timeoutMs;',
      '  while (Date.now() < end) { if (check()) return; await sleep(10); }',
      '};',
      'async function local(check: () => boolean) {',
      '  const limitMs = 2_000;',
      '  const stop = Date.now() + limitMs;',
      '  while (Date.now() < stop) { if (check()) return; await sleep(10); }',
      '}',
    );
    expect(lines(sites)).toEqual([3, 15]);
  });

  it('leaves a bound it cannot read alone', () => {
    expect(polls(
      'const deadline = Date.now() + HANG_CEILING_MS;',
      'while (Date.now() < deadline) await sleep(10);',
      'while (Date.now() < dueAt) await sleep(10);',
      'async function noDefault(check: () => boolean, ms: number) {',
      '  const deadline = Date.now() + ms;',
      '  while (Date.now() < deadline) { await sleep(10); }',
      '}',
    )).toEqual([]);
  });

  it("looks for a deadline only in the loop's own function", () => {
    const sites = polls(
      'async function a() {',
      '  const deadline = Date.now() + 1_000;',
      '  while (Date.now() < deadline) await sleep(10);',
      '}',
      'async function b(deadline: number) {',
      '  while (Date.now() < deadline) await sleep(10);',
      '}',
    );
    expect(lines(sites)).toEqual([3]);
  });

  it('reads attempts x interval as the deadline when both are literals', () => {
    const sites = polls(
      'for (let attempt = 0; attempt < 20; attempt += 1) {',
      '  if (ready()) break;',
      '  await sleep(100);',
      '}',
      'for (let attempt = 0; attempt < 200 && state.status !== "error"; attempt += 1) {',
      '  await sleep(100);',
      '}',
      'for (let i = 0; i < 10; i++) { await sleep(500); await sleep(400); }',
      'for (let i = 0; i < 100; i++) { await sleep(100); }',
      'for (let i = 0; i <= 99; i++) await new Promise(r => setTimeout(r, 90));',
    );
    expect(lines(sites)).toEqual([1, 8, 10]);
  });

  it('counts only the sleeps every pass reaches: a sleep a pass may skip is not part of the interval', () => {
    const counted = (...body: string[]) => lines(polls('for (let i = 0; i < 20; i++) {', ...body.map((line) => `  ${line}`), '}'));
    // 20 passes of 100 ms are 2 s; counting the skippable 10 s sleep would make them 202 s.
    expect(counted('await sleep(100);', 'if (rare()) await sleep(10_000);')).toEqual([1]);
    expect(counted('await sleep(100);', 'if (rare()) { await sleep(10_000); } else { log(); }')).toEqual([1]);
    expect(counted('await sleep(100);', 'ok() && await sleep(10_000);')).toEqual([1]);
    expect(counted('await sleep(100);', 'const wait = rare() ? await sleep(10_000) : 0;')).toEqual([1]);
    expect(counted('await sleep(100);', 'try { await sleep(10_000); } catch { log(); }')).toEqual([1]);
    expect(counted('await sleep(100);', 'for (const x of xs) await sleep(10_000);')).toEqual([1]);
    expect(counted('await sleep(100);', 'switch (state()) { case 1: await sleep(10_000); }')).toEqual([1]);
    expect(counted('await sleep(100);', 'if (rare()) {', '  await sleep(10_000);', '}')).toEqual([1]);
    // A `continue` before a sleep skips it; one after does not.
    expect(counted('await sleep(100);', 'if (busy()) continue;', 'await sleep(10_000);')).toEqual([1]);
    expect(counted('if (busy()) continue;', 'await sleep(10_000);')).toEqual([]);
    expect(counted('await sleep(10_000);', 'if (busy()) continue;')).toEqual([]);
    // Sleeps every pass reaches add up, with a `break` between them.
    expect(counted('await sleep(300);', 'if (ready()) break;', 'await sleep(300);')).toEqual([]);
    expect(counted('if (ready()) break;', 'await sleep(10_000);')).toEqual([]);
    // With only skippable sleeps there is no interval to count by.
    expect(counted('if (rare()) await sleep(10);')).toEqual([]);
  });

  it('leaves a count whose limit or interval it cannot read alone: it is a bound of a size the scan cannot tell', () => {
    expect(polls(
      'for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) await sleep(100);',
      'for (let attempt = 0; attempt < 20; attempt += 1) await sleep(interval);',
      'for (let i = 0; i < items.length; i += 1) await sleep(100);',
    )).toEqual([]);
  });

  it('reads arithmetic of literals as the literal it makes', () => {
    expect(lines(polls(
      'const late = Date.now() + 5 * 1000;',
      'while (Date.now() < late) await sleep(10);',
      'const soon = Date.now() + 2_000 + 500;',
      'while (Date.now() < soon) await sleep(10);',
    ))).toEqual([2, 4]);
    expect(polls('const ok = Date.now() + 30 * 1000;', 'while (Date.now() < ok) await sleep(10);', 'for (let i = 0; i < 20; i++) await sleep(60000 / 40);')).toEqual([]);
    expect(scanSource('x.test.ts', 'await vi.waitFor(() => ready(), { timeout: 2 * 1000 });').map((s) => s.rule)).toEqual(['short-bound']);
    expect(scanSource('x.test.ts', 'await vi.waitFor(() => ready(), { timeout: 3 * 5_000 });')).toEqual([]);
  });

  it('counts attempts from the start and by the step, up or down, and reads names for the literals', () => {
    const sites = polls(
      'for (let attempt = 100; attempt < 150; attempt += 1) await sleep(100);',
      'for (let i = 0; i < 100; i += 10) await sleep(100);',
      'for (let i = 0; i < 100; i = i + 10) await sleep(100);',
      'for (let left = 20; left > 0; left -= 1) await sleep(100);',
      'for (let left = 20; left >= 1; left--) await sleep(100);',
      'for (let i = 0; i < 100; i += 2) await sleep(250);',
      'for (let left = 200; left > 0; --left) await sleep(100);',
      'for (let i = 5; i <= 124; i++) await sleep(100);',
      'const interval = 50;',
      'for (let i = 0; i < 20; i++) await sleep(interval);',
      'async function named(check: () => boolean, tries = 400) {',
      '  for (let i = 0; i < tries; i++) { if (check()) return; await sleep(100); }',
      '}',
    );
    // Flagged: 5 s, 1 s, 1 s, 2 s, 2 s, and 1 s. Accepted: 12.5 s, 20 s, 12 s and 40 s.
    expect(lines(sites)).toEqual([1, 2, 3, 4, 5, 10]);
  });

  it('leaves a counter whose step it cannot read alone', () => {
    expect(polls(
      'for (let i = 0; i < 20; i += step) await sleep(100);',
      'for (let i = start; i < 20; i++) await sleep(100);',
      'for (let i = 0, j = 5; i < 20; i++) await sleep(100);',
    )).toEqual([]);
  });

  it('does not take a bound from a function nested in the loop: it is the helper\'s, not the loop\'s', () => {
    const sites = polls(
      'while (!ready()) {',
      '  const unused = (since: number) => Date.now() - since > 15_000;',
      '  await sleep(10);',
      '}',
      'while (!ready()) {',
      '  const late = () => { for (let attempt = 0; attempt < 500; attempt += 1) { void attempt; } };',
      '  await sleep(10);',
      '}',
      'async function a() {',
      '  const deadline = Date.now() + 1_000;',
      '  const helper = () => { const deadline = Date.now() + 60_000; return deadline; };',
      '  while (Date.now() < deadline) await sleep(10);',
      '}',
    );
    expect(lines(sites)).toEqual([1, 5, 12]);
    // The loop's own bound is still read beside a helper.
    expect(polls('while (!ready()) {', '  const unused = () => Date.now();', '  if (Date.now() - t0 > 15_000) throw new Error("late");', '  await sleep(10);', '}')).toEqual([]);
  });

  it('takes a clock read that is never compared, or a counter that is only stepped, for no deadline', () => {
    const sites = polls(
      'while (!ready()) { log(Date.now()); await sleep(10); }',
      'while (!ready()) { stamps.push(performance.now()); await sleep(10); }',
      'while (!ready()) { attempts++; await sleep(10); }',
      'while (!ready()) { retries += 1; await sleep(10); }',
    );
    expect(lines(sites)).toEqual([1, 2, 3, 4]);
  });

  it('leaves a clock comparison it cannot evaluate alone, directly or through a name', () => {
    expect(polls(
      'while (!ready()) { const elapsed = Date.now() - t0; if (elapsed > MAX_MS) throw new Error("late"); await sleep(10); }',
      'while (!ready()) { if (Date.now() - t0 > limits.wait) throw new Error("late"); await sleep(10); }',
      'while (!ready() && Date.now() < dueAt) await sleep(10);',
    )).toEqual([]);
  });

  it('gives a loop the earliest of its exits: a comparison that ends nothing bounds nothing', () => {
    const exits = (...body: string[]) => lines(polls('while (!ready()) {', ...body.map((line) => `  ${line}`), '  await sleep(10);', '}'));
    // Only the `throw` leaves the loop; `rotate()` leaves nothing, so the 1 s comparison is not a deadline.
    expect(exits('if (Date.now() - a > 60_000) throw new Error("late");', 'if (Date.now() - b > 1_000) rotate();')).toEqual([]);
    expect(exits('if (Date.now() - a > 2_000) throw new Error("late");', 'if (Date.now() - b > 1_000) rotate();')).toEqual([1]);
    // Two exits: the loop ends at the first to fire, whichever is written first.
    expect(exits('if (Date.now() - a > 60_000) throw new Error("late");', 'if (Date.now() - b > 1_000) break;')).toEqual([1]);
    expect(exits('if (Date.now() - b > 1_000) break;', 'if (Date.now() - a > 60_000) throw new Error("late");')).toEqual([1]);
    expect(exits('if (Date.now() - b > 20_000) break;', 'if (Date.now() - a > 60_000) throw new Error("late");')).toEqual([]);
    // A `break` in a loop of its own leaves that loop, not this one.
    expect(exits('for (const item of items) { if (Date.now() - b > 1_000) break; }', 'if (Date.now() - a > 60_000) throw new Error("late");')).toEqual([]);
    expect(exits('while (more()) { if (Date.now() - b > 1_000) break; }', 'if (Date.now() - a > 60_000) throw new Error("late");')).toEqual([]);
    // A `throw` in a loop of its own may never run, so it is not an exit of this one.
    expect(exits('for (const item of items) { if (Date.now() - b > 1_000) throw new Error("late"); }', 'if (Date.now() - a > 60_000) throw new Error("late");')).toEqual([]);
  });

  it('bounds an && chain by its smallest part and an || chain by its largest', () => {
    const wait = (condition: string) => lines(polls('const start = Date.now();', `while (${condition}) await sleep(10);`));
    expect(wait('!ready() && Date.now() < start + 1_000 && Date.now() < start + 15_000')).toEqual([2]);
    expect(wait('Date.now() < start + 15_000 && !ready() && Date.now() < start + 1_000')).toEqual([2]);
    expect(wait('!ready() && Date.now() < start + 15_000 && Date.now() < start + 20_000')).toEqual([]);
    expect(wait('Date.now() < start + 1_000 || Date.now() < start + 15_000')).toEqual([]);
    expect(wait('Date.now() < start + 1_000 || Date.now() < start + 2_000')).toEqual([2]);
    // Parentheses group as the language does, and && binds tighter than ||.
    expect(wait('(Date.now() < start + 1_000 || Date.now() < start + 15_000) && !ready()')).toEqual([]);
    expect(wait('(Date.now() < start + 1_000 && !ready()) || Date.now() < start + 2_000')).toEqual([2]);
    expect(wait('Date.now() < start + 1_000 && !ready() || Date.now() < start + 2_000')).toEqual([2]);
    expect(wait('!ready() && (Date.now() < start + 1_000 || Date.now() < start + 2_000)')).toEqual([2]);
    // The bound is read from the same forms as before.
    expect(wait('!ready() && Date.now() - start < 1_000 && Date.now() - start < 15_000')).toEqual([2]);
    expect(wait('!ready() && start + 1_000 > Date.now() && start + 15_000 > Date.now()')).toEqual([2]);
    // A part that bounds nothing, beside one that does, leaves an || chain with no bound: the loop may never end by the part that has one.
    // An operator the scan does not read leaves none either.
    expect(wait('!ready() || Date.now() < start + 1_000')).toEqual([2]);
    expect(wait('!ready() || Date.now() < start + 15_000')).toEqual([2]);
    expect(wait('(ready() ? Date.now() < start + 15_000 : false)')).toEqual([2]);
    expect(wait('(Date.now() < start + 15_000) ?? ready()')).toEqual([2]);
    expect(wait('ready?.value !== true && Date.now() < start + 1_000')).toEqual([2]);
  });

  it('takes the smallest attempt count of an && chain, whichever conjunct comes first', () => {
    expect(lines(polls('for (let i = 0; i < 500 && i < 5; i++) await sleep(100);'))).toEqual([1]);
    expect(lines(polls('for (let i = 0; i < 5 && i < 500; i++) await sleep(100);'))).toEqual([1]);
    expect(polls('for (let i = 0; i < 500 && i < 200; i++) await sleep(100);')).toEqual([]);
    // The attempts and the clock bound the loop together; it ends at the first.
    expect(lines(polls('for (let i = 0; i < 3; i++) { if (Date.now() - t0 > 15_000) throw new Error("late"); await sleep(100); }'))).toEqual([1]);
    expect(lines(polls('for (let i = 0; i < 100; i++) { if (Date.now() - t0 > 1_000) throw new Error("late"); await sleep(100); }'))).toEqual([1]);
    expect(polls('for (let i = 0; i < 300; i++) { if (Date.now() - t0 > 15_000) throw new Error("late"); await sleep(100); }')).toEqual([]);
  });

  it('takes a counter the body writes for no bound: the header\'s count says nothing about how long the loop runs', () => {
    // The body rewinds the counter, so the header's count is a floor on the run, not its length.
    for (const write of ['if (retry()) i = 0;', 'if (retry()) i -= 1;', 'if (retry()) i--;', 'if (retry()) --i;', 'if (retry()) [i] = [0];', 'if (retry()) ({ i } = origin);', 'i = 0;']) {
      expect(lines(polls(`for (let i = 0; i < 10; i++) { ${write} await sleep(1_000); }`))).toEqual([1]);
    }
    expect(lines(polls('for (let i = 0; i < 10; i++) { const rewind = () => { i = 0; }; if (retry()) rewind(); await sleep(1_000); }'))).toEqual([1]);
    // A name the body only reads or compares is still a counter, however similar its spelling.
    expect(lines(polls('for (let i = 0; i < 10; i++) { log(i); await sleep(100); }'))).toEqual([1]);
    expect(lines(polls('for (let i = 0; i < 10; i++) { if (i == 5 || i <= 2) log(i); await sleep(100); }'))).toEqual([1]);
    expect(lines(polls('for (let i = 0; i < 10; i++) { const idx = i; await sleep(100); }'))).toEqual([1]);
    // A body that declares its own `i` leaves the header's counter alone.
    expect(polls('for (let i = 0; i < 100; i++) { { let i = 5; use(i); } await sleep(200); }')).toEqual([]);
  });

  it('resolves a name at the place it is read: a block the use cannot see does not declare it', () => {
    // The head reads the outer `end`; the loop body's inner block declares another one.
    expect(lines(polls('const end = Date.now() + 1_000;', 'while (Date.now() < end) {', '  { const end = Date.now() + 15_000; use(end); }', '  await sleep(10);', '}'))).toEqual([2]);
    expect(polls('const end = Date.now() + 15_000;', 'while (Date.now() < end) {', '  { const end = Date.now() + 1_000; use(end); }', '  await sleep(10);', '}')).toEqual([]);
    // The same for an exit in the body.
    expect(lines(polls('const end = Date.now() + 1_000;', 'while (!ready()) {', '  { const end = Date.now() + 15_000; use(end); }', '  if (Date.now() > end) throw new Error("late");', '  await sleep(10);', '}'))).toEqual([2]);
    // A block that closed before the loop declares nothing for it either.
    expect(lines(polls('{ const end = Date.now() + 15_000; use(end); }', 'const end = Date.now() + 1_000;', 'while (Date.now() < end) await sleep(10);'))).toEqual([3]);
    expect(polls('{ const end = Date.now() + 1_000; use(end); }', 'const end = Date.now() + 15_000;', 'while (Date.now() < end) await sleep(10);')).toEqual([]);
    // A declaration the use is inside of is in view.
    expect(lines(polls('const end = Date.now() + 15_000;', 'while (!ready()) {', '  const end = Date.now() + 1_000;', '  if (Date.now() > end) throw new Error("late");', '  await sleep(10);', '}'))).toEqual([2]);
  });

  it('takes the smallest value a reassigned name can hold, and none when it cannot tell', () => {
    expect(lines(polls('let end = Date.now() + 15_000;', 'end = Date.now() + 1_000;', 'while (Date.now() < end) await sleep(10);'))).toEqual([3]);
    expect(lines(polls('let end = Date.now() + 1_000;', 'end = Date.now() + 15_000;', 'while (Date.now() < end) await sleep(10);'))).toEqual([3]);
    expect(polls('let end = Date.now() + 15_000;', 'end = Date.now() + 20_000;', 'while (Date.now() < end) await sleep(10);')).toEqual([]);
    // A write that is not a plain assignment leaves the value unknown; one in the loop moves the deadline, so it bounds nothing.
    expect(lines(polls('let end = Date.now() + 1_000;', 'while (Date.now() < end) { end += 20_000; await sleep(10); }'))).toEqual([2]);
    expect(lines(polls('let end = Date.now() + 1_000;', 'const extend = () => { end++; };', 'while (Date.now() < end) { extend(); await sleep(10); }'))).toEqual([3]);
    // The same for a constant that names a bound.
    expect(polls('async function run() {', '  let limit = 800;', '  limit += 20_000;', '  const end = Date.now() + limit;', '  while (Date.now() < end) await sleep(10);', '}')).toEqual([]);
    expect(lines(polls('async function run() {', '  let limit = 20_000;', '  limit = 800;', '  const end = Date.now() + limit;', '  while (Date.now() < end) await sleep(10);', '}'))).toEqual([5]);
    // A flag that holds a deadline comparison carries its bound.
    expect(lines(polls('while (!ready()) {', '  const late = Date.now() - t0 > 1_000;', '  if (late) break;', '  await sleep(10);', '}'))).toEqual([1]);
    expect(polls('while (!ready()) {', '  const late = Date.now() - t0 > 15_000;', '  if (late) break;', '  await sleep(10);', '}')).toEqual([]);
    // A name assigned from the clock and compared with a literal is read as that literal.
    expect(lines(polls('while (!ready()) { const elapsed = Date.now() - t0; if (elapsed > 1_000) throw new Error("late"); await sleep(10); }'))).toEqual([1]);
  });

  it('counts an exit only when it is a statement of the loop body that leaves on its own', () => {
    const exits = (...body: string[]) => lines(polls('while (!ready()) {', ...body.map((line) => `  ${line}`), '  await sleep(10);', '}'));
    const late = 'Date.now() - t0 > 15_000';
    // Written as a statement of the body: a bare leave, or a block with the leave among its own statements.
    expect(exits(`if (${late}) break;`)).toEqual([]);
    expect(exits(`if (${late}) return;`)).toEqual([]);
    expect(exits(`if (${late}) { log(); throw new Error("late"); }`)).toEqual([]);
    expect(exits(`if (${late}) { break; }`)).toEqual([]);
    expect(lines(polls('do {', `  if (${late}) break;`, '  await sleep(10);', '} while (!ready());'))).toEqual([]);
    expect(polls('while (!ready()) if (Date.now() - t0 > 15_000) break; else await sleep(10);')).toEqual([]);
    // Inside another `if`, an `else`, an `else if`, a `switch`, a `try`, a block or a loop it may never be reached.
    expect(exits('if (rare()) {', `  if (${late}) break;`, '}')).toEqual([1]);
    expect(exits('if (rare()) log(); else {', `  if (${late}) break;`, '}')).toEqual([1]);
    expect(exits('if (rare()) log(); else', `  if (${late}) break;`)).toEqual([1]);
    expect(exits(`if (rare()) log(); else if (${late}) break;`)).toEqual([1]);
    expect(exits('switch (kind) { case 1:', `  if (${late}) return;`, '}')).toEqual([1]);
    expect(exits('try {', `  if (${late}) throw new Error("late");`, '} catch { log(); }')).toEqual([1]);
    expect(exits('{', `  if (${late}) break;`, '}')).toEqual([1]);
    expect(exits('for (const item of items) {', `  if (${late}) return;`, '}')).toEqual([1]);
    expect(exits('while (more()) {', `  if (${late}) return;`, '}')).toEqual([1]);
    // A branch that leaves only inside another `if` may never leave, and an `else` that leaves is not an exit on the test.
    expect(exits(`if (${late}) {`, '  if (strict) throw new Error("late");', '}')).toEqual([1]);
    expect(exits(`if (${late}) { log(); } else break;`)).toEqual([1]);
    expect(exits(`if (!(${late})) { log(); } else break;`)).toEqual([1]);
    // Before a statement that can skip the rest of the pass.
    expect(exits(`if (${late}) break;`, 'if (skip()) continue;')).toEqual([]);
    expect(exits('if (skip()) continue;', `if (${late}) break;`)).toEqual([1]);
    expect(exits('for (const item of items) { if (skip(item)) continue; }', `if (${late}) break;`)).toEqual([1]);
    // The loop head still counts beside such exits, and a reason accepts a loop whose exit is one the scan does not read.
    expect(polls('const t0 = Date.now();', 'while (!ready() && Date.now() - t0 < 15_000) {', '  if (rare()) { if (Date.now() - t0 > 1_000) break; }', '  await sleep(10);', '}')).toEqual([]);
    expect(polls('// bound: ends when `rare` turns true, which the fixture below controls', 'while (!ready()) {', '  if (rare()) { if (Date.now() - t0 > 15_000) break; }', '  await sleep(10);', '}')).toEqual([]);
  });

  it('reads a clock comparison only with <, <=, > or >=: an equality can miss the value and never fire', () => {
    for (const operator of ['!==', '===', '!=', '==']) {
      expect(lines(polls('const end = Date.now() + 15_000;', `while (Date.now() ${operator} end) await sleep(10);`))).toEqual([2]);
      expect(lines(polls('const t0 = Date.now();', `while (Date.now() - t0 ${operator} 15_000) await sleep(10);`))).toEqual([2]);
      expect(lines(polls('const t0 = Date.now();', `while (!ready()) { if (Date.now() - t0 ${operator} 15_000) throw new Error("late"); await sleep(10); }`))).toEqual([2]);
      expect(lines(polls('const t0 = Date.now();', `while (!ready()) { if (15_000 ${operator} Date.now() - t0) throw new Error("late"); await sleep(10); }`))).toEqual([2]);
      expect(lines(polls(`for (let i = 0; i ${operator} 150; i += 1) await sleep(100);`))).toEqual([1]);
    }
    for (const operator of ['<', '<=', '>', '>=']) {
      expect(polls('const t0 = Date.now();', `while (!ready()) { if (Date.now() - t0 ${operator} 15_000) throw new Error("late"); await sleep(10); }`)).toEqual([]);
    }
  });

  it('reads a start or a deadline the loop sets again as no bound: it moves away as time passes', () => {
    expect(lines(polls('let start = Date.now();', 'while (Date.now() - start < 15_000) { start = Date.now(); await sleep(10); }'))).toEqual([2]);
    expect(lines(polls('let end = Date.now() + 15_000;', 'while (Date.now() < end) { end = Date.now() + 15_000; await sleep(10); }'))).toEqual([2]);
    expect(lines(polls('let start = Date.now();', 'while (!ready()) { if (Date.now() - start > 15_000) throw new Error("late"); start = Date.now(); await sleep(10); }'))).toEqual([2]);
    expect(lines(polls('const state = { t0: Date.now() };', 'while (Date.now() - state.t0 < 15_000) { state.t0 = Date.now(); await sleep(10); }'))).toEqual([2]);
    expect(lines(polls('let start = Date.now();', 'const restart = () => { start = Date.now(); };', 'while (Date.now() - start < 15_000) { restart(); await sleep(10); }'))).toEqual([3]);
    // Declared in the body, they are new on every pass; declared in a `for` header, they are set once.
    expect(lines(polls('while (!ready()) {', '  const start = Date.now();', '  if (Date.now() - start > 15_000) throw new Error("late");', '  await sleep(10);', '}'))).toEqual([1]);
    expect(lines(polls('while (!ready()) {', '  const end = Date.now() + 15_000;', '  if (Date.now() > end) throw new Error("late");', '  await sleep(10);', '}'))).toEqual([1]);
    expect(polls('for (const end = Date.now() + 15_000; Date.now() < end;) await sleep(10);')).toEqual([]);
    // A name set from the clock in the body is a fresh read of it; it is bounded by a start the loop leaves alone.
    expect(polls('const t0 = Date.now();', 'while (!ready()) {', '  const elapsed = Date.now() - t0;', '  if (elapsed > 15_000) throw new Error("late");', '  await sleep(10);', '}')).toEqual([]);
    expect(polls('const deadline = Date.now() + 15_000;', 'while (!ready()) {', '  const now = Date.now();', '  if (now > deadline) throw new Error("late");', '  await sleep(10);', '}')).toEqual([]);
    expect(lines(polls('let t0 = Date.now();', 'while (!ready()) {', '  t0 = Date.now();', '  const elapsed = Date.now() - t0;', '  if (elapsed > 15_000) throw new Error("late");', '  await sleep(10);', '}'))).toEqual([2]);
    expect(lines(polls('while (!ready()) {', '  const now = Date.now();', '  if (now > 15_000) throw new Error("late");', '  await sleep(10);', '}'))).toEqual([1]);
  });

  it('reads a clock comparison only in the forms it lists', () => {
    expect(lines(polls('while (Math.floor(Date.now() / 1000) <= second) await sleep(10);'))).toEqual([1]);
    expect(lines(polls('while (Date.now() * 2 < limit) await sleep(10);'))).toEqual([1]);
    expect(lines(polls('while (!ready()) { if (Math.floor(Date.now() / 1000) > second) break; await sleep(10); }'))).toEqual([1]);
    expect(lines(polls('const t0 = Date.now();', 'while (Date.now() - t0 - slack < 15_000) await sleep(10);'))).toEqual([2]);
    // The listed forms, in both orientations.
    expect(polls('const t0 = Date.now();', 'while (Date.now() - t0 < 15_000) await sleep(10);')).toEqual([]);
    expect(polls('const t0 = Date.now();', 'while (15_000 > Date.now() - t0) await sleep(10);')).toEqual([]);
    expect(polls('const t0 = Date.now();', 'while (Date.now() < t0 + 15_000) await sleep(10);')).toEqual([]);
    expect(polls('const t0 = Date.now();', 'while (t0 + 15_000 > Date.now()) await sleep(10);')).toEqual([]);
    expect(polls('const deadline = Date.now() + 15_000;', 'while (Date.now() < deadline) await sleep(10);')).toEqual([]);
  });

  it('counts only the counter of a for header: a step in the body may never run', () => {
    expect(lines(polls('let tries = 0;', 'while (!ready()) { if (tries++ > 20) throw new Error("late"); await sleep(100); }'))).toEqual([2]);
    expect(lines(polls('let n = 0;', 'while (n < 20) { if (rare()) n += 1; await sleep(100); }'))).toEqual([2]);
    expect(lines(polls('let n = 0;', 'while (n < 20) { n += 1; await sleep(100); }'))).toEqual([2]);
    expect(lines(polls('while (!ready() && retries < 5) { retries += 1; await sleep(100); }'))).toEqual([1]);
    expect(lines(polls('while (retries-- > 0) await sleep(100);'))).toEqual([1]);
    // A for header whose update never gets the counter to its limit runs for ever.
    expect(lines(polls('for (let i = 0; i < 20; i -= 1) await sleep(100);'))).toEqual([1]);
    expect(lines(polls('for (let i = 20; i > 0; i += 1) await sleep(100);'))).toEqual([1]);
    expect(lines(polls('for (let i = 0; i < 20; i += 0) await sleep(100);'))).toEqual([1]);
    expect(lines(polls('for (let i = 0; i < 20; j++) await sleep(100);'))).toEqual([1]);
    expect(lines(polls('for (let i = 0; i < 20;) await sleep(100);'))).toEqual([1]);
    // A count that ends the loop only beside a part with no bound is no bound.
    expect(lines(polls('for (let i = 0; i < 20 || !done(); i++) await sleep(100);'))).toEqual([1]);
  });

  it('takes a zero-delay sleep in a loop for the poll interval of a spin, and one outside a loop for a yield', () => {
    expect(lines(polls('while (!ready()) await sleep(0);', 'do { await new Promise(r => setTimeout(r, 0)); } while (!ready());'))).toEqual([1, 2]);
    expect(scan('while (!ready()) await sleep(0);', 'await sleep(0);')).toEqual([]);
    // A counted spin is bounded by its count, which says nothing in milliseconds.
    expect(polls('for (let i = 0; i < 50; i++) await sleep(0);')).toEqual([]);
    expect(polls('const t0 = Date.now();', 'while (!ready()) { if (Date.now() - t0 > 15_000) throw new Error("late"); await sleep(0); }')).toEqual([]);
  });

  it('reports one site per loop, on the innermost loop', () => {
    const sites = polls(
      'for (let a = 0; a < 3; a += 1) {',
      '  while (!ready()) {',
      '    await sleep(10);',
      '    await sleep(20);',
      '  }',
      '}',
    );
    expect(lines(sites)).toEqual([2]);
  });

  it('does not take a sleep in a test a loop defines for a poll', () => {
    expect(polls(
      'for (const row of ROWS) {',
      '  it(row.id, async () => {',
      '    await sleep(300);',
      '  });',
      '}',
      'for (const row of ROWS) it(row.id, async () => { await sleep(300); });',
    )).toEqual([]);
  });

  it('does not read the clock from a string, a template or a comment', () => {
    expect(lines(polls(
      'while (!ready()) {',
      "  const s = 'Date.now()';",
      '  // if (Date.now() > deadline) throw new Error("late");',
      '  const t = `${label} Date.now()`;',
      '  await sleep(10);',
      '}',
    ))).toEqual([1]);
  });

  it('is reported next to the sleep rule: a sleep in a loop is a poll interval, not a bare sleep', () => {
    const sites = scanSource('x.test.ts', ['await sleep(10);', 'while (!ready()) await sleep(10);'].join('\n'));
    expect(sites.map((s) => [s.rule, s.line])).toEqual([['sleep', 1], ['poll-deadline', 2]]);
  });

  it('is accepted by a // bound: reason on the loop line or in the comment block above it', () => {
    expect(polls(
      'while (churning) { startUnrelated(); await delay(15); } // bound: the finally block clears churning',
      '// bound: the fixture closes the socket, which ends the read',
      'while (!socket.closed) await sleep(10);',
      '// A load generator, not a poll.',
      '// bound: churning is cleared in the finally block below',
      'while (churning) {',
      '  await delay(15);',
      '}',
    )).toEqual([]);
    expect(lines(polls('// bound:', 'while (!ready()) await sleep(10);'))).toEqual([2]);
  });
});

describe('a bound with a reason', () => {
  it('is accepted on the same line', () => {
    expect(scan(
      'await sleep(400); // bound: observe past the 250 ms runner auto-end timer',
      'await vi.waitFor(() => ready(), { timeout: 2_000 }); // bound: the fake exits in under 10 ms',
    )).toEqual([]);
  });

  it('is accepted anywhere in the comment block directly above', () => {
    expect(scan(
      '// bound: the fixture is in memory',
      'await vi.waitFor(() => ready());',
      '',
      '// The product holds the slot for 250 ms.',
      '// bound: observe past that window once',
      '// (hearsay-tools/cezarion#1155).',
      'await sleep(400);',
    )).toEqual([]);
  });

  it('is refused with an empty reason, or with a blank line between', () => {
    const sites = scan(
      'await sleep(400); // bound:',
      '// bound:   ',
      'await sleep(400);',
      '// bound: a reason, but too far away',
      '',
      'await sleep(400);',
      '// Bound: the wrong case',
      'await sleep(400);',
    );
    expect(lines(sites)).toEqual([1, 3, 6, 8]);
  });

  it('ends the comment block above at a line with anything before its //', () => {
    const sites = scan(
      '// bound: reason',
      '/* extra */ // other',
      'await sleep(50);',
      '// bound: reason',
      'const x = 1; // other',
      'await sleep(50);',
      '// bound: reason',
      '  // indented is still a comment line',
      'await sleep(50);',
    );
    expect(lines(sites)).toEqual([3, 6]);
  });

  it('is accepted only from a real line comment, not from text in a string or a template', () => {
    const sites = scan(
      'await sleep(50); const x = "// bound: not a comment";',
      'const script = `',
      '// bound: template text, not a comment',
      '${await sleep(50)}',
      '`;',
      'const t = `x',
      '// bound: inside a template`; await sleep(50);',
      "await sleep(50); const u = 'http://x'; // bound: a real trailing comment",
    );
    expect(lines(sites)).toEqual([1, 4, 7]);
  });
});

describe('the baseline', () => {
  it('tallies sites by file, rule and site text, sorted', () => {
    const sites: Site[] = [
      { file: 'b.test.ts', rule: 'sleep', site: 's', line: 9 },
      { file: 'a.test.ts', rule: 'short-bound', site: 'await vi.waitFor(() => ready());', line: 5 },
      { file: 'a.test.ts', rule: 'short-bound', site: 'await vi.waitFor(() => ready());', line: 12 },
    ];
    expect(tally(sites)).toEqual([
      { file: 'a.test.ts', rule: 'short-bound', site: 'await vi.waitFor(() => ready());', count: 2 },
      { file: 'b.test.ts', rule: 'sleep', site: 's', count: 1 },
    ]);
  });

  it('reports a new site as added and a fixed site as stale', () => {
    const baseline = [
      { file: 'a.test.ts', rule: 'sleep' as const, site: 'old', count: 2 },
      { file: 'a.test.ts', rule: 'sleep' as const, site: 'gone', count: 1 },
    ];
    const actual = [
      { file: 'a.test.ts', rule: 'sleep' as const, site: 'old', count: 1 },
      { file: 'a.test.ts', rule: 'sleep' as const, site: 'new', count: 1 },
    ];
    const { added, stale } = compareToBaseline(actual, baseline);
    expect(added).toEqual([{ file: 'a.test.ts', rule: 'sleep', site: 'new', count: 1 }]);
    // Both a lowered count and a vanished site are stale: the baseline must shrink to match.
    expect(stale).toEqual([
      { file: 'a.test.ts', rule: 'sleep', site: 'old', count: 2 },
      { file: 'a.test.ts', rule: 'sleep', site: 'gone', count: 1 },
    ]);
  });

  it('keeps the poll loops in a baseline of their own, apart from the sleeps and short bounds', () => {
    expect(baselines.map((b) => b.rules)).toEqual([['sleep', 'short-bound'], ['poll-deadline']]);
    expect(new Set(baselines.map((b) => b.path)).size).toBe(baselines.length);
    expect(baselines.every((b) => b.path.endsWith('.baseline.json'))).toBe(true);
  });

  describe('in update mode', () => {
    const entry = (site: string, count: number) => ({ file: 'a.test.ts', rule: 'poll-deadline' as const, site, count });
    const withBaseline = (run: (baseline: Baseline) => void) => {
      const dir = mkdtempSync(join(tmpdir(), 'wait-discipline-'));
      try {
        run({ what: 'poll loop', path: join(dir, 'x.baseline.json'), comment: 'a comment', rules: ['poll-deadline'] });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    it('writes the first baseline of a rule from what the suite has', () => {
      withBaseline((baseline) => {
        shrinkBaseline([entry('while (!ready()) {', 2)], baseline);
        expect(JSON.parse(readFileSync(baseline.path, 'utf8'))).toEqual({ $comment: 'a comment', sites: [entry('while (!ready()) {', 2)] });
      });
    });

    it('then only lowers it: a count drops, a site that is gone leaves, a new site stays out', () => {
      withBaseline((baseline) => {
        shrinkBaseline([entry('old', 3), entry('gone', 1)], baseline);
        shrinkBaseline([entry('old', 1), entry('new', 4)], baseline);
        expect(readBaseline(baseline.path)).toEqual([entry('old', 1)]);
        writeFileSync(baseline.path, readFileSync(baseline.path, 'utf8').replace('a comment', 'kept'));
        shrinkBaseline([entry('old', 1)], baseline);
        expect(JSON.parse(readFileSync(baseline.path, 'utf8')).$comment).toBe('a comment');
      });
    });
  });
});

describe('the server unit suite', () => {
  // One read of each file for every whole-suite assertion below.
  let scanned: ReturnType<typeof scanSuite> | undefined;
  const suite = () => (scanned ??= scanSuite());

  it('scans every test and testkit under packages/cezar/src, and not its own files', () => {
    const files = scannedFiles();
    expect(files.length).toBeGreaterThan(300);
    expect(files).toContain('core/harness-parity.testkit.ts');
    expect(files.some((f) => f.startsWith('test-wait-discipline.'))).toBe(false);
    expect(files.some((f) => f.includes('__fixtures__/') || f.includes('node_modules/'))).toBe(false);
  });

  it('reads every scanned file to its end: no string, template or comment is left open', () => {
    const where = suite().errors.map((e) => `  ${e.file}:${e.line} unterminated ${e.construct}: ${e.text}`).join('\n');
    expect(
      suite().errors,
      `The scan read these as unterminated, so everything after them went unread. Fix the scan's blanking in test-wait-discipline.testkit.ts:\n${where}`,
    ).toEqual([]);
  });

  const remedy: Record<string, string> = {
    'poll-deadline':
      'A poll loop needs a deadline of 10 s or more, read from the clock in the loop or its function (or attempts x interval ' +
      'with literals). Add one, or state why the loop ends as a `// bound: <reason>` comment on its first line (AGENTS.md § Validation)',
  };
  for (const baseline of baselines) {
    it(`has no ${baseline.what} outside its baseline, and the baseline names no site that is gone`, () => {
      const sites = suite().sites.filter((s) => baseline.rules.includes(s.rule));
      const actual = tally(sites);
      // Update mode shrinks the baseline to what the suite has now; it never adds to it.
      if (process.env.TEST_WAIT_DISCIPLINE_UPDATE === '1') shrinkBaseline(actual, baseline);
      const { added, stale } = compareToBaseline(actual, readBaseline(baseline.path));
      const where = (entries: typeof added) =>
        entries
          .flatMap((e) => sites.filter((s) => s.file === e.file && s.rule === e.rule && s.site === e.site).map((s) => `  ${s.file}:${s.line} [${s.rule}] ${s.site}`))
          .join('\n');
      const listed = (entries: typeof stale) => entries.map((e) => `  ${e.file} [${e.rule}] ×${e.count}: ${e.site}`).join('\n');
      expect(
        added,
        `New ${baseline.what} found. ` +
          (remedy[baseline.rules[0] ?? ''] ??
            'Wait on the product\'s own signal, or state the bound\'s reason at the site as a `// bound: <reason>` comment (AGENTS.md § Validation)') +
          `. Never add a site to ${baseline.path}:\n${where(added)}`,
      ).toEqual([]);
      expect(
        stale,
        `Baseline entries no longer found; shrink ${baseline.path} ` +
          `(TEST_WAIT_DISCIPLINE_UPDATE=1 npm test -- packages/cezar/src/test-wait-discipline.test.ts does it):\n${listed(stale)}`,
      ).toEqual([]);
    });
  }
});
