import { WAIT_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { describe, expect, it } from 'vitest';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { manager, restart, root, store, until, work } from './worker-wait.testkit.ts';
import { observationClock } from '../core/observation-clock.testkit.ts';
import { noJitter, retryDelayMs, WAKE_RETRY_BACKOFF } from '../delegation/retry-backoff.ts';
import { MAX_WAKE_DELIVERY_ATTEMPTS, WAITS_DISCARDED_NOTE, WAKE_DELIVERY_CAP_NOTE } from './run.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { persistentWakeFailure, TIMER_WAKE_OPENING } from './waits-parity.testkit.ts';
import {
  pr,
  github,
  nativeWire,
  session,
  wakeRetryClock,
  openWait,
  fireTimer,
  turnEnds,
  waitById,
  settled,
  prompted,
  FOOTER_END,
  notes,
  timerOwedWithoutSession,
  useWaitsWakeFixture,
} from './waits-wake.testkit.ts';

// hearsay-tools/cezarion#1233: what every delivered turn ends with, failed wake deliveries across
// restarts, usage limits and Stop. Shared setup: waits-wake.testkit.ts.

describe('wakes beside questions, footers and slots (hearsay-tools/cezarion#1233): delivery, failures and Stop', { timeout: 45_000 }, () => {
  useWaitsWakeFixture();

  it('claude every delivered turn ends with the open-waits footer, and none when nothing is open', async () => {
    github();
    nativeWire('claude');
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS.claude.scenarios.baseline!, runner: 'claude' });
    await until(() => store.getRun(run.id)?.status === 'waiting');
    expect(manager.sendMessage(run.id, [{ type: 'text', text: 'first message' }])).toBe(true);
    await until(() => prompted('claude', 'first message').length > 0);
    expect(prompted('claude', 'first message')[0]).not.toContain('Still open');
    await until(() => store.getRun(run.id)?.status === 'waiting' && turnEnds(run.id) >= 2);
    const ci = await openWait(run.id, { kind: WAIT_KIND.pr, pr, timeout_seconds: 600 });
    const footer = `Still open: CI wait ${ci.id} for acme/repo#12, deadline ${ci.deadline}. ${FOOTER_END}`;
    expect(manager.sendMessage(run.id, [{ type: 'text', text: 'second message' }])).toBe(true);
    await until(() => prompted('claude', 'second message').length > 0);
    expect(prompted('claude', 'second message')[0]!.trimEnd().endsWith(footer)).toBe(true);
    await until(() => store.getRun(run.id)?.status === 'waiting' && turnEnds(run.id) >= 3);
    // A continuation's opening prompt is a delivered turn too.
    session().end();
    await until(() => !manager.isActive(run.id));
    expect(manager.continueRun(run.id, { text: 'third message' }).ok).toBe(true);
    await until(() => prompted('claude', 'third message').length > 0);
    expect(prompted('claude', 'third message')[0]!.trimEnd().endsWith(footer)).toBe(true);
    expect(waitById(run.id, ci.id)?.phase).toBe('open');
  });

  it('claude a failed wake delivery retries after its backoff, not at once, and Continue resets the count', async () => {
    nativeWire('claude');
    persistentWakeFailure(root, 'claude');
    const retry = wakeRetryClock();
    const { run, timer } = await timerOwedWithoutSession();
    fireTimer(timer.id);
    // The backoff is armed before the failing session is dropped.
    await until(() => store.getRun(run.id)?.waitDeliveryFailures === 1 && !manager.isActive(run.id) && retry.pending === 1);
    // The failed attempt armed the backoff instead of the next continuation: nothing runs or queues.
    expect(retry.delays).toEqual([retryDelayMs(0, WAKE_RETRY_BACKOFF, noJitter)]);
    await retry.advance(retryDelayMs(0, WAKE_RETRY_BACKOFF, noJitter) / 2);
    await Promise.all([...work.pending].filter(([, label]) => label === 'pump').map(([task]) => task));
    expect(prompted('claude', TIMER_WAKE_OPENING)).toHaveLength(1);
    expect(manager.isActive(run.id)).toBe(false);
    expect(store.getRun(run.id)?.status).toBe('waiting');
    expect(waitById(run.id, timer.id)?.phase).toBe('resolved');
    expect(store.getRun(run.id)?.waitDeliveryFailures).toBe(1);
    // The backoff owns the retry: when it fires, the second attempt starts and backs off further.
    retry.fire(0);
    await until(() => store.getRun(run.id)?.waitDeliveryFailures === 2 && !manager.isActive(run.id) && retry.captured === 2);
    expect(prompted('claude', TIMER_WAKE_OPENING)).toHaveLength(2);
    expect(retry.delays).toEqual([0, 1].map(attempt => retryDelayMs(attempt, WAKE_RETRY_BACKOFF, noJitter)));
    await retry.advance(retryDelayMs(1, WAKE_RETRY_BACKOFF, noJitter) / 2);
    await Promise.all([...work.pending].filter(([, label]) => label === 'pump').map(([task]) => task));
    expect(prompted('claude', TIMER_WAKE_OPENING)).toHaveLength(2);
    expect(store.getRun(run.id)?.waitDeliveryFailures).toBe(2);
    // Continue is a human act: it clears the count and the pending backoff, and delivers the result.
    expect(manager.continueRun(run.id, { text: 'go on' }).ok).toBe(true);
    expect(retry.pending).toBe(0);
    expect(store.getRun(run.id)?.waitDeliveryFailures).toBeUndefined();
    await until(() => settled(run.id, timer.id)?.phase === 'delivered' && prompted('claude', TIMER_WAKE_OPENING).length >= 2);
    expect(prompted('claude', TIMER_WAKE_OPENING)).toHaveLength(2);
  });

  it('claude the delivery-failure count survives a restart', async () => {
    nativeWire('claude');
    persistentWakeFailure(root, 'claude');
    const retry = wakeRetryClock();
    const { run, timer } = await timerOwedWithoutSession();
    fireTimer(timer.id);
    await until(() => store.getRun(run.id)?.waitDeliveryFailures === 1 && !manager.isActive(run.id) && retry.pending === 1);
    retry.fire(0);
    await until(() => store.getRun(run.id)?.waitDeliveryFailures === 2 && !manager.isActive(run.id) && retry.captured === 2);
    expect(store.getRun(run.id)?.waitDeliveryFailures).toBe(2);
    await restart();
    expect(store.getRun(run.id)?.waitDeliveryFailures).toBe(2);
    // The third failed attempt, the first after the restart, reaches the bound.
    await until(() => store.getRun(run.id)?.status === 'failed' && !manager.isActive(run.id));
    expect(prompted('claude', TIMER_WAKE_OPENING)).toHaveLength(MAX_WAKE_DELIVERY_ATTEMPTS);
    expect(notes(run.id, WAKE_DELIVERY_CAP_NOTE)).toHaveLength(1);
    expect(waitById(run.id, timer.id)?.phase).toBe('resolved');
    expect(store.getRun(run.id)?.waitDeliveryFailures).toBeUndefined();
  });

  it('claude a failed run holding a wait result keeps it and its armed open wait across a restart, and Stop discards them', async () => {
    nativeWire('claude');
    persistentWakeFailure(root, 'claude');
    const retry = wakeRetryClock();
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS.claude.scenarios.baseline!, runner: 'claude' });
    await until(() => store.getRun(run.id)?.status === 'waiting');
    const timer = await openWait(run.id, { kind: WAIT_KIND.timer, seconds: 60, note: 'owed' });
    const later = await openWait(run.id, { kind: WAIT_KIND.timer, seconds: 7200, note: 'later' });
    session().end();
    await until(() => !manager.isActive(run.id));
    fireTimer(timer.id);
    for (let attempt = 0; attempt < MAX_WAKE_DELIVERY_ATTEMPTS - 1; attempt++) {
      await until(() => retry.captured === attempt + 1 && !manager.isActive(run.id));
      retry.fire(attempt);
    }
    await until(() => store.getRun(run.id)?.status === 'failed' && !manager.isActive(run.id));
    const restored = observationClock(() => /\bat (?:[^ (\n]+\.)?armWait \(/.test(new Error().stack ?? ''));
    await restart();
    // Recovery keeps the held result and re-arms the open wait, and nothing wakes the failed run.
    expect(store.getRun(run.id)?.status).toBe('failed');
    expect(waitById(run.id, timer.id)?.phase).toBe('resolved');
    expect(waitById(run.id, later.id)?.phase).toBe('open');
    expect(restored.captured).toBe(1);
    expect(restored.pending).toBe(1);
    expect(manager.isActive(run.id)).toBe(false);
    expect(prompted('claude', TIMER_WAKE_OPENING)).toHaveLength(MAX_WAKE_DELIVERY_ATTEMPTS);
    // Stop discards what the failed run held; the run stays failed.
    expect(manager.cancel(run.id)).toBe(true);
    expect(store.getRun(run.id)?.waits ?? []).toEqual([]);
    expect(store.getRun(run.id)?.status).toBe('failed');
    expect(restored.pending).toBe(0);
    restored.fire(0);
    expect(store.getRun(run.id)?.waits ?? []).toEqual([]);
  });

  it('claude a usage-limited wake continuation is not counted: the run waits for the usage-limit resume and keeps its result', async () => {
    const retry = wakeRetryClock();
    nativeWire('claude');
    persistentWakeFailure(root, 'claude', { usageLimit: true });
    // Far out, so the resume never fires during the test.
    process.env.CEZ_MOCK_LIMIT_RESET_SECONDS = '3600';
    const { run, timer } = await timerOwedWithoutSession();
    fireTimer(timer.id);
    // The usage-limit resume is scheduled as the failed session is dropped; the run waits for it
    // (hearsay-tools/cezarion#1236).
    await until(() => store.getRun(run.id)?.status === 'waiting' && !!store.getRun(run.id)?.autoResumeAt && !manager.isActive(run.id));
    expect(prompted('claude', TIMER_WAKE_OPENING)).toHaveLength(1);
    expect(store.getRun(run.id)?.autoResumeAt).toBeDefined();
    expect(waitById(run.id, timer.id)?.phase).toBe('resolved');
    expect(store.getRun(run.id)?.waitDeliveryFailures).toBeUndefined();
    expect(retry.pending).toBe(0);
    expect(notes(run.id, 'could not deliver wait results')).toEqual([]);
  });

  it('claude Stop on a usage-limited failed run holding a wait result discards it and cancels the automatic resume, so no session starts later', async () => {
    const resume = observationClock(() => /\bat (?:[^ (\n]+\.)?armAutoResume \(/.test(new Error().stack ?? ''));
    nativeWire('claude');
    persistentWakeFailure(root, 'claude', { usageLimit: true });
    process.env.CEZ_MOCK_LIMIT_RESET_SECONDS = '3600';
    const { run, timer } = await timerOwedWithoutSession();
    fireTimer(timer.id);
    await until(() => store.getRun(run.id)?.status === 'waiting' && !manager.isActive(run.id) && !!store.getRun(run.id)?.autoResumeAt);
    const resumeDelay = Date.parse(store.getRun(run.id)!.autoResumeAt!) - Date.now();
    expect(manager.cancel(run.id)).toBe(true);
    await resume.advance(resumeDelay + 1);
    await Promise.all([...work.pending].filter(([, label]) => label === 'pump').map(([task]) => task));
    expect(store.getRun(run.id)?.waits ?? []).toEqual([]);
    expect(settled(run.id, timer.id)?.phase).toBe('cancelled');
    expect(store.getRun(run.id)?.status).toBe('failed');
    // The resume would have started a provider session on a run Stop just discarded.
    expect(resume.pending).toBe(0);
    expect(store.getRun(run.id)?.autoResumeAt).toBeUndefined();
    expect(notes(run.id, 'automatic resume cancelled for this task')).toHaveLength(1);
    expect(notes(run.id, WAITS_DISCARDED_NOTE)).toHaveLength(1);
    expect(manager.isActive(run.id)).toBe(false);
  });

  it('claude Stop on a usage-limited run without waits is refused and leaves its automatic resume armed', async () => {
    const resume = observationClock(() => /\bat (?:[^ (\n]+\.)?armAutoResume \(/.test(new Error().stack ?? ''));
    nativeWire('claude');
    process.env.CEZ_MOCK_LIMIT_RESET_SECONDS = '3600';
    // A usage-limited first turn fails the run without any wait.
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:limit ship it', runner: 'claude' });
    await until(() => store.getRun(run.id)?.status === 'waiting' && !manager.isActive(run.id) && !!store.getRun(run.id)?.autoResumeAt);
    expect(store.getRun(run.id)?.waits ?? []).toEqual([]);
    expect(manager.cancel(run.id)).toBe(false);
    expect(resume.pending).toBe(1);
    expect(notes(run.id, WAITS_DISCARDED_NOTE)).toEqual([]);
  });
});
