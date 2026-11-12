import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSendRequest } from '@open-mercato/cezar-contract/conversations';
import { RUN_STATUS, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { RunRecord } from '../runs/store.ts';
import { RunStore } from '../runs/store.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { fixture } from './service.testkit.ts';
import { QUICK_TASK_WORKFLOW } from '../workflows/types.ts';
import { MESSAGING_OFF, WORKERS_OFF } from './policy.ts';
import { workerCleanups } from './worker-cleanup.ts';

// Per-task access (hearsay-tools/cezarion#2784): the human's two switches, read at every call.
describe('task access', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => { f = fixture(workerCleanups()); });
  afterEach(async () => {
    for (const run of f.store.listRuns()) if (f.manager.isActive(run.id)) f.manager.cancel(run.id);
    await f.close(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  });
  const spawnInput = () => ({ task: 'work', baseline: 'parent-head', requestId: randomUUID() });
  const access = (id: string, patch: Pick<RunRecord, 'allowWorkers' | 'allowMessaging'>) => f.store.updateRun(id, patch);
  const message = (recipientRunId: string, kind: ConversationSendRequest['kind'] = 'request', extra: Partial<ConversationSendRequest> = {}): ConversationSendRequest =>
    ({ id: randomUUID(), recipientRunId, kind, text: `${kind} text`, timeoutSeconds: 600, ...extra });
  function peer() {
    const run = f.store.createRun({ title: 'peer', task: 'peer', workflow: 'quick-task', runner: 'claude', steps: [], allowWorkers: true, allowMessaging: true });
    setRunStatus(f.store, run.id, RUN_STATUS.running, { delegation: { role: 'root', permissions: ['spawn', 'inspect', 'steer', 'stop', 'destroy', 'diff', 'wait'], receipts: [] } });
    return { id: run.id, caller: f.credentials.authenticate(f.credentials.issue('project', run.id, randomUUID()))! };
  }
  async function completedWorker() {
    const { workerId } = await f.service.spawn(f.caller, spawnInput());
    f.manager.cancel(workerId);
    await f.manager.awaitRunTermination(workerId, 5_000);
    f.store.updateStep(workerId, 'task', { status: STEP_STATUS.done, sessionId: 'previous-session', backend: 'claude' });
    const generation = f.store.commitWorkerExecutionStart(workerId);
    setRunStatus(f.store, workerId, RUN_STATUS.done);
    f.store.commitWorkerExecutionComplete(workerId, generation);
    return workerId;
  }

  it('a new run stores an explicit choice: on when omitted, off when asked', async () => {
    const omitted = f.manager.startRun(QUICK_TASK_WORKFLOW, { task: 'omitted', worktree: false });
    const off = f.manager.startRun(QUICK_TASK_WORKFLOW, { task: 'off', worktree: false, allowWorkers: false, allowMessaging: false });
    expect(f.store.getRun(omitted.id)).toMatchObject({ allowWorkers: true, allowMessaging: true });
    expect(f.store.getRun(off.id)).toMatchObject({ allowWorkers: false, allowMessaging: false });
    for (const id of [omitted.id, off.id]) { f.manager.cancel(id); await f.manager.awaitRunTermination(id, 5_000); }
  });

  describe('workers', () => {
    it('a record with no saved choice may spawn', async () => {
      expect(f.store.getRun(f.parent.id)?.allowWorkers).toBeUndefined();
      await expect(f.service.spawn(f.caller, spawnInput())).resolves.toMatchObject({ workerId: expect.any(String) });
    });
    it('refuses a new spawn through the existing credential once workers are off, and on again allows it', async () => {
      access(f.parent.id, { allowWorkers: false });
      await expect(f.service.spawn(f.caller, spawnInput())).rejects.toMatchObject({ code: 'incompatible_state', message: WORKERS_OFF });
      expect(f.store.getRun(f.parent.id)?.delegation).toMatchObject({ role: 'root', receipts: [] });
      access(f.parent.id, { allowWorkers: true });
      await expect(f.service.spawn(f.caller, spawnInput())).resolves.toMatchObject({ workerId: expect.any(String) });
    });
    it('reads the switch again before acceptance: a spawn waiting on its baseline is refused when workers turn off', async () => {
      // Settings resolution yields before acceptance; the human turns workers off meanwhile.
      const select = f.manager.selectDelegationExecutionSettings.bind(f.manager);
      vi.spyOn(f.manager, 'selectDelegationExecutionSettings').mockImplementationOnce(async (...args) => {
        access(f.parent.id, { allowWorkers: false });
        return select(...args);
      });
      await expect(f.service.spawn(f.caller, spawnInput())).rejects.toMatchObject({ code: 'incompatible_state', message: WORKERS_OFF });
      expect(f.store.getRun(f.parent.id)?.delegation).toMatchObject({ receipts: [] });
    });
    it('a replay of an accepted spawn returns its receipt after workers turn off', async () => {
      const input = spawnInput();
      const first = await f.service.spawn(f.caller, input);
      access(f.parent.id, { allowWorkers: false });
      await expect(f.service.spawn(f.caller, input)).resolves.toEqual(first);
    });
    it('existing workers stay manageable after workers turn off', async () => {
      const { workerId } = await f.service.spawn(f.caller, spawnInput());
      access(f.parent.id, { allowWorkers: false, allowMessaging: false });
      expect((await f.service.list(f.caller)).workers.map(worker => worker.workerId)).toEqual([workerId]);
      await expect(f.service.inspect(f.caller, { workerId })).resolves.toMatchObject({ workerId });
      setRunStatus(f.store, workerId, RUN_STATUS.running);
      const sent = await f.service.send(f.caller, message(workerId, 'progress'));
      expect(sent.delivery).not.toBe('not-delivered');
      await expect(f.service.destroy(f.caller, { workerId })).resolves.toMatchObject({ workerId });
    });
    it('refuses --resume of a settled worker once workers are off and accepts nothing', async () => {
      const workerId = await completedWorker();
      access(f.parent.id, { allowWorkers: false });
      const request = { ...message(workerId), resume: true };
      await expect(f.service.send(f.caller, request)).rejects.toMatchObject({ code: 'incompatible_state', message: WORKERS_OFF });
      expect(f.store.getRun(workerId)).toMatchObject({ status: RUN_STATUS.done });
      expect(f.store.getRun(f.parent.id)?.delegation).not.toHaveProperty('conversation.messages.0');
      access(f.parent.id, { allowWorkers: true });
      await expect(f.service.send(f.caller, request)).resolves.toMatchObject({ message: { resumed: true } });
    });
    it('refuses model and runner discovery once workers are off', async () => {
      access(f.parent.id, { allowWorkers: false });
      await expect(f.service.discover(f.caller, { kind: 'runners' })).rejects.toMatchObject({ code: 'incompatible_state', message: WORKERS_OFF });
    });
    it('an explicit choice survives a store reload', () => {
      access(f.parent.id, { allowWorkers: false, allowMessaging: false });
      const reopened = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true });
      expect(reopened.getRun(f.parent.id)).toMatchObject({ allowWorkers: false, allowMessaging: false });
      reopened.flush();
    });
  });

  describe('peer messaging', () => {
    it('a sender with messaging off can neither send nor list peers', async () => {
      const b = peer();
      access(f.parent.id, { allowMessaging: false });
      await expect(f.service.send(f.caller, message(b.id))).rejects.toMatchObject({ code: 'incompatible_state', message: MESSAGING_OFF });
      await expect(f.service.send(f.caller, message(b.id, 'progress'))).rejects.toMatchObject({ code: 'incompatible_state', message: MESSAGING_OFF });
      await expect(f.service.discover(f.caller, { kind: 'tasks' })).rejects.toMatchObject({ code: 'incompatible_state', message: MESSAGING_OFF });
      expect(f.store.getRun(b.id)?.agentInputs ?? []).toEqual([]);
    });
    it('a recipient with messaging off takes no new message', async () => {
      const b = peer();
      access(b.id, { allowMessaging: false });
      const sent = await f.service.send(f.caller, message(b.id));
      expect(sent).toMatchObject({ delivery: 'not-delivered', message: { instruction: 'Not delivered: this task does not accept task messages.' } });
      expect(f.store.getRun(b.id)?.agentInputs ?? []).toEqual([]);
    });
    it('a reply to a request accepted before messaging went off still lands, both ways', async () => {
      const b = peer();
      const request = await f.service.send(b.caller, message(f.parent.id));
      access(f.parent.id, { allowMessaging: false });
      access(b.id, { allowMessaging: false });
      const reply = await f.service.reply(f.caller, message(b.id, 'reply', { requestId: request.message.id }));
      expect(reply.delivery).not.toBe('not-delivered');
      expect(f.store.getRun(b.id)?.agentInputs?.some(input => input.id === reply.message.id)).toBe(true);
    });
    it('an exact retry of a message accepted before messaging went off returns its receipt', async () => {
      const b = peer();
      const request = message(b.id);
      const sent = await f.service.send(f.caller, request);
      access(f.parent.id, { allowMessaging: false });
      await expect(f.service.send(f.caller, request)).resolves.toMatchObject({ message: { id: sent.message.id }, effect: 'unchanged' });
    });
    it('discovery lists a peer with messaging off as not accepting', async () => {
      const b = peer();
      access(b.id, { allowMessaging: false });
      const { tasks } = await f.service.discover(f.caller, { kind: 'tasks' }) as { tasks: Array<{ id: string; accepts: boolean; reason?: string }> };
      expect(tasks.find(task => task.id === b.id)).toMatchObject({ accepts: false, reason: 'task messaging is off: it does not accept task messages' });
    });
    it('messaging off does not touch family messages', async () => {
      const { workerId } = await f.service.spawn(f.caller, spawnInput());
      setRunStatus(f.store, workerId, RUN_STATUS.running);
      access(f.parent.id, { allowMessaging: false });
      const workerCaller = f.credentials.authenticate(f.credentials.issue('project', workerId, randomUUID()))!;
      const sent = await f.service.send(workerCaller, message(f.parent.id, 'progress'));
      expect(sent.delivery).not.toBe('not-delivered');
    });
  });
});
