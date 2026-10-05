import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, describe } from 'vitest';
import { deriveAttention, type ApiRun } from '@open-mercato/cezar-contract';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { CredentialRegistry } from '../delegation/credentials.ts';
import { DelegationService } from '../delegation/service.ts';
import { attentionFields, projectStatus } from '../task-cli/projections.ts';
import { endsWait } from '../task-cli/watch.ts';
import { TaskWebhook, type TaskWebhookPayload } from '../runs/webhook.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { manager, store, root, worker, until, semaphore, useWorkerWaitFixture, register, waitOf, restart, eventCheckpoint } from './worker-wait.testkit.ts';
import { MONITORING_TURN_CRITERIA, messagesPrompt, MONITORING_TEXT, ACK_TEXT, ASK_TEXT, REJECTED_ASK_TEXT } from './monitoring-turn.testkit.ts';

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
        if (row.id === 'M16' || row.id === 'M25') {
          store.commitDelegation([{ id: p.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
          const w = await worker(p.id);
          process.env.CEZ_CLAUDE_BIN = HARNESS_ADAPTERS.claude.mockBin;
          manager.enqueueOwnedRun(w.id);
          await until(() => store.getRun(w.id)?.status === 'waiting');
          let acceptedWaitId = '';
          await send([MONITORING_TEXT, ...(row.id === 'M25' ? [ASK_TEXT, REJECTED_ASK_TEXT, ACK_TEXT] : ['Please review the changes before I continue.'])], () => {
            acceptedWaitId = register(p.id, [w.id]).id;
            expect(waitOf(run())?.phase).toBe('registered');
          });
          attention('needs you', true);
          expect(run().hasPendingHumanAsk).not.toBe(true);
          expect(store.readEvents(p.id).filter(event => event.type === 'ask.requested')).toHaveLength(0);
          const gateSeq = store.readEvents(p.id).filter(event => event.type === 'note' && event.code === 'unstructured-human-gate').at(-1)!.seq;
          if (row.id === 'M25') {
            expect(run().invalidAsk).toBe(true);
            expect(store.readEvents(p.id).some(event => event.type === 'text' && String(event.text).includes(REJECTED_ASK_TEXT))).toBe(true);
          }
          const timer = manager['active'].get(p.id)!.idleTimer! as NodeJS.Timeout & { _onTimeout(): void };
          const expire = timer._onTimeout; clearTimeout(timer); expire();
          await until(() => !manager.isActive(p.id));
          expect(run().status).toBe('waiting');
          expect(run().error).toBeUndefined();
          expect(store.getRun(w.id)?.status).toBe('waiting');
          expect(manager.isActive(w.id)).toBe(true);
          expect(waitOf(run())).toBeUndefined();
          expect(run().agentInputs?.some(input => input.id === acceptedWaitId)).not.toBe(true);
          const credentials = new CredentialRegistry();
          const service = new DelegationService();
          service.registerProject({ id: 'project', root, store, manager });
          const id = randomUUID();
          try {
            const caller = credentials.authenticate(credentials.issue('project', w.id, randomUUID()))!;
            await service.send(caller, { id, recipientRunId: p.id, kind: 'progress',
              text: messagesPrompt(backend, [MONITORING_TEXT, ACK_TEXT]), timeoutSeconds: 600 });
            expect(run().agentInputs?.find(input => input.id === id)?.deliveredAt).toBeUndefined();
            attention('needs you', true);
          } finally { credentials.close(); }
          const events = eventCheckpoint();
          hook.dispose(); // restart replaces the fixture store
          await restart(false, undefined, events);
          attention('needs you', true);
          expect(manager.isActive(p.id)).toBe(false);
          expect(waitOf(run())).toBeUndefined();
          expect(run().agentInputs?.find(input => input.id === id)?.deliveredAt).toBeUndefined();
          expect(store.getRun(w.id)?.status).not.toBe('cancelled');
          expect(manager.continueRun(p.id, { text: messagesPrompt(backend, [MONITORING_TEXT, ACK_TEXT]) }).ok).toBe(true);
          await until(() => run().activity === 'monitoring');
          attention('monitoring', false);
          expect(store.readEvents(p.id).some(event => event.type === 'human-input-delivered' && event.askSeq === gateSeq)).toBe(true);
          expect(run().invalidAsk).not.toBe(true);
          expect(run().agentInputs?.find(input => input.id === id)?.deliveredAt).toBeDefined();
        } else if (row.id === 'M1') {
          await send([MONITORING_TEXT, ACK_TEXT]);
          attention('monitoring', false);
          expect(run().monitoringWakeAt).toBeDefined();
          const timer = manager['active'].get(p.id)!.monitoringWakeTimer! as NodeJS.Timeout & { _onTimeout(): void };
          expect(timer).toBeDefined();
          const expire = timer._onTimeout; clearTimeout(timer); expire();
          await until(() => store.readEvents(p.id).some(event => event.type === 'note' && String(event.message).includes('automatic monitoring wake-up (1/')));
          await until(() => run().status === 'waiting'); // mock wake response has no declaration
          attention('needs you', true);
        } else if (row.id === 'M15') {
          for (const gate of ['### Should I merge this PR?', '- [ ] Please review the changes before I continue.', '- Should I merge this PR?', '**Please review the changes before I continue.**', '1. __I need your approval before proceeding.__', '*Should I merge this PR?* Please let me know.']) {
            await send([MONITORING_TEXT, gate]);
            attention('needs you', true);
            expect(run().monitoringWakeAt).toBeUndefined();
          }
        } else if (row.id === 'M12') {
          await send(['Should I merge this PR?', 'That step is approved; the load campaign is still running.\nCEZ:MONITORING', ACK_TEXT]);
          attention('monitoring', false);
          expect(run().monitoringWakeAt).toBeDefined();
        } else if (row.id === 'M11') {
          await send([MONITORING_TEXT, ACK_TEXT + '\nWhat changed?\nThe startup checks now record diagnostics.\n> - Should I merge this PR?\n> **Please review the changes.**\n```text\n**I need your approval.**\n```\n**Example:**\n- Should I merge this PR?\nThe review checks are approved.']);
          attention('monitoring', false);
          expect(run().monitoringWakeAt).toBeDefined();
        } else if (row.id === 'M2' || row.id === 'M3') {
          for (const gate of row.id === 'M2' ? ['Should I merge this PR?', 'The checks passed. Do you want me to merge?', 'Which module?', 'Is this okay?'] : ['Please review the changes before I continue.', 'The checks passed. I need your approval before proceeding.', 'The PR is ready for your review.']) {
            await send([MONITORING_TEXT, gate]);
            attention('needs you', true);
          }
          expect(run().hasPendingHumanAsk).not.toBe(true);
          expect(run().monitoringWakeAt).toBeUndefined();
        } else if (row.id === 'M24') {
          for (const messages of [[MONITORING_TEXT, REJECTED_ASK_TEXT], [MONITORING_TEXT, ASK_TEXT, REJECTED_ASK_TEXT, ACK_TEXT], [MONITORING_TEXT, REJECTED_ASK_TEXT, ACK_TEXT, MONITORING_TEXT], [MONITORING_TEXT, 'CEZ:ASK {', ACK_TEXT]]) {
            const before = store.readEvents(p.id).at(-1)!.seq;
            await send(messages);
            const turnEvents = store.readEvents(p.id).filter(event => event.seq > before);
            attention('needs you', true);
            expect(run().invalidAsk).toBe(true);
            expect(run().hasPendingHumanAsk).not.toBe(true);
            expect(run().monitoringWakeAt).toBeUndefined();
            expect(store.readEvents(p.id).filter(event => event.type === 'ask.requested')).toHaveLength(0);
            expect(turnEvents.some(event => event.type === 'text' && String(event.text).includes(messages.includes(REJECTED_ASK_TEXT) ? REJECTED_ASK_TEXT : 'CEZ:ASK {'))).toBe(true);
            expect(turnEvents.some(event => event.type === 'note' && event.tone === 'danger')).toBe(true);
          }
          // The latest valid declaration replaces a rejected payload.
          await send([MONITORING_TEXT, REJECTED_ASK_TEXT, ASK_TEXT, ACK_TEXT]);
          attention('needs you', true);
          expect(run().invalidAsk).not.toBe(true);
          expect(run().hasPendingHumanAsk).toBe(true);
          expect(store.readEvents(p.id).filter(event => event.type === 'ask.requested')).toHaveLength(1);
        } else if (row.id === 'M22') {
          const malformed = 'CEZ:ASK {"questions":[]}';
          await send([ASK_TEXT, malformed]);
          attention('needs you', true);
          expect(run().hasPendingHumanAsk).not.toBe(true);
          expect(run().invalidAsk).toBe(true);
          expect(store.readEvents(p.id).filter(event => event.type === 'ask.requested')).toHaveLength(0);
          expect(store.readEvents(p.id).some(event => event.type === 'note' && event.tone === 'danger' && String(event.message).includes('payload failed validation'))).toBe(true);
          expect(store.readEvents(p.id).some(event => event.type === 'text' && String(event.text).includes(malformed))).toBe(true);
        } else if (row.id === 'M20') {
          for (const example of [`> ${REJECTED_ASK_TEXT}`, `Example:\n${REJECTED_ASK_TEXT}`, `\`\`\`text\n${REJECTED_ASK_TEXT}\n\`\`\``, `> ${ASK_TEXT}`, `\`\`\`text\n${ASK_TEXT}\nCEZ:DONE\n\`\`\``, `Example:\n${ASK_TEXT}`, 'Example:\nCEZ:DONE', `    ${ASK_TEXT}`, '    CEZ:DONE']) {
            await send([MONITORING_TEXT, example, ACK_TEXT]);
            attention('monitoring', false);
            expect(run().hasPendingHumanAsk).not.toBe(true);
            expect(store.readEvents(p.id).filter(event => event.type === 'ask.requested')).toHaveLength(0);
            expect(run().invalidAsk).not.toBe(true);
            expect(store.readEvents(p.id).some(event => event.type === 'note' && event.tone === 'danger')).toBe(false);
          }
          // Examples at the final line remain inert too.
          for (const example of [`Example:\n${ASK_TEXT}`, 'Example:\nCEZ:DONE']) {
            await send([MONITORING_TEXT, example]);
            attention('monitoring', false);
            expect(run().hasPendingHumanAsk).not.toBe(true);
          }
        } else if (row.id === 'M4' || row.id === 'M7' || row.id === 'M18') {
          if (row.id === 'M18') {
            for (const messages of [[MONITORING_TEXT, ASK_TEXT, ACK_TEXT], [MONITORING_TEXT, 'CEZ:DONE', ASK_TEXT, ACK_TEXT], [MONITORING_TEXT, ASK_TEXT, ACK_TEXT, MONITORING_TEXT],
              [MONITORING_TEXT, `Example:\n\`\`\`text\n${ASK_TEXT}\n\`\`\``, ASK_TEXT, ACK_TEXT],
              [MONITORING_TEXT, `Example:\n> ${ASK_TEXT}`, ASK_TEXT, ACK_TEXT],
              [MONITORING_TEXT, `Example:\n    ${ASK_TEXT}`, ASK_TEXT, ACK_TEXT]]) {
              await send(messages);
              attention('needs you', true);
              expect(run().hasPendingHumanAsk).toBe(true);
              expect(store.readEvents(p.id).filter(event => event.type === 'ask.requested').at(-1)?.questions).toEqual(JSON.parse(ASK_TEXT.slice('CEZ:ASK '.length)).questions);
              expect(store.readEvents(p.id).some(event => event.type === 'note' && event.code === 'unstructured-human-gate')).toBe(false);
            }
          } else await send([MONITORING_TEXT, ASK_TEXT]);
          attention('needs you', true);
          expect(run().hasPendingHumanAsk).toBe(true);
          if (row.id === 'M7' || row.id === 'M18') {
            const askSeq = store.readEvents(p.id).filter(event => event.type === 'ask.requested').at(-1)!.seq;
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
            expect(store.readEvents(p.id).some(event => event.type === 'human-input-delivered' && event.askSeq === askSeq)).toBe(true);
          }
        } else if (row.id === 'M5' || row.id === 'M19' || row.id === 'M21') {
          process.env.CEZ_REVIEW_GATE = '1';
          const cwd = run().worktreePath!;
          expect(cwd).toBeDefined();
          writeFileSync(join(cwd, 'review.txt'), 'review this change');
          execFileSync('git', ['add', 'review.txt'], { cwd });
          execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'review change'], { cwd });
          await send([MONITORING_TEXT, ...(row.id === 'M21' ? [ASK_TEXT] : []), 'Complete.\nCEZ:DONE', ...(row.id === 'M5' ? [] : [ACK_TEXT])]);
          expect(run().status).toBe('review');
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
        if (row.id !== 'M16' && row.id !== 'M25') expect(final.task.attentionLabel).toBe(deriveAttention(run()).label);
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

  it('fresh M17 genuine accepted-wait session loss still fails', async () => {
    process.env.CEZ_DRY_RUN = '0';
    process.env[HARNESS_ADAPTERS[backend].binEnv] = HARNESS_ADAPTERS[backend].mockBin;
    const p = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:hold', runner: backend });
    await until(() => store.getRun(p.id)?.status === 'waiting');
    store.commitDelegation([{ id: p.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
    const w = await worker(p.id);
    expect(manager.sendMessage(p.id, [{ type: 'text', text: messagesPrompt(backend, [MONITORING_TEXT, ACK_TEXT]) }])).toBe(true);
    register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    manager['active'].get(p.id)!.session!.end();
    await until(() => !manager.isActive(p.id));
    expect(store.getRun(p.id)).toMatchObject({ status: 'failed', error: 'step "task" failed: Agent session ended before its accepted worker wait completed' });
    expect(store.getRun(w.id)?.status).toBe('cancelled');
  });

  for (const mode of ['fresh', 'continuation'] as const) for (const rejected of [false, true]) it(`${mode} ${rejected ? 'M28 ordinary rejected ASK keeps the existing autonomous nudge policy' : 'M23 portable ASK followed by acknowledgement keeps the existing autonomous override'}`, async () => {
    process.env.CEZ_DRY_RUN = '0';
    process.env[HARNESS_ADAPTERS[backend].binEnv] = HARNESS_ADAPTERS[backend].mockBin;
    const prompt = messagesPrompt(backend, rejected ? [REJECTED_ASK_TEXT] : [MONITORING_TEXT, ASK_TEXT, ACK_TEXT]);
    const p = manager.startRun(QUICK_TASK_WORKFLOW, { task: mode === 'fresh' ? prompt : 'mock:hold', runner: backend, autonomous: mode === 'fresh' });
    if (mode === 'continuation') {
      await until(() => store.getRun(p.id)?.status === 'waiting');
      expect(manager.finish(p.id)).toBe(true);
      await until(() => !manager.isActive(p.id));
      store.updateRun(p.id, { autonomous: true });
      expect(manager.continueRun(p.id, { text: prompt }).ok).toBe(true);
    }
    await until(() => !manager.isActive(p.id));
    expect(store.getRun(p.id)?.status).toBe('done');
    expect(store.readEvents(p.id).some(event => event.type === 'note' && String(event.message).includes(rejected ? 'autonomous — continuing without pausing' : 'question overridden'))).toBe(true);
    expect(store.readEvents(p.id).some(event => event.type === 'note' && event.code === 'unstructured-human-gate')).toBe(false);
    expect(store.readEvents(p.id).filter(event => event.type === 'ask.requested' || event.type === 'human-input-delivered')).toHaveLength(0);
  });

});
