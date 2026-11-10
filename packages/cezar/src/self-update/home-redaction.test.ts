import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cleanStoreRoots, storeRoot } from '../home/store.testkit.ts';

afterEach(() => {
  vi.doUnmock('../home/switch.ts');
  vi.restoreAllMocks();
  vi.resetModules();
  cleanStoreRoots();
});

it.each([false, true])('redacts staging paths from hosted logs with switch %s', async rebrand => {
  vi.resetModules();
  vi.doMock('../home/switch.ts', () => ({ REBRAND_SWITCH: rebrand }));
  const { Home } = await import('../home/home.ts');
  const { SelfUpdateService } = await import('./service.ts');
  const { RegistryCache } = await import('./registry.ts');
  const { versionEntry, writeManifest } = await import('./layout.ts');
  const installer = await import('./installer.ts');
  const root = storeRoot();
  const home = Home.sandbox(root);
  const entry = versionEntry('0.15.0', {}, home);
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, '// fixture');
  writeManifest('0.15.0', { source: 'registry', version: '0.15.0', installedAt: '2026-10-01T00:00:00Z' }, {}, home);
  const staging = join(home.data, 'versions', '.staging-0.16.0-123');
  vi.spyOn(installer, 'installFromRegistry').mockImplementation(async (_target, opts) => {
    opts?.onLog?.('npm install --prefix ' + staging);
    throw new Error('EACCES ' + staging);
  });
  const service = new SelfUpdateService({ home, pkgName: '@wjarka/cezarion', version: '0.15.0', entry,
    restart: vi.fn(), registry: new RegistryCache('@wjarka/cezarion', async () => Response.json({
      'dist-tags': { latest: '0.16.0' }, versions: { '0.16.0': {} },
    })),
  });
  await service.status();
  const job = service.apply('0.16.0', { registryOnly: true });
  // bound: installer rejection settles the job; this limit guards a missing settlement.
  await vi.waitFor(() => expect(job.status).toBe('failed'), { timeout: 5000 });
  const hosted = (await service.status({ registryOnly: true })).job!;
  expect(hosted.log.join('\n')).not.toContain(root);
  expect(hosted.error).toBe('EACCES [cezar home]/versions/.staging-0.16.0-123');
  expect(job.error).toBe('EACCES ' + staging);
});
