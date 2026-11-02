import { runInternals } from './run-internals.testkit.ts';
import { requestOutcomeSchema } from '@open-mercato/cezar-contract/conversations';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RUNNER_IDS, type AgentSession, type RunnerId } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { parkNoticeId } from '../delegation/park-notice.ts';
import { monitoringWakeOf } from './waits.testkit.ts';
import {
  checkpoint, controlledWire, delegatingParent, manager, parent, restart, root, semaphore, spendWorkerBudget,
  store, until, useWorkerWaitFixture, waitOf, lastWaitOf, workerEntryOf, worker,
} from './worker-wait.testkit.ts';
import type { TimerWaitEntry, Wait } from '@open-mercato/cezar-contract/waits';
/** The deadline of the run's open timer: `mock:cezar-wait` opens a cezar_wait timer (hearsay-tools/cezarion#2397). */
const timerDeadlineOf = (run?: { waits?: Wait[] | undefined }) => run?.waits?.find((wait): wait is TimerWaitEntry => wait.kind === 'timer' && wait.phase === 'open')?.deadline;


describe('parent and worker conversation waits through RunManager', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  // `delegatingParent` sets CEZ_DELEGATION, so these tests do not depend on the host (hearsay-tools/cezarion#1752).
  async function conversationPair(runner: RunnerId = 'claude') {
    const { p, service, callerFor, close } = await delegatingParent({ runner, permissions: ['spawn', 'wait', 'steer'] });
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id, 'mock:hold', runner);
    // An idle worker that only talks: it plain-parks rather than ask its parent (hearsay-tools/cezarion#1301).
    spendWorkerBudget(w.id);
    manager.enqueueOwnedRun(w.id);
    await until(() => store.getRun(w.id)?.status === 'waiting');
    return { p, w, service, parentCaller: callerFor(p.id), workerCaller: callerFor(w.id), callerFor, close };
  }

  // A parent with a live worker parks on a monitoring timer after handling a request
  // (hearsay-tools/cezarion#1233). The parked state before delivery looks the same, and waiting
  // for it raced the scheduler's Git probe, so the request's own turn must have ended.
  const turnEnds = (runId: string) => store.readEvents(runId).filter(event => event.type === 'turn-end').length;
  async function parentHandledRequest(parentId: string, inputId: string, boundaries: number) {
    await until(() => {
      const run = store.getRun(parentId);
      return run?.status === 'waiting' && !!monitoringWakeOf(run) && turnEnds(parentId) > boundaries &&
        !!run.agentInputs?.find(input => input.id === inputId)?.deliveredAt;
    });
  }

  for (const runner of RUNNER_IDS) {
    it(`${runner} WP1 progress wakes the parent and preserves its worker wait until one terminal wake`, async () => {
      process.env.CEZ_DRY_RUN = '0';
      process.env.CEZ_CLAUDE_BIN = HARNESS_ADAPTERS.claude.mockBin;
      process.env[HARNESS_ADAPTERS[runner].binEnv] = HARNESS_ADAPTERS[runner].mockBin;
      const f = await conversationPair(runner);
      try {
        const wait = manager.registerWorkerWait(f.p.id, { workerIds: [f.w.id], timeoutSeconds: 600 });
        await until(() => waitOf(store.getRun(f.p.id))?.phase === 'parked');
        for (let n = 0; n < 2; n++) {
          const id = randomUUID();
          await f.service.send(f.workerCaller, { id, recipientRunId: f.p.id, kind: 'progress', text: 'Still working mock:hold', timeoutSeconds: 600 });
          await until(() => !!store.getRun(f.p.id)?.agentInputs?.find(input => input.id === id)?.deliveredAt);
          expect(waitOf(store.getRun(f.p.id))).toMatchObject({ id: wait.id, deadline: wait.deadline, workerIds: [f.w.id] });
          await until(() => waitOf(store.getRun(f.p.id))?.phase === 'parked');
          expect(semaphore.busy()).toBe(0);
        }
        expect(manager.finish(f.w.id)).toBe(true);
        await until(() => !!store.getRun(f.p.id)?.agentInputs?.find(input => input.id === wait.id)?.deliveredAt);
        manager.reconcileWorkerWaits(); manager.reconcileWorkerWaits();
        expect(waitOf(store.getRun(f.p.id))).toBeUndefined();
        expect(store.getRun(f.p.id)?.agentInputs?.filter(input => input.id === wait.id)).toHaveLength(1);
        expect(lastWaitOf(store.getRun(f.p.id))).toMatchObject({ id: wait.id, reason: 'outcome' });
      } finally { f.close(); }
    });
  }

  for (const runner of RUNNER_IDS) {
    it(`${runner} WP2 preserves a resumed request for 45 minutes and delivers its late reply amendment`, async () => {
      process.env.CEZ_DRY_RUN = '0';
      process.env.CEZ_CLAUDE_BIN = HARNESS_ADAPTERS.claude.mockBin;
      process.env[HARNESS_ADAPTERS[runner].binEnv] = HARNESS_ADAPTERS[runner].mockBin;
      const f = await conversationPair(runner);
      const release = join(root, 'resume-receipt-release');
      try {
        await expect(f.service.send(f.parentCaller, { id: randomUUID(), recipientRunId: f.w.id,
          kind: 'request', text: 'Still active', resume: true, timeoutSeconds: 3600 })).rejects.toMatchObject({ code: 'incompatible_state' });
        manager.finish(f.w.id);
        await until(() => !manager.isActive(f.w.id));
        process.env.CEZ_MOCK_RELEASE_FILE = release;
        const boundaries = turnEnds(f.w.id);
        const started = Date.now();
        const sent = await f.service.send(f.parentCaller, { id: randomUUID(), recipientRunId: f.w.id,
          kind: 'request', text: 'Fix review mock:hold-gated', resume: true, timeoutSeconds: 3600 });
        await until(() => !!store.getRun(f.w.id)?.agentInputs?.find(input => input.id === sent.message.id)?.deliveredAt);
        // hearsay-tools/cezarion#2173: acceptance must reach both transcripts before another
        // message, history read or turn end can incidentally reconcile the saved receipt.
        const accepted = store.getRun(f.w.id)!.agentInputs!.find(input => input.id === sent.message.id)!;
        for (const id of [f.p.id, f.w.id]) {
          expect(store.readEvents(id).filter(event => event.type === 'conversation-message' &&
            (event.message as { id: string }).id === sent.message.id && event.delivery === 'delivered'))
            .toEqual([expect.objectContaining({ deliveredAt: accepted.deliveredAt })]);
        }
        expect(turnEnds(f.w.id)).toBe(boundaries);
        expect(accepted.consumedAt).toBeUndefined();
        expect(store.getRun(f.w.id)?.continuationMessage?.agentInputId).toBe(sent.message.id);
        expect(store.getRun(f.p.id)?.delegation).toMatchObject({ conversation: { outcomes: [] } });
        writeFileSync(release, 'release');
        await until(() => store.getRun(f.w.id)?.status === 'waiting');
        expect(store.getRun(f.w.id)?.agentInputs?.find(input => input.id === sent.message.id)?.consumedAt).toBeDefined();
        expect(store.getRun(f.w.id)?.continuationMessage).toBeUndefined();
        // Only the wall clock changes: native mock wire/process timers keep running.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(started + 45 * 60_000);
        expect((await f.service.conversation(f.parentCaller, { recipientRunId: f.w.id })).outcomes).toEqual([]);
        vi.setSystemTime(started + 61 * 60_000);
        expect((await f.service.conversation(f.parentCaller, { recipientRunId: f.w.id })).outcomes[0]?.status).toBe('timed-out');
        const reply = await f.service.reply(f.workerCaller, { id: randomUUID(), recipientRunId: f.p.id,
          kind: 'reply', requestId: sent.message.id, text: 'Fixed mock:hold', timeoutSeconds: 600 });
        expect(reply.outcome).toMatchObject({ status: 'replied-late', replyId: reply.message.id });
        await until(() => !!store.getRun(f.p.id)?.agentInputs?.find(input => input.id === reply.message.id)?.deliveredAt);
        expect(store.readEvents(f.p.id).some(event => event.type === 'request-outcome' && requestOutcomeSchema.safeParse(event.outcome).data?.status === 'replied-late')).toBe(true);
      } finally { writeFileSync(release, 'release'); vi.useRealTimers(); f.close(); }
    });
  }

  it('inbox ACK of progress preserves a parked worker wait and its terminal wake', async () => {
    const f = await conversationPair();
    const engine = runInternals(manager).line;
    // The wait opens on a parked worker, which sends its park notice (hearsay-tools/cezarion#1327).
    // The parent takes it and parks again before the progress this test acknowledges.
    const turns = turnEnds(f.p.id);
    const wait = manager.registerWorkerWait(f.p.id, { workerIds: [f.w.id], timeoutSeconds: 600 });
    const notice = parkNoticeId(f.w.id, wait.id);
    await until(() => turnEnds(f.p.id) > turns && waitOf(store.getRun(f.p.id))?.phase === 'parked' &&
      !!store.getRun(f.p.id)?.agentInputs?.find(input => input.id === notice)?.deliveredAt);
    const pump = vi.spyOn(runInternals(manager).line, 'pump').mockResolvedValue();
    try {
      const id = randomUUID();
      await f.service.send(f.workerCaller, { id, recipientRunId: f.p.id, kind: 'progress', text: 'Still working mock:hold', timeoutSeconds: 600 });
      const generation = randomUUID();
      const claim = manager.reserveInboxInputs(f.p.id, generation, [id])!;
      expect(manager.acknowledgeInbox(f.p.id, generation, claim.receiptId)).toBe('acknowledged');
      expect(waitOf(store.getRun(f.p.id))).toMatchObject({ id: wait.id, phase: 'parked', deadline: wait.deadline });
      expect(runInternals(manager).line.queue).not.toContain(f.p.id);
      expect(semaphore.busy()).toBe(0);
      expect(pump).toHaveBeenCalled(); pump.mockRestore();
      expect(manager.finish(f.w.id)).toBe(true);
      await until(() => !!store.getRun(f.p.id)?.agentInputs?.find(input => input.id === wait.id)?.deliveredAt);
      expect(waitOf(store.getRun(f.p.id))).toBeUndefined();
      expect(store.getRun(f.p.id)?.agentInputs?.filter(input => input.id === wait.id)).toHaveLength(1);
    } finally { pump.mockRestore(); f.close(); }
  });

  // hearsay-tools/cezarion#1235: messages are not waits; a request no longer interrupts the wait.
  it.each(['provider', 'inbox'] as const)('a mixed progress/request %s batch is delivered and the worker wait stays open', async mode => {
    const f = await conversationPair();
    const engine = runInternals(manager).line;
    const pump = vi.spyOn(runInternals(manager).line, 'pump').mockResolvedValue();
    try {
      const wait = manager.registerWorkerWait(f.p.id, { workerIds: [f.w.id], timeoutSeconds: 600 });
      expect(pump).toHaveBeenCalled();
      const progressId = randomUUID(); const requestId = randomUUID();
      await f.service.send(f.workerCaller, { id: progressId, recipientRunId: f.p.id, kind: 'progress', text: 'Working mock:hold', timeoutSeconds: 600 });
      await f.service.send(f.workerCaller, { id: requestId, recipientRunId: f.p.id, kind: 'request', text: 'Need a decision mock:hold', timeoutSeconds: 600 });
      if (mode === 'inbox') {
        const generation = randomUUID();
        const claim = manager.reserveInboxInputs(f.p.id, generation, [progressId, requestId])!;
        expect(manager.acknowledgeInbox(f.p.id, generation, claim.receiptId)).toBe('acknowledged');
      } else {
        const active = runInternals(manager);
        const send = vi.spyOn(active.active.get(f.p.id)!.session!, 'sendAgentMessage');
        expect(pump).toHaveBeenCalled(); pump.mockRestore(); await runInternals(manager).line.pump();
        await until(() => [progressId, requestId].every(id => !!store.getRun(f.p.id)?.agentInputs?.find(input => input.id === id)?.deliveredAt));
        const submitted = JSON.stringify(send.mock.calls);
        expect(submitted).not.toContain('interrupted wait');
        expect(submitted).toContain(`Still open: worker wait ${wait.id}`);
      }
      expect(workerEntryOf(store.getRun(f.p.id))).toMatchObject({ id: wait.id, phase: 'open', workerIds: [f.w.id] });
      expect(lastWaitOf(store.getRun(f.p.id))).toBeUndefined();
      expect(store.getRun(f.p.id)?.delegation).toMatchObject({ conversation: { outcomes: [] } });
    } finally { pump.mockRestore(); f.close(); }
  });

  // hearsay-tools/cezarion#1235: neither message ends the worker wait.
  it('a request-only inbox ACK beside a progress wake still awaiting provider ACK leaves the worker wait open', async () => {
    const f = await conversationPair();
    const engine = runInternals(manager);
    const pump = vi.spyOn(runInternals(manager).line, 'pump').mockResolvedValue();
    let acknowledge!: () => void;
    const pending = new Promise<void>(resolve => { acknowledge = resolve; });
    const send = vi.spyOn(engine.active.get(f.p.id)!.session!, 'sendAgentMessage').mockReturnValue(pending);
    try {
      const wait = manager.registerWorkerWait(f.p.id, { workerIds: [f.w.id], timeoutSeconds: 600 });
      expect(pump).toHaveBeenCalled();
      const progressId = randomUUID(); const requestId = randomUUID();
      await f.service.send(f.workerCaller, { id: progressId, recipientRunId: f.p.id, kind: 'progress', text: 'Working mock:hold', timeoutSeconds: 600 });
      expect(pump).toHaveBeenCalled(); pump.mockRestore(); await runInternals(manager).line.pump();
      await until(() => send.mock.calls.some(call => call[1]?.includes(progressId)));
      expect(manager.canClaimInboxInput(f.p.id, progressId)).toBe(false);
      await f.service.send(f.workerCaller, { id: requestId, recipientRunId: f.p.id, kind: 'request', text: 'Need a decision mock:hold', timeoutSeconds: 600 });
      const generation = randomUUID();
      const claim = manager.reserveInboxInputs(f.p.id, generation, [requestId])!;
      expect(manager.acknowledgeInbox(f.p.id, generation, claim.receiptId)).toBe('acknowledged');
      expect(workerEntryOf(store.getRun(f.p.id))).toMatchObject({ id: wait.id, phase: 'open' });
      acknowledge();
      await until(() => !!store.getRun(f.p.id)?.agentInputs?.find(input => input.id === progressId)?.deliveredAt);
      expect(workerEntryOf(store.getRun(f.p.id))).toMatchObject({ id: wait.id, phase: 'open' });
      expect(lastWaitOf(store.getRun(f.p.id))).toBeUndefined();
    } finally { acknowledge(); send.mockRestore(); pump.mockRestore(); f.close(); }
  });

  it('conversation: worker request wait releases capacity and explicit parent reply wakes exactly once', async () => {
    const f = await conversationPair();
    try {
      const id = randomUUID();
      const boundaries = turnEnds(f.p.id);
      await f.service.send(f.workerCaller, { id, recipientRunId: f.p.id, kind: 'request', text: 'Which module? mock:hold', timeoutSeconds: 600 });
      const wait = manager.registerRequestWait(f.w.id, { requestIds: [id], timeoutSeconds: 600 });
      await until(() => waitOf(store.getRun(f.w.id))?.phase === 'parked');
      await parentHandledRequest(f.p.id, id, boundaries);
      expect(semaphore.busy()).toBe(0);
      const reply = { id: randomUUID(), recipientRunId: f.w.id, kind: 'reply' as const, requestId: id, text: 'The parser. mock:hold', timeoutSeconds: 600 };
      await f.service.send(f.parentCaller, reply);
      await until(() => !waitOf(store.getRun(f.w.id)));
      await f.service.send(f.parentCaller, reply);
      manager.reconcileWorkerWaits(); manager.reconcileWorkerWaits();
      expect(store.getRun(f.w.id)?.agentInputs?.filter(input => input.id === wait.id && input.deliveredAt)).toHaveLength(1);
      expect(store.getRun(f.w.id)?.agentInputs?.filter(input => input.id === reply.id)).toHaveLength(1);
      const rootState = store.getRun(f.p.id)?.delegation;
      expect(rootState?.role === 'root' && rootState.conversation?.outcomes).toEqual([expect.objectContaining({ requestId: id, status: 'replied', replyId: reply.id })]);
    } finally { f.close(); }
  });

  it('conversation: reply before registration satisfies request wait and is retained after retirement', async () => {
    const f = await conversationPair();
    try {
      const id = randomUUID();
      const boundaries = turnEnds(f.p.id);
      await f.service.send(f.workerCaller, { id, recipientRunId: f.p.id, kind: 'request', text: 'Early question mock:hold', timeoutSeconds: 600 });
      await parentHandledRequest(f.p.id, id, boundaries);
      await f.service.send(f.parentCaller, { id: randomUUID(), recipientRunId: f.w.id, kind: 'reply', requestId: id, text: 'Early reply mock:hold', timeoutSeconds: 600 });
      await until(() => store.getRun(f.w.id)?.status === 'waiting' && !waitOf(store.getRun(f.w.id)) && !!store.getRun(f.w.id)?.agentInputs?.every(input => input.deliveredAt));
      const wait = manager.registerRequestWait(f.w.id, { requestIds: [id], timeoutSeconds: 600 });
      expect(wait.reason).toBe('outcome');
      await until(() => !waitOf(store.getRun(f.w.id)));
      expect(lastWaitOf(store.getRun(f.w.id))?.requestOutcomes).toEqual([expect.objectContaining({ requestId: id, status: 'replied' })]);
    } finally { f.close(); }
  });

  // hearsay-tools/cezarion#1235: the question wakes the worker; its wait and the obligation stay open.
  it('conversation: an incoming question wakes a parked worker without ending its wait or settling its obligation', async () => {
    const f = await conversationPair();
    try {
      const first = randomUUID();
      const boundaries = turnEnds(f.p.id);
      await f.service.send(f.workerCaller, { id: first, recipientRunId: f.p.id, kind: 'request', text: 'Need module mock:hold', timeoutSeconds: 600 });
      const wait = manager.registerRequestWait(f.w.id, { requestIds: [first], timeoutSeconds: 600 });
      await until(() => waitOf(store.getRun(f.w.id))?.phase === 'parked');
      await parentHandledRequest(f.p.id, first, boundaries);
      const second = randomUUID();
      await f.service.send(f.parentCaller, { id: second, recipientRunId: f.w.id, kind: 'request', text: 'Which options? mock:hold', timeoutSeconds: 600 });
      await until(() => !!store.getRun(f.w.id)?.agentInputs?.find(input => input.id === second)?.deliveredAt);
      expect(workerEntryOf(store.getRun(f.w.id))).toMatchObject({ id: wait.id, phase: 'open', requestIds: [first] });
      expect(lastWaitOf(store.getRun(f.w.id))).toBeUndefined();
      const rootState = store.getRun(f.p.id)?.delegation;
      expect(rootState?.role === 'root' && rootState.conversation?.outcomes).toEqual([]);
      expect(store.getRun(f.w.id)?.agentInputs?.find(input => input.id === second)?.deliveredAt).toBeTruthy();
    } finally { f.close(); }
  });

  it('conversation: request deadlines settle without registering a wait or polling', async () => {
    const f = await conversationPair();
    try {
      const id = randomUUID();
      await f.service.send(f.workerCaller, { id, recipientRunId: f.p.id, kind: 'request', text: 'Deadline question mock:hold', timeoutSeconds: 1 });
      await until(() => {
        const rootState = store.getRun(f.p.id)?.delegation;
        return rootState?.role === 'root' && rootState.conversation?.outcomes.some(outcome => outcome.requestId === id && outcome.status === 'timed-out') === true;
      });
      expect(store.getRun(f.w.id)?.status).toBe('waiting');
      expect(store.getRun(f.p.id)?.status).not.toBe('cancelled');
    } finally { f.close(); }
  });

  it('conversation: restart restores a worker request wait and deadline, and cancelling it leaves a receipt and no wake', async () => {
    const f = await conversationPair();
    try {
      const id = randomUUID();
      await f.service.send(f.workerCaller, { id, recipientRunId: f.p.id, kind: 'request', text: 'Recovery question mock:hold', timeoutSeconds: 600 });
      await until(() => !waitOf(store.getRun(f.p.id)) && !!store.getRun(f.p.id)?.agentInputs?.find(input => input.id === id)?.deliveredAt);
      const wait = manager.registerRequestWait(f.w.id, { requestIds: [id], timeoutSeconds: 600 });
      await until(() => waitOf(store.getRun(f.w.id))?.phase === 'parked');
      await restart();
      expect(store.getRun(f.w.id)?.status).toBe('waiting');
      expect(waitOf(store.getRun(f.w.id))).toMatchObject({ id: wait.id, requestIds: [id], deadline: wait.deadline, phase: 'parked' });
      manager.cancelWorkerWait(f.w.id, wait.id);
      checkpoint('conversation-cancel-wait');
      await until(() => !waitOf(store.getRun(f.w.id)));
      checkpoint('conversation-wait-cancelled');
      // hearsay-tools/cezarion#1235: a cancelled wait moves to lastWaits and queues no wake.
      expect(lastWaitOf(store.getRun(f.w.id))).toMatchObject({ id: wait.id, reason: 'cancelled' });
      manager.reconcileWorkerWaits(); manager.reconcileWorkerWaits();
      expect(store.getRun(f.w.id)?.agentInputs?.filter(input => input.id === wait.id) ?? []).toEqual([]);
    checkpoint('conversation-test-complete');
    } finally { f.close(); }
  });

  // hearsay-tools/cezarion#1235: the first reply settles its request in the open entry, which
  // waits on for the second; the reply itself reaches the parent as a message.
  it('conversation: parent waits for replies from two workers and the first reply leaves the wait open', async () => {
    const f = await conversationPair();
    try {
      const secondWorker = await worker(f.p.id);
      manager.enqueueOwnedRun(secondWorker.id);
      await until(() => store.getRun(secondWorker.id)?.status === 'waiting');
      const secondCaller = f.callerFor(secondWorker.id);
      const first = randomUUID(); const second = randomUUID();
      await f.service.send(f.parentCaller, { id: first, recipientRunId: f.w.id, kind: 'request', text: 'First check mock:hold', timeoutSeconds: 600 });
      await f.service.send(f.parentCaller, { id: second, recipientRunId: secondWorker.id, kind: 'request', text: 'Second check mock:hold', timeoutSeconds: 600 });
      const wait = manager.registerRequestWait(f.p.id, { requestIds: [first, second], mode: 'all', timeoutSeconds: 600 });
      await until(() => waitOf(store.getRun(f.p.id))?.phase === 'parked');
      await f.service.send(f.workerCaller, { id: randomUUID(), recipientRunId: f.p.id, kind: 'reply', requestId: first, text: 'First result mock:hold', timeoutSeconds: 600 });
      expect(workerEntryOf(store.getRun(f.p.id))).toMatchObject({ id: wait.id, phase: 'open', requestOutcomes: [expect.objectContaining({ requestId: first, status: 'replied' })] });
      await f.service.send(secondCaller, { id: randomUUID(), recipientRunId: f.p.id, kind: 'reply', requestId: second, text: 'Second result mock:hold', timeoutSeconds: 600 });
      await until(() => lastWaitOf(store.getRun(f.p.id))?.id === wait.id && !waitOf(store.getRun(f.p.id)));
      expect(lastWaitOf(store.getRun(f.p.id))).toMatchObject({ id: wait.id, reason: 'outcome', requestOutcomes: [expect.objectContaining({ requestId: first }), expect.objectContaining({ requestId: second })] });
      expect(store.getRun(f.p.id)?.agentInputs?.filter(input => input.id === wait.id && input.deliveredAt)).toHaveLength(1);
    } finally { f.close(); }
  });

  it('conversation: a full queue of 32 replies can admit an all-request wake without losing a message', async () => {
    const f = await conversationPair();
    const engine = runInternals(manager).line;
    const pump = vi.spyOn(runInternals(manager).line, 'pump').mockResolvedValue();
    const submissions = vi.spyOn(runInternals(manager).inputDelivery, 'submitAgentInput');
    try {
      const requestIds = Array.from({ length: 32 }, () => randomUUID());
      for (const id of requestIds) await f.service.send(f.parentCaller, { id, recipientRunId: f.w.id, kind: 'request', text: 'Batch question mock:hold', timeoutSeconds: 600 });
      const wait = manager.registerRequestWait(f.p.id, { requestIds, mode: 'all', timeoutSeconds: 600 });
      const replyIds: string[] = [];
      for (const requestId of requestIds) {
        const id = randomUUID(); replyIds.push(id);
        await f.service.send(f.workerCaller, { id, recipientRunId: f.p.id, kind: 'reply', requestId, text: 'Batch answer mock:hold', timeoutSeconds: 600 });
      }
      // hearsay-tools/cezarion#1235: the wait resolves in the list with its own lifecycle input
      // beside the 32 replies, which stay queued as messages.
      const queued = store.getRun(f.p.id)?.agentInputs ?? [];
      expect(queued.filter(input => !input.deliveredAt)).toHaveLength(33);
      expect(queued.map(input => input.id)).toEqual([...replyIds, wait.id]);
      expect(waitOf(store.getRun(f.p.id))).toMatchObject({ id: wait.id, phase: 'wake-pending', reason: 'outcome' });
      expect(pump).toHaveBeenCalled(); pump.mockRestore();
      await runInternals(manager).line.pump();
      await vi.waitFor(() => {
        expect(store.getRun(f.p.id)?.agentInputs?.filter(input => input.deliveredAt).map(input => input.id)).toEqual([...replyIds, wait.id]);
        expect(waitOf(store.getRun(f.p.id))).toBeUndefined();
      }, { timeout: 60_000, interval: 20 }); // bound: 33 real deliveries on a loaded host, as before
      expect(lastWaitOf(store.getRun(f.p.id))).toMatchObject({ id: wait.id, reason: 'outcome', requestOutcomes: expect.arrayContaining(requestIds.map(requestId => expect.objectContaining({ requestId, status: 'replied' }))) });
      // One submission: the result, then every reply, each once.
      const delivered = submissions.mock.calls.filter((call, index) => call[0] === f.p.id && submissions.mock.results[index]?.value === true);
      expect(delivered).toHaveLength(1);
      expect(delivered.flatMap(call => call[3])).toEqual([wait.id, ...replyIds]);
      expect((delivered.at(-1)?.[2][0] as { text: string })?.text).toContain(`Request wait ${wait.id} (outcome). Request outcomes:`);
      expect((delivered.at(-1)?.[2][0] as { text: string })?.text.match(/Batch answer mock:hold/g)).toHaveLength(32);
    } finally { pump.mockRestore(); submissions.mockRestore(); f.close(); }
  }, 90_000);

  // hearsay-tools/cezarion#1235: the message is a wake of its own, and a monitoring park keeps its
  // slot (hearsay-tools/cezarion#1233), so it takes the message at once without a regular slot.
  it('conversation: a monitoring recipient takes its message on the slot its park keeps', async () => {
    const f = await conversationPair();
    const gate = join(root, 'conversation-monitor-gate');
    try {
      const boundaries = turnEnds(f.p.id);
      expect(manager.sendMessage(f.p.id, [{ type: 'text', text: 'mock:cezar-wait' }])).toBe(true);
      await until(() => turnEnds(f.p.id) > boundaries && store.getRun(f.p.id)?.status === 'waiting' && !!timerDeadlineOf(store.getRun(f.p.id)));
      // A real in-flight turn occupies the sole slot until this gate opens.
      controlledWire({ firstResultGate: gate });
      const busy = await worker(f.p.id);
      manager.enqueueOwnedRun(busy.id);
      await until(() => store.getRun(busy.id)?.status === 'running' && semaphore.busy() === 1);
      const id = randomUUID();
      await f.service.send(f.workerCaller, { id, recipientRunId: f.p.id, kind: 'progress', text: 'Progress while monitoring mock:hold', timeoutSeconds: 600 });
      await until(() => !!store.getRun(f.p.id)?.agentInputs?.find(input => input.id === id)?.deliveredAt);
      expect(semaphore.busy()).toBe(1);
      expect(store.getRun(busy.id)?.status).toBe('running');
      expect(waitOf(store.getRun(f.p.id))).toBeUndefined();
      writeFileSync(gate, 'release');
    } finally { writeFileSync(gate, 'release'); f.close(); }
  });

  it.each(['fresh', 'continuation'] as const)('inbox race at the %s turn boundary preserves a claimed input', async mode => {
    const gate = join(root, 'inbox-turn-gate');
    let p: Awaited<ReturnType<typeof parent>>;
    if (mode === 'fresh') {
      const wire = controlledWire({ firstResultGate: gate });
      p = await parent(); await until(wire.initialReceived);
    } else {
      p = await parent(); await until(() => store.getRun(p.id)?.status === 'waiting');
      expect(manager.finish(p.id)).toBe(true); await until(() => !manager.isActive(p.id));
      const wire = controlledWire({ firstResultGate: gate });
      expect(manager.continueRun(p.id, { text: 'mock:hold' }).ok).toBe(true);
      await until(wire.initialReceived);
    }
    try {
      const first = { id: randomUUID(), parentRunId: p.id, source: 'agent' as const, text: 'claimed message', createdAt: new Date().toISOString(),
        conversation: { senderRunId: randomUUID(), recipientRunId: p.id, kind: 'progress' as const } };
      store.commitAgentInputs(p.id, [first]);
      // Seed through the Task 1 store so removing only Task 2 source proves an actual duplicate-delivery race.
      const claim = { receiptId: randomUUID(), generation: randomUUID(), expiresAt: new Date(Date.now() + 120_000).toISOString() };
      store.claimInboxInputs(p.id, [first.id], claim);
      const later = { ...first, id: randomUUID(), text: 'later arrival' };
      store.commitAgentInputs(p.id, [...store.getRun(p.id)!.agentInputs!, later]);
      writeFileSync(gate, 'release');
      await until(() => store.getRun(p.id)?.status === 'waiting');
      expect(store.getRun(p.id)?.agentInputs?.map(input => input.deliveredAt)).toEqual([undefined, undefined]);
      expect(manager.acknowledgeInbox(p.id, claim.generation, claim.receiptId)).toBe('acknowledged');
      await until(() => !!store.getRun(p.id)?.agentInputs?.find(input => input.id === later.id)?.deliveredAt);
    } finally { writeFileSync(gate, 'release'); }
  });

  // hearsay-tools/cezarion#1235: the message wake is the wait list's admission, not a stand-in wait.
  it.each(['queued', 'admitted'] as const)('inbox ACK retires an unsubmitted message wake (%s) without resolving the request', async mode => {
    const f = await conversationPair();
    const engine = runInternals(manager);
    const pump = vi.spyOn(engine.line, 'pump').mockResolvedValue();
    const send = vi.spyOn(engine.active.get(f.p.id)!.session!, 'sendAgentMessage');
    try {
      const first = randomUUID();
      await f.service.send(f.workerCaller, { id: first, recipientRunId: f.p.id, kind: 'request', text: 'Unanswered request mock:hold', timeoutSeconds: 600 });
      expect(waitOf(store.getRun(f.p.id))).toBeUndefined();
      expect(runInternals(manager).line.queue).toContain(f.p.id);
      expect(pump).toHaveBeenCalled();
      if (mode === 'admitted') {
        send.mockReturnValue(false); pump.mockRestore(); await runInternals(manager).line.pump();
        expect(runInternals(manager).line.waitWakeAdmitted.has(f.p.id)).toBe(true);
      }
      const before = store.getRun(f.p.id)?.delegation;
      const beforeOutcomes = before?.role === 'root' ? before.conversation?.outcomes : undefined;
      const generation = randomUUID();
      expect(manager.canClaimInboxInput(f.p.id, first)).toBe(true);
      const receipt = manager.reserveInboxInputs(f.p.id, generation, [first])!;
      runInternals(manager).wakeAdmission.queueWaitWake(f.p.id);
      pump.mockRestore(); await runInternals(manager).line.pump();
      if (mode === 'queued') {
        // The claimed message owes no wake: the queued one is dropped rather than admitted.
        expect(semaphore.busy()).toBe(0);
        expect(runInternals(manager).line.queue).not.toContain(f.p.id);
      }
      expect(manager.acknowledgeInbox(f.p.id, generation, receipt.receiptId)).toBe('acknowledged');
      expect(waitOf(store.getRun(f.p.id))).toBeUndefined();
      expect(runInternals(manager).line.queue).not.toContain(f.p.id);
      expect(runInternals(manager).line.waitWakeQueuedAt.has(f.p.id)).toBe(false);
      expect(runInternals(manager).line.waitWakeAdmitted.has(f.p.id)).toBe(false);
      expect(semaphore.busy()).toBe(0);
      const after = store.getRun(f.p.id)?.delegation;
      expect(after?.role === 'root' ? after.conversation?.outcomes : undefined).toEqual(beforeOutcomes);
      expect(store.getRun(f.p.id)?.agentInputs?.find(input => input.id === first)?.deliveredAt).toBeDefined();
    } finally { send.mockRestore(); pump.mockRestore(); f.close(); }
  });

  it('a claimed message cannot interrupt a registered wait or acquire a wake admission', async () => {
    const f = await conversationPair();
    const engine = runInternals(manager).line;
    const pump = vi.spyOn(runInternals(manager).line, 'pump').mockResolvedValue();
    try {
      const request = randomUUID();
      await f.service.send(f.parentCaller, { id: request, recipientRunId: f.w.id, kind: 'request', text: 'Waiting for reply mock:hold', timeoutSeconds: 600 });
      const wait = manager.registerRequestWait(f.p.id, { requestIds: [request], timeoutSeconds: 600 });
      const incoming = { id: randomUUID(), source: 'agent' as const, parentRunId: f.p.id, text: 'claimed progress', createdAt: new Date().toISOString(),
        conversation: { senderRunId: f.w.id, recipientRunId: f.p.id, kind: 'progress' as const } };
      store.commitAgentInputs(f.p.id, [incoming]);
      const generation = randomUUID(); const receipt = manager.reserveInboxInputs(f.p.id, generation, [incoming.id])!;
      manager.reconcileWorkerWaits();
      expect(waitOf(store.getRun(f.p.id))).toMatchObject({ id: wait.id, phase: 'parked' });
      expect(runInternals(manager).line.queue).not.toContain(f.p.id);
      expect(manager.releaseInbox(f.p.id, generation, receipt.receiptId)).toBe('released');
      // hearsay-tools/cezarion#1235: the released message wakes the run on its own; the wait stays open.
      expect(waitOf(store.getRun(f.p.id))).toMatchObject({ id: wait.id, phase: 'parked' });
      expect(runInternals(manager).line.queue).toContain(f.p.id);
    } finally { expect(pump).toHaveBeenCalled(); pump.mockRestore(); f.close(); }
  });

});
