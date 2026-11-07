import { expect, it, vi } from 'vitest';
import { warnLegacyHome } from './deprecation.ts';

it('prints one boot warning for a set CEZ_HOME with split layout', () => {
  const warn = vi.fn();
  warnLegacyHome({ CEZ_HOME: '/legacy', HSQ_HOME: '/preferred' }, { layout: 'split', warn });
  expect(warn).toHaveBeenCalledExactlyOnceWith('[hsq] CEZ_HOME is deprecated. Rename it to HSQ_HOME.');
});

it('keeps the disabled switch and absent legacy env silent', () => {
  const warn = vi.fn();
  warnLegacyHome({ CEZ_HOME: '/legacy' }, { warn });
  warnLegacyHome({ HSQ_HOME: '/preferred' }, { layout: 'split', warn });
  expect(warn).not.toHaveBeenCalled();
});
