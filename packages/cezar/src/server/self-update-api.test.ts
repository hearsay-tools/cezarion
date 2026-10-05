import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { versionEntry, writeManifest } from '../self-update/layout.ts';
import type { Hono } from 'hono';
import { selfUpdateStatusSchema } from '@open-mercato/cezar-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RegistryCache } from '../self-update/registry.ts';
import { SelfUpdateService } from '../self-update/service.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/**
 * `/api/v1/workspace/self-update` (self-update PoC). The load-bearing security property: a
 * HOSTED cockpit (`CEZ_REMOTE`) may only apply a version that is forward IN TIME. Installing a
 * published package cannot inject code, but installing an older one can — every hosted guard
 * (the `/api/*` request-origin check #426, the `localHandoff` 409 on agent-config writes that
 * closes the hooks RCE path) lives in the running version, so moving back to a release that
 * predates them re-opens exactly what they close. A local cockpit keeps the whole picker.
 *
 * The registry is stubbed: the unit gate stays hermetic (no npmjs.org round trip), and the
 * stubbed publish dates encode the trap that semver order alone misses — cezar's nightlies are
 * `<next-version>-nightly.<date>.<run>`, so `0.13.0-nightly.20260901.3` OUTRANKS the running
 * `0.12.1` while having been published nineteen days before it.
 */
