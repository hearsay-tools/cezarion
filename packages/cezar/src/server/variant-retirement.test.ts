import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunInputSchema, groupResponseSchema } from '@open-mercato/cezar-contract/runs';
import { createAutomationInputSchema, updateAutomationInputSchema } from '@open-mercato/cezar-contract/automations';
import { AutomationStore } from '../automations/store.ts';
import { launchAutomationRun, launchScheduledRun } from '../automations/task-template.ts';
import { automationDefinitionSchema, type GithubAutomationDefinition, type ScheduleAutomationDefinition } from '../automations/types.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';

const retired = /parallel variants (have been |are )?removed/i;

describe('parallel variant retirement', () => {
  let root: string;
  let store: RunStore;
  const startRun = vi.fn();
  // Deliberately include the old primitive: old source must demonstrate a real launch,
  // rather than fail because a mock omits the method we are retiring.
  const startVariants = vi.fn();
  const manager = { startRun, startVariants, isActive: () => false, cancel: vi.fn() } as unknown as RunManager;
  const task = { task: 'Compare approaches', steps: [{ id: 'work', prompt: '{{task}}' }] };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cezar-variant-retirement-'));
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    execFileSync('git', ['-C', root, '-c', 'user.email=qa@cezar.test', '-c', 'user.name=QA', 'commit', '--allow-empty', '-qm', 'init']);
    store = RunStore.open(join(root, '.ai/cezar'));
    vi.clearAllMocks();
    startRun.mockImplementation(() => store.createRun({ title: 'ordinary', workflow: 'quick-task', task: 'Work', steps: [] }));
    startVariants.mockImplementation(() => [startRun(), startRun()]);
  });

  afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

  it.each([2, 3])('refuses %s candidates at every run API scope without creating a run', async variants => {
    const app = createApp({ repoRoot: root, store, manager, version: 'test', bootProjectId: 'project', providerAuth: connectedProviderAuth() });
    for (const prefix of ['/api/v1', '/api/v1/p/project', '/api/v1/p/default']) {
      const response = await apiRequest(app, `${prefix}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...task, variants }) });
      expect(response.status).toBe(400);
      expect((await response.json() as { error: string }).error).toMatch(retired);
    }
    expect(startRun).not.toHaveBeenCalled();
    expect(startVariants).not.toHaveBeenCalled();
    expect(store.listRuns()).toEqual([]);
  });

  it('keeps ordinary launch available and rejects retired counts in shared input contracts', async () => {
    for (const variants of [undefined, 1]) expect(createRunInputSchema.safeParse({ ...task, variants }).success).toBe(true);
    for (const variants of [2, 3]) {
      const parsed = createRunInputSchema.safeParse({ ...task, variants });
      expect(parsed.success).toBe(false);
      if (!parsed.success) expect(parsed.error.message).toMatch(retired);
      const automation = { name: 'Compare', events: ['issue.opened'], task: { prompt: 'Work', variants } };
      expect(createAutomationInputSchema.safeParse(automation).success).toBe(false);
      expect(updateAutomationInputSchema.safeParse({ ...automation, expectedRevision: 1 }).success).toBe(false);
    }
    const app = createApp({ repoRoot: root, store, manager, version: 'test', providerAuth: connectedProviderAuth() });
    const response = await apiRequest(app, '/api/v1/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(task) });
    expect(response.status).toBe(201);
    expect(await response.json()).toHaveProperty('id');
    expect(startRun).toHaveBeenCalledOnce();
  });

  it('reads historical groups after reopening and refuses pick without changing any retained data', async () => {
    const records = ['A', 'B'].map(variant => {
      const worktreePath = join(root, `retained-${variant}`);
      mkdirSync(worktreePath);
      writeFileSync(join(worktreePath, 'diff.txt'), `retained ${variant}`);
      const record = store.createRun({ title: `Work (${variant})`, task: 'Work', workflow: 'quick-task', steps: [], groupId: 'old-group', variant });
      store.updateRun(record.id, { status: 'done', archived: variant === 'B', branch: `retained-${variant}`, worktreePath });
      return store.getRun(record.id)!;
    });
    store.close();
    store = RunStore.open(join(root, '.ai/cezar'));
    const app = createApp({ repoRoot: root, store, manager, version: 'test', bootProjectId: 'project' });
    for (const prefix of ['/api/v1', '/api/v1/p/project', '/api/v1/p/default']) {
      const read = await apiRequest(app, `${prefix}/groups/old-group`);
      expect(read.status).toBe(200);
      expect(groupResponseSchema.parse(await read.json()).runs.map(r => r.variant)).toEqual(['A', 'B']);
      const pick = await apiRequest(app, `${prefix}/groups/old-group/pick`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: records[0]!.id }) });
      expect(pick.status).toBe(410);
      expect((await pick.json() as { error: string }).error).toMatch(retired);
    }
    for (const record of records) {
      expect(store.getRun(record.id)).toEqual(record);
      expect(existsSync(record.worktreePath!)).toBe(true);
      expect(readFileSync(join(record.worktreePath!, 'diff.txt'), 'utf8')).toBe(`retained ${record.variant}`);
    }
    expect(manager.cancel).not.toHaveBeenCalled();
  });

  it.each(['github', 'schedule'] as const)('retains a saved %s template but refuses to launch its candidates', async kind => {
    const definition = automationDefinitionSchema.parse({
      id: 'legacy', revision: 1, name: 'Legacy', enabled: true, kind,
      ...(kind === 'github' ? { events: ['issue.opened'] } : { schedule: { type: 'daily', hour: 4 } }),
      task: { prompt: 'Compare', variants: 2, workflow: 'quick-task' },
      createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    });
    const automations = AutomationStore.open(join(root, '.ai/cezar'));
    automations.create(definition, definition.id);
    expect(AutomationStore.open(join(root, '.ai/cezar')).get(definition.id)?.task.variants).toBe(2);
    const launch = kind === 'github'
      ? launchAutomationRun({ root, manager, store, definition: definition as GithubAutomationDefinition, receiptId: 'legacy-receipt', candidate: { eventId: 'e', event: 'issue.opened', timestamp: '2026-10-23T00:00:00.000Z', tieBreaker: 'I', repo: 'acme/demo', nodeId: 'I_1', number: 7, title: 'Work', url: 'https://github.com/acme/demo/issues/7', author: 'alice', assignees: [], labels: [] } })
      : launchScheduledRun({ root, manager, store, definition: definition as ScheduleAutomationDefinition, receiptId: 'legacy-receipt', occurrence: { at: '2026-10-23T04:00:00.000Z', trigger: 'schedule' }, projectName: 'demo', timeZone: 'UTC' });
    await expect(launch).rejects.toThrow(retired);
    expect(startRun).not.toHaveBeenCalled();
    expect(startVariants).not.toHaveBeenCalled();
  });
});
