import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkerOperation } from '@open-mercato/cezar-contract';
import { isAuthenticatedCaller } from '../delegation/credentials.ts';
import { delegatingParent, parent, store, useWorkerWaitFixture } from './worker-wait.testkit.ts';

describe('service-ready worker-wait fixture (hearsay-tools/cezarion#1752)', () => {
  let original: string | undefined;
  beforeEach(() => { original = process.env.CEZ_DELEGATION; delete process.env.CEZ_DELEGATION; });
  // Registered before the fixture: its teardown restores the environment first.
  afterEach(() => {
    expect(process.env.CEZ_DELEGATION).toBeUndefined();
    if (original === undefined) delete process.env.CEZ_DELEGATION;
    else process.env.CEZ_DELEGATION = original;
  });
  useWorkerWaitFixture();

  it.each<{ permissions: WorkerOperation[] }>([{ permissions: [] }, { permissions: ['wait'] }, { permissions: ['spawn', 'wait', 'steer', 'inspect'] }])('opts in with exact permissions $permissions', async ({ permissions }) => {
    const f = await delegatingParent({ permissions });
    expect(process.env.CEZ_DELEGATION).toBe('1');
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

  it('keeps the low-level parent independent of the delegation opt-in', async () => {
    const p = await parent();
    expect(process.env.CEZ_DELEGATION).toBeUndefined();
    expect(store.getRun(p.id)?.delegation).toMatchObject({ role: 'root', permissions: ['spawn', 'wait'] });
  });
});
