import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeRunRecord, RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { discoveredTasksSchema } from '@open-mercato/cezar-contract/discovery';
import { RunDatabase } from '../runs/run-database.ts';
import { encodeRunRow } from '../runs/run-row.ts';
import { fixture } from './service.testkit.ts';

describe('bounded peer discovery pages', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => { vi.stubEnv('CEZ_DELEGATION', '1'); f = fixture(); });
  afterEach(async () => { await f.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  const tasks = async (all = false, offset = 0) => discoveredTasksSchema.parse(await f.service.discover(f.caller, { kind: 'tasks', all, offset }));

  it('does not materialize archived history for the default page or later all-history pages', async () => {
    const db = RunDatabase.open(join(f.root, '.ai/cezar/runs.db'));
    try {
      const records = Array.from({ length: 5040 }, (_, index) => makeRunRecord({
        id: randomUUID(), title: `History ${index}`, status: RUN_STATUS.done, archived: index >= 40,
        createdAt: new Date(Date.UTC(2020, 0, 1) + index * 1000).toISOString(),
      }));
      db.transaction({ upserts: records.map(run => encodeRunRow(run)), deletes: [] });
      const fullScan = vi.spyOn(RunDatabase.prototype, 'listSummaries');
      const read = vi.spyOn(f.store, 'getRun');
      const first = await tasks();
      expect(first.tasks).toHaveLength(32); expect(first.nextOffset).toBe(32);
      expect(first.tasks.every(task => records.find(run => run.id === task.id)?.archived === false)).toBe(true);
      expect(fullScan).not.toHaveBeenCalled();
      expect(read.mock.calls.length).toBeLessThanOrEqual(33);
      const second = await tasks(false, 32);
      expect(second.tasks).toHaveLength(8); expect(second.nextOffset).toBeUndefined();
      expect(new Set([...first.tasks, ...second.tasks].map(task => task.id)).size).toBe(40);
      const pageRead = vi.spyOn(RunDatabase.prototype, 'listPeerSummaries');
      const archived = await tasks(true, 4000);
      expect(archived.tasks).toHaveLength(32); expect(archived.nextOffset).toBe(4032);
      expect(pageRead.mock.results[0]!.value).toHaveLength(33);
      expect(pageRead).toHaveBeenCalledWith(expect.objectContaining({ offset: 4000, limit: 33 }));
      const last = await tasks(true, 5024);
      expect(last.tasks).toHaveLength(16); expect(last.nextOffset).toBeUndefined();
      expect(fullScan).not.toHaveBeenCalled();
    } finally { db.close(); }
  });

  it('keeps held roots in their proper rank without duplicating their stored rows', async () => {
    const db = RunDatabase.open(join(f.root, '.ai/cezar/runs.db'));
    try {
      const records = Array.from({ length: 70 }, (_, index) => makeRunRecord({ id: randomUUID(), createdAt: new Date(Date.UTC(2020, 0, 1) + index * 2000).toISOString() }));
      db.transaction({ upserts: records.map(run => encodeRunRow(run)), deletes: [] });
      for (const index of [0, 3, 25, 42, 65]) {
        const run = f.store.createRun({ title: `Held ${index}`, task: 'hold', workflow: 'quick-task', steps: [] });
        f.store.updateRun(run.id, { createdAt: new Date(Date.UTC(2020, 0, 1) + index * 2000 + 1000).toISOString() });
      }
      const expected = f.store.listRunSummaries().runs.filter(run => run.id !== f.parent.id).map(run => run.id);
      const actual = [];
      for (let offset = 0; offset < expected.length; offset += 32) actual.push(...(await tasks(false, offset)).tasks.map(run => run.id));
      expect(actual).toEqual(expected);
      expect(new Set(actual).size).toBe(expected.length);
    } finally { db.close(); }
  });
});
