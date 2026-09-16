import { describe, expect, it, vi } from 'vitest';
import { RUNNER_IDS, type RunnerId } from './agent-runner.ts';
import { RunnerModelCatalog, type ModelOption } from './runner-model-catalog.ts';

const UNAVAILABLE_REASON_NAME: Record<RunnerId, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
  cursor: 'Cursor',
};

const models: ModelOption[] = [
  {
    id: 'gpt-latest',
    label: 'GPT Latest',
    description: 'Latest model',
    effortLevels: ['low', 'high'],
  },
];

describe('RunnerModelCatalog', () => {
  it('returns a live discovery, then a cached value for five minutes', async () => {
    let now = 1_000;
    const discover = vi.fn(async () => models);
    const catalog = new RunnerModelCatalog({ adapters: { codex: { discover } }, now: () => now });

    await expect(catalog.get('codex')).resolves.toEqual({
      runner: 'codex', models, source: 'live', stale: false,
    });
    now += 299_999;
    await expect(catalog.get('codex')).resolves.toEqual({
      runner: 'codex', models, source: 'cache', stale: false,
    });
    expect(discover).toHaveBeenCalledTimes(1);

    now += 1;
    await catalog.get('codex');
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent refreshes into the same discovery', async () => {
    let resolveDiscovery!: (value: ModelOption[]) => void;
    const discover = vi.fn(() => new Promise<ModelOption[]>((resolve) => { resolveDiscovery = resolve; }));
    const catalog = new RunnerModelCatalog({ adapters: { codex: { discover } } });

    const first = catalog.get('codex');
    const second = catalog.get('codex');
    expect(discover).toHaveBeenCalledTimes(1);
    resolveDiscovery(models);
    await expect(Promise.all([first, second])).resolves.toEqual([
      { runner: 'codex', models, source: 'live', stale: false },
      { runner: 'codex', models, source: 'live', stale: false },
    ]);
  });

  it('returns stale last-known-good data when a refresh fails', async () => {
    let now = 0;
    const discover = vi.fn()
      .mockResolvedValueOnce(models)
      .mockRejectedValueOnce(new Error('token=/secret/path account@example.test'));
    const catalog = new RunnerModelCatalog({
      adapters: { codex: { discover } },
      now: () => now,
      ttlMs: 10,
    });

    await catalog.get('codex');
    now = 10;
    await expect(catalog.get('codex')).resolves.toEqual({
      runner: 'codex',
      models,
      source: 'cache',
      stale: true,
      reason: 'Codex model discovery is temporarily unavailable',
    });
    await catalog.get('codex');
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('returns a sanitized unavailable result when no good value exists', async () => {
    const discover = vi.fn().mockRejectedValue(new Error('spawn /private/bin ENOENT: API_KEY=secret'));
    const catalog = new RunnerModelCatalog({ adapters: { codex: { discover } } });

    const result = await catalog.get('codex');
    expect(result).toEqual({
      runner: 'codex',
      models: [],
      source: 'unavailable',
      stale: false,
      reason: 'Codex model discovery is temporarily unavailable',
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('/private');
    await catalog.get('codex');
    expect(discover).toHaveBeenCalledOnce();
  });

  it('names Pi when its discovery is unavailable', async () => {
    const catalog = new RunnerModelCatalog({
      adapters: { pi: { discover: async () => { throw new Error('secret'); } } },
    });
    await expect(catalog.get('pi')).resolves.toEqual({
      runner: 'pi',
      models: [],
      source: 'unavailable',
      stale: false,
      reason: 'Pi model discovery is temporarily unavailable',
    });
  });

  it.each(RUNNER_IDS)('names %s when its discovery is unavailable', async (runner) => {
    const catalog = new RunnerModelCatalog({
      adapters: { [runner]: { discover: async () => { throw new Error('secret'); } } },
    });
    await expect(catalog.get(runner)).resolves.toEqual({
      runner,
      models: [],
      source: 'unavailable',
      stale: false,
      reason: `${UNAVAILABLE_REASON_NAME[runner]} model discovery is temporarily unavailable`,
    });
  });

  it('does not let one runner cache or in-flight request affect another', async () => {
    const codex = vi.fn(async () => models);
    const claude = vi.fn(async () => [{ id: 'opus', label: 'Opus', description: '' }]);
    const catalog = new RunnerModelCatalog({ adapters: { codex: { discover: codex }, claude: { discover: claude } } });

    await Promise.all([catalog.get('codex'), catalog.get('claude')]);
    expect(codex).toHaveBeenCalledOnce();
    expect(claude).toHaveBeenCalledOnce();
  });

  it('drops a cached miss so the next get rediscovers', async () => {
    const discover = vi.fn()
      .mockRejectedValueOnce(new Error('not logged in'))
      .mockResolvedValueOnce(models);
    const catalog = new RunnerModelCatalog({ adapters: { codex: { discover } } });

    await expect(catalog.get('codex')).resolves.toMatchObject({ source: 'unavailable', models: [] });
    catalog.invalidate('codex');
    await expect(catalog.get('codex')).resolves.toEqual({
      runner: 'codex', models, source: 'live', stale: false,
    });
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('does not spawn discovery itself', async () => {
    const discover = vi.fn().mockRejectedValue(new Error('not logged in'));
    const catalog = new RunnerModelCatalog({ adapters: { codex: { discover } } });
    await catalog.get('codex');
    expect(discover).toHaveBeenCalledOnce();
    catalog.invalidate('codex');
    expect(discover).toHaveBeenCalledOnce();
  });

  it('does not drop another runner\'s cache', async () => {
    const codex = vi.fn(async () => models);
    const pi = vi.fn(async () => [{ id: 'grok', label: 'grok', description: '' }]);
    const catalog = new RunnerModelCatalog({ adapters: { codex: { discover: codex }, pi: { discover: pi } } });
    await catalog.get('codex');
    await catalog.get('pi');
    catalog.invalidate('codex');
    await catalog.get('pi');
    expect(pi).toHaveBeenCalledOnce();
  });

  it('discards an in-flight miss that finishes after invalidate', async () => {
    let rejectFirst!: (error: Error) => void;
    const discover = vi.fn()
      .mockImplementationOnce(() => new Promise<ModelOption[]>((_, reject) => { rejectFirst = reject; }))
      .mockResolvedValueOnce(models);
    const catalog = new RunnerModelCatalog({ adapters: { codex: { discover } } });

    const first = catalog.get('codex');
    catalog.invalidate('codex');
    await expect(catalog.get('codex')).resolves.toEqual({
      runner: 'codex', models, source: 'live', stale: false,
    });
    rejectFirst(new Error('not logged in'));
    await expect(first).resolves.toMatchObject({ source: 'unavailable', models: [] });
    await expect(catalog.get('codex')).resolves.toEqual({
      runner: 'codex', models, source: 'cache', stale: false,
    });
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('keeps last-known-good models when rediscovery after invalidate fails', async () => {
    const discover = vi.fn()
      .mockResolvedValueOnce(models)
      .mockRejectedValueOnce(new Error('timeout'));
    const catalog = new RunnerModelCatalog({ adapters: { codex: { discover } } });

    await catalog.get('codex');
    catalog.invalidate('codex');
    await expect(catalog.get('codex')).resolves.toEqual({
      runner: 'codex',
      models,
      source: 'cache',
      stale: true,
      reason: 'Codex model discovery is temporarily unavailable',
    });
    expect(discover).toHaveBeenCalledTimes(2);
  });
});
