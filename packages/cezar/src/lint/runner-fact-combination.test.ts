import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMBINATION_ROWS, factCombinations, runnerFactCombination } from './runner-fact-combination.ts';
import { repoRoot } from './source-rule.ts';

describe('runner-fact-combination (hearsay-tools/cezarion#2991)', () => {
  it.each([
    ['a row fact and the resume prompt', "function f(runner, id) { return runner.systemPromptOnResume === 'resent' && RUNNER_FACTS[id].nativeAsk === 'none'; }", 'f', ['nativeAsk', 'systemPromptOnResume']],
    ['two delivery fields', "const g = (state, runner) => state.inputState.inputDelivery?.consumption === 'observable' && inputDeliveryOf(runner).mode === 'steer';", 'g', ['inputDelivery.consumption', 'inputDelivery.mode']],
    ['a fact in a nested callback', "class A { settle(runner) { if (runner.facts.costReport === 'cumulative') return list.filter(x => x.inputDelivery.acknowledgement === 'write'); } }", 'settle', ['costReport', 'inputDelivery.acknowledgement']],
    ['destructured facts', "function h(id) { const { nativeAsk, nativeTimerTool } = RUNNER_FACTS[id]; return nativeAsk && nativeTimerTool; }", 'h', ['nativeAsk', 'nativeTimerTool']],
    ['a private method', "class B { #pick(id, runner) { return RUNNER_FACTS[id]?.nativeSubagents ?? inputDeliveryOf(runner).humanInputAtTurnEnd; } }", '#pick', ['inputDelivery.humanInputAtTurnEnd', 'nativeSubagents']],
  ])('names a function that reads %s', (_case, source, name, facts) => {
    expect(factCombinations(source)).toEqual([{ name, line: 1, facts }]);
  });

  it.each([
    ['one fact twice', "function f(id, other) { return RUNNER_FACTS[id].costReport === RUNNER_FACTS[other].costReport; }"],
    ['one fact per function', "const a = runner => runner.systemPromptOnResume;\nconst b = id => RUNNER_FACTS[id].nativeAsk;"],
    ['a same-named key that is no fact', "function f(state) { return { nativeAsk: !!state.ask, mode: state.mode, costReport: x.costReport }; }"],
    ['the whole delivery and the documentation field', "function f(state, runner) { state.declare(inputDeliveryOf(runner)); return runner.inputDelivery.via; }"],
  ])('passes %s', (_case, source) => {
    expect(factCombinations(source)).toEqual([]);
  });

  // Each way a function can hold a fact source in a local, then read two facts from it.
  it.each([
    ['a const bound to .inputDelivery', "function f(runner) { const d = runner.inputDelivery; return d.mode === 'steer' && d.humanInputAtTurnEnd === 'always-held'; }",
      ['inputDelivery.humanInputAtTurnEnd', 'inputDelivery.mode']],
    ['a const bound to inputDeliveryOf(…)', 'function f(runner) { const d = inputDeliveryOf(runner); return d.mode && d.acknowledgement; }',
      ['inputDelivery.acknowledgement', 'inputDelivery.mode']],
    ['a let assigned later', 'function f(runner) { let d; d = inputDeliveryOf(runner); return d.mode && d.consumption; }',
      ['inputDelivery.consumption', 'inputDelivery.mode']],
    ['a const bound to RUNNER_FACTS[x]', 'function f(id) { const row = RUNNER_FACTS[id]; return row.nativeAsk && row.costReport; }', ['costReport', 'nativeAsk']],
    ['a const bound to RUNNER_FACTS.x', 'function f() { const row = RUNNER_FACTS.claude; return row.nativeTimerTool && row.nativeSubagents; }',
      ['nativeSubagents', 'nativeTimerTool']],
    ['a const bound to .facts', 'function f(runner) { const facts = runner.facts; return facts.nativeAsk && facts.costReport; }', ['costReport', 'nativeAsk']],
    ['a delivery read off a row alias', 'function f(id) { const row = RUNNER_FACTS[id]; const d = row.inputDelivery; return d.mode && row.nativeAsk; }',
      ['inputDelivery.mode', 'nativeAsk']],
    ['an alias of an alias', 'function f(runner) { const d = runner.inputDelivery; const e = d; return e.mode && e.acknowledgement; }',
      ['inputDelivery.acknowledgement', 'inputDelivery.mode']],
    ['optional chaining through an alias', "function f(state) { const d = state.inputDelivery; return d?.mode === 'steer' && d?.consumption === 'observable'; }",
      ['inputDelivery.consumption', 'inputDelivery.mode']],
    ['a cast or non-null alias', 'function f(runner) { const d = runner.inputDelivery as InputDelivery; return d!.mode && (d).consumption; }',
      ['inputDelivery.consumption', 'inputDelivery.mode']],
    ['a runner destructured to its delivery and resume prompt', 'function f(runner) { const { inputDelivery, systemPromptOnResume } = runner; return inputDelivery.mode && systemPromptOnResume; }',
      ['inputDelivery.mode', 'systemPromptOnResume']],
    ['a runner destructured to nested delivery fields', 'function f(runner) { const { inputDelivery: { mode, acknowledgement } } = runner; return mode && acknowledgement; }',
      ['inputDelivery.acknowledgement', 'inputDelivery.mode']],
    ['a runner destructured to a renamed fact row', 'function f(runner) { const { facts: row } = runner; return row.nativeAsk && row.costReport; }', ['costReport', 'nativeAsk']],
    ['a delivery alias destructured', 'function f(runner) { const d = runner.inputDelivery; const { mode, humanInputAtTurnEnd } = d; return mode && humanInputAtTurnEnd; }',
      ['inputDelivery.humanInputAtTurnEnd', 'inputDelivery.mode']],
    ['a destructuring assignment', 'function f(runner) { let mode, consumption; ({ mode, consumption } = inputDeliveryOf(runner)); return mode && consumption; }',
      ['inputDelivery.consumption', 'inputDelivery.mode']],
    ['a destructured parameter', 'function f({ inputDelivery }) { return inputDelivery.mode && inputDelivery.consumption; }',
      ['inputDelivery.consumption', 'inputDelivery.mode']],
  ])('names a function that reads two facts through %s', (_case, source, facts) => {
    expect(factCombinations(source)).toEqual([{ name: 'f', line: 1, facts }]);
  });

  it.each([
    ['one fact read twice through aliases', 'function f(a, b) { const d = a.inputDelivery; const e = b.inputDelivery; return d.mode === e.mode; }'],
    ['one fact on two runners', 'function f(a, b) { const x = RUNNER_FACTS[a]; const y = RUNNER_FACTS[b]; return x.costReport === y.costReport; }'],
    ['a name that a parameter shadows', 'const d = runner.inputDelivery;\nfunction f(d) { return d.mode && d.consumption; }'],
    ['a local reassigned to another value', 'function f(runner, options) { let d = runner.inputDelivery; d = options; return d.mode && d.consumption; }'],
    ['same-named fields of another object', 'function f(options) { const { mode, consumption, nativeAsk } = options; return mode && consumption && nativeAsk; }'],
  ])('passes %s', (_case, source) => {
    expect(factCombinations(source)).toEqual([]);
  });

  it('reports only the innermost function that combines facts', () => {
    const source = "function outer(id, runner) {\n  const inner = () => RUNNER_FACTS[id].nativeAsk && runner.systemPromptOnResume;\n  return inner;\n}";
    expect(factCombinations(source)).toEqual([{ name: 'inner', line: 2, facts: ['nativeAsk', 'systemPromptOnResume'] }]);
  });

  it('applies to workflow sources and not to their tests', () => {
    expect(runnerFactCombination.applies('packages/cezar/src/workflows/run/launch-read-resolver.ts')).toBe(true);
    expect(runnerFactCombination.applies('packages/cezar/src/workflows/input-acknowledgement.ts')).toBe(true);
    expect(runnerFactCombination.applies('packages/cezar/src/workflows/run/turn-settler.test.ts')).toBe(false);
    expect(runnerFactCombination.applies('packages/cezar/src/workflows/waits-parity-cells.testkit.ts')).toBe(false);
    expect(runnerFactCombination.applies('packages/cezar/src/core/runner-facts.ts')).toBe(false);
  });

  it('finds no combination in the workflow sources today, and every exception names a live function', () => {
    const dir = join(repoRoot, 'packages/cezar/src/workflows');
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).map(file => `packages/cezar/src/workflows/${file.replaceAll('\\', '/')}`)
      .filter(file => runnerFactCombination.applies(file));
    expect(files.length).toBeGreaterThan(50);
    const found = files.flatMap(file => factCombinations(readFileSync(join(repoRoot, file), 'utf8')).map(({ name }) => `${file}#${name}`));
    expect(found.sort()).toEqual(Object.keys(COMBINATION_ROWS).sort());
  });
});
