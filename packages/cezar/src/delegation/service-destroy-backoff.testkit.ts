import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { scopeFixtureProcesses } from './process-scope.testkit.ts';

import { syncBuiltinESMExports } from 'node:module';

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import { afterEach, beforeEach, expect, onTestFinished, vi } from 'vitest';

import { fixture } from './service.testkit.ts';
import { ensureOwnedWorkspace } from './workspace.ts';

import { readableHolder } from './non-dumpable.testkit.ts';
import { workerDestroyView } from '../runs/delegation-state.ts';
import { workerCleanups } from './worker-cleanup.ts';

export let f: ReturnType<typeof fixture>;

export const linux = process.platform === 'linux';

export const input = () => ({ task: 'do work', baseline: 'parent-head', requestId: randomUUID() });

/** Each fixture receives its test cadence at construction. */
export const cadence = async (backoff = { fastMs: 40, fastCount: 3, capMs: 300 }, attention = 5) => {
    await f.close();
    f = fixture(workerCleanups({ backoff, attentionAttempts: attention }));
  };

/** A settled worker with a real worktree and complete execution, optionally held by a real process. */
export async function settled(hold = true) {
    const { workerId } = await f.service.spawn(f.caller, input());
    const generation = f.store.commitWorkerExecutionStart(workerId);
    const workspace = await ensureOwnedWorkspace(f.root, f.store.getRun(workerId)!);
    setRunStatus(f.store, workerId, RUN_STATUS.review, { worktreePath: workspace.path, branch: workspace.branch });
    expect(f.store.commitWorkerExecutionComplete(workerId, generation)).toBe(true);
    const holder = hold ? await readableHolder(workspace.path) : undefined;
    if (holder) onTestFinished(() => holder.close());
    return { workerId, workspace, holder };
  }

/** The destroy as the API shows it: the stored phase plus the run's retry state. */
export const destroyOf = (workerId: string) => { const run = f.store.getRun(workerId); return run ? workerDestroyView(run) : undefined; };

/** One `/proc` listing is one full holder scan; the fixture's process scope spies the listing. */
export const listings = () => vi.mocked(fs.readdirSync).mock.calls.filter(([path]) => path === '/proc').length;

export function useDestroyBackoffFixture() {
  beforeEach(() => { scopeFixtureProcesses(); f = fixture(); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); syncBuiltinESMExports(); vi.unstubAllEnvs(); });
}
