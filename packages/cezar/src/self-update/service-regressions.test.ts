import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activate, activeId, versionEntry, writeManifest } from './layout.ts';
import { RegistryCache } from './registry.ts';
import * as installer from './installer.ts';
import { SelfUpdateService } from './service.ts';

describe('managed update review regressions', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cezar-update-review-'));
    vi.stubEnv('CEZ_HOME', home);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });
  const install = (id: string, source: 'registry' | 'local' | 'link', version = id) => {
    const entry = versionEntry(id);
    mkdirSync(dirname(entry), { recursive: true }); writeFileSync(entry, '// fixture');
    writeManifest(id, { source, version, installedAt: '2026-10-01T00:00:00Z' });
    return entry;
  };
  const document = { 'dist-tags': { latest: '0.16.0' }, versions: { '0.15.0': {}, '0.16.0': {} }, time: { '0.15.0': '2026-09-01T00:00:00Z', '0.16.0': '2026-10-01T00:00:00Z' } };
  const service = (registry: RegistryCache, hosted = false) => new SelfUpdateService({
    pkgName: '@wjarka/cezarion', version: '0.15.0', entry: install('0.15.0', 'registry'),
    restart: vi.fn(), trimPaths: () => hosted, registry,
  });
  const registry = () => new RegistryCache('@wjarka/cezarion', vi.fn(async () => Response.json(document)));

  it.each(['local', 'link'] as const)('refuses unpublished installed %s builds in hosted mode', async source => {
    const svc = service(registry(), true);
    const id = '0.16.0+' + source;
    install(id, source, '0.16.0'); activate('0.15.0');
    expect(await svc.forwardOnlyRefusal(id)).toMatch(/published registry/);
    expect(() => svc.apply(id)).toThrow(/published registry/);
    expect(activeId()).toBe('0.15.0');
  });

  it('enforces registry-only apply for a hosted request using an otherwise local service', async () => {
    const svc = service(registry());
    install('0.16.0+local', 'local', '0.16.0');
    await svc.status();
    expect(() => svc.apply('0.16.0+local', { registryOnly: true })).toThrow(/published registry/);
  });

  it('refuses versions absent from the registry even when semver is newer', async () => {
    expect(await service(registry(), true).forwardOnlyRefusal('9.99.0')).toMatch(/published registry/);
  });

  it('refuses a local manifest even when its ID shadows a published version', async () => {
    const svc = service(registry(), true);
    install('0.16.0', 'local');
    expect(await svc.forwardOnlyRefusal('0.16.0')).toMatch(/published registry/);
  });

  it('hides unpublished builds from hosted status and preserves the local picker', async () => {
    const svc = service(registry());
    install('0.16.0+local', 'local', '0.16.0'); install('0.16.0+link', 'link', '0.16.0');
    expect((await svc.status({ registryOnly: true })).installed.map(entry => entry.source)).toEqual(['registry']);
    expect((await svc.status()).installed.map(entry => entry.source)).toEqual(expect.arrayContaining(['local', 'link', 'registry']));
  });

  it('allows a newer published registry install and preserves local build switching', async () => {
    const svc = service(registry(), true);
    install('0.16.0', 'registry');
    expect(await svc.forwardOnlyRefusal('0.16.0')).toBeNull();
    expect(svc.apply('0.16.0').status).toBe('restarting');
    expect(activeId()).toBe('0.16.0');
    const local = service(registry()); install('0.16.0+local', 'local', '0.16.0');
    expect(local.apply('0.16.0+local').status).toBe('restarting');
    expect(activeId()).toBe('0.16.0+local');
  });

  it.each([false, true])('redacts hosted job logs and errors without changing local diagnostics (trimPaths=%s)', async hosted => {
    const staging = join(home, 'versions', '.staging-0.16.0-123');
    vi.spyOn(installer, 'installFromRegistry').mockImplementation(async (_target, opts) => {
      opts?.onLog?.('npm install --prefix ' + staging + ' @wjarka/cezarion@0.16.0');
      throw new Error('EACCES: permission denied, mkdir ' + staging);
    });
    const svc = service(registry(), hosted);
    await svc.status();
    const job = svc.apply('0.16.0', { registryOnly: true });
    await vi.waitFor(() => expect(job.status).toBe('failed'));
    const status = await svc.status({ registryOnly: true });
    expect(status.job?.log.join('\n')).not.toContain(home);
    expect(status.job?.error).not.toContain(home);
    expect(status.job?.error).toContain('EACCES');
    expect(status.job?.log.join('\n')).toContain('npm install --prefix');
    // Redaction is a response projection; local troubleshooting keeps the original failure.
    expect(job.log.join('\n')).toContain(staging);
    expect(job.error).toContain(staging);
    if (!hosted) expect((await svc.status()).job?.error).toContain(staging);
  });

  it('waits for the first registry read so the initial dialog receives versions', async () => {
    let release!: (value: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
    const svc = service(new RegistryCache('@wjarka/cezarion', fetch));
    const pending = svc.status();
    const observed = vi.fn(); void pending.then(observed);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(observed).not.toHaveBeenCalled();
    release(Response.json(document));
    const status = await pending;
    expect(status.latest.stable).toBe('0.16.0'); expect(status.checkedAt).not.toBeNull();
    expect(status.available.map(row => row.version)).toContain('0.16.0');
  });

  it('degrades cleanly when the initial registry request fails', async () => {
    const svc = service(new RegistryCache('@wjarka/cezarion', vi.fn(async () => { throw new Error('offline'); })));
    expect(await svc.status()).toMatchObject({ latest: { stable: null, nightly: null }, checkedAt: null, available: [] });
  });
});
