import { observationClock } from '../core/observation-clock.testkit.ts';
import { WAKE_RETRY_BACKOFF } from '../delegation/retry-backoff.ts';
// Register the external CI mock before loading RunManager.
import { externalResource, pr, identity, success, ciWaitOf, lastCiWaitOf, parked, github, register, acquireExternalCiResources } from './ci-wait-fixture.testkit.ts';
import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';
import { WAIT_KIND, WAIT_PHASE, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type Wait } from '@open-mercato/cezar-contract/waits';
import type { CiWait, CiWaitResult } from '@open-mercato/cezar-contract';
import { controlledWire, manager, parent, root, restart, store, until, worker, waitOf, useWorkerWaitFixture, work, toolGenerationOf, reopenRuntime } from './worker-wait-claude.testkit.ts';

import { readPersistedRuns, hasPendingAsk } from '../runs/run-store.testkit.ts';



describe('CI wait recovery and conversations', { timeout: 30_000 }, () => {
  useWorkerWaitFixture({ acquireCiResources: acquireExternalCiResources });
  afterEach(() => vi.restoreAllMocks());

  it('rebuilds a parked wait after restart without launching a model before settlement', async () => {
    const external = github();
    const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    const receipt = await register(run.id);
    await restart();
    expect(manager.isActive(run.id)).toBe(false);
    expect(ciWaitOf(run.id)?.id).toBe(receipt.id);
    expect(store.getRun(run.id)?.status).toBe('waiting');
    external.settle(success());
    await until(() => !!lastCiWaitOf(run.id)?.deliveredAt);
    expect(store.getRun(run.id)?.agentInputs?.filter(input => input.id === receipt.id)).toHaveLength(1);
  });

  // hearsay-tools/cezarion#1425: recovery re-arms a merge wait as a merge wait, with no live session.
  it.each(['merge', 'merge_or_blocked'] as const)('rebuilds a parked %s wait with no session and commits its outcome before delivery', async target => {
    let settle!: (result: CiWaitResult) => void;
    const watched: CiWait[] = [];
    const supervisor = { resolve: async () => identity, watch: (wait: CiWait) => { watched.push(wait); return new Promise<CiWaitResult>(done => { settle = done; }); }, close() {} };
    externalResource.supervisor = supervisor;
    manager.dispose();
    reopenRuntime();
    const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    const receipt = await manager.registerWait(run.id, { kind: WAIT_KIND.pr, pr, until: target, wake_on_conflict: false, timeout_seconds: 30 }, 'cezar_wait', toolGenerationOf(run.id));
    await restart();
    expect(manager.isActive(run.id)).toBe(false);
    expect(watched.at(-1)).toMatchObject({ id: receipt.id, until: target, wakeOnConflict: false });
    // The committed row at the wake boundary already holds the result and its input.
    let committed: { waits?: Wait[]; agentInputs?: Array<{ id: string; text: string }> } | undefined;
    const observe = (row: { id: string; waits?: Wait[] }) => {
      if (row.id === run.id && row.waits?.some(wait => wait.id === receipt.id && wait.phase === 'resolved')) {
        committed = readPersistedRuns(join(root, '.ai/cezar')).find(row => row.id === run.id);
      }
    };
    store.on('run', observe);
    const outcome = target === 'merge' ? 'merged' : 'blocked';
    settle({ outcome, headSha: identity.headSha, observedAt: new Date().toISOString(), checks: [], totalChecks: 0, truncated: false,
      ...(target === 'merge' ? { mergedAt: '2026-10-23T09:00:00Z' } : { mergeBlock: { reason: 'no_pending_merge' as const, isInMergeQueue: false, autoMergeEnabled: false } }) });
    await until(() => !!lastCiWaitOf(run.id)?.deliveredAt);
    store.off('run', observe);
    expect(committed).toBeDefined();
    expect(committed?.waits?.find(wait => wait.id === receipt.id)).toMatchObject({ phase: WAIT_PHASE.resolved, until: target, result: { outcome } });
    expect(committed?.agentInputs?.find(input => input.id === receipt.id)?.text).toContain(`(until ${target})`);
    expect(store.getRun(run.id)?.agentInputs?.filter(input => input.id === receipt.id)).toHaveLength(1);
  });

  it('cancellation retires the wait and never reopens the run on late completion', async () => {
    const external = github();
    const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    await register(run.id);
    expect(manager.cancel(run.id)).toBe(true);
    await until(() => !manager.isActive(run.id));
    external.settle(success());
    await Promise.resolve();
    expect(store.getRun(run.id)?.status).toBe('cancelled');
    expect(ciWaitOf(run.id)).toBeUndefined();
  });

  // hearsay-tools/cezarion#1235 phase 3a (design § Registration and cancel): "A CI wait is already
  // active" is a removed refusal. Worker and request waits are list entries beside CI.
  it('registers worker and request waits beside a registered CI wait, which stays open', async () => {
    github(); const p = await parent();
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id);
    const ci = await register(p.id);
    const now = new Date().toISOString();
    const request = { id: randomUUID(), senderRunId: p.id, recipientRunId: w.id, kind: 'request' as const, text: 'Which module?', createdAt: now,
      deadline: new Date(Date.now() + 600_000).toISOString(), requestHash: 'a'.repeat(64), state: 'accepted' as const };
    store.commitConversation(p.id, { messages: [request], outcomes: [] }, { recipientRunId: w.id,
      input: { id: request.id, source: agentInputSchema.shape.source.enum.agent, parentRunId: p.id, text: request.text, createdAt: now, conversation: { senderRunId: p.id, recipientRunId: w.id, kind: 'request' } } });
    const workers = manager.registerWorkerWait(p.id, { workerIds: [w.id], timeoutSeconds: 30 });
    const requests = manager.registerRequestWait(p.id, { requestIds: [request.id], timeoutSeconds: 30 });
    expect([workers.phase, requests.phase]).toEqual(['registered', 'registered']);
    const waits = store.getRun(p.id)!.waits!;
    expect(waits.map(wait => [wait.id, wait.kind, wait.phase])).toEqual([[ci.id, 'pr', 'open'], [workers.id, 'worker', 'open'], [requests.id, 'worker', 'open']]);
    expect(waits.find(wait => wait.id === workers.id)).toMatchObject({ via: WAIT_VIA['cez-worker-wait'], workerIds: [w.id] });
    expect(waits.find(wait => wait.id === requests.id)).toMatchObject({ via: WAIT_VIA['cez-worker-wait'], requestIds: [request.id] });
    expect(store.getRun(p.id)?.delegation).not.toHaveProperty('wait');
  });

  // hearsay-tools/cezarion#1233: the ask leaves CI open; its result wakes the run and never
  // answers the question.
  it('a human ask at turn-end keeps CI open and its result leaves the question unanswered', async () => {
    const external = github();
    const gate = join(root, 'ask-boundary'); controlledWire({ firstResultGate: gate });
    const run = await parent('mock:cezar-ask');
    const wait = await register(run.id);
    writeFileSync(gate, 'end');
    await until(() => store.getRun(run.id)?.status === 'waiting' && hasPendingAsk(store, run.id) === true);
    expect(ciWaitOf(run.id)?.phase).toBe('open');
    expect(external.aborted()).toBe(false);
    external.settle(success());
    await until(() => !!lastCiWaitOf(run.id)?.deliveredAt);
    expect(store.getRun(run.id)?.agentInputs?.filter(input => input.id === wait.id)).toHaveLength(1);
    // This wire never echoes a consumed line, so the re-park itself is U3b's, on native wires.
    expect(hasPendingAsk(store, run.id)).toBe(true);
    expect(store.readEvents(run.id).filter(event => event.type === 'human-input-delivered')).toEqual([]);
  });

  it('backend disconnect retains the bounded wait and recovers only after settlement', async () => {
    const external = github();
    const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    await register(run.id);
    expect(work.liveSessions.size).toBe(1);
    const [session] = work.liveSessions;
    session!.end();
    await until(() => !manager.isActive(run.id));
    expect(store.getRun(run.id)?.status).toBe('waiting');
    external.settle(success());
    await until(() => !!lastCiWaitOf(run.id)?.deliveredAt);
    expect(lastCiWaitOf(run.id)?.result?.outcome).toBe('passed');
  });

  it('a CI wait keeps an earlier step open, and the step advances only on a done after the resumed turn', async () => {
    const external = github();
    const gate = join(root, 'nonfinal-boundary'); const wire = controlledWire({ firstResultGate: gate, replay: true });
    const run = manager.startRun({ name: 'ci-chain', source: 'built-in', steps: [
      { id: 'first', prompt: 'hold' }, { id: 'check', command: 'node -e "process.exit(0)"' },
    ] }, { task: 'CI chain', runner: 'claude' });
    await until(wire.initialReceived);
    await register(run.id); writeFileSync(gate, 'end');
    await until(() => parked(run.id));
    expect(store.getRun(run.id)?.steps.find(step => step.id === 'check')?.status).toBe('pending');
    external.settle(success());
    await until(() => !!lastCiWaitOf(run.id)?.deliveredAt);
    // The wake turn signals nothing; the earlier step completes only on a done (hearsay-tools/cezarion#1620).
    expect(store.getRun(run.id)?.steps.find(step => step.id === 'check')?.status).toBe('pending');
    expect(manager.sendMessage(run.id, [{ type: 'text', text: 'mock:cezar-done' }])).toBe(true);
    await until(() => !manager.isActive(run.id));
    expect(store.getRun(run.id)?.steps.map(step => step.status)).toEqual(['done', 'done']);
  });

  // hearsay-tools/cezarion#1233: one wake batch carries the observation first, then the conversations.
  // hearsay-tools/cezarion#1235 phase 3a (design § Resolution and waking, Transitions out): a
  // message alone is a wake of its own and leaves CI open; messages owed beside the CI result
  // still ride its one wake.
  it('batches worker conversations behind the CI observation in one wake without losing admission', async () => {
    const external = github();
    const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    const wait = await register(run.id);
    await until(() => parked(run.id));
    expect(work.liveSessions.size).toBe(1);
    const [session] = work.liveSessions;
    const send = vi.spyOn(session!, 'sendAgentMessage');
    const update = (n: number) => ({ id: randomUUID(), parentRunId: run.id, source: agentInputSchema.shape.source.enum.agent, text: `worker update ${n}`,
      createdAt: new Date().toISOString(), conversation: { senderRunId: randomUUID(), recipientRunId: run.id, kind: 'progress' as const } });
    const inputOf = (id: string) => store.getRun(run.id)?.agentInputs?.find(input => input.id === id);
    // A message during the CI park wakes the run at once; CI stays open and re-parks it.
    const early = update(0);
    store.commitAgentInputs(run.id, [early]);
    const boundaries = store.readEvents(run.id).filter(event => event.type === 'turn-end').length;
    manager.deliverConversationInput(run.id);
    await until(() => !!inputOf(early.id)?.deliveredAt);
    expect(ciWaitOf(run.id)).toMatchObject({ id: wait.id, phase: WAIT_PHASE.open });
    await until(() => store.readEvents(run.id).filter(event => event.type === 'turn-end').length > boundaries && parked(run.id));
    expect(waitOf(store.getRun(run.id))).toBeUndefined();
    send.mockClear();
    // Messages owed when the observation lands go in its one wake, after it.
    const messages = [1, 2, 3].map(update);
    store.commitAgentInputs(run.id, messages);
    external.settle(success());
    await until(() => !!lastCiWaitOf(run.id)?.deliveredAt);
    await until(() => messages.every(message => inputOf(message.id)?.deliveredAt));
    const delivered = store.getRun(run.id)!.agentInputs!;
    expect(delivered.find(input => input.id === wait.id)?.deliveredAt).toBeTruthy();
    // A later turn-end nudge is its own send; only the wake may carry the observation or a message.
    const ids = [wait.id, ...messages.map(message => message.id)];
    const accepted = send.mock.calls.filter((call, i) => send.mock.results[i]?.value !== false
      && ids.some(id => JSON.stringify(call).includes(id)));
    expect(accepted).toHaveLength(1);
    const batch = JSON.stringify(accepted[0]);
    for (const message of messages) expect(batch.indexOf(message.id)).toBeGreaterThan(batch.indexOf(wait.id));
    expect(new Set(messages.map(message => inputOf(message.id)?.deliveredAt)).size).toBe(1);
  });

  it('reconciles a settled CI wake after an owned worker execution finalizes', async () => {
    const external = github();
    const p = await parent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    const gate = join(root, 'worker-boundary'); controlledWire({ firstResultGate: gate });
    const sessions = new Set(work.liveSessions);
    const child = await worker(p.id); manager.enqueueOwnedRun(child.id);
    await until(() => store.getRun(child.id)?.steps.some(step => !!step.sessionId) === true && [...work.liveSessions].some(session => !sessions.has(session)));
    await register(child.id);
    external.settle(success());
    await until(() => ciWaitOf(child.id)?.phase === 'resolved');
    const session = [...work.liveSessions].find(session => !sessions.has(session))!;
    // The session closes with the result owed: one failed delivery, retried after the wake backoff
    // (hearsay-tools/cezarion#1233), which the test need not wait out.
    const clock = observationClock(delay => delay === WAKE_RETRY_BACKOFF.fastMs &&
      /\bat WakeRetries\.backoff \(/.test(new Error().stack ?? ''));
    session.end(); writeFileSync(gate, 'end');
    await until(() => clock.pending > 0 || !!lastCiWaitOf(child.id)?.deliveredAt);
    if (clock.pending) await clock.advance(WAKE_RETRY_BACKOFF.fastMs);
    await until(() => !!lastCiWaitOf(child.id)?.deliveredAt);
    expect(ciWaitOf(child.id)).toBeUndefined();
  });
});
