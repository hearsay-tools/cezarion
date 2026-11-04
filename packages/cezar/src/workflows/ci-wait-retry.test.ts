// Register the external CI mock before loading RunManager.
import { success, ciWaitOf, lastCiWaitOf, github, register } from './ci-wait-fixture.testkit.ts';
import { runInternals } from './run-internals.testkit.ts';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';

import { manager, semaphore, store, until, useWorkerWaitFixture } from './worker-wait.testkit.ts';



describe('CI wait retry', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  afterEach(() => vi.restoreAllMocks());
  it('CI retry matrix covers every runner with a native hold scenario', () => {
    for (const runner of RUNNER_IDS) {
      expect(HARNESS_ADAPTERS[runner].mockBin).toBeTruthy();
      expect(HARNESS_ADAPTERS[runner].scenarios.hold).toBeDefined();
    }
  });

  it.each(RUNNER_IDS)('%s retries a refused settled CI observation without human input', async runner => {
    const external = github();
    process.env.CEZ_DRY_RUN = '0';
    const adapter = HARNESS_ADAPTERS[runner];
    process.env[adapter.binEnv] = adapter.mockBin;
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: adapter.scenarios.hold!, runner });
    await until(() => store.getRun(run.id)?.status === 'waiting');
    const receipt = await register(run.id);
    const engine = runInternals(manager);
    const session = engine.active.get(run.id)!.liveSession.session!;
    const send = vi.spyOn(session, 'sendAgentMessage').mockReturnValueOnce(false);
    external.settle(success());
    await until(() => send.mock.calls.length > 0);
    expect.soft(runInternals(manager).line.monitoring.has(run.id)).toBe(true);
    expect.soft(store.getRun(run.id)?.status).toBe('waiting');
    expect(store.getRun(run.id)?.agentInputs?.find(input => input.id === receipt.id)?.deliveredAt).toBeUndefined();
    expect.soft(semaphore.busy()).toBe(0); // The park's monitoring slot carries the wake.
    await until(() => !!lastCiWaitOf(run.id)?.deliveredAt);
    expect(ciWaitOf(run.id)).toBeUndefined();
    expect(store.getRun(run.id)?.agentInputs?.filter(input => input.id === receipt.id)).toHaveLength(1);
    expect(store.readEvents(run.id).filter(event => event.type === 'human-input-delivered')).toEqual([]);
  });
});
