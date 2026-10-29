import { expect, it } from 'vitest';
import { AliasBudgetExceeded } from './linux-alias-model.ts';
import { observeReapers } from './capacity-reaper-observation.testkit.ts';

it('reports settled promises in invocation order after one checkpoint', async () => {
  const rejected = Promise.reject(new AliasBudgetExceeded());
  rejected.catch(() => {});
  const lines: string[] = [];
  await observeReapers([{ type: 'return', value: Promise.resolve() }, { type: 'return', value: rejected }], line => lines.push(line));
  expect(lines).toEqual(['capacity reapers: total=2 outcomes=fulfilled,budget-rejected omitted=no\n']);
});

it('preserves a destroy-like generic result and failing assertion', async () => {
  const rejected = Promise.reject(new AliasBudgetExceeded());
  const result = await (async () => { try { await rejected; } catch { return { state: 'incomplete', error: 'generic' }; } })();
  const lines: string[] = [];
  await observeReapers([{ type: 'return', value: rejected }], line => lines.push(line));
  expect(result).toEqual({ state: 'incomplete', error: 'generic' });
  expect(() => expect(result).toMatchObject({ state: 'complete' })).toThrow();
  expect(lines[0]).toContain('budget-rejected');
});

it('does not wait for pending promises or invoke thenables and freezes the output', async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let invoked = false;
  const thenable = { then() { invoked = true; } };
  const lines: string[] = [];
  await observeReapers([{ type: 'return', value: pending }, { type: 'return', value: thenable }], line => lines.push(line));
  finish();
  await Promise.resolve();
  expect(invoked).toBe(false);
  expect(lines).toEqual(['capacity reapers: total=2 outcomes=unsupported,unsupported omitted=no\n']);
});

it('uses class identity and fixed labels for other results', async () => {
  class ForeignBudget extends Error { override name = 'AliasBudgetExceeded'; }
  const rejected = Promise.reject(new ForeignBudget());
  rejected.catch(() => {});
  const lines: string[] = [];
  await observeReapers([{ type: 'return', value: rejected }, { type: 'throw' }, { type: 'incomplete' }, { type: 'unexpected' }], line => lines.push(line));
  expect(lines).toEqual(['capacity reapers: total=4 outcomes=other-rejected,sync-throw,incomplete,unsupported omitted=no\n']);
});

it('bounds the output at 0, 16 and 17 calls', async () => {
  for (const count of [0, 16, 17]) {
    const lines: string[] = [];
    await observeReapers(Array.from({ length: count }, () => ({ type: 'throw' })), line => lines.push(line));
    expect(lines).toEqual([`capacity reapers: total=${count} outcomes=${Array(Math.min(count, 16)).fill('sync-throw').join(',')} omitted=${count > 16 ? 'yes' : 'no'}\n`]);
  }
});

it('contains classification and both output failures without skipping the verdict', async () => {
  const evil = new Proxy({}, { getPrototypeOf() { throw Error('private'); } });
  const rejected = Promise.reject(evil);
  rejected.catch(() => {});
  const lines: string[] = [];
  await observeReapers([{ type: 'return', value: rejected }], line => lines.push(line));
  expect(lines[0]).toContain('diagnostic-failed');
  let attempts = 0;
  await observeReapers([], () => { attempts++; throw Error('private'); });
  expect(attempts).toBe(2);
  expect(() => expect({ state: 'incomplete' }).toMatchObject({ state: 'complete' })).toThrow();
});
