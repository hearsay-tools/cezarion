import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { readPersistedRuns } from '../runs/run-store.testkit.ts';
import { manager, store, root, until, useWorkerWaitFixture } from './worker-wait.testkit.ts';
import { messagesPrompt } from './monitoring-turn.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';

// hearsay-tools/cezarion#1540: completion controls run on every native wire, fresh and Continue.
describe('task completion controls on native harnesses', { timeout: 40_000 }, () => {
  useWorkerWaitFixture();
  for (const runner of RUNNER_IDS) {
    it(`${runner} R100 archives only Done, restores on Continue, and archives the next Done`, async () => {
      process.env.CEZ_DRY_RUN = '0';
      process.env[HARNESS_ADAPTERS[runner].binEnv] = HARNESS_ADAPTERS[runner].mockBin;
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios.baseline!, archiveWhenDone: true });
      await until(() => store.getRun(run.id)?.status === 'waiting');
      expect(store.getRun(run.id)?.archived).toBe(false);
      const done = messagesPrompt(runner, ['All done.\nCEZ:DONE']);
      expect(manager.sendMessage(run.id, [{ type: 'text', text: done }])).toBe(true);
      await until(() => store.getRun(run.id)?.status === 'done' && !manager.isActive(run.id));
      expect(readPersistedRuns(join(root, '.ai/cezar')).find(row => row.id === run.id)).toMatchObject({ status: 'done', archived: true });
      expect(manager.continueRun(run.id, { text: HARNESS_ADAPTERS[runner].scenarios.baseline! }).ok).toBe(true);
      await until(() => store.getRun(run.id)?.status === 'waiting');
      expect(store.getRun(run.id)?.archived).toBe(false);
      expect(manager.sendMessage(run.id, [{ type: 'text', text: done }])).toBe(true);
      await until(() => store.getRun(run.id)?.status === 'done' && !manager.isActive(run.id));
      expect(store.getRun(run.id)?.archived).toBe(true);
    });
    it(`${runner} R101 records merge intent before archiving, while defaults stay off`, async () => {
      process.env.CEZ_DRY_RUN = '0';
      process.env[HARNESS_ADAPTERS[runner].binEnv] = HARNESS_ADAPTERS[runner].mockBin;
      for (const enabled of [false, true]) {
        const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios.done!,
          ...(enabled ? { archiveWhenDone: true, autoMergePr: true } : {}) });
        await until(() => store.getRun(run.id)?.status === 'done' && !manager.isActive(run.id));
        const row = readPersistedRuns(join(root, '.ai/cezar')).find(row => row.id === run.id);
        expect(row.archived).toBe(false);
        if (enabled) expect(row.completionAction).toMatchObject({ phase: 'pending' });
        else expect(row.completionAction).toBeUndefined();
      }
    });
  }
});
