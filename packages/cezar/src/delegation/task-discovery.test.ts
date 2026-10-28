import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixture } from './service.testkit.ts';
import { discoveredTasksSchema } from '@open-mercato/cezar-contract/discovery';

describe('peer discovery lifecycle', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => { vi.stubEnv('CEZ_DELEGATION', '1'); f = fixture(); });
  afterEach(async () => { await f.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  const create = () => f.store.createRun({ title: 'peer', task: 'peer', workflow: 'quick-task', steps: [] });
  const tasks = async () => discoveredTasksSchema.parse(await f.service.discover(f.caller, { kind: 'tasks' })).tasks;
  it.each([
    ['queued', true], ['running', true], ['waiting', true], ['review', false], ['done', false], ['failed', false], ['cancelled', false],
  ] as const)('reports %s admission without an active session', async (status, accepts) => {
    const run = create(); f.store.updateRun(run.id, { status });
    expect(await tasks()).toEqual([expect.objectContaining({ id: run.id, status, accepts })]);
  });
  it('refuses stopping and finishing peers and omits deletion-pending roots', async () => {
    const stopping = create(); f.store.updateRun(stopping.id, { status: 'running', stopping: true });
    const finishing = create(); f.store.updateRun(finishing.id, { status: 'waiting', delegation: { role: 'root', permissions: [], receipts: [], finishRequestedAt: new Date().toISOString() } });
    const deleting = create(); f.store.updateRun(deleting.id, { delegation: { role: 'root', permissions: [], receipts: [], historyDeletion: 'pending' } });
    const list = await tasks();
    expect(list.map(run => run.id)).not.toContain(deleting.id);
    expect(list).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: stopping.id, accepts: false, reason: 'stopping: only its human can continue it' }),
      expect.objectContaining({ id: finishing.id, accepts: false, reason: 'finishing: only its human can continue it' }),
    ]));
  });
  it('uses only the authenticated project store and needs no spawn permission or host discovery', async () => {
    const other = fixture();
    const unregister = f.service.registerProject({ id: 'other', root: other.root, store: other.store, manager: other.manager });
    try {
      const run = create();
      f.store.updateRun(f.parent.id, { delegation: { role: 'root', permissions: [], receipts: [] } });
      expect((await tasks()).map(task => task.id)).toEqual([run.id]);
      const token = f.credentials.issue('other', other.parent.id, randomUUID());
      expect(discoveredTasksSchema.parse(await f.service.discover(f.credentials.authenticate(token)!, { kind: 'tasks' })).tasks).toEqual([]);
    } finally { unregister(); await other.close(); }
  });
});
