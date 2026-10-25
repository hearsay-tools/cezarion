import { expect, describe, it } from 'vitest';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS, driveSeam } from '../core/harness-parity.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { manager, store, until, semaphore, useWorkerWaitFixture } from './worker-wait.testkit.ts';
import { ACK_TEXT, ASK_TEXT, REJECTED_ASK_TEXT, messagesPrompt } from './monitoring-turn.testkit.ts';
import { CHANNEL_WIRES, withChannelWire } from './monitoring-channel-order.testkit.ts';
import { monitoringWakeOf } from './waits.testkit.ts';
import { hasPendingAsk } from '../runs/run-store.testkit.ts';

const GATE = 'Please review the changes before I continue.';
/** A turn-messages input with the mock's channel-wire token, when the direction has one. */
const tokened = (prompt: string, token: string) => token ? `${prompt} ${token}` : prompt;
it('enumerates every native channel-divergence capability', () => {
  expect(Object.keys(CHANNEL_WIRES).sort()).toEqual([...RUNNER_IDS].sort());
});
for (const backend of RUNNER_IDS) describe(`${backend} channel order`, { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  // Each divergent direction the wire has, plus one coupled-wire control when it lacks one: two
  // controls would drive the same untokened wire twice (hearsay-tools/cezarion#1665).
  const unsupported = (['missing', 'refresh'] as const).find(direction => !CHANNEL_WIRES[backend][direction]);
  for (const direction of (['missing', 'refresh'] as const).filter(direction => CHANNEL_WIRES[backend][direction] || direction === unsupported)) {
    const gap = CHANNEL_WIRES[backend][direction] ? '' : `wire exemption: ${CHANNEL_WIRES[backend].reason}`;
    const label = gap ? 'coupled control' : direction;
    it(`${label} observes actual v1/v2 native text ${gap}`, async () => withChannelWire(backend, direction, async token => {
      const seam = await driveSeam(backend, 'turn-messages', { spec: { userPrompt: tokened(messagesPrompt(backend, [GATE, 'CEZ:MONITORING', ACK_TEXT]), token) } });
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
      it(`${mode} ${done ? 'M30' : 'M29'} ${label} later declaration precedes a stale channel gate ${gap}`, async () => withChannelWire(backend, direction, async token => {
        process.env.CEZ_DRY_RUN = '0';
        process.env.CEZ_REVIEW_GATE = '0';
        process.env[HARNESS_ADAPTERS[backend].binEnv] = HARNESS_ADAPTERS[backend].mockBin;
        // A later DONE ends the run whatever came first, so M30 drives the structured ASK it must
        // supersede; its prose and rejected-ASK earliers are in turn-end-text.test.ts (hearsay-tools/cezarion#1665).
        for (const earlier of done ? [ASK_TEXT] : [GATE, ASK_TEXT, REJECTED_ASK_TEXT]) {
          const p = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:hold', runner: backend });
          await until(() => store.getRun(p.id)?.status === 'waiting');
          if (mode === 'continuation') {
            expect(manager.finish(p.id)).toBe(true);
            await until(() => !manager.isActive(p.id));
            expect(manager.continueRun(p.id, { text: 'mock:hold' }).ok).toBe(true);
            await until(() => store.getRun(p.id)?.status === 'waiting');
          }
          const boundaries = store.readEvents(p.id).filter(event => event.type === 'turn-end').length;
          expect(manager.sendMessage(p.id, [{ type: 'text', text: tokened(messagesPrompt(backend, [earlier, done ? 'CEZ:DONE' : 'CEZ:MONITORING', ACK_TEXT]), token) }])).toBe(true);
          await until(() => store.readEvents(p.id).filter(event => event.type === 'turn-end').length > boundaries && semaphore.busy() === 0);
          const run = () => store.getRun(p.id)!;
          if (done) { await until(() => !manager.isActive(p.id)); expect(run().status).toBe('done'); }
          else if (earlier === GATE) {
            expect(run()).toMatchObject({ status: 'waiting' });
            expect(monitoringWakeOf(run())).toBeDefined();
          }
          else {
            expect(run().status).toBe('waiting');
            expect(hasPendingAsk(store, p.id)).toBe(earlier === ASK_TEXT);
            expect(run().invalidAsk).toBe(earlier === REJECTED_ASK_TEXT ? true : undefined);
          }
          expect(store.readEvents(p.id).filter(event => event.type === 'ask.requested')).toHaveLength(!done && earlier === ASK_TEXT ? 1 : 0);
        }
      }));
    }
  }
});
