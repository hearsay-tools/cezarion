import { testHome } from '../home/test-home.testkit.ts';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { afterEach, expect, vi } from 'vitest';
import { CredentialRegistry, type Caller } from '../delegation/credentials.ts';
import { DelegationService } from '../delegation/service.ts';
import { bookkeeping, delegatingParent, eventCheckpoint, fixtureUpdateRun, manager, parent, restart, root, store, until, useWorkerWaitFixture, worker } from './worker-wait-claude.testkit.ts';
import { setRunStatus, hasPendingAsk } from '../runs/run-store.testkit.ts';
import { monitoringWakeOf } from './waits.testkit.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';

export const conversationOf = (rootId: string) => { const d = store.getRun(rootId)?.delegation; return d?.role === 'root' ? d.conversation : undefined; };

export const eventsOf = (runId: string, type: string) => store.readEvents(runId).filter(event => event.type === type);

export const squawkAnswered = (runId: string) => eventsOf(runId, 'human-input-delivered').filter(event => event.source === 'cezar');

export const closedAs = (runId: string) => eventsOf(runId, 'human-ask-closed').map(event => event.reason);

export const noHumanCard = (runId: string) => {
    expect(eventsOf(runId, 'worker-question-fallback')).toEqual([]);
    if (hasPendingAsk(store, runId)) {
      const ask = store.transcriptFacts(runId).pendingAsk!;
      expect(!ask.fallback && !!ask.routedMessageId || store.getRun(runId)?.agentInputs?.some(input => !input.deliveredAt && input.purpose === 'undelivered-question')).toBe(true);
    }
  };

export async function steeringParent(task = 'mock:hold') {
    const p = await parent(task);
    const delegation = store.getRun(p.id)!.delegation!;
    if (delegation.role !== 'root') throw Error('missing root');
    store.commitDelegation([{ id: p.id, delegation: { ...delegation, permissions: [...delegation.permissions, 'steer'] } }]);
    return p;
  }

