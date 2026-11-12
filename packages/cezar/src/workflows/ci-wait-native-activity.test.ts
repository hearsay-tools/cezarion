// Register the external CI mock before loading RunManager.
import { ciWaitOf, github, register, acquireExternalCiResources } from './ci-wait-fixture.testkit.ts';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';

import { manager, semaphore, store, until, useWorkerWaitFixture, work } from './worker-wait.testkit.ts';



describe('CI wait native activity', { timeout: 30_000 }, () => {
  useWorkerWaitFixture({ acquireCiResources: acquireExternalCiResources });
  afterEach(() => vi.restoreAllMocks());
  it.each(RUNNER_IDS)('%s resumes on native activity before CI admission', async runner => {
    github();
    process.env.CEZ_DRY_RUN = '0';
    const adapter = HARNESS_ADAPTERS[runner];
    process.env[adapter.binEnv] = adapter.mockBin;
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: adapter.scenarios.hold!, runner });
    await until(() => store.getRun(run.id)?.status === 'waiting');
    await register(run.id);
    const [session] = work.liveSessions;
    expect(work.liveSessions.size).toBe(1);
    // Counted from here: the no-wait nudge's turn came before the park (hearsay-tools/cezarion#1234).
    const started = () => store.readEvents(run.id).filter(event => event.type === 'turn.started').length;
    const before = started();
    // Resume the backend itself, bypassing the manager's human-input path.
    // Native frames resume the run; it works in the monitoring slot its park kept
    // (hearsay-tools/cezarion#1233), so no regular slot is charged.
    expect(session!.sendMessage([{ type: 'text', text: adapter.scenarios.hold! }])).toBe(true);
    await until(() => started() > before);
    expect(store.getRun(run.id)?.status).toBe('running');
    expect(semaphore.busy()).toBe(0);
    expect(ciWaitOf(run.id)?.phase).toBe('open');
  });
});
