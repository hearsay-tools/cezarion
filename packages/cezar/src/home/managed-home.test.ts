import { Home } from './home.ts';
import { useTestHome } from './test-home.testkit.ts';
import { testHome } from './test-home.testkit.ts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { resolveHome } from './resolve.ts';
import { runSelfUpdateCommand } from '../self-update/cli.ts';
import { activeId, listLinks } from '../self-update/layout.ts';
import { SelfUpdateService } from '../self-update/service.ts';
import { RegistryCache } from '../self-update/registry.ts';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('links, lists and unlinks a managed checkout in the injected home after CEZ_HOME changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-managed-home-')); roots.push(root);
  const checkout = join(root, 'checkout');
  mkdirSync(join(checkout, 'dist'), { recursive: true });
  writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: '@wjarka/cezarion', version: '1.2.3' }));
  writeFileSync(join(checkout, 'dist', 'index.js'), '// fixture');
  const env = { CEZ_HOME: join(root, 'selected') };
  const home = resolveHome({ purpose: 'cli', env }); // test-home-read: resolve CEZ_HOME inside the temporary fixture
  useTestHome(join(root, 'later') ? Home.sandbox(join(root, 'later')) : undefined);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
  const service = new SelfUpdateService({ pkgName: '@wjarka/cezarion', version: '1.2.3', entry: join(checkout, 'dist', 'index.js'), home, restart: () => {} });
  const opts = { service, home, modifyPath: false };
  expect(await runSelfUpdateCommand('link', [checkout], opts)).toBe(0);
  const links = listLinks(process.env, home);
  expect(links).toHaveLength(1);
  expect(links[0]?.checkout).toBe(checkout);
  expect(await runSelfUpdateCommand('versions', [], opts)).toBe(0);
  expect(log.mock.calls.flat().join('\n')).toContain(links[0]!.id);
  expect(await runSelfUpdateCommand('use', [links[0]!.id], opts)).toBe(0);
  expect(activeId(process.env, home)).toBe(links[0]!.id);
  expect(listLinks(undefined, testHome())).toEqual([]);
  // The active version is protected; a second link gives us an inactive one to remove.
  expect(await runSelfUpdateCommand('unlink', [links[0]!.id], opts)).toBe(1);
  const second = join(root, 'second');
  mkdirSync(join(second, 'dist'), { recursive: true });
  writeFileSync(join(second, 'package.json'), JSON.stringify({ name: '@wjarka/cezarion', version: '1.2.4' }));
  writeFileSync(join(second, 'dist', 'index.js'), '// fixture');
  expect(await runSelfUpdateCommand('link', [second], { ...opts, use: true })).toBe(0);
  expect(await runSelfUpdateCommand('unlink', [links[0]!.id], opts)).toBe(0);
  expect(listLinks(process.env, home).map(link => link.checkout)).toEqual([second]);
});

it('reports an unavailable registry without changing the injected managed home', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-managed-offline-')); roots.push(root);
  const home = Home.sandbox(root);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const registry = new RegistryCache('@wjarka/cezarion', async () => new Response('', { status: 503 }));
  const service = new SelfUpdateService({ pkgName: '@wjarka/cezarion', version: '1.2.3', entry: '/entry', home, registry, restart: () => {} });
  expect(await runSelfUpdateCommand('update', [], { service, home, channel: 'stable', modifyPath: false })).toBe(1);
  expect(listLinks(process.env, home)).toEqual([]);
});
