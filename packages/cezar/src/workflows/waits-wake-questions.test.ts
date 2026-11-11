import { WAIT_KIND, RUN_STATUS, WAIT_PHASE } from '@open-mercato/cezar-contract/test-factories.testkit';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { manager, root, semaphore, store, until, work } from './worker-wait.testkit.ts';
import { observationClock } from '../core/observation-clock.testkit.ts';
import { IDLE_TIMEOUT_MS } from './run/constants.ts';
import { hasPendingAsk } from '../runs/run-store.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { toolCall } from './waits-parity.testkit.ts';
import {
  prUrl,
  pr,
  github,
  nativeWire,
  pump,
  openWait,
  turnEnds,
  asks,
  waitById,
  settled,
  prompted,
  label,
  answered,
  flushMicrotasks,
  questionBesideCi,
  useWaitsWakeFixture,
} from './waits-wake.testkit.ts';

// hearsay-tools/cezarion#1233: a resolved wait beside a pending question, and which parks hold a slot.
// Shared setup: waits-wake.testkit.ts.

describe('wakes beside questions, footers and slots (hearsay-tools/cezarion#1233): questions and slots', { timeout: 45_000 }, () => {
  useWaitsWakeFixture();

  for (const runner of ['claude', 'codex'] as const) {
    it(`${runner} U3b a CI result beside a pending portable question is delivered, the card stays answerable, and the answer keeps its askSeq`, async () => {
      const external = github();
      const { run, ci, askSeq } = await questionBesideCi(runner);
      const turns = turnEnds(run.id);
      external.settle();
      await until(() => settled(run.id, ci.id)?.phase === 'delivered' && prompted(runner, `CI wait observation ${ci.id}`).length > 0);
      await until(() => turnEnds(run.id) > turns && store.getRun(run.id)?.status === 'waiting');
      expect(hasPendingAsk(store, run.id)).toBe(true);
      expect(label(run.id)).toBe('needs you');
      expect(store.readEvents(run.id).filter(event => event.type === 'human-input-delivered')).toEqual([]);
      expect(manager.sendMessage(run.id, [{ type: 'text', text: 'Vitest' }])).toBe(true);
      await until(() => answered(run.id, askSeq));
      // The answer's own turn end gets the no-wait nudge (hearsay-tools/cezarion#1234): the card
      // pending now is the one the mock answered it with, not the answered one.
      await until(() => asks(run.id).length === 2 && store.getRun(run.id)?.status === 'waiting');
      expect(asks(run.id)[1]).toMatchObject({ questions: [expect.objectContaining({ header: 'Next step' })] });
    });
  }

  it('codex a CI result during a native question waits for the answer and its turn end', async () => {
    const external = github();
    nativeWire('codex');
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:native-codex-ask', runner: 'codex' });
    await until(() => asks(run.id).length === 1 && store.getRun(run.id)?.status === 'waiting');
    const ci = await openWait(run.id, { kind: WAIT_KIND.pr, pr, timeout_seconds: 600 });
    external.settle();
    await until(() => waitById(run.id, ci.id)?.phase === 'resolved');
    // The question holds its turn open: nothing may reach the wire, however often the line is pumped.
    await pump();
    await flushMicrotasks();
    expect(store.getRun(run.id)?.agentInputs?.find(input => input.id === ci.id)?.deliveredAt).toBeUndefined();
    expect(existsSync(join(root, 'args')) && readFileSync(join(root, 'args'), 'utf8').includes(ci.id)).toBe(false);
    expect(manager.sendMessage(run.id, [{ type: 'text', text: 'Library: Vitest' }])).toBe(true);
    await until(() => settled(run.id, ci.id)?.phase === 'delivered' && prompted('codex', `CI wait observation ${ci.id}`).length > 0);
    const events = store.readEvents(run.id);
    const answer = events.find(event => event.type === 'human-input-delivered')!;
    const answeredTurnEnd = events.find(event => event.type === 'turn-end' && event.seq > answer.seq)!;
    expect(answeredTurnEnd).toBeDefined();
    expect(prompted('codex', `CI wait observation ${ci.id}`)).toHaveLength(1);
    await until(() => store.getRun(run.id)?.status === 'waiting');
  });

  it('claude a CI result after a pending question idle-closed reopens through a scheduler continuation and re-parks as Needs you', async () => {
    const external = github();
    const idle = observationClock(delay => delay === IDLE_TIMEOUT_MS &&
      /\bat (?:[^ (\n]+\.)?armIdleTimer \(/.test(new Error().stack ?? ''));
    const { run, ci, askSeq } = await questionBesideCi('claude');
    await idle.advance(IDLE_TIMEOUT_MS);
    await until(() => !manager.isActive(run.id));
    expect(store.getRun(run.id)).toMatchObject({ status: RUN_STATUS.waiting, waits: expect.arrayContaining([expect.objectContaining({ kind: WAIT_KIND.human, phase: WAIT_PHASE.open })]) });
    expect(waitById(run.id, ci.id)?.phase).toBe('open');
    external.settle();
    await until(() => settled(run.id, ci.id)?.phase === 'delivered' && prompted('claude', `CI wait observation ${ci.id}`).length > 0);
    await until(() => manager.isActive(run.id) && store.getRun(run.id)?.status === 'waiting');
    expect(hasPendingAsk(store, run.id)).toBe(true);
    expect(label(run.id)).toBe('needs you');
    expect(manager.sendMessage(run.id, [{ type: 'text', text: 'Vitest' }])).toBe(true);
    // The continuation's opening prompt repeats the task, so the mock asks again; the answer goes to
    // the run's current question.
    await until(() => answered(run.id, asks(run.id).at(-1)!.seq));
    expect(asks(run.id)[0]!.seq).toBe(askSeq);
  });

  it('pool members beyond maxMonitoringSessions hold regular slots; one leaving frees one and pumps', async () => {
    github();
    nativeWire('claude');
    vi.spyOn(semaphore, 'maxMonitoringSessions').mockReturnValue(1);
    expect(semaphore.maxParallel()).toBe(1);
    const parkOn = async (n: number) => {
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_wait', { kind: WAIT_KIND.pr, pr: prUrl(n) }), runner: 'claude' });
      await until(() => store.getRun(run.id)?.waits?.[0]?.phase === 'open' && store.getRun(run.id)?.status === 'waiting');
      return run;
    };
    const first = await parkOn(12);
    expect(semaphore.busy()).toBe(0); // the pool slot
    const second = await parkOn(13);
    expect(semaphore.busy()).toBe(1); // past the pool: its regular slot
    const third = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS.claude.scenarios.baseline!, runner: 'claude' });
    expect(store.getRun(third.id)?.status).toBe('queued');
    await Promise.all([...work.pending].filter(([, label]) => label === 'pump').map(([task]) => task));
    expect(manager.cancel(first.id)).toBe(true);
    await until(() => store.getRun(third.id)?.status === 'waiting');
    expect(store.readEvents(third.id).filter(event => event.type === 'step-start')).toHaveLength(1);
    expect(store.getRun(second.id)?.waits?.[0]?.phase).toBe('open');
  });
});