export async function parentAtLastSlot(service: DelegationService, callerFor: (id: string) => import('../delegation/credentials.ts').Caller, parentId: string) {
    const now = new Date().toISOString();
    fixtureUpdateRun(parentId, { agentInputs: Array.from({ length: 31 }, () => ({ id: randomUUID(), source: agentInputSchema.shape.source.enum.agent, parentRunId: parentId, text: 'queued', createdAt: now })) });
    const peer = store.createRun({ title: 'peer', task: 'peer', workflow: 'quick-task', runner: 'claude', steps: [] });
    setRunStatus(store, peer.id, RUN_STATUS.running, { delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
    const request = await service.send(callerFor(parentId), { id: randomUUID(), recipientRunId: peer.id, kind: 'request', text: 'Which versions?', timeoutSeconds: 600 });
    const reply = () => service.send(callerFor(peer.id), { id: randomUUID(), recipientRunId: parentId, kind: 'reply', requestId: request.message.id, text: 'zod 4', timeoutSeconds: 600 });
    return { reply, undelivered: () => store.getRun(parentId)?.agentInputs?.filter(input => !input.deliveredAt).length ?? 0 };
  }

export const fillInbox = (parentId: string) => {
    const now = new Date().toISOString();
    fixtureUpdateRun(parentId, { agentInputs: Array.from({ length: 32 }, () => ({ id: randomUUID(), source: agentInputSchema.shape.source.enum.agent, parentRunId: parentId, text: 'queued', createdAt: now })) });
  };

export async function idleWorker() {
    const p = await steeringParent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id); manager.enqueueOwnedRun(w.id);
    await until(() => eventsOf(w.id, 'worker-question-routed').length === 1 && store.getRun(w.id)?.status === 'waiting');
    return { p, w, askSeq: eventsOf(w.id, 'ask.requested')[0]!.seq, requestId: String(eventsOf(w.id, 'worker-question-routed')[0]!.messageId) };
  }

export const steer = (workerId: string, parentRunId: string, text: string) => {
    const id = randomUUID();
    return { id, result: manager.steerWorker(workerId, { id, source: agentInputSchema.shape.source.enum.agent, parentRunId, text, createdAt: new Date().toISOString() }) };
  };

export function expectFallbackIntact(f: Awaited<ReturnType<typeof idleWorker>>, waits: unknown, outcomes: unknown, stopped = false) {
    expect(eventsOf(f.w.id, 'human-ask-closed').map(event => event.reason)).toEqual(stopped ? ['worker-stopped'] : []);
    expect(store.transcriptFacts(f.w.id).pendingAsk?.seq).toBe(stopped ? undefined : f.askSeq);
    expect(store.getRun(f.w.id)?.waits).toEqual(waits);
    expect(conversationOf(f.p.id)?.outcomes.filter(outcome => outcome.requestId === f.requestId)).toEqual(outcomes);
  }

export async function askedPair(parentTask = 'mock:hold'): Promise<{
  p: Awaited<ReturnType<typeof parent>>;
  w: Awaited<ReturnType<typeof worker>>;
  questionId: string;
  service: DelegationService;
  parentCaller: Caller;
  workerCaller: Caller;
  reply: (text: string, id?: string) => ReturnType<DelegationService['send']>;
  close: () => void;
}> {
    const { p, service, callerFor, close } = await delegatingParent({ task: parentTask, permissions: ['spawn', 'wait', 'steer'] });
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id, 'mock:cezar-ask'); manager.enqueueOwnedRun(w.id);
    await until(() => eventsOf(w.id, 'worker-question-routed').length === 1 && store.getRun(w.id)?.status === 'waiting');
    const questionId = String(eventsOf(w.id, 'worker-question-routed')[0]!.messageId);
    const parentCaller = callerFor(p.id), workerCaller = callerFor(w.id);
    const reply = (text: string, id: string = randomUUID()) => service.send(parentCaller!, { id, recipientRunId: w.id, kind: 'reply', requestId: questionId, text, timeoutSeconds: 600 });
    return { p, w, questionId, service, parentCaller: parentCaller!, workerCaller: workerCaller!, reply, close };
  }

export const answered = (runId: string) => eventsOf(runId, 'human-input-delivered').filter(event => event.source === 'parent');

export const said = (runId: string, text: string) => store.readEvents(runId).some(event => event.type === 'text' && String(event.text).includes(text));

