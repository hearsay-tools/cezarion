import { expect, it, vi } from 'vitest';
import { createLegacyEnvWarning } from './deprecation.ts';

it('reports shadowed, empty and unread legacy names once per boot without values', () => {
  const warn = vi.fn();
  const boot = createLegacyEnvWarning();
  const env = { CEZ_HOME: '/legacy-private', HSQ_HOME: '/preferred-private', CEZ_UNUSED: 'secret', CEZ_EMPTY: '', CEZ_UNSET: undefined };
  boot(env, { warn });
  boot(env, { warn });
  expect(warn).toHaveBeenCalledExactlyOnceWith('[hsq] Legacy environment names are set: CEZ_EMPTY, CEZ_HOME, CEZ_UNUSED. Use the matching HSQ_* names. CEZ_HOME remains supported.');
  createLegacyEnvWarning()(env, { warn });
  expect(warn).toHaveBeenCalledTimes(2);
});

it('keeps an absent legacy env silent', () => {
  const warn = vi.fn();
  createLegacyEnvWarning()({ HSQ_HOME: '/preferred', CEZ_HOME: undefined }, { warn });
  expect(warn).not.toHaveBeenCalled();
});
