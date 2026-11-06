import { afterEach, expect, it, vi } from 'vitest';
import * as resolver from '../home/resolve.ts';
import { withServerHome } from './home.ts';

afterEach(() => { vi.restoreAllMocks(); });

it('resolves Home once for a direct server entry and reuses it when passed down', () => {
  const resolve = vi.spyOn(resolver, 'resolveHome');
  const first = withServerHome({});
  expect(resolve).toHaveBeenCalledExactlyOnceWith({ purpose: 'server' });
  const second = withServerHome(first);
  expect(second.home).toBe(first.home);
  expect(resolve).toHaveBeenCalledTimes(1);
});

it('keeps a CLI Home without resolving again at server boot', () => {
  const home = resolver.resolveHome({ purpose: 'cli', env: { CEZ_HOME: '/operator/home' } });
  const resolve = vi.spyOn(resolver, 'resolveHome');
  expect(withServerHome({ home }).home).toBe(home);
  expect(resolve).not.toHaveBeenCalled();
});
