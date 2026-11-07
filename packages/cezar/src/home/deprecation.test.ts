import { expect, it, vi } from 'vitest';
import { createLegacyEnvWarning } from './deprecation.ts';

it('reports shadowed, empty and unread legacy names once per boot without values', () => {
  const warn = vi.fn();
  const boot = createLegacyEnvWarning();
  const env = { CEZ_HOME: '/legacy-private', HSQ_HOME: '/preferred-private', CEZ_UNUSED: 'secret', CEZ_EMPTY: '', CEZ_UNSET: undefined };
  boot(env, { enabled: true, warn });
  boot(env, { enabled: true, warn });
  expect(warn).toHaveBeenCalledExactlyOnceWith('[hsq] Legacy environment names are set: CEZ_EMPTY, CEZ_HOME, CEZ_UNUSED. Use the matching HSQ_* names. CEZ_HOME remains supported.');
  createLegacyEnvWarning()(env, { enabled: true, warn });
  expect(warn).toHaveBeenCalledTimes(2);
});

it('keeps the disabled switch and absent legacy env silent', () => {
  const warn = vi.fn();
  createLegacyEnvWarning()({ CEZ_HOME: '/legacy', CEZ_UNUSED: '' }, { warn });
  createLegacyEnvWarning()({ CEZ_HOME: '/legacy' }, { enabled: false, warn });
  createLegacyEnvWarning()({ HSQ_HOME: '/preferred', CEZ_HOME: undefined }, { enabled: true, warn });
  expect(warn).not.toHaveBeenCalled();
});
