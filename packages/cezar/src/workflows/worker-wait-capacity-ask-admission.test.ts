import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import '../core/claude-runner.testkit.ts';
import { answerAsParent } from '../core/workflow-parity-core.testkit.ts';
import { grantSteer, eventCheckpoint, timeline, controlledWire, fixtureUpdateRun, manager, parent, register, restart, root, store, until, waitOf, worker, work } from './worker-wait-claude.testkit.ts';
import { setRunStatus, readPersistedRuns, hasPendingAsk } from '../runs/run-store.testkit.ts';
import { useWorkerCapacityFixture } from './worker-wait-capacity.testkit.ts';

describe("worker waits through RunManager", { timeout: 30_000 }, () => {
  useWorkerCapacityFixture();

for (const mode of ['fresh', 'continuation'] as const) {
    it(`${mode}: an admitted undelivered wake cannot suppress a portable ask`, async () => {
      const p = await parent();
      await until(() => store.getRun(p.id)?.status === 'waiting');
      if (mode === 'continuation') {
        manager.finish(p.id); await until(() => !manager.isActive(p.id));
        expect(manager.continueRun(p.id, { text: 'mock:hold' }).ok).toBe(true);
        await until(() => store.getRun(p.id)?.status === 'waiting');
      }
      // hearsay-tools/cezarion#1235: the list's admission, not `workerWakeAdmitted`.
      expect(work.liveSessions.size).toBe(1);
      const [session] = work.liveSessions;
      const send = vi.spyOn(session!, 'sendAgentMessage').mockReturnValue(false);
      // A backend opening/ack window legitimately refuses non-human input.

      const w = await worker(p.id); const wait = register(p.id, [w.id]);
      await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
      fixtureUpdateRun(w.id, { status: RUN_STATUS.done });
      await until(() => send.mock.calls.length > 0);
      expect(store.getRun(p.id)?.agentInputs?.find(input => input.id === wait.id)?.deliveredAt).toBeUndefined();
      const boundaries = store.readEvents(p.id).filter(event => event.type === 'turn-end').length;
      session!.sendMessage([{ type: 'text', text: 'mock:cezar-ask' }]);
      await until(() => store.readEvents(p.id).filter(event => event.type === 'turn-end').length > boundaries);
      expect(store.readEvents(p.id).some(event => event.type === 'ask.requested')).toBe(true);
      expect(waitOf(store.getRun(p.id))?.id).toBe(wait.id);
      expect(store.getRun(p.id)?.agentInputs?.[0]?.deliveredAt).toBeUndefined();
      expect(store.readEvents(p.id).filter(event => event.type === 'human-input-delivered')).toEqual([]);
      // hearsay-tools/cezarion#1235 ("Messages beside a pending question"): the question no longer
      // holds the wake back. Once the backend takes input, the result is delivered beside the card,
      // which stays pending and answerable; it used to release the admission and wait for the answer.
      send.mockRestore();
      await until(() => !!store.getRun(p.id)?.agentInputs?.[0]?.deliveredAt);
      expect(hasPendingAsk(store, p.id)).toBe(true);
      expect(waitOf(store.getRun(p.id))).toBeUndefined();
      expect(store.readEvents(p.id).filter(event => event.type === 'human-input-delivered')).toEqual([]);
    });
  }

for (const role of ['root', 'worker'] as const) {
    it(`${role}: restart re-admits a persisted human answer before its first boundary`, async () => {
      const replyGate = join(root, 'release-human-reply'); const wire = controlledWire({ humanAnswerGate: replyGate });
      const p = await parent('mock:cezar-ask');
      await until(() => store.getRun(p.id)?.status === 'waiting');
      const w = await worker(p.id, 'mock:cezar-ask');
      const target = role === 'root' ? p : w;
      if (role === 'worker') {
        // A worker's question is its parent's to answer (hearsay-tools/cezarion#2410).
        grantSteer(p.id);
        manager.enqueueOwnedRun(w.id);
        await until(() => store.getRun(w.id)?.status === 'waiting' && store.transcriptFacts(w.id).pendingAsk?.routedMessageId !== undefined);
      }
      const sessions = [...work.liveSessions];
      const session = role === 'root' ? sessions[0] : sessions[1];
      expect(session).toBeDefined();
      session!.end();
      await until(() => !manager.isActive(target.id));
      // Only an explicit answer may answer the ask: the human's Continue on the root, the parent's
      // reply on the worker, which reopens it through the same human-origin continuation.
      if (role === 'root') expect(manager.continueRun(target.id, { text: 'human answer mock:hold' }).ok).toBe(true);
      else await answerAsParent(store, manager, p.id, w.id, 'human answer mock:hold');
      await until(() => store.getRun(target.id)?.continuationMessage !== undefined);
      if (role === 'root') setRunStatus(store, w.id, RUN_STATUS.queued, { finishedAt: undefined });
      // The transcripts belong to the crash checkpoint too: the cancel below closes a worker's
      // question as it stops (hearsay-tools/cezarion#2410), which a crash never writes.
      store.flush(); const checkpoint = readPersistedRuns(join(root, '.ai/cezar')); const events = eventCheckpoint();
      expect(store.getRun(target.id)?.continuationMessage?.origin).toBe('human');
      await until(() => manager.isActive(target.id) && store.getRun(target.id)?.steps.some(step => !!step.sessionId) === true);
      // The real wire received the accepted input but cannot reply until released.
      await until(() => wire.received() === 1);
      manager.cancel(target.id);
      await until(() => !manager.isActive(target.id));
      expect(store.readEvents(target.id).filter(event => event.type === 'human-input-delivered')).toEqual([]);
      await restart(false, checkpoint, events);
      expect(store.getRun(target.id)?.status).not.toBe('failed');
      expect(store.getRun(w.id)?.status).not.toBe('cancelled');
      expect(store.readEvents(target.id).filter(event => event.type === 'human-input-delivered')).toEqual([]);
      // A miss names the count, each wire's start and stdin lines, and the target's timeline
      // with event times (hearsay-tools/squawk#2535).
      await until(() => wire.received() === 2, () => `${wire.received()} human answers reached the wire; wire processes:\n${wire.inputs()}\n${timeline(target.id)}`);
      expect(store.readEvents(target.id).filter(event => event.type === 'human-input-delivered')).toEqual([]);
      writeFileSync(replyGate, 'release');
      await until(() => store.readEvents(target.id).some(event => event.type === 'human-input-delivered'));
      expect(store.readEvents(target.id).filter(event => event.type === 'human-input-delivered')).toEqual([expect.objectContaining(role === 'root' ? {} : { source: 'parent' })]);
      if (role === 'root') expect(store.readEvents(target.id).filter(event => event.type === 'user-message').at(-1)?.text).toContain('human answer');
    });
  }
});
