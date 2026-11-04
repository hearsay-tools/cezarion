

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const { sessions, acceptIdentityWorker, launchAccepted } = context;
  beforeEach(() => { f = context.f; controller = context.controller; });

  it.each(PROVISION_ROWS.inputRecipes)('rejects lost accepted input recipes on %s', async mode => {
    const a = await acceptIdentityWorker(undefined, undefined, { context: { text: 'accepted context' } });
    if (mode === 'continue') {
      await launchAccepted(a, mode); await until(() => sessions.length === 2);
      sessions[1]!.finish(); expect(await f.manager.awaitRunTermination(a.child.workerId, 15000)).toBe(true);
    }
    const worker = f.store.getRun(a.child.workerId)!;
    if (worker.delegation?.role !== 'worker') throw Error('worker');
    const { context: _context, ...delegation } = worker.delegation;
    f.store.commitDelegation([{ id: worker.id, delegation }]);
    if (mode === 'continue') expect(f.manager.continueRun(worker.id, { text: 'again' })).toMatchObject({ ok: false, error: expect.stringContaining('context') });
    else {
      const { store } = await launchAccepted(a, mode);
      await until(() => store.getRun(worker.id)?.status === 'failed' || sessions.length > 1);
      expect(store.getRun(worker.id)).toMatchObject({ status: RUN_STATUS.failed, error: expect.stringContaining('context') });
    }
    expect(sessions).toHaveLength(mode === 'continue' ? 2 : 1);
  });
  it.each(PROVISION_ROWS.contextArtifacts)('verifies or rebuilds explicit context with $damage on $mode', async ({ mode, damage }) => {
    let original = '';
    const a = await acceptIdentityWorker(undefined, undefined, { context: { artifacts: [{ kind: 'parent-attachment', id: 'document.txt' }] } }, parentId => {
      const dir = join(f.root, '.ai/cezar/runs', `${parentId}-images`); mkdirSync(dir);
      original = join(dir, 'document.txt'); writeFileSync(original, 'accepted document');
    });
    const inspected = await controller.service.inspect(a.caller, { workerId: a.child.workerId });
    const copy = inspected.inputs![0]!.path;
    if (mode === 'continue') {
      await launchAccepted(a, mode); await until(() => sessions.length === 2);
      sessions[1]!.finish(); expect(await f.manager.awaitRunTermination(a.child.workerId, 15000)).toBe(true);
    }
    if (damage === 'original-deleted') rmSync(original);
    else { rmSync(copy); if (damage === 'both-changed') writeFileSync(original, 'replaced document'); }
    let store = f.store;
    if (mode === 'continue') expect(f.manager.continueRun(a.child.workerId, { text: 'again' }).ok).toBe(true);
    else ({ store } = await launchAccepted(a, mode));
    const expectedSessions = mode === 'continue' ? 3 : 2;
    if (damage === 'both-changed') {
      await until(() => store.getRun(a.child.workerId)?.status === 'failed' || sessions.length === expectedSessions);
      expect(store.getRun(a.child.workerId)).toMatchObject({ status: RUN_STATUS.failed, error: expect.stringContaining('context input') });
      expect(sessions).toHaveLength(expectedSessions - 1);
    } else {
      await until(() => sessions.length === expectedSessions);
      expect(readFileSync(copy, 'utf8')).toBe('accepted document');
    }
  });
});
