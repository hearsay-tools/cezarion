import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { ConversationMessage } from '@open-mercato/cezar-contract';
import { CredentialRegistry } from '../delegation/credentials.ts';
import { DelegationService } from '../delegation/service.ts';
import { parkNoticeId } from '../delegation/park-notice.ts';
import { messagesPrompt } from './monitoring-turn.testkit.ts';
import { eventCheckpoint, fixtureUpdateRun, manager, parent, register, restart, root, spendWorkerBudget, store, timeline, until, useWorkerWaitFixture, worker } from './worker-wait.testkit.ts';

/** hearsay-tools/cezarion#1327: the single-runner paths of the park notice. The RUNNER_IDS cells
 *  U3n, U3r and U3d (`waits-parity-cells.testkit.ts`) pin it on every native wire. */
describe('a parked worker tells its waiting parent why (hearsay-tools/cezarion#1327)', { timeout: 45_000 }, () => {
  afterEach(() => vi.restoreAllMocks());
  useWorkerWaitFixture();
  const conversationOf = (id: string): ConversationMessage[] => {
    const delegation = store.getRun(id)?.delegation;
    return delegation?.role === 'root' ? delegation.conversation?.messages ?? [] : [];
  };
  const notices = (parentId: string, workerId: string) => conversationOf(parentId).filter(message =>
    message.senderRunId === workerId && message.kind === 'progress' && message.text.startsWith('Cezar notice: '));
  const parked = (id: string) => store.getRun(id)?.status === 'waiting';
  const turnEnds = (id: string) => store.readEvents(id).filter(event => event.type === 'turn-end').length;
  /** A root parent, parked, that may message its workers, with a delegation service for both. */
  async function family() {
    process.env.CEZ_DELEGATION = '1';
    const p = await parent();
    await until(() => parked(p.id));
    const delegation = store.getRun(p.id)!.delegation!;
    if (delegation.role !== 'root') throw Error('root fixture');
    store.commitDelegation([{ id: p.id, delegation: { ...delegation, permissions: [...delegation.permissions, 'steer'] } }]);
    const service = new DelegationService();
    service.registerProject({ id: 'project', root, store, manager });
    const credentials = new CredentialRegistry();
    onTestFinished(() => credentials.close());
    const callerOf = (id: string) => credentials.authenticate(credentials.issue('project', id, randomUUID()))!;
    return { p, service, callerOf };
  }
  /** A worker whose opening turn says `text` and plain-parks, as a spent budget makes it. */
  async function parkedWorker(parentId: string, text: string) {
    const w = await worker(parentId, messagesPrompt('claude', [text]));
    spendWorkerBudget(w.id);
    manager.enqueueOwnedRun(w.id);
    await until(() => parked(w.id) && turnEnds(w.id) > 0, () => timeline(w.id));
    return w;
  }

  it('posts the notice a crash lost before its commit when recovery runs, with no live session', async () => {
    const { p } = await family();
    const w = await worker(p.id, messagesPrompt('claude', ['Waiting on the load run.\nCEZ:MONITORING']));
    const wait = register(p.id, [w.id]);
    // The crash: the worker parks, and its notice is never committed.
    vi.spyOn(manager as unknown as { noticeParkedWorker(id: string): void }, 'noticeParkedWorker').mockImplementation(() => {});
    manager.enqueueOwnedRun(w.id);
    await until(() => parked(w.id) && (store.getRun(w.id)?.waits ?? []).some(entry => entry.kind === 'timer' && entry.phase === 'open'), () => timeline(w.id));
    expect(notices(p.id, w.id)).toEqual([]);
    // As a crash leaves them: the fixture's own shutdown cancels runs, which completes the worker's
    // execution record, so it goes back with the event logs.
    const files = eventCheckpoint();
    const execution = join(root, '.ai/cezar/runs', `${w.id}.execution.json`);
    files.set(execution, readFileSync(execution, 'utf8'));
    await restart(false, undefined, files);
    await until(() => notices(p.id, w.id).length > 0, () => timeline(w.id));
    const [notice, ...more] = notices(p.id, w.id);
    expect(more).toEqual([]);
    expect(notice).toMatchObject({ id: parkNoticeId(w.id, wait.id), recipientRunId: p.id, state: 'accepted' });
    expect(notice!.text).toMatch(/It waits on: timer [0-9a-f-]+ at \S+ \(Opened by CEZ:MONITORING\.\)/);
    expect(notice!.text).toContain('Its last message:\nWaiting on the load run.');
    // The parent's input commits with the message.
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.id === notice!.id)).toEqual([
      expect.objectContaining({ conversation: { senderRunId: w.id, recipientRunId: p.id, kind: 'progress' } })]);
    // Recovery again finds the same message and posts nothing more.
    await restart();
    expect(notices(p.id, w.id)).toHaveLength(1);
  });

  it('sends no notice when the turn that parked already messaged the parent', async () => {
    const { p, service, callerOf } = await family();
    const w = await parkedWorker(p.id, 'Parked after reporting.');
    const own = randomUUID();
    await service.send(callerOf(w.id), { id: own, recipientRunId: p.id, kind: 'progress', text: 'I wait on the CI run of PR 12.', timeoutSeconds: 600 });
    register(p.id, [w.id]);
    expect(conversationOf(p.id).filter(message => message.senderRunId === w.id).map(message => message.id)).toEqual([own]);
  });

  it('a request wait on a reply from a parked worker gets the notice', async () => {
    const { p, service, callerOf } = await family();
    const w = await parkedWorker(p.id, 'Parked before the request.');
    const request = randomUUID();
    const turns = turnEnds(w.id);
    await service.send(callerOf(p.id), { id: request, recipientRunId: w.id, kind: 'request', text: messagesPrompt('claude', ['Read it; still blocked.']), timeoutSeconds: 600 });
    // The request runs as the worker's next turn, which parks again without a reply.
    await until(() => turnEnds(w.id) > turns && parked(w.id), () => timeline(w.id));
    expect(notices(p.id, w.id)).toEqual([]);
    const wait = manager.registerWorkerListWait(p.id, { requestIds: [request], timeoutSeconds: 600 }, 'cez-worker-wait');
    const [notice, ...more] = notices(p.id, w.id);
    expect(more).toEqual([]);
    expect(notice).toMatchObject({ id: parkNoticeId(w.id, wait.id) });
    expect(notice!.text).toContain('Its last message:\nRead it; still blocked.');
  });

  it('a full parent inbox sends no notice and notes it on the worker once', async () => {
    const { p } = await family();
    const now = new Date().toISOString();
    // 32 undelivered plain inputs fill the parent's inbox; nothing wakes it.
    fixtureUpdateRun(p.id, { agentInputs: Array.from({ length: 32 }, () => ({ id: randomUUID(), source: 'agent' as const, parentRunId: p.id, text: 'queued', createdAt: now })) });
    const w = await parkedWorker(p.id, 'Parked with a full inbox.');
    const wait = register(p.id, [w.id]);
    // Another registration sweeps the family again, and the same wait finds the inbox still full.
    const notify = vi.spyOn(manager as unknown as { noticeParkedWorker(id: string): void }, 'noticeParkedWorker');
    register(p.id, [(await worker(p.id)).id]);
    expect(notify).toHaveBeenCalledWith(w.id);
    expect(store.getRun(p.id)?.waits?.find(entry => entry.id === wait.id)?.phase).toBe('open');
    expect(notices(p.id, w.id)).toEqual([]);
    expect(store.readEvents(w.id).filter(event => event.type === 'note' && String(event.message).includes('no park notice was sent'))).toHaveLength(1);
  });
});
