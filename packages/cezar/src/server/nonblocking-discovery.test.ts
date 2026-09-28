import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { detectEnvironment, type BackendCheck } from '../core/backend-detect.ts';
import { RunnerModelCatalog, type ModelOption } from '../core/runner-model-catalog.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { ProviderAuthService } from '../core/provider-auth.ts';
import type { TopicPublisher } from './ws.ts';
import { createApp, WorkspaceEventBus, type ServerDeps } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

vi.mock('../core/backend-detect.ts', () => ({ detectEnvironment: vi.fn() }));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
function build(modelCatalog = new RunnerModelCatalog({ adapters: {} }), extra: Partial<ServerDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cez-nonblocking-')); roots.push(root);
  return createApp({ repoRoot: root, store: RunStore.open(join(root, '.ai/cezar')), manager: {} as RunManager, version: 'test', modelCatalog, ...extra });
}

it('answers cold health while availability probes remain unresolved', async () => {
  vi.mocked(detectEnvironment).mockReturnValue(new Promise(() => {}));
  const app = build();
  const response = await apiRequest(app, '/api/v1/health');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ checks: [] });
}, 1500);

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

it('keeps last-known availability while a stale probe is pending, dedupes, and retries after failure', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const checks: BackendCheck[] = [{ name: 'cursor', available: true, version: '1' }];
    let fail!: (error: Error) => void;
    vi.mocked(detectEnvironment).mockReset().mockResolvedValueOnce(checks)
      .mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }))
      .mockResolvedValueOnce([{ name: 'cursor', available: false }]);
    const app = build();
    await apiRequest(app, '/api/v1/health');
    expect(await (await apiRequest(app, '/api/v1/health')).json()).toMatchObject({ checks });
    vi.setSystemTime(Date.now() + 120_000);
    for (let i = 0; i < 2; i++) {
      expect(await (await apiRequest(app, '/api/v1/health')).json()).toMatchObject({ checks });
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
  const app = createApp({
    repoRoot: root, store: RunStore.open(join(root, '.ai/cezar')), manager: {} as RunManager,
    version: 'test', modelCatalog: catalog, workspaceEvents: events,
    providerAuth: new ProviderAuthService({ runCommand: async () => ({ stdout: '', stderr: '', exitCode: 1 }) }),
    socketHub: { registerTopic: (name, topic) => { topics.set(name, topic); }, attach: () => {}, close: () => {} },
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
    socketHub: { registerTopic: (name, topic) => { topics.set(name, topic); }, attach: () => {}, close: () => {} },
  });
  expect(await topics.get('models:cursor')!.snapshot()).toMatchObject({ source: 'unavailable' });
  catalog.invalidate('cursor');
  const fresh = catalog.get('cursor');
  finish[1]!([{ id: 'new', label: 'New', description: '' }]);
  await fresh;
  finish[0]!([]);
  expect(await topics.get('models:cursor')!.snapshot()).toMatchObject({ models: [{ id: 'new' }] });
}, 1500);
