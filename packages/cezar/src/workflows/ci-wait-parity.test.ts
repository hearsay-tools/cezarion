import { describe, expect, it, vi } from 'vitest';
import type { CiWaitResult } from '@open-mercato/cezar-contract';
import { CiToolController } from '../ci-wait/controller.ts';
import { CiWatcherSupervisor } from '../ci-wait/supervisor.ts';
import { manager, store, restart, until, useWorkerWaitFixture } from './worker-wait.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';

// hearsay-tools/cezarion#1233: CI waits live in the run's wait list; a parked one is an open wait
// on a waiting run.
const ciWaitOf = (id: string) => store.getRun(id)?.waits?.find(entry => entry.kind === 'pr');
const lastCiWaitOf = (id: string) => [...(store.getRun(id)?.lastWaits ?? [])].reverse().find(entry => entry.kind === 'pr');
const parked = (id: string) => ciWaitOf(id)?.phase === 'open' && store.getRun(id)?.status === 'waiting';

// The production controller, bundled tool, runner, store and scheduler remain real.
// Only the external CI completion time is controlled; metadata uses the dry-run gh process.
describe('CI tool registration and scheduled delivery across harnesses', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  const cases = (['claude', 'codex', 'opencode', 'pi', 'cursor', 'omp'] as const).flatMap(runner =>
    (['fresh', 'continued', 'recovered'] as const).map(mode => ({ runner, mode })));
  it.each(cases)('$runner $mode parks from a real tool call and resumes with one observation', async ({ runner, mode }) => {
    let settle!: (result: CiWaitResult) => void;
    const observation = new Promise<CiWaitResult>(resolve => { settle = resolve; });
    const provision = vi.spyOn(CiToolController.prototype, 'provision');
    const watch = vi.spyOn(CiWatcherSupervisor.prototype, 'watch').mockReturnValue(observation);
    try {
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:ci-wait https://github.com/acme/repo/pull/12', runner });
      await until(() => parked(run.id));
      const firstWait = ciWaitOf(run.id)!;
      if (mode === 'continued') {
        const state = (manager as unknown as { active: Map<string, { session: { end(): void } }> }).active.get(run.id)!;
        state.session.end();
        await until(() => !manager.isActive(run.id));
        const boundaries = store.readEvents(run.id).filter(event => event.type === 'turn-end').length;
        expect(manager.continueRun(run.id, { text: 'mock:ci-wait https://github.com/acme/repo/pull/12' }).ok).toBe(true);
        await until(() => parked(run.id) && store.readEvents(run.id).filter(event => event.type === 'turn-end').length > boundaries);
        // hearsay-tools/cezarion#1233: the wait outlives its session, and the continuation's
        // registration for the same PR returns it.
        expect(ciWaitOf(run.id)?.id).toBe(firstWait.id);
      } else if (mode === 'recovered') {
        await restart();
        expect(manager.isActive(run.id)).toBe(false);
        expect(ciWaitOf(run.id)?.id).toBe(firstWait.id);
      }
      const wait = ciWaitOf(run.id)!;
      expect(store.getRun(run.id)).toMatchObject({ status: 'waiting' });
      expect(store.getRun(run.id)?.delegation).toBeUndefined();
      expect(store.getRun(run.id)?.waits?.some(entry => entry.kind === 'timer')).toBeFalsy();
      settle({ outcome: 'passed', headSha: wait.headSha, observedAt: new Date().toISOString(),
        checks: [{ name: 'build', state: 'SUCCESS', link: '' }], totalChecks: 1, truncated: false });
      await until(() => !!lastCiWaitOf(run.id)?.deliveredAt);
      expect(store.getRun(run.id)?.agentInputs?.filter(input => input.id === wait.id)).toHaveLength(1);
      expect(ciWaitOf(run.id)).toBeUndefined();
      if (mode !== 'fresh') {
        const descriptors = provision.mock.results.filter(result => result.type === 'return').map(result => result.value.descriptor.name);
        expect(descriptors.length).toBeGreaterThanOrEqual(2);
        expect(new Set(descriptors).size).toBe(descriptors.length);
      }
    } finally { watch.mockRestore(); provision.mockRestore(); }
  });
});
