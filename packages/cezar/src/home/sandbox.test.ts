import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { expect, it } from 'vitest';
import { Home } from './home.ts';

it('creates a test marker and contains all paths, including caches, in its directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-home-sandbox-'));
  try {
    const home = Home.sandbox(root);
    const marker = JSON.parse(readFileSync(join(root, 'install.json'), 'utf8'));
    expect(marker).toEqual({ installId: expect.any(String), kind: 'test', createdAt: expect.any(String) });
    expect(marker.installId).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
    expect(new Date(marker.createdAt).toISOString()).toBe(marker.createdAt);
    const { serverState, serverLock, rootOverride: _override, ...paths } = home;
    for (const path of [...Object.values(paths), serverState(), serverState('other'), serverLock(), serverLock('other')]) {
      const rel = relative(root, path);
      expect(isAbsolute(rel) || rel === '..' || rel.startsWith('../')).toBe(false);
    }
    expect(Object.isFrozen(home)).toBe(true);
    Home.sandbox(root);
    expect(JSON.parse(readFileSync(join(root, 'install.json'), 'utf8'))).toEqual(marker);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
