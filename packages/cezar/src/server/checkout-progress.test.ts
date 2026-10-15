import { expect, it } from 'vitest';
import { CheckoutProgressCache } from './checkout-progress.ts';
it('retains only bounded latest progress, expires it, and evicts oldest tokens', () => {
  let now = 0;
  const cache = new CheckoutProgressCache(() => now);
  cache.record({ checkoutId: 'one', name: 'clone', phase: 'cloning', line: 'x'.repeat(9000) });
  expect(cache.get('one')?.line).toHaveLength(4096);
  cache.record({ checkoutId: 'one', name: 'clone', phase: 'done' });
  expect(cache.get('one')?.phase).toBe('done');
  for (let i = 0; i < 128; i++) cache.record({ checkoutId: String(i), name: 'clone', phase: 'cloning' });
  expect(cache.get('one')).toBeNull();
  now = 300_000;
  expect(cache.get('127')).toBeNull();
});
it('keeps a bounded warning on the terminal event', () => {
  const cache = new CheckoutProgressCache(() => 0);
  cache.record({ checkoutId: 'a', name: 'n', phase: 'done', warning: 'w'.repeat(5000) });
  expect(cache.get('a')?.phase).toBe('done');
  expect(cache.get('a')?.warning).toHaveLength(4096);
});
