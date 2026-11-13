import { testHome } from '../home/test-home.testkit.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { BackendCheck } from '../core/backend-detect.ts';
import { RunnerModelCatalog, type ModelOption } from '../core/runner-model-catalog.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { ProviderAuthService } from '../core/provider-auth.ts';
import type { TopicPublisher } from './ws.ts';
import { createApp, WorkspaceEventBus, type ServerDeps } from './server.ts';
import * as git from './git.ts';
import { apiRequest } from './loopback-request.testkit.ts';

/** Hang guard for the waits below: each ends the moment its condition holds, so the bound only ends a hang. */
const HANG_GUARD_MS = 15_000;

const detectEnvironment = vi.fn<() => Promise<BackendCheck[]>>();
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
function build(modelCatalog = new RunnerModelCatalog({ adapters: {} }), extra: Partial<ServerDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cez-nonblocking-')); roots.push(root);
  return createApp({ home: testHome(), repoRoot: root, store: RunStore.open(join(root, '.ai/cezar')), manager: {} as RunManager, version: 'test', modelCatalog, detectEnvironment, ...extra });
}

// hearsay-tools/cezarion#974: the full Node 24.15 run took 1734ms against 1500ms.
// This cell also builds the app and reads real Git/workspace metadata; its deadline
// is a liveness bound, not a health latency benchmark. The never-resolving probe
// still makes awaiting availability fail within the ordinary 5s unit-test budget.
it('answers cold health while availability probes remain unresolved', async () => {
  vi.mocked(detectEnvironment).mockReturnValue(new Promise(() => {}));
  const app = build();
  const response = await apiRequest(app, '/api/v1/health');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ checks: [] });
  expect(detectEnvironment).toHaveBeenCalledOnce();
}, 5_000);

it('answers cold Cursor models before discovery completes and returns them on the next read', async () => {
  let finish!: (models: ModelOption[]) => void;
  const discover = vi.fn(() => new Promise<ModelOption[]>((resolve) => { finish = resolve; }));
  const app = build(new RunnerModelCatalog({ adapters: { cursor: { discover } } }));
  const first = await apiRequest(app, '/api/v1/models?runner=cursor');
  expect(await first.json()).toMatchObject({ models: [], source: 'unavailable' });
  finish([{ id: 'auto', label: 'Auto', description: '' }]);
  const second = await apiRequest(app, '/api/v1/models?runner=cursor');
  expect(await second.json()).toMatchObject({ models: [{ id: 'auto' }], source: 'cache' });
  expect(discover).toHaveBeenCalledOnce();
}, 1500);

it.each([false, true])('keeps last-known availability while a stale probe is pending, dedupes, and retries after failure (held refresh=%s)', async (heldRefresh) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const checks: BackendCheck[] = [{ name: 'cursor', available: true, version: '1' }];
    let fail!: (error: Error) => void;
    vi.mocked(detectEnvironment).mockReset().mockResolvedValueOnce(checks)
      .mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }))
      .mockResolvedValueOnce([{ name: 'cursor', available: false }]);
    const getRepoInfo = git.getRepoInfo;
    let refreshEntered!: () => void;
    const refreshEnteredPromise = new Promise<void>((resolve) => { refreshEntered = resolve; });
    let releaseRefresh!: () => void;
    const releaseRefreshPromise = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    let refreshFinished!: () => void;
    const refreshFinishedPromise = new Promise<void>((resolve) => { refreshFinished = resolve; });
    if (heldRefresh) {
      vi.spyOn(git, 'getRepoInfo').mockImplementationOnce(getRepoInfo).mockImplementationOnce(async (...args) => {
        refreshEntered();
        await releaseRefreshPromise;
        try { return await getRepoInfo(...args); }
        finally { refreshFinished(); }
      });
    }
    const app = build();
    await apiRequest(app, '/api/v1/health');
    if (heldRefresh) await refreshEnteredPromise;
    expect(await (await apiRequest(app, '/api/v1/health')).json()).toMatchObject({ checks });
    vi.setSystemTime(Date.now() + 120_000);
    for (let i = 0; i < 2; i++) {
      expect(await (await apiRequest(app, '/api/v1/health')).json()).toMatchObject({ checks });
      if (heldRefresh && i === 0) {
        releaseRefresh();
        await refreshFinishedPromise;
      }
    }
    expect(detectEnvironment).toHaveBeenCalledTimes(2);
    fail(new Error('unavailable'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await (await apiRequest(app, '/api/v1/health')).json()).toMatchObject({ checks });
    expect(detectEnvironment).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 5_001);
    await apiRequest(app, '/api/v1/health');
    expect(await (await apiRequest(app, '/api/v1/health')).json()).toMatchObject({ checks: [{ name: 'cursor', available: false }] });
  } finally { vi.useRealTimers(); }
});

