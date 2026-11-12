// Register the external CI mock before loading RunManager.
import { externalResource, generationOf, prUrl, registerPr, registerTimer, waitById, settledById, inputsFor, fireTimer, timerFired, flushMicrotasks, githubByPr, waitingParent, expectNoWaitHumanWait } from './ci-wait-fixture.testkit.ts';
import { WAIT_KIND, WAIT_PHASE } from '@open-mercato/cezar-contract/test-factories.testkit';

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WAIT_LIMIT, type Wait } from '@open-mercato/cezar-contract/waits';

import { controlledWire, manager, parent, root, semaphore, store, until, useWorkerWaitFixture } from './worker-wait-claude.testkit.ts';



describe('Wait list registration and resolution', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  afterEach(() => vi.restoreAllMocks());

  it('two CI waits for different PRs and a timer are open at once and resolve independently', async () => {
    const external = githubByPr();
    const run = await waitingParent();
    const first = await registerPr(run.id, 12);
    const second = await registerPr(run.id, 13);
    const timer = await registerTimer(run.id, 60, 'check the deploy');
    expect(store.getRun(run.id)?.waits?.map(wait => [wait.id, wait.phase])).toEqual([[first.id, 'open'], [second.id, 'open'], [timer.id, 'open']]);
    expect(store.getRun(run.id)?.status).toBe('waiting');
    external.settle(13);
    await until(() => settledById(run.id, second.id)?.phase === 'delivered');
    expect(inputsFor(run.id, second.id).map(input => input.text)).toEqual([expect.stringContaining(prUrl(13))]);
    expect([waitById(run.id, first.id)?.phase, waitById(run.id, timer.id)?.phase]).toEqual(['open', 'open']);
    fireTimer(timer.id);
    await until(() => settledById(run.id, timer.id)?.phase === 'delivered');
    expect(inputsFor(run.id, timer.id).map(input => input.text)).toEqual([timerFired(timer.id, 'check the deploy')]);
    expect(waitById(run.id, first.id)?.phase).toBe('open');
    external.settle(12);
    await until(() => settledById(run.id, first.id)?.phase === 'delivered');
    await expectNoWaitHumanWait(run.id);
    for (const wait of [first, second, timer]) expect(inputsFor(run.id, wait.id)).toHaveLength(1);
  });

  it('identical CI registration returns the existing wait id; a different timeout is refused without changing it', async () => {
    githubByPr();
    const run = await waitingParent();
    const wait = await registerPr(run.id, 12, 30);
    const again = await manager.registerWait(run.id, { kind: WAIT_KIND.pr, pr: 'https://github.com/Acme/Repo/pull/12', timeout_seconds: 30 }, 'cezar_wait', generationOf(run.id));
    expect(again).toMatchObject({ id: wait.id, deadline: wait.deadline, timeoutSeconds: 30, until: 'checks' as const, wakeOnConflict: true });
    await expect(registerPr(run.id, 12, 600)).rejects.toMatchObject({ code: 'duplicate_deadline', retainedWait: { id: wait.id, deadline: wait.deadline } });
    const timer = await registerTimer(run.id, 120, 'deploy');
    expect((await registerTimer(run.id, 120, 'deploy')).id).toBe(timer.id);
    expect((await registerTimer(run.id, 180, 'deploy')).id).not.toBe(timer.id);
    expect(store.getRun(run.id)?.waits).toHaveLength(3);
  });

  it('a timer registered with seconds=120 resolves at +120s with its note and enqueues one lifecycle input with the wait id', async () => {
    const run = await waitingParent();
    const charged = store.getRun(run.id)?.automaticWakes ?? 0;
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      const wait = await registerTimer(run.id, 120, 'check the deploy');
      expect(Date.parse(wait.deadline!) - Date.parse(wait.registeredAt)).toBe(120_000);
      await vi.advanceTimersByTimeAsync(119_000);
      expect(waitById(run.id, wait.id)?.phase).toBe('open');
      expect(inputsFor(run.id, wait.id)).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(inputsFor(run.id, wait.id)).toMatchObject([{ source: 'lifecycle', text: timerFired(wait.id, 'check the deploy') }]);
      await until(() => settledById(run.id, wait.id)?.phase === 'delivered');
      expect(inputsFor(run.id, wait.id)).toHaveLength(1);
      // A timer expiry is a self-generated wake: its admitted turn counts against the session's budget.
      expect(store.readEvents(run.id).filter(event => event.type === 'note' && event.message === `automatic timer wake-up (${charged + 1}/40)`)).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('cancelWait on an open CI wait aborts its watch and no observation is ever enqueued, even when the watcher settles afterwards', async () => {
    const external = githubByPr();
    const run = await waitingParent();
    const wait = await registerPr(run.id, 12);
    const kept = await registerTimer(run.id, 600);
    expect(manager.cancelWait(run.id, wait.id, generationOf(run.id))).toEqual({ cancelled: true });
    expect(external.aborted(12)).toBe(true);
    expect(settledById(run.id, wait.id)?.phase).toBe('cancelled');
    external.settle(12);
    await flushMicrotasks();
    expect(inputsFor(run.id, wait.id)).toEqual([]);
    expect(manager.cancelWait(run.id, wait.id, generationOf(run.id))).toEqual({ cancelled: false, code: 'not_found' });
    expect(waitById(run.id, kept.id)?.phase).toBe('open');
    // The tool answer lists what is still open.
    const answer = await manager.squawkToolHandlers(run.id, generationOf(run.id)).cancelWait({ wait_id: kept.id }, new AbortController().signal);
    expect(answer).toEqual({ cancelled: true, wait_id: kept.id, open_waits: [] });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(inputsFor(run.id, kept.id)).toEqual([]);
    expect(settledById(run.id, kept.id)?.phase).toBe('cancelled');
    vi.useRealTimers();
  });

  it('two concurrent cezar_wait ci calls for different PRs both register', async () => {
    let release!: () => void;
    githubByPr(new Promise<void>(resolve => { release = resolve; }));
    const lookups = vi.spyOn(externalResource.supervisor as { resolve(url: string): Promise<unknown> }, 'resolve');
    const run = await waitingParent();
    const pending = Promise.all([registerPr(run.id, 12), registerPr(run.id, 13)]);
    await until(() => lookups.mock.calls.length === 2);
    release();
    const [first, second] = await pending;
    expect(first.id).not.toBe(second.id);
    expect(store.getRun(run.id)?.waits?.map(wait => wait.kind === 'pr' ? wait.prNumber : undefined)).toEqual([12, 13]);
  });

  it('cancelWait on a resolved, undelivered wait answers already_resolved and the result is still delivered', async () => {
    const external = githubByPr();
    const gate = join(root, 'turn-boundary');
    const wire = controlledWire({ firstResultGate: gate });
    const run = await parent(); await until(wire.initialReceived);
    const wait = await registerPr(run.id, 12);
    external.settle(12);
    await until(() => waitById(run.id, wait.id)?.phase === 'resolved');
    expect(manager.cancelWait(run.id, wait.id, generationOf(run.id))).toEqual({ cancelled: false, code: 'already_resolved' });
    expect(waitById(run.id, wait.id)?.phase).toBe('resolved');
    writeFileSync(gate, 'end');
    await until(() => settledById(run.id, wait.id)?.phase === 'delivered');
    expect(inputsFor(run.id, wait.id)).toMatchObject([{ deliveredAt: expect.any(String) }]);
  });

  it('timer refuses timers_disabled when the interval is null; an open timer keeps its deadline when the interval changes', async () => {
    githubByPr();
    const run = await waitingParent();
    const interval = vi.spyOn(semaphore, 'monitoringWakeIntervalMinutes').mockReturnValue(null);
    await expect(registerTimer(run.id)).rejects.toMatchObject({ code: 'timers_disabled' });
    const answer = await manager.squawkToolHandlers(run.id, generationOf(run.id)).registerWait({ kind: WAIT_KIND.timer, seconds: 60 }, 'cezar_wait', new AbortController().signal);
    expect(answer.answer).toMatchObject({ ok: false, code: 'timers_disabled', open_waits: [] });
    // A refused registration registers nothing, so Cezar's own wait stays.
    expect(store.getRun(run.id)?.waits?.map(wait => wait.via)).toEqual(['no-wait']);
    // CI is an external event: Park until resumed does not refuse it.
    await expect(registerPr(run.id, 12)).resolves.toMatchObject({ kind: WAIT_KIND.pr });
    interval.mockReturnValue(5);
    const wait = await registerTimer(run.id, 600);
    interval.mockReturnValue(1);
    await semaphore.release();
    expect(waitById(run.id, wait.id)?.deadline).toBe(wait.deadline);
    interval.mockReturnValue(null);
    await semaphore.release();
    expect(waitById(run.id, wait.id)).toMatchObject({ phase: WAIT_PHASE.open, deadline: wait.deadline });
    await vi.advanceTimersByTimeAsync(599_000);
    expect(waitById(run.id, wait.id)?.phase).toBe('open');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(inputsFor(run.id, wait.id)).toHaveLength(1);
    vi.useRealTimers();
  });

  it('timer refuses wake_budget_spent once the run spent its automatic wakes', async () => {
    githubByPr();
    const run = await waitingParent();
    store.updateRun(run.id, { automaticWakes: 40 });
    await expect(registerTimer(run.id)).rejects.toMatchObject({ code: 'wake_budget_spent' });
    await expect(registerPr(run.id, 12)).resolves.toMatchObject({ kind: WAIT_KIND.pr });
  });

  it('registration refuses capacity at 16 open waits', async () => {
    githubByPr();
    const run = await waitingParent();
    const opened: Wait[] = [];
    for (let n = 0; n < WAIT_LIMIT; n++) opened.push(await registerTimer(run.id, 60 + n));
    await expect(registerTimer(run.id, 600)).rejects.toMatchObject({ code: 'capacity' });
    await expect(registerPr(run.id, 12)).rejects.toMatchObject({ code: 'capacity' });
    const answer = await manager.squawkToolHandlers(run.id, generationOf(run.id)).registerWait({ kind: WAIT_KIND.timer, seconds: 600 }, 'cezar_wait', new AbortController().signal);
    expect(answer.answer).toMatchObject({ ok: false, code: 'capacity' });
    expect(answer.answer.open_waits).toHaveLength(WAIT_LIMIT);
    // Only open waits count, as the store counts them: a resolved one frees its place.
    fireTimer(opened[0]!.id);
    await until(() => waitById(run.id, opened[0]!.id)?.phase !== 'open');
    await expect(registerPr(run.id, 12)).resolves.toMatchObject({ kind: WAIT_KIND.pr });
  });
});
