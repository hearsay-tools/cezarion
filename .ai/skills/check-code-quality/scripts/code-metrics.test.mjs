import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeSource } from './code-metrics.mjs';

// The complexity gate's counter. Squeal counts requested stats; CI's gate counts with this.
test('classic complexity counts decisions, defaults, short circuits and optional chains', () => {
  const source = `export function choose(x: any = 0) {
    if (x > 0 && x < 3) return x ? 1 : 2;
    for (let i = 0; i < 2; i++) x++;
    try { work(); } catch { recover(); }
    switch (x) { case 0: break; case 1: break; default: break; }
    x ||= 1;
    return x?.f?.();
  }`;
  assert.equal(analyzeSource(source, 'choose.ts')[0].complexity, 12);
  const loops = 'function loops(xs) { for (const x of xs) {} for (const x in xs) {} while (xs) {} do {} while (xs); }';
  assert.equal(analyzeSource(loops, 'loops.js')[0].complexity, 5);
});

test('nested functions, comments, strings and types do not add decisions to their parent', () => {
  const source = `type Result<T> = T extends string ? 1 : 2;
  function outer(x: number) {
    // if (x) while (x) {}
    const text = 'if && || ?';
    if (x) return () => x ? 1 : 2;
    return () => 0;
  }`;
  assert.deepEqual(analyzeSource(source, 'nested.ts').map(fn => fn.complexity), [2, 2, 1]);
});

test('accepts TSX, JavaScript modules and TypeScript overloads, and rejects invalid source', () => {
  assert.equal(analyzeSource('const View = ({ ok }: { ok: boolean }) => <div>{ok ? "yes" : "no"}</div>;', 'view.tsx')[0].complexity, 2);
  assert.equal(analyzeSource('module.exports = function (x) { return x ?? 0; };', 'index.cjs')[0].complexity, 2);
  assert.equal(analyzeSource('function f(x: string): string; function f(x: string) { return x; }', 'overload.ts').length, 1);
  assert.deepEqual(analyzeSource('export const value = 1;', 'constant.mts'), []);
  assert.throws(() => analyzeSource('function broken( {', 'broken.ts'), /Unexpected token/);
});

test('TypeScript declaration files report no executable functions', () => {
  for (const filename of ['catalog.d.mts', 'catalog.d.ts', 'catalog.d.cts']) {
    assert.deepEqual(analyzeSource('export const X: string[]; export function f(): void;', filename), [], filename);
  }
});

test('names methods and isolates class initialization from an enclosing function', () => {
  const source = `function make() {
    class Box {
      value = flag ? 1 : 0;
      static { if (flag) work(); }
      get size() { return this.value; }
      #adjust(x) { return x ? 1 : 0; }
      map = (x) => x && 1;
    }
    return Box;
  }`;
  assert.deepEqual(analyzeSource(source, 'box.ts').map(fn => [fn.name, fn.complexity]), [
    ['make', 1], ['Box.size', 1], ['Box.#adjust', 2], ['Box.map', 2],
  ]);
});

test('computed method keys count in their enclosing function, not the method body', () => {
  const functions = analyzeSource('function outer(x) { return { [x ? "a" : "b"]() { return 1; } }; }', 'computed.js');
  assert.deepEqual(functions.map(fn => fn.complexity), [2, 1]);
});

