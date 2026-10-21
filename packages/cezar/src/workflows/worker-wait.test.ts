import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFailed, vi } from 'vitest';
import { workerWaitRequestSchema, type WorkerWait } from '@open-mercato/cezar-contract/delegation';
import { RunStore, type RunRecord } from '../runs/store.ts';
import * as runnerFactory from '../core/runner-factory.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import { collectWorkerEvidence } from '../delegation/results.ts';
import { planOwnedWorkspace } from '../delegation/workspace.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { COMPLETION_NUDGE_NOTE, COMPLETION_WILL_WAIT, MAX_AUTO_CONTINUES, RunManager } from './run.ts';
import { currentUsage } from '../core/process-usage.ts';
import type { AgentSession } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { withDelayedCommand } from '../core/owned-input-delivery.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';

import {
  bookkeeping, captureState, checkpoint, collect, controlledWire, executions, fixtureUpdateRun,
  manager, parent, queuedWake, register, reopenRuntime, restart, root, semaphore, setFailureState,
  store, terminal, track, until, useWorkerWaitFixture, waitOf, lastWaitOf, workerEntryOf, worker,
} from './worker-wait.testkit.ts';
import { blockRunWrites, readPersistedRuns } from '../runs/run-store.testkit.ts';

/** The refusal nudges a blocked done received (hearsay-tools/cezarion#1301), as their notes. */
const completionNudges = (id: string) => store.readEvents(id).filter(event => event.type === 'note' && String(event.message).startsWith(COMPLETION_NUDGE_NOTE));
/** The agent inputs Cezar submitted on the session, by text. */
const sentTexts = (sent: string[], text: string) => sent.filter(entry => entry.includes(text));
/** Record every text a session is sent through Cezar's agent-input seam. */
function recordAgentInput(id: string): string[] {
  const sent: string[] = [];
  const session = (manager as unknown as { active: Map<string, { session: AgentSession }> }).active.get(id)!.session;
  const real = session.sendAgentMessage.bind(session);
  session.sendAgentMessage = ((content, ...rest) => {
    sent.push(content.map(block => block.type === 'text' ? block.text : '').join('\n'));
    return real(content, ...rest);
  }) as AgentSession['sendAgentMessage'];
  return sent;
}

