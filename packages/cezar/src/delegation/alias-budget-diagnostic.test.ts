import { expect, it, vi } from 'vitest';
import { instrumentAliasBudget } from '../../test/e2e/alias-budget-diagnostic.ts';
import { aggregateModule, aggregateNames, instrumentAggregate } from '../../test/e2e/alias-aggregate-diagnostic.ts';

it('logs only the first exhaustion with bounded approved frames and preserves refusal', async () => {
  const source = `class AliasBudgetExceeded extends Error {}\nexport class AliasWorkBudget {\n  remaining = 2;\n  spend(amount = 1) {\n    this.remaining -= amount;\n    if (this.remaining < 0)\n            throw new AliasBudgetExceeded();\n  }\n}`;
  const aggregateUrl = 'data:text/javascript,' + encodeURIComponent(aggregateModule);
  const instrumented = instrumentAliasBudget(source).replace('./cez-alias-aggregate.js', aggregateUrl);
  const module = await import('data:text/javascript,' + encodeURIComponent(instrumented));
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const budget = new module.AliasWorkBudget();
    budget.spend(1);
    expect(log).not.toHaveBeenCalled();
    expect(() => budget.spend(2)).toThrow();
    expect(() => budget.spend(1)).toThrow();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toBe('[packaged-alias-budget-diagnostic]');
    const result = JSON.parse(String(log.mock.calls[0]?.[1]));
    expect(result).toMatchObject({ remaining: -1, charge: 2 });
    expect(result.frames).toEqual(['AliasWorkBudget.spend']);
    expect(() => instrumentAliasBudget('different source')).toThrow('marker changed');
  } finally { log.mockRestore(); }
});

it('saturates fixed aggregate counters and refuses missing or duplicated source markers', async () => {
  const module = await import('data:text/javascript,' + encodeURIComponent(aggregateModule));
  expect(Object.keys(module.snapshot())).toEqual([...aggregateNames]);
  module.count('mapsBytes', 2147483646); module.count('mapsBytes', 10);
  expect(module.snapshot().mapsBytes).toBe(2147483647);
  expect(() => instrumentAggregate({})).toThrow('missing');
  expect(() => instrumentAggregate({ 'linux-alias-model.js': 'return lines.map(line => {\n        budget.spend();'.repeat(2) })).toThrow('marker changed');
});