it('prewarms Cursor on the live path and publishes completion to both transports', async () => {
  vi.mocked(detectEnvironment).mockReturnValue(new Promise(() => {}));
  let finish!: (models: ModelOption[]) => void;
  const discover = vi.fn(() => new Promise<ModelOption[]>((resolve) => { finish = resolve; }));
  const catalog = new RunnerModelCatalog({ adapters: { cursor: { discover } } });
  const root = mkdtempSync(join(tmpdir(), 'cez-prewarm-')); roots.push(root);
  const topics = new Map<string, TopicPublisher>();
  const events = new WorkspaceEventBus();
  const sse = vi.fn(); events.on(sse);
  const app = createApp({ home: testHome(),
    repoRoot: root, store: RunStore.open(join(root, '.ai/cezar')), manager: {} as RunManager,
    version: 'test', modelCatalog: catalog, detectEnvironment, workspaceEvents: events,
    providerAuth: new ProviderAuthService({ runCommand: async () => ({ stdout: '', stderr: '', exitCode: 1 }) }),
    socketHub: { registerTopic: (name, topic) => { topics.set(name, topic); }, registerTopicFamily: () => {}, handleUpgrade: () => {}, close: () => {}, onClose: () => () => undefined },
  });
  expect(discover).toHaveBeenCalledOnce();
  const publish = vi.fn();
  const stop = topics.get('models:cursor')!.start(publish);
  try {
    expect((await apiRequest(app, '/api/v1/health')).status).toBe(200);
    const snapshot = topics.get('models:cursor')!.snapshot();
    finish([{ id: 'auto', label: 'Auto', description: '' }]);
    await snapshot;
    await catalog.get('cursor');
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ models: [{ id: 'auto', label: 'Auto', description: '' }] }));
    expect(sse).toHaveBeenCalledWith('model-catalog', expect.objectContaining({ runner: 'cursor', source: 'live' }));
    expect(discover).toHaveBeenCalledOnce();
    stop();
    catalog.invalidate('cursor');
    const refresh = catalog.get('cursor');
    finish([]); await refresh;
    expect(publish).toHaveBeenCalledOnce();
  } finally { stop(); }
});

it('a Cursor topic snapshot does not wait on an obsolete discovery generation', async () => {
  vi.mocked(detectEnvironment).mockResolvedValue([]);
  const finish: Array<(models: ModelOption[]) => void> = [];
  const catalog = new RunnerModelCatalog({ adapters: { cursor: { discover: () => new Promise((resolve) => { finish.push(resolve); }) } } });
  const topics = new Map<string, TopicPublisher>();
  build(catalog, {
    providerAuth: new ProviderAuthService({ runCommand: async () => ({ stdout: '', stderr: '', exitCode: 1 }) }),
    socketHub: { registerTopic: (name, topic) => { topics.set(name, topic); }, registerTopicFamily: () => {}, handleUpgrade: () => {}, close: () => {}, onClose: () => () => undefined },
  });
  expect(await topics.get('models:cursor')!.snapshot()).toMatchObject({ source: 'unavailable' });
  catalog.invalidate('cursor');
  const fresh = catalog.get('cursor');
  finish[1]!([{ id: 'new', label: 'New', description: '' }]);
  await fresh;
  finish[0]!([]);
  expect(await topics.get('models:cursor')!.snapshot()).toMatchObject({ models: [{ id: 'new' }] });
}, 1500);

it.each([false, true])('publishes completed availability without a health subscriber (early=%s)', async (early) => {
  const checks: BackendCheck[] = [{ name: 'cursor', available: true, version: '1' }];
  let finish!: (checks: BackendCheck[]) => void;
  vi.mocked(detectEnvironment).mockReturnValue(early ? Promise.resolve(checks) : new Promise((resolve) => { finish = resolve; }));
  const events = new WorkspaceEventBus();
  const published = vi.fn(); events.on(published);
  const app = build(undefined, {
    workspaceEvents: events,
    providerAuth: new ProviderAuthService({ runCommand: async () => ({ stdout: '', stderr: '', exitCode: 1 }) }),
    socketHub: { registerTopic: () => {}, registerTopicFamily: () => {}, handleUpgrade: () => {}, close: () => {}, onClose: () => () => undefined },
  });
  if (!early) {
    expect(await (await apiRequest(app, '/api/v1/health')).json()).toMatchObject({ checks: [] });
    finish(checks);
  }
  await vi.waitFor(() => expect(published).toHaveBeenCalledWith('health', expect.objectContaining({ checks })), { timeout: HANG_GUARD_MS });
  expect(await (await apiRequest(app, '/api/v1/health')).json()).toMatchObject({ checks });
});
