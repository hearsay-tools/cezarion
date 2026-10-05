import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, describe } from 'vitest';
import { deriveAttention, type ApiRun } from '@open-mercato/cezar-contract';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { attentionFields, projectStatus } from '../task-cli/projections.ts';
import { endsWait } from '../task-cli/watch.ts';
import { TaskWebhook, type TaskWebhookPayload } from '../runs/webhook.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { manager, store, root, worker, until, semaphore, useWorkerWaitFixture } from './worker-wait.testkit.ts';
import { MONITORING_TURN_CRITERIA, messagesPrompt, MONITORING_TEXT, ACK_TEXT, ASK_TEXT } from './monitoring-turn.testkit.ts';

for (const backend of RUNNER_IDS) describe(`${backend} monitoring turn`, { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  for (const mode of ['fresh', 'continuation'] as const) for (const row of MONITORING_TURN_CRITERIA) {
    it(`${mode} ${row.id} ${row.name}`, async () => {
      process.env.CEZ_DRY_RUN = '0';
      process.env[HARNESS_ADAPTERS[backend].binEnv] = HARNESS_ADAPTERS[backend].mockBin;
      const p = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:hold', runner: backend });
      await until(() => store.getRun(p.id)?.status === 'waiting');
      if (mode === 'continuation') {
        expect(manager.finish(p.id)).toBe(true);
        await until(() => !manager.isActive(p.id));
        expect(manager.continueRun(p.id, { text: 'mock:hold' }).ok).toBe(true);
        await until(() => store.getRun(p.id)?.status === 'waiting');
      }
      const run = () => store.getRun(p.id)!;
      const attention = (label: string, wants: boolean) => {
        const record = run();
        expect(deriveAttention(record).label).toBe(label);
        expect(endsWait({ id: p.id, status: record.status, ...attentionFields(record) }, 'attention')).toBe(wants);
        expect(projectStatus(record as unknown as ApiRun, 'http://localhost/task')).toMatchObject({ attentionLabel: label });
      };
      const send = async (messages: string[], afterDelivery?: () => void) => {
        const boundaries = store.readEvents(p.id).filter(event => event.type === 'turn-end').length;
        expect(manager.sendMessage(p.id, [{ type: 'text', text: messagesPrompt(backend, messages) }])).toBe(true);
        afterDelivery?.();
        await until(() => store.readEvents(p.id).filter(event => event.type === 'turn-end').length > boundaries && semaphore.busy() === 0);
      };
      if (row.id === 'M3' || row.id === 'M8') {
        store.commitDelegation([{ id: p.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [],
          ...(row.id === 'M8' ? { completion: { phase: 'attention' } } : {}) } }]);
        if (row.id === 'M3') await worker(p.id);
      }
      const calls: TaskWebhookPayload[] = [];
      const hook = new TaskWebhook(store, { dataDir: join(root, '.ai/cezar'), dryRun: false,
        resolveProject: async () => ({ id: 'project', webhook: { url: 'https://example.test/hook' } }), origin: () => 'http://localhost',
        fetch: (async (_url, init) => { calls.push(JSON.parse(String(init?.body))); return new Response(null, { status: 204 }); }) as typeof fetch,
      });
      store.updateRun(p.id, { notify: true });
      try {
        if (row.id === 'M1') {
          await send([MONITORING_TEXT, ACK_TEXT]);
          attention('monitoring', false);
          expect(run().monitoringWakeAt).toBeDefined();
          const timer = manager['active'].get(p.id)!.monitoringWakeTimer! as NodeJS.Timeout & { _onTimeout(): void };
          expect(timer).toBeDefined();
          const expire = timer._onTimeout; clearTimeout(timer); expire();
          await until(() => store.readEvents(p.id).some(event => event.type === 'note' && String(event.message).includes('automatic monitoring wake-up (1/')));
          await until(() => run().status === 'waiting'); // mock wake response has no declaration
          attention('needs you', true);
        } else if (row.id === 'M12') {
          await send(['Should I merge this PR?', 'That step is approved; the load campaign is still running.\nCEZ:MONITORING', ACK_TEXT]);
          attention('monitoring', false);
          expect(run().monitoringWakeAt).toBeDefined();
        } else if (row.id === 'M11') {
          await send([MONITORING_TEXT, ACK_TEXT + '\nWhat changed?\nThe startup checks now record diagnostics.\n> Should I merge this PR?\n> Please review the changes.\n```text\nI need your approval.\n```\nThe review checks are approved.']);
          attention('monitoring', false);
          expect(run().monitoringWakeAt).toBeDefined();
        } else if (row.id === 'M2' || row.id === 'M3') {
          for (const gate of row.id === 'M2' ? ['Should I merge this PR?', 'The checks passed. Do you want me to merge?', 'Which module?', 'Is this okay?'] : ['Please review the changes before I continue.', 'The checks passed. I need your approval before proceeding.', 'The PR is ready for your review.']) {
            await send([MONITORING_TEXT, gate]);
            attention('needs you', true);
          }
          expect(run().hasPendingHumanAsk).not.toBe(true);
          expect(run().monitoringWakeAt).toBeUndefined();
        } else if (row.id === 'M4' || row.id === 'M7') {
          await send([MONITORING_TEXT, ASK_TEXT]);
          attention('needs you', true);
          expect(run().hasPendingHumanAsk).toBe(true);
          if (row.id === 'M7') {
            const timer = manager['active'].get(p.id)!.idleTimer! as NodeJS.Timeout & { _onTimeout(): void };
            const expire = timer._onTimeout; clearTimeout(timer); expire();
            await until(() => !manager.isActive(p.id));
            expect(run().hasPendingHumanAsk).toBe(true);
            attention('needs you', true);
            expect(manager.continueRun(p.id, { text: messagesPrompt(backend, [MONITORING_TEXT, ACK_TEXT]) }).ok).toBe(true);
            await until(() => run().activity === 'monitoring' || run().status === 'waiting' && manager['active'].get(p.id)?.atTurnBoundary !== undefined);
            attention('monitoring', false);
            expect(run().hasPendingHumanAsk).not.toBe(true);
            expect(store.readEvents(p.id).some(event => event.type === 'human-input-delivered')).toBe(true);
          }
        } else if (row.id === 'M5') {
          process.env.CEZ_REVIEW_GATE = '1';
          const cwd = run().worktreePath!;
          expect(cwd).toBeDefined();
          writeFileSync(join(cwd, 'review.txt'), 'review this change');
          execFileSync('git', ['add', 'review.txt'], { cwd });
          execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'review change'], { cwd });
          await send([MONITORING_TEXT, 'Complete.\nCEZ:DONE']);
          await until(() => !manager.isActive(p.id));
          expect(run().status).toBe('review');
          attention('needs review', true);
        } else if (row.id === 'M6') {
          for (const example of ['Use `CEZ:MONITORING` in your reply.', '> CEZ:MONITORING', 'Example:\n```text\nCEZ:MONITORING\n```', 'Example:\n    CEZ:MONITORING', 'Example:\nCEZ:MONITORING']) {
            await send([example]);
            attention('needs you', true);
          }
        } else {
          await send([MONITORING_TEXT, ACK_TEXT], () => {
            store.commitDelegation([{ id: p.id, delegation: { role: 'root', permissions: [], receipts: [], completion: { phase: 'attention' } } }]);
          });
          attention('needs you', true);
        }
        await hook.idle();
        const final = calls.at(-1)!;
        expect(final.task.attentionLabel).toBe(deriveAttention(run()).label);
        if (row.id === 'M1') expect(calls.some(call => call.activity === 'monitoring' && call.task.attentionLabel === 'monitoring')).toBe(true);
      } finally { hook.dispose(); }
    });
  }
  for (const mode of ['fresh', 'continuation'] as const) it(`${mode} ${mode === 'fresh' ? 'M13' : 'M14'} ordinary markerless prose questions keep autonomous nudges`, async () => {
    process.env.CEZ_DRY_RUN = '0';
    process.env[HARNESS_ADAPTERS[backend].binEnv] = HARNESS_ADAPTERS[backend].mockBin;
    const prompt = messagesPrompt(backend, ['Should I merge this PR?']);
    const p = manager.startRun(QUICK_TASK_WORKFLOW, { task: mode === 'fresh' ? prompt : 'mock:hold', runner: backend, autonomous: mode === 'fresh' });
    if (mode === 'continuation') {
      await until(() => store.getRun(p.id)?.status === 'waiting');
      expect(manager.finish(p.id)).toBe(true);
      await until(() => !manager.isActive(p.id));
      store.updateRun(p.id, { autonomous: true });
      expect(manager.continueRun(p.id, { text: prompt }).ok).toBe(true);
    }
    await until(() => store.getRun(p.id)?.status === 'waiting' || !manager.isActive(p.id));
    expect(store.getRun(p.id)?.status).toBe('done');
    expect(store.readEvents(p.id).some(event => event.type === 'note' && String(event.message).includes('autonomous — continuing without pausing'))).toBe(true);
  });

});