export async function replyAfterRestart(crashed: boolean, holdResources = false) {
    const f = await askedPair();
    f.close();
    const parentIdle = async () => {
      // Routing and recovery can wake the parent. Finish that turn's real Git
      // bookkeeping before testing a one-shot reply into a quiescent worktree.
      // Recovery leaves a monitoring park inactive on its persisted timer (hearsay-tools/cezarion#1233).
      await until(() => store.getRun(f.p.id)?.status === 'waiting' || (!manager.isActive(f.p.id) && !!monitoringWakeOf(store.getRun(f.p.id))));
      await Promise.all(bookkeeping);
    };
    await parentIdle();
    const files = eventCheckpoint();
    if (crashed) {
      // #469: restore the worker's pre-cancel `starting` proof, as a real crash leaves it, with a dead controller.
      const proof = join(root, '.ai/cezar/runs', `${f.w.id}.execution.json`), record = proof.replace(/\.execution\.json$/, '.processes.json');
      expect(store.readWorkerExecution(f.w.id)?.phase).toBe('starting');
      const dead = spawn(process.execPath, ['-e', '']); await new Promise(resolve => dead.once('exit', resolve));
      files.set(proof, readFileSync(proof, 'utf8'));
      files.set(record, JSON.stringify({ ...JSON.parse(readFileSync(record, 'utf8')), controller: { pid: dead.pid, startToken: '1' } }));
    }
    await restart(false, undefined, files);
    const credentials = new CredentialRegistry();
    let releaseHolder: (() => Promise<void>) | undefined;
    try {
      const parentCaller = credentials.authenticate(credentials.issue('project', f.p.id, randomUUID()))!;
      const service = new DelegationService();
      service.registerProject({ home: testHome(), id: 'project', root, store, manager });
      // Recovery resumes the parent; the worker's session stays closed on its pending question.
      await until(() => ['running', 'waiting'].includes(store.getRun(f.p.id)?.status ?? '') && store.getRun(f.w.id)?.status === 'waiting');
      await parentIdle();
      expect(manager.isActive(f.w.id)).toBe(false);
      if (holdResources) {
        await until(() => store.readWorkerExecution(f.w.id)?.phase === 'complete');
        const delegation = store.getRun(f.w.id)!.delegation!;
        if (delegation.role !== 'worker') throw Error('missing worker');
        const holder = spawn(process.execPath, ['-e', "console.log('ready'); process.stdin.resume()"], {
          cwd: delegation.workspace.path, stdio: ['pipe', 'pipe', 'ignore'],
        });
        const exited = once(holder, 'exit');
        releaseHolder = async () => { holder.stdin.end(); await exited; };
        await once(holder.stdout, 'data');
        const resourcesSafe = store.workerResourcesSafe.bind(store);
        // Release a real holder only after the first resource check sees it.
        // Without the pre-reply wait, admission refuses the one-shot answer;
        // closing the holder afterward cannot turn that refusal into success.
        vi.spyOn(store, 'workerResourcesSafe').mockImplementation((...args) => {
          const safe = resourcesSafe(...args);
          if (args[0] === f.w.id && !safe) holder.stdin.end();
          return safe;
        });
      }
      if (crashed) {
        // This case answers after the crashed execution has no possible process
        // holders. Inactive only proves our manager released it: the real #469
        // scan can still see transient Git children or unreadable same-user host
        // processes. Recovery may already have finalized the execution, but that
        // does not prove its resources can be reused (hearsay-tools/cezarion#732).
        // Wait for that physical precondition without finalizing the proof,
        // suppressing any PIDs, or retrying the answer under test.
        await until(() => {
          const proof = store.readWorkerExecution(f.w.id);
          const delegation = store.getRun(f.w.id)?.delegation;
          return !!proof && delegation?.role === 'worker' &&
            store.workerResourcesSafe(f.w.id, proof.generation, delegation.workspace.resourceId);
        });
      }
      await service.send(parentCaller, { id: randomUUID(), recipientRunId: f.w.id, kind: 'reply', requestId: f.questionId, text: 'mock:agent-echo Use the parser', timeoutSeconds: 600 });
      await until(() => answered(f.w.id).length === 1);
      await until(() => said(f.w.id, 'Use the parser'));
      expect(eventsOf(f.w.id, 'user-message').some(event => String(event.text).includes('Use the parser'))).toBe(false);
    } finally { await releaseHolder?.(); credentials.close(); }
  }

export const expectSettledParentRefusal = (workerId: string, parentId: string, status: string) => {
    const before = JSON.stringify(store.getRun(workerId));
    const events = store.readEvents(workerId).length;
    expect(manager.continueRun(workerId, { text: 'mock:agent-echo human answer' })).toEqual({ ok: false, error: `Parent task ${parentId} is ${status}; continue the parent before its worker.` });
    expect(JSON.stringify(store.getRun(workerId))).toBe(before);
    expect(store.readEvents(workerId)).toHaveLength(events);
  };

export function fillConversation(parentId: string, workerId: string, count: number) {
    const now = new Date().toISOString();
    const state = conversationOf(parentId) ?? { messages: [], outcomes: [] };
    store.commitConversation(parentId, { ...state, messages: [...state.messages, ...Array.from({ length: count - state.messages.length }, () => ({
      id: randomUUID(), senderRunId: parentId, recipientRunId: workerId, kind: 'progress' as const, text: 'old', createdAt: now, requestHash: 'd'.repeat(64), state: 'accepted' as const,
    }))] });
  }

export function useWorkerQuestionsFixture() {
// afterEach runs in reverse registration order: keep process scoping alive
  // through the fixture's real session/autosave shutdown, then restore mocks.
  afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });
useWorkerWaitFixture();
}
