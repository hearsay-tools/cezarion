import { expect, it } from 'vitest';
import { legacyEnvNames, legacyHomeEnv, preferredHomeEnv, productEnv, shellProductEnv } from './product-env.ts';
import { resolveHome } from '../home/resolve.ts'; // test-home-read: pure resolver tests use injected env objects; no IO.

it.each([
  [{ HSQ_X: 'new', CEZ_X: 'old' }, 'new'],
  [{ CEZ_X: 'old' }, 'old'],
  [{}, undefined],
  [{ HSQ_X: '', CEZ_X: 'old' }, ''],
  [{ HSQ_X: undefined, CEZ_X: 'old' }, 'old'],
] as const)('reads product settings by presence (%j)', (env, expected) => {
  expect(productEnv('X', env)).toBe(expected);
});

it('preserves case-insensitive child-env toggle reads with the new prefix first', () => {
  expect(productEnv('X', { hsq_x: '', CEZ_X: 'old' }, true)).toBe('');
  expect(productEnv('X', { CeZ_X: 'old' }, true)).toBe('old');
  expect(productEnv('X', { hsq_x: 'lower', HSQ_X: 'upper' }, true)).toBe('upper');
  expect(productEnv('X', { hsq_x: 'lower' })).toBeUndefined();
});

it('keeps the migration source separate from the destination and the switch-off layout', () => {
  const env = { CEZ_HOME: '/legacy', HSQ_HOME: '/new' };
  expect(legacyHomeEnv(env)).toBe('/legacy');
  expect(preferredHomeEnv(env)).toBe('/new');
  expect(legacyHomeEnv({ HSQ_HOME: '/new' })).toBeUndefined();
  expect(resolveHome({ purpose: 'cli', env }).root).toBe('/new/config'); // test-home-read: pure resolution from an injected env object; no filesystem access.
  expect(resolveHome({ purpose: 'cli', env, layout: 'legacy' }).root).toBe('/legacy'); // test-home-read: pure resolution from an injected env object; no filesystem access.
  expect(resolveHome({ purpose: 'cli', env, layout: 'split' }).config).toBe('/new/config'); // test-home-read: pure resolution from an injected env object; no filesystem access.
  expect(resolveHome({ purpose: 'cli', env: { CEZ_HOME: '/legacy' }, layout: 'split' }).config).toBe('/legacy/config'); // test-home-read: pure resolution from an injected env object; no filesystem access.
});

it('collects legacy names independently of fallback reads', () => {
  expect(legacyEnvNames({ CEZ_X: 'hidden', HSQ_X: 'new', CEZ_UNREAD: '', CEZ_ABSENT: undefined, OTHER: 'value' }))
    .toEqual(['CEZ_UNREAD', 'CEZ_X']);
});

it.each(['DESKTOP', 'SUPERVISED', 'SUPERVISOR_PID', 'SUPERVISOR_STDIN', 'DISCLAIM_EXEC'] as const)(
  'keeps native shell ownership of %s (D11)', suffix => {
    for (const [legacy, preferred, expected] of [
      [undefined, undefined, undefined], [undefined, '', ''], [undefined, 'preferred', 'preferred'],
      ['', 'preferred', ''], ['shell', '', 'shell'], ['shell', 'conflict', 'shell'], ['shell', 'shell', 'shell'],
    ]) {
      expect(shellProductEnv(suffix, {[`CEZ_${suffix}`]: legacy, [`HSQ_${suffix}`]: preferred})).toBe(expected);
    }
  },
);
