import { expect, describe, it } from 'vitest';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS, driveSeam } from '../core/harness-parity.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { manager, store, until, semaphore, useWorkerWaitFixture } from './worker-wait.testkit.ts';
import { ACK_TEXT, ASK_TEXT, REJECTED_ASK_TEXT, messagesPrompt } from './monitoring-turn.testkit.ts';
import { CHANNEL_WIRES, withChannelWire } from './monitoring-channel-order.testkit.ts';

const GATE = 'Please review the changes before I continue.';
it('enumerates every native channel-divergence capability', () => {
  expect(Object.keys(CHANNEL_WIRES).sort()).toEqual([...RUNNER_IDS].sort());
});
for (const backend of RUNNER_IDS) describe(`${backend} channel order`, { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  for (const direction of ['missing', 'refresh'] as const) {
    const gap = CHANNEL_WIRES[backend][direction] ? '' : `wire exemption: ${CHANNEL_WIRES[backend].reason}`;
    it(`${direction} observes actual v1/v2 native text ${gap}`, async () => withChannelWire(backend, direction, async () => {
      const seam = await driveSeam(backend, 'turn-messages', { spec: { userPrompt: messagesPrompt(backend, [GATE, 'CEZ:MONITORING', ACK_TEXT]) } });
      const v1 = seam.v1.flatMap(event => event.type === 'text' ? [event.text] : []).join('\n');
      const v2 = seam.v2.flatMap(event => event.type === 'item.completed' && event.item.kind === 'message' && event.item.role === 'assistant' ? [event.item.text] : []).filter(Boolean).join('\n');
      expect(v1).toContain(GATE); expect(v2).toContain(GATE);
      if (!CHANNEL_WIRES[backend][direction]) expect(v1).toBe(v2);
      else {
        expect(v1.includes('CEZ:MONITORING')).toBe(direction === 'missing');
        expect(v2.includes('CEZ:MONITORING')).toBe(direction === 'refresh');
      }
    }));
    for (const mode of ['fresh', 'continuation'] as const) for (const done of [false, true]) {
      it(`${mode} ${done ? 'M30' : 'M29'} ${direction} later declaration precedes a stale channel gate ${gap}`, async () => withChannelWire(backend, direction, async () => {
        process.env.CEZ_DRY_RUN = '0';
        process.env.CEZ_REVIEW_GATE = '0';
        process.env[HARNESS_ADAPTERS[backend].binEnv] = HARNESS_ADAPTERS[backend].mockBin;
        for (const earlier of [GATE, ASK_TEXT, REJECTED_ASK_TEXT]) {
          const p = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:hold', runner: backend });
          await until(() => store.getRun(p.id)?.status === 'waiting');
          if (mode === 'continuation') {
            expect(manager.finish(p.id)).toBe(true);
            await until(() => !manager.isActive(p.id));
            expect(manager.continueRun(p.id, { text: 'mock:hold' }).ok).toBe(true);
            await until(() => store.getRun(p.id)?.status === 'waiting');
          }
          const boundaries = store.readEvents(p.id).filter(event => event.type === 'turn-end').length;
          expect(manager.sendMessage(p.id, [{ type: 'text', text: messagesPrompt(backend, [earlier, done ? 'CEZ:DONE' : 'CEZ:MONITORING', ACK_TEXT]) }])).toBe(true);
          await until(() => store.readEvents(p.id).filter(event => event.type === 'turn-end').length > boundaries && semaphore.busy() === 0);
          const run = () => store.getRun(p.id)!;
          if (done) { await until(() => !manager.isActive(p.id)); expect(run().status).toBe('done'); }
          else if (earlier === GATE) expect(run()).toMatchObject({ status: 'running', activity: 'monitoring' });
          else {
            expect(run().status).toBe('waiting');
            expect(run().hasPendingHumanAsk).toBe(earlier === ASK_TEXT ? true : undefined);
            expect(run().invalidAsk).toBe(earlier === REJECTED_ASK_TEXT ? true : undefined);
          }
          expect(store.readEvents(p.id).filter(event => event.type === 'ask.requested')).toHaveLength(!done && earlier === ASK_TEXT ? 1 : 0);
        }
      }));
    }
  }
});
