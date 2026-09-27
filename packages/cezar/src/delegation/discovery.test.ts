import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeWriteAgentAccounts } from '../workspace/agent-accounts.ts';
import { RunnerModelCatalog } from '../core/runner-model-catalog.ts';
import { fixture } from './service.testkit.ts';
import { createDelegationRoutes } from './routes.ts';

const model = (id: string) => ({ id, label: id, description: '', effortLevels: ['low', 'high'] as const });
describe('parent discovery and model admission', () => {
  let f: ReturnType<typeof fixture>;
  let catalog: RunnerModelCatalog;
  beforeEach(() => {
    vi.stubEnv('CEZ_DELEGATION', '1'); f = fixture(); vi.stubEnv('CODEX_HOME', f.root);
    catalog = new RunnerModelCatalog({ adapters: {
      codex: { discover: async () => [{ ...model('gpt-current'), effortLevels: ['low', 'high'] }] },
      claude: { discover: async () => [{ id: 'gpt-retired', label: 'Other', description: '' }] },
    } });
    f.service.setDiscovery({ models: catalog, providers: async () => ({ providers: [{ provider: 'codex', status: 'connected', enabled: true }, { provider: 'claude', status: 'disconnected', enabled: false }] }) });
  });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  const spawn = (extra = {}) => f.service.spawn(f.caller, { task: 'work', baseline: 'parent-head', requestId: randomUUID(), backend: 'codex', model: 'gpt-retired', ...extra });
  it('rejects a catalog miss with choices and alternative runners before allocating a worker', async () => {
    await expect(spawn()).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringMatching(/gpt-retired.*codex.*gpt-current.*low.*high.*claude/s) });
    expect(f.store.listRuns()).toHaveLength(1);
    expect(f.store.getRun(f.parent.id)?.delegation).toMatchObject({ receipts: [] });
    expect(existsSync(join(f.root, '.ai/cezar/worktrees'))).toBe(false);
  });
  it('returns catalog choices even when the old preset heuristic also rejects the model', async () => {
    f.service.setDiscovery({ models: new RunnerModelCatalog({ adapters: {
      codex: { discover: async () => [{ id: 'gpt-current', label: '', description: '' }] },
      claude: { discover: async () => [{ id: 'opus', label: '', description: '' }] },
    } }), providers: async () => ({ providers: [] }) });
    await expect(spawn({ model: 'opus' })).rejects.toMatchObject({ code: 'invalid_input', modelChoices: { requestedModel: 'opus', otherRunners: ['claude'] } });
  });
  it('accepts an explicit provider-qualified spelling of a catalog model', async () => {
    const accepted = await spawn({ model: 'openai/gpt-current' });
    expect(f.store.getRun(accepted.workerId)?.model).toBe('gpt-current');
  });
  it('uses native configured-provider normalization before consulting the catalog', async () => {
    writeFileSync(join(f.root, 'config.toml'), 'model_provider = "custom"\n');
    const accepted = await spawn({ model: 'custom/gpt-current' });
    expect(f.store.getRun(accepted.workerId)?.model).toBe('gpt-current');
  });
  it.each(['inherited', 'workflow'] as const)('does not disprove an %s named-account pin with the host default catalog', async kind => {
    const home = join(f.root, 'work-account'); mkdirSync(home);
    if (kind === 'inherited') {
      vi.mocked(f.manager.delegationExecutionSettings).mockReturnValue({ cwd: f.root, runner: 'codex', agentProfile: 'work', accountBinding: { provider: 'codex', profileId: 'work', homePath: home } });
      const accepted = await spawn();
      expect(f.store.readWorkerIdentity(accepted.workerId)).toMatchObject({ model: 'gpt-retired', account: { profileId: 'work' } });
    } else {
      await mergeWriteAgentAccounts(store => { store.accounts = [{ id: 'work', provider: 'codex', configDir: home, label: 'Work', addedAt: '' }]; });
      const dir = join(f.root, '.ai/cezar/workflows'); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'profiled.yaml'), 'name: profiled\nsteps:\n  - id: task\n    prompt: "{{task}}"\n    runner: codex\n    agentProfile: work\n');
      const accepted = await spawn({ workflow: 'profiled' });
      expect(f.store.readWorkerIdentity(accepted.workerId)).toMatchObject({ model: 'gpt-retired', account: { profileId: 'work' } });
    }
  });
  it('lists alternate catalog IDs matching the resolved native and canonical model', async () => {
    f.service.setDiscovery({ models: new RunnerModelCatalog({ adapters: {
      codex: { discover: async () => [{ id: 'different', label: '', description: '' }] },
      cursor: { discover: async () => [{ id: 'gpt-current', label: '', description: '' }] },
      opencode: { discover: async () => [{ id: 'openai/gpt-current', label: '', description: '' }] },
      pi: { discover: async () => [{ id: 'different-provider/gpt-current', label: '', description: '' }] },
    } }), providers: async () => ({ providers: [] }) });
    for (const model of ['gpt-current', 'openai/gpt-current']) {
      await expect(spawn({ model })).rejects.toMatchObject({ code: 'invalid_input', modelChoices: { otherRunners: ['opencode', 'cursor'] } });
    }
  });
  it('keeps accepted retries valid when the catalog changes', async () => {
    const request = { task: 'work', baseline: 'parent-head', requestId: randomUUID(), backend: 'codex' as const, model: 'gpt-current' };
    const accepted = await f.service.spawn(f.caller, request);
    f.service.setDiscovery({ models: new RunnerModelCatalog({ adapters: { codex: { discover: async () => [{ id: 'replacement', label: '', description: '' }] } } }), providers: async () => ({ providers: [] }) });
    expect(await f.service.spawn(f.caller, request)).toEqual(accepted);
  });
  it.each(['absent', 'empty', 'stale'] as const)('does not reject on an %s catalog', async kind => {
    let broken = false;
    const models = new RunnerModelCatalog({ adapters: kind === 'absent' ? {} : { codex: { discover: async () => {
      if (broken) throw Error('offline');
      return kind === 'empty' ? [] : [{ id: 'different', label: '', description: '' }];
    } } } });
    if (kind === 'stale') { await models.get('codex'); broken = true; models.invalidate('codex'); }
    f.service.setDiscovery({ models, providers: async () => ({ providers: [] }) });
    expect(await spawn()).toHaveProperty('workerId');
  });
  it('preserves omitted model inheritance without treating the inherited value as a new pin', async () => {
    const result = await spawn({ backend: 'claude', model: undefined });
    expect(f.store.getRun(result.workerId)?.model).toBe('opus');
  });
  it('checks pins on every authored workflow step before acceptance', async () => {
    const dir = join(f.root, '.ai/cezar/workflows'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'chain.yaml'), 'name: chain\nsteps:\n  - id: first\n    prompt: "{{task}}"\n    runner: codex\n    model: gpt-current\n  - id: second\n    prompt: review\n    runner: codex\n    model: gpt-retired\n');
    await expect(spawn({ workflow: 'chain', model: undefined })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(f.store.listRuns()).toHaveLength(1);
  });
  it('serves scoped runner status and model metadata, refusing workers and forged inputs', async () => {
    const app = createDelegationRoutes(f.service, f.credentials);
    const request = (body: unknown, token = f.token) => app.request('http://127.0.0.1/discover', { method: 'POST', headers: { host: '127.0.0.1', authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const runners = await request({ kind: 'runners' });
    expect(runners.status).toBe(200);
    expect(await runners.json()).toEqual({ scope: 'host-default-account', runners: [{ runner: 'codex', status: 'connected', enabled: true }, { runner: 'claude', status: 'disconnected', enabled: false }] });
    const models = await request({ kind: 'models', runner: 'codex' });
    expect(models.status).toBe(200);
    expect(await models.json()).toMatchObject({ runner: 'codex', models: [{ id: 'gpt-current', effortLevels: ['low', 'high'] }] });
    expect((await request({ kind: 'models', runner: 'bogus' })).status).toBe(400);
    expect((await request({ kind: 'runners', runId: f.parent.id })).status).toBe(400);
    expect((await request({ kind: 'runners' }, 'x'.repeat(43))).status).toBe(401);
    const rejected = await app.request('http://127.0.0.1/spawn', { method: 'POST', headers: { host: '127.0.0.1', authorization: `Bearer ${f.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ task: 'work', baseline: 'HEAD', requestId: randomUUID(), backend: 'codex', model: 'gpt-retired' }) });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ code: 'invalid_input', modelChoices: { runner: 'codex', requestedModel: 'gpt-retired', availableModels: [{ id: 'gpt-current', effortLevels: ['low', 'high'] }], otherRunners: ['claude'] } });
    const child = await spawn({ model: 'gpt-current' });
    const token = f.credentials.issue('project', child.workerId, randomUUID());
    expect((await request({ kind: 'runners' }, token)).status).toBe(403);
  });
});
