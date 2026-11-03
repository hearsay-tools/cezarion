import { openTestRunStore, readPersistedRuns, seedRuns } from '../runs/run-store.testkit.ts';
import { createFixtureManager } from '../workflows/fixture-cleanup.testkit.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { provisionWorkflowFixture, until, PROVISION_ROWS } from './provision-workflows.testkit.ts';

// Git worktrees + a live RunManager contend under full-suite workers. until() is already 15s;
// the default 5s testTimeout / 10s hookTimeout cannot finish those waits. Teardown still cancels
// and finishes sessions without polling, then waits for owned work before removing the fixture.
describe('manager session delegation lifecycle', { timeout: 15_000 }, () => {
  const context = provisionWorkflowFixture();
  let f: typeof context.f, controller: typeof context.controller;
  const { sessions, recoveredManagers, recoveredStores, acceptIdentityWorker, launchAccepted } = context;
  beforeEach(() => { f = context.f; controller = context.controller; });

  it.each(PROVISION_ROWS.workflowGrants)('pins accepted $allowedTools grants across $damage workflow on $mode', async ({ mode, damage, allowedTools }) => {
    const grants = { allowedTools, bashAllowlist: ['git status'] };
    const a = await acceptIdentityWorker(undefined, grants);
    if (mode === 'continue') {
      await launchAccepted(a, mode); await until(() => sessions.length === 2);
      sessions[1]!.finish(); expect(await f.manager.awaitRunTermination(a.child.workerId, 15000)).toBe(true);
    }
    // Simulate exactly the public on-disk salvage boundary, keeping private identity intact.
    f.store.flush(); const dataDir = join(f.root, '.ai/cezar');
    const records = readPersistedRuns(dataDir);
    const record = records.find((r: { id: string }) => r.id === a.child.workerId)!;
    if (damage === 'missing') delete record.workflowDef;
    else if (damage === 'malformed') record.workflowDef.name = 42;
    else record.workflowDef.steps = [{ id: 'different', prompt: '{{task}}' }];
    f.store.close(); // a restart: the old store must not still own the family it reloads
    seedRuns(dataDir, records);
    f.manager.dispose(); sessions[0]!.finish();
    const store = openTestRunStore(join(f.root, '.ai/cezar'), { keepLive: true });
    const manager = createFixtureManager(store, f.root); recoveredManagers.push(manager); recoveredStores.push(store);
    // Keep root live without restarting its old session; this case concerns only the worker.
    store.updateRun(a.parent.id, { status: RUN_STATUS.waiting });
    controller.attachProject({ id: 'grants-reopened', root: f.root, store, manager });
    if (mode === 'continue') expect(manager.continueRun(a.child.workerId, { text: 'again' }).ok).toBe(true);
    else await manager.recover();
    await until(() => sessions.length === (mode === 'continue' ? 3 : 2));
    expect(sessions.at(-1)!.spec.toolGrant).toEqual({ kind: 'inherited', tools: grants.allowedTools, bashAllowlist: grants.bashAllowlist });
  });

  it.each(PROVISION_ROWS.privateGrants)('refuses $damage private accepted grants on $mode', async ({ mode, damage }) => {
    const a = await acceptIdentityWorker(undefined, { allowedTools: [], bashAllowlist: [] });
    if (mode === 'continue') {
      await launchAccepted(a, mode); await until(() => sessions.length === 2);
      sessions[1]!.finish(); expect(await f.manager.awaitRunTermination(a.child.workerId, 15000)).toBe(true);
    }
    const path = join(f.root, '.ai/cezar/runs', `${a.child.workerId}.identity.json`);
    const identity = JSON.parse(readFileSync(path, 'utf8'));
    if (damage === 'missing') delete identity.grants; else identity.grants = { allowedTools: 'Read' };
    writeFileSync(path, JSON.stringify(identity));
    if (mode === 'continue') expect(f.manager.continueRun(a.child.workerId, { text: 'again' })).toMatchObject({ ok: false, error: expect.stringContaining('identity') });
    else {
      const { store } = await launchAccepted(a, mode);
      await until(() => store.getRun(a.child.workerId)?.status === 'failed' || sessions.length > 1);
      expect(store.getRun(a.child.workerId)).toMatchObject({ status: RUN_STATUS.failed, error: expect.stringContaining('identity') });
    }
    expect(sessions).toHaveLength(mode === 'continue' ? 2 : 1);
  });

});