// Real Git, durable fsync checkpoints and process shutdown share this outer budget.
// Keep the separate 15s state/termination assertions and actual runner timers intact.
describe('worker waits through RunManager', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  for (const mode of ['fresh', 'continuation'] as const) {
    it(`readiness ${mode}: a DONE blocked by live workers gets the refusal nudge, opens no wait, and Finish stays refused`, async () => {
      const p = await parent();
      await until(() => store.getRun(p.id)?.status === 'waiting');
      if (mode === 'continuation') {
        expect(manager.finish(p.id)).toBe(true); await until(() => !manager.isActive(p.id));
        expect(manager.continueRun(p.id, { text: 'mock:hold' }).ok).toBe(true);
        await until(() => store.getRun(p.id)?.status === 'waiting');
      }
      const w = await worker(p.id);
      const sent = recordAgentInput(p.id);
      expect(manager.sendMessage(p.id, [{ type: 'text', text: 'mock:done' }])).toBe(true);
      // hearsay-tools/cezarion#1301: the refusal `cezar_done` gives, as one automatic turn.
      await until(() => completionNudges(p.id).length === 1 && store.getRun(p.id)?.status === 'waiting');
      expect(sentTexts(sent, `Workers are still live: ${w.id}.`)).toEqual([expect.stringContaining(COMPLETION_WILL_WAIT)]);
      expect(waitOf(store.getRun(p.id))).toBeUndefined();
      expect(store.getRun(p.id)?.delegation).not.toHaveProperty('completion');
      expect(store.getRun(p.id)?.waits?.filter(wait => wait.kind === 'worker') ?? []).toEqual([]);
      expect(manager.finish(p.id)).toBe(false);
      expect(store.getRun(p.id)?.delegation).not.toHaveProperty('finishRequestedAt');
      expect(store.getRun(w.id)?.status).toBe('queued');
      expect(semaphore.busy()).toBe(0);
    });
  }

  // hearsay-tools/cezarion#1301: a closed session's blocked done is queued as the refusal, and the
  // scheduler continuation reopens the session to deliver it; Cezar opens no wait.
  it('readiness closed session reopens to refuse a successful done with outstanding workers', async () => {
    const p = await parent(); const w = await worker(p.id);
    const state = (manager as unknown as { active: Map<string, { session: AgentSession }> }).active.get(p.id)!;
    state.session.end();
    const refusal = (run: RunRecord | undefined) => run?.agentInputs?.find(input => input.source === 'lifecycle' && input.text.includes(`Workers are still live: ${w.id}.`));
    await until(() => !!refusal(store.getRun(p.id))?.deliveredAt && store.getRun(p.id)?.steps.some(step => step.id === 'continue-1') === true);
    expect(refusal(store.getRun(p.id))?.text).toContain(COMPLETION_WILL_WAIT);
    expect(completionNudges(p.id)).toHaveLength(1);
    expect(store.getRun(p.id)?.status).not.toBe('done');
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
    expect(store.getRun(p.id)?.delegation).not.toHaveProperty('wait');
    expect(store.getRun(p.id)?.delegation).not.toHaveProperty('completion');
    expect(store.getRun(w.id)?.status).toBe('queued');
  });

  it('readiness collects a markerless worker after its idle timer closes the session', async () => {
    const p = await parent();
    const w = await worker(p.id);
    const wait = register(p.id, [w.id]);
    manager.enqueueOwnedRun(w.id);
    await until(() => store.getRun(w.id)?.status === 'waiting');
    const state = (manager as unknown as { active: Map<string, { idleTimer?: NodeJS.Timeout }> }).active.get(w.id);
    const idleTimer = state?.idleTimer as (NodeJS.Timeout & { _onTimeout?: () => void }) | undefined;
    if (!idleTimer?._onTimeout) throw new Error('waiting worker did not arm an idle timer');
    idleTimer._onTimeout();

    await until(() => store.getRun(w.id)?.status === 'done');
    await until(() => store.getRun(p.id)?.agentInputs?.some(input => input.id === wait.id && !!input.deliveredAt) === true);
    expect(store.readWorkerExecution(w.id)?.phase).toBe('complete');
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
  });

  it('readiness fails rather than collects success for a worker with a rejected ASK marker', async () => {
    const p = await parent();
    const w = await worker(p.id);
    const wait = register(p.id, [w.id]);
    manager.enqueueOwnedRun(w.id);
    await until(() => store.getRun(w.id)?.status === 'waiting');
    store.updateRun(w.id, { invalidAsk: true });
    const state = (manager as unknown as { active: Map<string, { idleTimer?: NodeJS.Timeout }> }).active.get(w.id);
    const idleTimer = state?.idleTimer as (NodeJS.Timeout & { _onTimeout?: () => void }) | undefined;
    if (!idleTimer?._onTimeout) throw new Error('waiting worker did not arm an idle timer');
    idleTimer._onTimeout();

    await until(() => store.getRun(w.id)?.status === 'failed');
    await until(() => store.getRun(p.id)?.agentInputs?.some(input => input.id === wait.id && !!input.deliveredAt) === true);
    expect(store.getRun(w.id)?.error).toBe('invalid structured question');
  });

  it('readiness public cancellation does not wake until private completion is durable', async () => {
    const p = await parent(); const w = await worker(p.id);
    const generation = store.commitWorkerExecutionStart(w.id);
    const wait = register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    store.updateRun(w.id, { status: 'cancelled' }); manager.reconcileWorkerWaits();
    expect(waitOf(store.getRun(p.id))?.phase).toBe('parked');
    expect(store.getRun(p.id)?.agentInputs).toBeUndefined();
    expect(store.commitWorkerExecutionComplete(w.id, generation)).toBe(true);
    await until(() => !waitOf(store.getRun(p.id)));
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.id === wait.id && input.deliveredAt)).toHaveLength(1);
  });

  it('readiness real stopped process wakes its parent only after actual exit and finalization', async () => {
    const p = await parent(); const w = await worker(p.id);
    let child: ReturnType<typeof spawn> | undefined; let ready = false;
    const runner = vi.spyOn(runnerFactory, 'createRunner').mockReturnValue({ backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent', interrupt: async () => undefined,
      run: async () => { throw Error('unused'); }, startSession: () => {
        child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout!.once('data', () => { ready = true; });
        const result = new Promise<never>((_resolve, reject) => child!.once('close', () => reject(Error('stopped'))));
        return { pid: child.pid, result, open: true, sendMessage: () => false, sendAgentMessage: () => false, discardQueuedMessages: () => {}, holdsHumanInput: () => false,
          interrupt: () => { child!.kill('SIGTERM'); }, end: () => { child!.kill('SIGTERM'); } };
      } });
    try {
      const wait = register(p.id, [w.id]); manager.enqueueOwnedRun(w.id);
      await until(() => ready);
      expect(manager.requestWorkerStop(w.id).state).toBe('stopping');
      expect(store.getRun(w.id)?.status).toBe('cancelled');
      expect(await manager.awaitRunTermination(w.id, 30)).toBe(false);
      expect(waitOf(store.getRun(p.id))?.phase).toBe('parked');
      expect(manager.finish(p.id)).toBe(false);
      child!.kill('SIGKILL');
      await until(() => store.getRun(p.id)?.agentInputs?.some(input => input.id === wait.id && !!input.deliveredAt) === true);
      expect(store.readWorkerExecution(w.id)?.phase).toBe('complete');
      expect(waitOf(store.getRun(p.id))).toBeUndefined();
    } finally { child?.kill('SIGKILL'); runner.mockRestore(); }
  });

  it('readiness review preserves workers live and through recovery', async () => {
    const p = await parent(); const w = await worker(p.id);
    store.updateRun(p.id, { status: 'review' }); manager.reconcileWorkerWaits();
    expect(store.getRun(w.id)?.status).toBe('queued');
    await restart();
    expect(store.getRun(w.id)?.status).not.toBe('cancelled');
  });

  it('readiness worker Continue requires continuing a reviewing parent first', async () => {
    const p = await parent(); const w = await worker(p.id);
    store.updateRun(w.id, { status: 'done' });
    store.updateStep(w.id, 'task', { status: 'done', sessionId: randomUUID(), backend: 'claude' });
    const generation = store.commitWorkerExecutionStart(w.id); store.commitWorkerExecutionComplete(w.id, generation);
    store.updateRun(p.id, { status: 'review' });
    expect(manager.continueRun(w.id, { text: 'more' })).toMatchObject({ ok: false, error: expect.stringMatching(/parent.*review|parent.*continu/i) });
  });

  it.each(['review', 'failed', 'cancelled'] as const)('readiness requires settled collection of %s and accepts partial failures', async status => {
    const p = await parent();
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id);
    const generation = store.commitWorkerExecutionStart(w.id);
    store.updateRun(w.id, { status });
    await collect(w.id); // Same status/revision, but the process is still unproven.
    expect(manager.finish(p.id)).toBe(false);
    expect(store.commitWorkerExecutionComplete(w.id, generation)).toBe(true);
    expect(manager.finish(p.id)).toBe(false); // A formerly partial observation is not fresh evidence.
    const result = await collect(w.id);
    expect(result.settled).toBe(true);
    expect(manager.finish(p.id)).toBe(true);
    await until(() => !manager.isActive(p.id));
    expect(store.getRun(p.id)?.status).toBe('done');
  });

  // hearsay-tools/cezarion#1301: a blocked DONE gets the refusal nudge. The nudge's own turn end with
  // live workers opens the live-worker re-check timer, so the next blocked DONE parks on that timer
  // with the refusal as a note, and neither opens an automatic worker wait.
  it('readiness repeated DONE with live workers: one nudge, then a park on the re-check timer, and no automatic wait', async () => {
    const p = await parent();
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id);
    manager.sendMessage(p.id, [{ type: 'text', text: 'mock:done' }]);
    await until(() => completionNudges(p.id).length === 1 && store.getRun(p.id)?.status === 'waiting');
    const timer = store.getRun(p.id)?.waits?.find(wait => wait.kind === 'timer' && wait.via === 'monitoring-line');
    expect(timer).toBeDefined();
    const boundaries = store.readEvents(p.id).filter(event => event.type === 'turn-end').length;
    const engine = manager as unknown as { active: Map<string, { session: AgentSession }> };
    engine.active.get(p.id)!.session.sendMessage([{ type: 'text', text: 'mock:done' }]);
    const refused = () => store.readEvents(p.id).filter(event => event.type === 'note' && String(event.message).startsWith(`Completion blocked: Workers are still live: ${w.id}.`));
    await until(() => store.readEvents(p.id).filter(event => event.type === 'turn-end').length > boundaries && refused().length === 1 && store.getRun(p.id)?.status === 'waiting');
    expect(completionNudges(p.id)).toHaveLength(1);
    expect(store.getRun(p.id)?.waits).toEqual([expect.objectContaining({ id: timer!.id, phase: 'open' })]);
    expect(store.getRun(p.id)?.delegation).not.toHaveProperty('completion');
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.source === 'lifecycle') ?? []).toEqual([]);
    expect(store.getRun(w.id)?.status).toBe('queued');
  });

  // The refusal nudge is charged to the automatic-wake budget; with it spent, the blocked DONE opens
  // Cezar's budget human wait instead (hearsay-tools/cezarion#1301).
  it('a blocked DONE with the automatic-wake budget spent opens the budget human wait instead of a nudge', async () => {
    const p = await parent();
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id);
    store.commitWakeCounters(p.id, { automaticWakes: MAX_AUTO_CONTINUES });
    const sent = recordAgentInput(p.id);
    const boundaries = store.readEvents(p.id).filter(event => event.type === 'turn-end').length;
    // Straight to the session: a human message would restart the budget.
    (manager as unknown as { active: Map<string, { session: AgentSession }> }).active.get(p.id)!.session.sendMessage([{ type: 'text', text: 'mock:done' }]);
    await until(() => store.readEvents(p.id).filter(event => event.type === 'turn-end').length > boundaries && store.getRun(p.id)?.status === 'waiting');
    expect(completionNudges(p.id)).toEqual([]);
    expect(sentTexts(sent, `Workers are still live: ${w.id}.`)).toEqual([]);
    expect(store.getRun(p.id)?.waits).toEqual([expect.objectContaining({ kind: 'human', source: 'cezar', via: 'budget', phase: 'open' })]);
    expect(store.readEvents(p.id).some(event => event.type === 'note' && String(event.message).includes(`Workers are still live: ${w.id}.`))).toBe(true);
    expect(store.getRun(p.id)?.automaticWakes).toBe(MAX_AUTO_CONTINUES);
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
    expect(manager.finish(p.id)).toBe(false);
  });

  it('readiness settled uncollected completion sends the collect refusal without the will-wait sentence, then finishes once collected', async () => {
    const p = await parent();
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id);
    manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15000)).toBe(true);
    const sent = recordAgentInput(p.id);
    manager.sendMessage(p.id, [{ type: 'text', text: 'mock:done' }]);
    await until(() => completionNudges(p.id).length === 1 && store.getRun(p.id)?.status === 'waiting');
    const [nudge, ...more] = sentTexts(sent, `worker collect ${w.id}`);
    expect(more).toEqual([]);
    expect(nudge).not.toContain(COMPLETION_WILL_WAIT);
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.source === 'lifecycle') ?? []).toEqual([]);
    await collect(w.id);
    process.env.CEZ_REVIEW_GATE = '1';
    writeFileSync(join(store.getRun(p.id)!.worktreePath!, 'parent-result.txt'), 'parent result');
    const state = (manager as unknown as { active: Map<string, { session: AgentSession }> }).active.get(p.id)!;
    state.session.sendMessage([{ type: 'text', text: 'mock:done' }]);
    await until(() => !manager.isActive(p.id));
    expect(store.getRun(p.id)?.status).toBe('review');
  });

  it('readiness accepted worker revision invalidates a previously collected settled result', async () => {
    const p = await parent();
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id);
    manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15000)).toBe(true); await collect(w.id);
    store.commitWorkerContinuation(w.id, { status: 'queued' });
    expect(manager.finish(p.id)).toBe(false);
    fixtureUpdateRun(w.id, { status: 'done' });
    expect(manager.finish(p.id)).toBe(false);
    await collect(w.id);
    expect(manager.finish(p.id)).toBe(true);
    await until(() => !manager.isActive(p.id));
  });

  // hearsay-tools/cezarion#1301: which input is a refusal is in memory only; one still queued at a
  // crash is a lifecycle input no wait names, which recovery delivers as ordinary input.
  it('readiness closed-session refusal still queued at a crash is delivered after recovery', async () => {
    const p = await parent(); const w = await worker(p.id);
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const events = new Map();
    const disk = readPersistedRuns(join(root, '.ai/cezar')) as Array<RunRecord>;
    const text = `Workers are still live: ${w.id}. u-crash`;
    const input = { id: randomUUID(), parentRunId: p.id, source: 'lifecycle' as const, text, createdAt: new Date().toISOString() };
    for (const run of disk) if (run.id === p.id) Object.assign(run, { agentInputs: [...run.agentInputs ?? [], input] });
    await restart(false, disk, events);
    await until(() => !!store.getRun(p.id)?.agentInputs?.find(entry => entry.id === input.id)?.deliveredAt);
    expect(store.getRun(p.id)?.status).not.toBe('done');
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
  });

  it('readiness ready human Finish retires an accepted wait before closing its session', async () => {
    const p = await parent('mock:slow'); const w = await worker(p.id);
    manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15000)).toBe(true); await collect(w.id);
    register(p.id, [w.id]);
    expect(manager.finish(p.id)).toBe(true);
    await until(() => !manager.isActive(p.id));
    expect(store.getRun(p.id)?.status).toBe('done');
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
  });

  it('readiness discards cached unsettled observations lacking current private proof', async () => {
    const p = await parent(); const first = await worker(p.id); const second = await worker(p.id);
    const generation = store.commitWorkerExecutionStart(first.id);
    store.updateRun(first.id, { status: 'cancelled' });
    // An agent's worker wait is a list entry (hearsay-tools/cezarion#1301).
    const now = Date.now();
    store.commitWait(p.id, { kind: 'worker', id: randomUUID(), source: 'agent', via: 'cez-worker-wait', registeredAt: new Date(now).toISOString(),
      deadline: new Date(now + 600000).toISOString(), timeoutSeconds: 600, phase: 'open', turnId: 'turn-1', mode: 'all',
      workerIds: [first.id, second.id], revisions: [{ workerId: first.id, revision: 0 }, { workerId: second.id, revision: 0 }],
      outcomes: [{ workerId: first.id, revision: 0, status: 'cancelled', observedAt: new Date(now).toISOString() }] });
    manager.reconcileWorkerWaits();
    expect(waitOf(store.getRun(p.id))?.outcomes).toEqual([]);
    expect(store.commitWorkerExecutionComplete(first.id, generation)).toBe(true);
    expect(waitOf(store.getRun(p.id))?.outcomes).toHaveLength(1);
  });

  // hearsay-tools/cezarion#1301: the refusal nudge goes through the agent-input seam, so an OpenCode
  // acknowledgement that lands after the nudge's own turn ended neither sends it twice nor charges
  // it twice.
  for (const mode of ['fresh', 'continuation'] as const) {
    for (const delayedAck of [false, true]) {
      it(`completion nudge ${mode} is sent and charged once with delayed ACK=${delayedAck}`, async () => {
        const exercise = async (release: () => void) => {
          const backend = delayedAck ? 'opencode' : 'claude';
          process.env.CEZ_DRY_RUN = '0'; process.env[HARNESS_ADAPTERS[backend].binEnv] = HARNESS_ADAPTERS[backend].mockBin;
          const p = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:hold', runner: backend });
          store.commitDelegation([{ id: p.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
          checkpoint('parent parked'); await until(() => store.getRun(p.id)?.status === 'waiting');
          if (mode === 'continuation') {
            expect(manager.finish(p.id)).toBe(true);
            checkpoint('parent finished'); await until(() => !manager.isActive(p.id));
            expect(manager.continueRun(p.id, { text: 'mock:hold' }).ok).toBe(true);
            checkpoint('continuation parked'); await until(() => store.getRun(p.id)?.status === 'waiting');
          }
          checkpoint('worker spawned'); const w = await worker(p.id);
          const sent = recordAgentInput(p.id);
          manager.sendMessage(p.id, [{ type: 'text', text: 'mock:done' }]);
          checkpoint('completion nudge note'); await until(() => completionNudges(p.id).length === 1);
          if (delayedAck) {
            // The nudge's own turn ends before its acknowledgement. The note is written inside that
            // turn, so its turn-end is the first one after the note; a count read after the note
            // misses it when the turn ends first (hearsay-tools/cezarion#1355).
            const note = completionNudges(p.id)[0]!.seq;
            checkpoint('nudge turn-end');
            await until(() => store.readEvents(p.id).some(event => event.type === 'turn-end' && event.seq > note));
            const engine = manager as unknown as { active: Map<string, { agentInputFlight?: { settled?: Promise<void> } }> };
            const settled = engine.active.get(p.id)?.agentInputFlight?.settled;
            expect(settled).toBeInstanceOf(Promise);
            checkpoint('acknowledgement settled'); release(); await settled;
          }
          checkpoint('parent parked after nudge'); await until(() => store.getRun(p.id)?.status === 'waiting');
          expect(sentTexts(sent, `Workers are still live: ${w.id}.`)).toHaveLength(1);
          expect(completionNudges(p.id)).toEqual([expect.objectContaining({ message: `${COMPLETION_NUDGE_NOTE} (1/${MAX_AUTO_CONTINUES}): workers_outstanding` })]);
          expect(waitOf(store.getRun(p.id))).toBeUndefined();
          expect(store.getRun(p.id)?.delegation).not.toHaveProperty('completion');
          expect(store.getRun(w.id)?.status).toBe('queued');
          expect(semaphore.busy()).toBe(0);
        };
        if (delayedAck) await withDelayedCommand('opencode', exercise, 'Workers are still live');
        else await exercise(() => {});
      });
    }
  }

  it('readiness Finish preserves pending parent human questions', async () => {
    const p = await parent('mock:ask'); await until(() => store.getRun(p.id)?.status === 'waiting');
    expect(manager.finish(p.id)).toBe(false);
    expect(store.getRun(p.id)?.status).toBe('waiting');
    expect(store.readEvents(p.id).filter(event => event.type === 'human-input-delivered')).toEqual([]);
  });

  it('all-mode replaces old observations when a selected worker accepts another execution', async () => {
    const p = await parent(); const first = await worker(p.id); const second = await worker(p.id);
    manager.registerWorkerWait(p.id, { workerIds: [first.id, second.id], timeoutSeconds: 600, mode: 'all' });
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    fixtureUpdateRun(first.id, { status: 'review' }); manager.reconcileWorkerWaits();
    expect(waitOf(store.getRun(p.id))?.outcomes).toHaveLength(1);
    store.commitWorkerContinuation(first.id, { status: 'queued' });
    fixtureUpdateRun(second.id, { status: 'done' }); manager.reconcileWorkerWaits();
    expect(waitOf(store.getRun(p.id))).toMatchObject({ phase: 'parked', outcomes: [{ workerId: second.id }] });
    expect(waitOf(store.getRun(p.id))?.revisions).toContainEqual({ workerId: first.id, revision: 1 });
    fixtureUpdateRun(first.id, { status: 'review' }); manager.reconcileWorkerWaits();
    await until(() => !waitOf(store.getRun(p.id)));
    expect(lastWaitOf(store.getRun(p.id))).toMatchObject({ outcomes: expect.arrayContaining([{ workerId: first.id, revision: 1, status: 'review', observedAt: expect.any(String) }]) });
    expect(store.readEvents(p.id)).toContainEqual(expect.objectContaining({ type: 'worker-outcome', outcome: expect.objectContaining({ workerId: first.id, revision: 1 }) }));
  });

  it('all-mode stays parked after one outcome and wakes exactly once after both', async () => {
    const p = await parent(); const first = await worker(p.id); const second = await worker(p.id);
    const wait = manager.registerWorkerWait(p.id, { workerIds: [first.id, second.id], timeoutSeconds: 600, mode: 'all' });
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    fixtureUpdateRun(first.id, { status: 'done' }); manager.reconcileWorkerWaits();
    expect(waitOf(store.getRun(p.id))).toMatchObject({ phase: 'parked', mode: 'all', outcomes: [{ workerId: first.id }] });
    expect(store.getRun(p.id)?.agentInputs).toBeUndefined();
    fixtureUpdateRun(second.id, { status: 'done' }); manager.reconcileWorkerWaits();
    await until(() => !waitOf(store.getRun(p.id)));
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.id === wait.id)).toHaveLength(1);
    expect(lastWaitOf(store.getRun(p.id))).toMatchObject({ id: wait.id, reason: 'outcome' });
  });

  it('cancels before park durably without releasing an executing parent slot', async () => {
    const release = join(root, 'release-cancelled-turn'); const wire = controlledWire({ firstResultGate: release });
    const p = await parent(); await until(wire.initialReceived); const w = await worker(p.id);
    const wait = register(p.id, [w.id]);
    const cancelled = manager.cancelWorkerWait(p.id, wait.id);
    expect(cancelled).toMatchObject({ id: wait.id, phase: 'wake-pending', reason: 'cancelled', wakeId: wait.id });
    expect(semaphore.busy()).toBe(1); expect(store.getRun(w.id)?.status).toBe('queued');
    const disk = readPersistedRuns(join(root, '.ai/cezar')) as RunRecord[];
    // hearsay-tools/cezarion#1235: a cancelled wait moves to lastWaits and queues no wake.
    expect(lastWaitOf(disk.find(run => run.id === p.id))).toMatchObject({ id: wait.id, reason: 'cancelled' });
    expect(store.getRun(p.id)?.agentInputs?.some(input => input.deliveredAt)).not.toBe(true);
    writeFileSync(release, 'release');
    await until(() => !waitOf(store.getRun(p.id)));
    expect(manager.cancelWorkerWait(p.id, wait.id).reason).toBe('cancelled');
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.id === wait.id) ?? []).toEqual([]);
  });

  it('cancelled parked wait queues no wake behind a running worker and stale IDs cannot cancel a later wait', async () => {
    const p = await parent(); const w = await worker(p.id, 'mock:slow');
    const wait = register(p.id, [w.id]); manager.enqueueOwnedRun(w.id);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked' && store.getRun(w.id)?.status === 'running');
    manager.cancelWorkerWait(p.id, wait.id); manager.cancelWorkerWait(p.id, wait.id); manager.reconcileWorkerWaits();
    expect(store.getRun(w.id)?.status).toBe('running'); expect(semaphore.busy()).toBe(1);
    // hearsay-tools/cezarion#1235: the cancelled entry moves to lastWaits; nothing wakes the parent.
    expect(lastWaitOf(store.getRun(p.id))).toMatchObject({ id: wait.id, reason: 'cancelled' });
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.id === wait.id) ?? []).toEqual([]);
    manager.requestWorkerStop(w.id); await manager.awaitRunTermination(w.id, 15_000);
    await until(() => !waitOf(store.getRun(p.id)));
    const nextWorker = await worker(p.id); const next = register(p.id, [nextWorker.id]);
    expect(manager.cancelWorkerWait(p.id, wait.id).reason).toBe('cancelled');
    expect(waitOf(store.getRun(p.id))?.id).toBe(next.id);
    expect(() => manager.cancelWorkerWait(p.id, randomUUID())).toThrow();
    expect(waitOf(store.getRun(p.id))?.reason).toBeUndefined();
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.id === wait.id) ?? []).toEqual([]);
  });

  it('restarts a cancelled wait and retains its receipt across restarts without a wake', async () => {
    const release = join(root, 'release-recovered-turn'); const wire = controlledWire({ firstResultGate: release });
    const p = await parent(); await until(wire.initialReceived); const w = await worker(p.id);
    const wait = register(p.id, [w.id]); manager.cancelWorkerWait(p.id, wait.id);
    const disk = readPersistedRuns(join(root, '.ai/cezar'));
    writeFileSync(release, 'release');
    await restart(false, disk);
    await until(() => !waitOf(store.getRun(p.id)));
    expect(manager.cancelWorkerWait(p.id, wait.id).reason).toBe('cancelled');
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.id === wait.id) ?? []).toEqual([]);
    expect(store.getRun(w.id)?.status).not.toBe('cancelled');
    await restart();
    expect(manager.cancelWorkerWait(p.id, wait.id).reason).toBe('cancelled');
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.id === wait.id) ?? []).toEqual([]);
  });

  it('failed cancellation checkpoint publishes no wake and keeps the original wait retryable', async () => {
    const p = await parent('mock:slow'); const w = await worker(p.id); const wait = register(p.id, [w.id]);
    store.flush(); const release = blockRunWrites(join(root, '.ai/cezar'));
    try {
      expect(() => manager.cancelWorkerWait(p.id, wait.id)).toThrow();
      expect(waitOf(store.getRun(p.id))).toEqual(wait);
      expect(store.getRun(p.id)?.agentInputs).toBeUndefined();
      expect(lastWaitOf(store.getRun(p.id))).toBeUndefined();
      expect(semaphore.busy()).toBe(1);
    } finally { release(); }
    expect(manager.cancelWorkerWait(p.id, wait.id).reason).toBe('cancelled');
  });

  it('parent cancellation retires its wait with a receipt while cancelling workers', async () => {
    const p = await parent(); const w = await worker(p.id); const wait = register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    manager.cancel(p.id);
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
    expect(lastWaitOf(store.getRun(p.id))).toMatchObject({ id: wait.id, reason: 'cancelled' });
    await until(() => store.getRun(w.id)?.status === 'cancelled');
    expect(store.getRun(p.id)?.agentInputs).toBeUndefined();
  });

});
