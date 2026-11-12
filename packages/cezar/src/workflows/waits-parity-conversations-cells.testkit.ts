import { waitPartDescribers, conversingParent, askPrompt, pendingQuestion, asks, turnEnds, delivered, prompted, answered, humanOpen, listed, settled } from './waits-parity-fixture.testkit.ts';
import { MAX_AUTO_CONTINUES } from './run.ts';
import { randomUUID } from 'node:crypto';
import { it as registerTest, expect } from 'vitest';
import { deriveAttention } from '@open-mercato/cezar-contract/attention';
import { WAIT_PHASE, RUN_STATUS, WAIT_SOURCE } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { RunnerId } from '../core/agent-runner.ts';
import { manager, until, store, fixtureUpdateRun, semaphore } from './worker-wait-core.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';

// The conversations part of the wait parity cells (`WAIT_PARITY_PARTS` in `waits-parity-catalog.testkit.ts`).
// A wait parity file imports this module first, so it loads no other part's cells (hearsay-tools/cezarion#3242).
export const { describeWaitParity } = waitPartDescribers('conversations', conversationsCells);

export function conversationsCells(runners: RunnerId[], it: typeof registerTest = registerTest): void {
  for (const runner of runners) {
    it(`${runner} U19 a worker message beside a pending portable question is delivered and the question stays answerable`, async () => {
      const f = await conversingParent(runner);
      expect(manager.sendMessage(f.p.id, [{ type: 'text', text: askPrompt() }])).toBe(true);
      await until(() => pendingQuestion(f.p.id) && asks(f.p.id).length === 1);
      const askSeq = asks(f.p.id)[0]!.seq;
      const turns = turnEnds(f.p.id);
      const id = await f.progress('Worker progress u19');
      await until(() => delivered(f.p.id, id) && prompted(runner, 'Worker progress u19').length > 0);
      // Delivered beside the card, which no message answers or replaces: after the beside turn the
      // pending question is still the original one, with its askSeq.
      await until(() => turnEnds(f.p.id) > turns && pendingQuestion(f.p.id));
      expect(answered(f.p.id, askSeq)).toBe(false);
      expect(asks(f.p.id).map(event => event.seq)).toEqual([askSeq]);
      expect(humanOpen(f.p.id)).toEqual([expect.objectContaining({ phase: WAIT_PHASE.open, askSeq })]);
      expect(store.transcriptFacts(f.p.id).pendingAsk?.seq).toBe(askSeq);
      expect(deriveAttention(store.getRun(f.p.id)!).label).toBe('needs you');
      // The human's answer checkpoints that same question.
      expect(manager.sendMessage(f.p.id, [{ type: 'text', text: 'Parser' }])).toBe(true);
      await until(() => answered(f.p.id, askSeq));
    });

    /** Another root task of the project (hearsay-tools/cezarion#1990): a record with no session,
     *  whose authenticated caller sends to `to` through the conversing parent's service. */
    function peerOf(f: Awaited<ReturnType<typeof conversingParent>>, to: string) {
      const peer = store.createRun({ title: 'peer', task: 'peer', workflow: 'quick-task', runner: 'claude', steps: [] });
      setRunStatus(store, peer.id, RUN_STATUS.running, { delegation: { role: 'root', permissions: ['spawn', 'wait', 'steer', 'inspect'], receipts: [] } });
      const progress = async (text: string) => {
        const id = randomUUID();
        await f.service.send(f.callerFor(peer.id), { id, recipientRunId: to, kind: 'progress', text, timeoutSeconds: 600 });
        return id;
      };
      return { id: peer.id, progress };
    }
    const peerWakeNotes = (id: string) => store.readEvents(id).filter(event => event.type === 'note' && String(event.message).startsWith('automatic peer message wake-up'));

    it(`${runner} U19p a peer message beside a pending portable question is delivered with its peer attribution and the question stays answerable`, async () => {
      const f = await conversingParent(runner);
      const peer = peerOf(f, f.p.id);
      expect(manager.sendMessage(f.p.id, [{ type: 'text', text: askPrompt() }])).toBe(true);
      await until(() => pendingQuestion(f.p.id) && asks(f.p.id).length === 1);
      const askSeq = asks(f.p.id)[0]!.seq;
      const turns = turnEnds(f.p.id);
      const users = store.readEvents(f.p.id).filter(event => event.type === 'user-message').length;
      const id = await peer.progress('Peer progress u19p');
      await until(() => delivered(f.p.id, id) && prompted(runner, 'Peer progress u19p').length > 0);
      // The agent reads who sent it: the peer task, as a peer, never the user.
      const [prompt] = prompted(runner, 'Peer progress u19p');
      expect(prompt).toContain(`"senderRunId":"${peer.id}"`);
      expect(prompt).toContain('"relationship":"peer"');
      await until(() => turnEnds(f.p.id) > turns && pendingQuestion(f.p.id));
      expect(store.readEvents(f.p.id).filter(event => event.type === 'user-message')).toHaveLength(users);
      expect(answered(f.p.id, askSeq)).toBe(false);
      expect(asks(f.p.id).map(event => event.seq)).toEqual([askSeq]);
      expect(humanOpen(f.p.id)).toEqual([expect.objectContaining({ phase: WAIT_PHASE.open, askSeq })]);
      expect(store.transcriptFacts(f.p.id).pendingAsk?.seq).toBe(askSeq);
      expect(deriveAttention(store.getRun(f.p.id)!).label).toBe('needs you');
      expect(manager.sendMessage(f.p.id, [{ type: 'text', text: 'Parser' }])).toBe(true);
      await until(() => answered(f.p.id, askSeq));
    });

    it(`${runner} U19q a peer message that wakes a parked run spends one unit of the automatic-wake budget, a family message spends none, and past the budget a peer message stays queued until a human message`, async () => {
      const f = await conversingParent(runner);
      const peer = peerOf(f, f.p.id);
      // A family message wakes the parked parent and charges nothing.
      let turns = turnEnds(f.p.id);
      const family = await f.progress('Worker progress u19q');
      await until(() => delivered(f.p.id, family) && turnEnds(f.p.id) > turns && store.getRun(f.p.id)?.status === 'waiting');
      expect(peerWakeNotes(f.p.id)).toEqual([]);
      // A peer message that opens the wake turn spends the budget's last unit.
      fixtureUpdateRun(f.p.id, { automaticWakes: MAX_AUTO_CONTINUES - 1 });
      turns = turnEnds(f.p.id);
      const first = await peer.progress('Peer progress u19q one');
      await until(() => delivered(f.p.id, first) && peerWakeNotes(f.p.id).length === 1);
      expect(peerWakeNotes(f.p.id)).toEqual([expect.objectContaining({ message: `automatic peer message wake-up (${MAX_AUTO_CONTINUES}/${MAX_AUTO_CONTINUES})` })]);
      await until(() => turnEnds(f.p.id) > turns && store.getRun(f.p.id)?.status === 'waiting');
      // Past the budget the next peer message wakes nothing: it stays queued and Squawk's human wait opens.
      fixtureUpdateRun(f.p.id, { automaticWakes: MAX_AUTO_CONTINUES });
      const held = await peer.progress('Peer progress u19q held');
      expect(delivered(f.p.id, held)).toBe(false);
      expect(prompted(runner, 'Peer progress u19q held')).toEqual([]);
      expect(humanOpen(f.p.id)).toEqual([expect.objectContaining({ phase: WAIT_PHASE.open, source: WAIT_SOURCE.cezar })]);
      expect(deriveAttention(store.getRun(f.p.id)!).label).toBe('needs you');
      // A human message restarts the budget, and its turn takes the held message.
      expect(manager.sendMessage(f.p.id, [{ type: 'text', text: 'Carry on' }])).toBe(true);
      await until(() => delivered(f.p.id, held) && prompted(runner, 'Peer progress u19q held').length > 0);
      expect(store.getRun(f.p.id)?.automaticWakes ?? 0).toBeLessThan(MAX_AUTO_CONTINUES);
      expect(peerWakeNotes(f.p.id)).toHaveLength(1);
    });

    // hearsay-tools/cezarion#1995 (R9, R11): the peer wait, the one wait a message closes, and only
    // a named peer's message.
    it(`${runner} U19w a peer wait parks a root that reads waiting on 1 task; a family message wakes it and the wait stays open; the named peer's message resolves it and is delivered with its result`, async () => {
      const f = await conversingParent(runner);
      const peer = peerOf(f, f.p.id);
      const wait = manager.registerPeerWait(f.p.id, { peerIds: [peer.id], timeoutSeconds: 600 }, 'cez-message-wait');
      await until(() => store.getRun(f.p.id)?.status === RUN_STATUS.waiting && listed(f.p.id, wait.id) !== undefined && semaphore.busy() === 0);
      expect(deriveAttention(store.getRun(f.p.id)!)).toMatchObject({ bucket: 'none', label: 'waiting on 1 task' });
      const turns = turnEnds(f.p.id);
      const family = await f.progress('Worker progress u19w');
      await until(() => delivered(f.p.id, family) && turnEnds(f.p.id) > turns && store.getRun(f.p.id)?.status === RUN_STATUS.waiting);
      expect(listed(f.p.id, wait.id)).toMatchObject({ phase: WAIT_PHASE.open });
      const id = await peer.progress('Peer progress u19w');
      await until(() => delivered(f.p.id, id) && settled(f.p.id, wait.id)?.phase === WAIT_PHASE.delivered);
      expect(settled(f.p.id, wait.id)).toMatchObject({ result: { reason: 'message', peerRunId: peer.id, messageId: id } });
      await until(() => prompted(runner, 'Peer progress u19w').length > 0 && prompted(runner, `Peer wait ${wait.id}`).length > 0);
      expect(prompted(runner, `Peer wait ${wait.id}`)[0]).toContain(`task ${peer.id} sent message ${id}`);
    });

    // hearsay-tools/cezarion#1301: a blocked done at the turn end is answered with the refusal
    // `cezar_done` gives mid-turn, as one automatic turn, and Squawk opens no wait.
  }
}
