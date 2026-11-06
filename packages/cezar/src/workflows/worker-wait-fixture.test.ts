import { describe, expect, it } from 'vitest';
import type { WorkerOperation } from '@open-mercato/cezar-contract';
import { isAuthenticatedCaller } from '../delegation/credentials.ts';
import { delegatingParent, parent, store, useWorkerWaitFixture } from './worker-wait.testkit.ts';

describe('service-ready worker-wait fixture (hearsay-tools/cezarion#1752)', () => {
  useWorkerWaitFixture();

  it.each<{ permissions: WorkerOperation[] }>([{ permissions: [] }, { permissions: ['wait'] }, { permissions: ['spawn', 'wait', 'steer', 'inspect'] }])('opts in with exact permissions $permissions', async ({ permissions }) => {
    const f = await delegatingParent({ permissions });
    expect(store.getRun(f.p.id)?.delegation).toMatchObject({ role: 'root', permissions });
    const caller = f.callerFor(f.p.id);
    expect(isAuthenticatedCaller(caller)).toBe(true);
    expect(f.callerFor(f.p.id)).toBe(caller);
    expect(caller).toMatchObject({ projectId: 'project', runId: f.p.id });
    if (permissions.includes('inspect')) expect(await f.service.list(caller)).toMatchObject({ workers: [] });
    else await expect(f.service.list(caller)).rejects.toMatchObject({ code: 'denied_scope' });
    f.close(); f.close();
    expect(isAuthenticatedCaller(caller)).toBe(false);
    expect(() => f.callerFor(f.p.id)).toThrow('closed');
    await expect(f.service.list(caller)).rejects.toMatchObject({ code: 'denied_scope' });
  });

  it('builds the low-level parent with spawn and wait only', async () => {
    const p = await parent();
    expect(store.getRun(p.id)?.delegation).toMatchObject({ role: 'root', permissions: ['spawn', 'wait'] });
  });
});