describe('the self-update API', () => {
  const RUNNING = '0.12.1';
  const registryDocument = {
    'dist-tags': { latest: '0.13.0', nightly: '0.13.0-nightly.20260901.3' },
    versions: {
      '0.11.1': {},
      '0.12.0': {},
      '0.12.1': {},
      '0.13.0-nightly.20260901.3': {},
      '0.13.0': {},
    },
    time: {
      '0.11.1': '2026-08-01T00:00:00.000Z',
      '0.12.0': '2026-09-01T00:00:00.000Z',
      '0.12.1': '2026-09-20T00:00:00.000Z',
      // Published BEFORE the running 0.12.1, yet semver-newer than it. The trap.
      '0.13.0-nightly.20260901.3': '2026-09-01T03:00:00.000Z',
      '0.13.0': '2026-09-27T00:00:00.000Z',
    },
  };

  let repoRoot: string;
  let home: string;
  let store: RunStore;
  let app: Hono;
  const prevRemote = process.env.CEZ_REMOTE;
  const prevHome = process.env.CEZ_HOME;

  beforeEach(() => {
    delete process.env.CEZ_REMOTE;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-selfupdate-'));
    home = mkdtempSync(join(tmpdir(), 'cez-selfupdate-home-'));
    process.env.CEZ_HOME = home;
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    const stubFetch = (async () =>
      new Response(JSON.stringify(registryDocument), { status: 200 })) as unknown as typeof fetch;
    const selfUpdate = new SelfUpdateService({
      pkgName: '@wjarka/cezarion',
      version: RUNNING,
      entry: join(home, 'somewhere', 'dist', 'index.js'),
      restart: () => {},
      env: { ...process.env, CEZ_HOME: home },
      registry: new RegistryCache('@wjarka/cezarion', stubFetch),
    });
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: RUNNING, selfUpdate });
  });
  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    if (prevRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = prevRemote;
    if (prevHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = prevHome;
  });

  const apply = (version: string) =>
    apiRequest(app, '/api/v1/workspace/self-update/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version }),
    });
  const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

  it('answers the status with the running version and an install kind', async () => {
    const res = await apiRequest(app, '/api/v1/workspace/self-update');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string; installKind: string; job: unknown };
    expect(body.version).toBe(RUNNING);
    expect(['managed', 'global-npm', 'npx', 'checkout', 'unknown']).toContain(body.installKind);
    expect(body.job).toBeNull();
  });

  it('returns offline installed-version apply and polling status before restart', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let release!: (response: Response) => void;
    const pendingRegistry = new Promise<Response>(resolve => { release = resolve; });
    const fetchRegistry = vi.fn(() => pendingRegistry);
    const registry = new RegistryCache('@wjarka/cezarion', fetchRegistry);
    const restart = vi.fn();
    for (const id of [RUNNING, '0.13.0']) {
      const entry = versionEntry(id);
      mkdirSync(dirname(entry), { recursive: true }); writeFileSync(entry, '// fixture');
      writeManifest(id, { source: 'registry', version: id, installedAt: '2026-10-01T00:00:00Z' });
    }
    const selfUpdate = new SelfUpdateService({
      pkgName: '@wjarka/cezarion', version: RUNNING, entry: versionEntry(RUNNING), restart, registry,
    });
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: RUNNING, selfUpdate });
    // An initial dialog read may already be stalled by an unreachable registry.
    const firstRead = registry.get();
    try {
      const received = vi.fn();
      const response = apply('0.13.0').then(res => { received(res); return res; });
      await vi.waitFor(() => expect(received).toHaveBeenCalledOnce(), { timeout: 500 });
      const res = await response;
      expect(res.status).toBe(200);
      expect(selfUpdateStatusSchema.parse(await res.json()).job).toMatchObject({ status: 'restarting', target: '0.13.0' });
      const polled = vi.fn();
      const poll = apiRequest(app, '/api/v1/workspace/self-update').then(res => { polled(res); return res; });
      await vi.waitFor(() => expect(polled).toHaveBeenCalledOnce(), { timeout: 100 });
      expect(selfUpdateStatusSchema.parse(await (await poll).json()).job?.status).toBe('restarting');
      expect(restart).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(750);
      expect(restart).toHaveBeenCalledOnce();
      expect(fetchRegistry).toHaveBeenCalledOnce();
    } finally {
      release(new Response(null, { status: 503 }));
      await firstRead;
      vi.clearAllTimers(); vi.useRealTimers();
    }
  });

  it('rejects a body that is not a plain version string', async () => {
    for (const version of ['', 'https://evil.example/x.tgz', '../../etc', 'a'.repeat(65)]) {
      expect((await apply(version)).status).toBe(400);
    }
  });

  it('refuses an older or equal version in hosted mode', async () => {
    process.env.CEZ_REMOTE = '1';
    for (const target of ['0.11.1', '0.12.0', RUNNING, '0.11.1+local']) {
      const res = await apply(target);
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toContain('is not newer than the running');
    }
  });

  // The whole point of the publish-date check: semver order alone would wave this one through.
  it('refuses a semver-newer version that was published BEFORE the running one', async () => {
    process.env.CEZ_REMOTE = '1';
    const res = await apply('0.13.0-nightly.20260901.3');
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toContain('was published before the running');
  });

  it('refuses a prerelease absent from the registry', async () => {
    process.env.CEZ_REMOTE = '1';
    const res = await apply('0.99.0-nightly.20260101.1');
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toContain('published registry version');
  });

  it.each(['local', 'link'] as const)('refuses installed %s targets and hides them in hosted status', async source => {
    const id = '0.16.0+' + source;
    const entry = versionEntry(id);
    mkdirSync(dirname(entry), { recursive: true }); writeFileSync(entry, '// fixture');
    writeManifest(id, { source, version: '0.16.0', installedAt: '2026-10-01T00:00:00Z' });
    const local = selfUpdateStatusSchema.parse(await (await apiRequest(app, '/api/v1/workspace/self-update')).json());
    expect(local.installed.some((row) => row.id === id)).toBe(true);
    process.env.CEZ_REMOTE = '1';
    expect(await errorOf(await apply(id))).toContain('published registry version');
    const hosted = selfUpdateStatusSchema.parse(await (await apiRequest(app, '/api/v1/workspace/self-update')).json());
    expect(hosted.installed).toEqual([]);
  });

  it('lets a genuinely newer version past the hosted guard', async () => {
    process.env.CEZ_REMOTE = '1';
    const res = await apply('0.13.0');
    expect(res.status).toBe(409);
    // Past the forward-only guard: what refuses now is the install-kind capability, not it.
    const error = await errorOf(res);
    expect(error).not.toContain('can only update forward');
    expect(error).toMatch(/could not tell how it was installed|npx|npm -g|git checkout/);
  });

  it('never applies the forward-only rule to a local cockpit', async () => {
    for (const target of ['0.11.1', RUNNING, '0.13.0-nightly.20260901.3']) {
      const res = await apply(target);
      expect(res.status).toBe(409);
      expect(await errorOf(res)).not.toContain('can only update forward');
    }
  });
});
