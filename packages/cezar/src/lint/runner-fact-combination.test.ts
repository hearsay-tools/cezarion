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
