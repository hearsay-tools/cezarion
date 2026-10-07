import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectWorkerEvidence } from '../delegation/results.ts';
import { projectConversationEvents } from '../delegation/conversations.ts';
import { historyPaths } from '../runs/history-file.ts';
import { RunStore } from '../runs/store.ts';
import { countTranscriptReads, restoreTranscriptReads } from '../runs/transcript-reads.testkit.ts';
import { RunManager } from './run.ts';
import { seedSettledFamily } from './delegation-reconcile.testkit.ts';
import { manager as liveManager, parent, store as liveStore, until, useWorkerWaitFixture, worker } from './worker-wait.testkit.ts';

const questions = [{ header: 'Pick', question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] }];
type Private = { routedAsk(runId: string): unknown };

/** The commit, reconcile and delivery paths answer from the transcript facts index (#880). */
describe('delegation paths read no transcript (#880)', () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  let family: ReturnType<typeof seedSettledFamily>;
  let familyPaths: (path: string) => boolean;
  beforeEach(() => {
    vi.stubEnv('CEZ_DELEGATION', '1');
    root = mkdtempSync(join(tmpdir(), 'cez-transcript-reads-'));
    store = RunStore.open(join(root, '.ai/cezar'));
    family = seedSettledFamily(store, root);
    // A worker that asked, and routed the ask, before it settled.
    const ask = store.appendEvent(family.workerId, { type: 'ask.requested', requestId: 'q', questions });
    store.appendEvent(family.workerId, { type: 'worker-question-routed', askSeq: ask.seq, messageId: randomUUID(), parentRunId: family.parentId });
    for (let i = 0; i < 50; i++) store.appendEvent(family.parentId, { type: 'text', text: `parent token ${i}` });
    manager = new RunManager(store, root);
    const ids = [family.parentId, family.workerId];
    familyPaths = (path) => ids.some((id) => path.includes(id));
  });
  afterEach(() => {
    restoreTranscriptReads();
    manager.dispose(); store.close(); vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  const checkpoint = (id: string) => store.commitDelegation([{ id, delegation: store.getRun(id)!.delegation! }]);

  it('a terminal worker checkpoint commit reads no transcript', () => {
    checkpoint(family.workerId); // projects the family once
    const projected = store.readEvents(family.parentId).length;
    const reads = countTranscriptReads(familyPaths);
    const reconcile = vi.spyOn(manager, 'reconcileWorkerWaits');
    checkpoint(family.workerId);
    expect(reconcile).toHaveBeenCalled();
    expect(reads.counts).toEqual({ files: [], decompress: 0 });
    restoreTranscriptReads();
    expect(store.readEvents(family.parentId)).toHaveLength(projected);
  });

  it('projectConversationEvents and routedAsk read no transcript', () => {
    checkpoint(family.workerId);
    const before = store.readEvents(family.workerId).filter((event) => event.type === 'conversation-message').length;
    const reads = countTranscriptReads(familyPaths);
    projectConversationEvents(store, store.getRun(family.parentId)!);
    (manager as unknown as Private).routedAsk(family.workerId);
    expect(reads.counts).toEqual({ files: [], decompress: 0 });
    restoreTranscriptReads();
    expect(store.readEvents(family.workerId).filter((event) => event.type === 'conversation-message')).toHaveLength(before);
  });

  const destroyPhase = (phase: 'terminating' | 'cleaning' | 'complete') => {
    const delegation = store.getRun(family.workerId)!.delegation!;
    if (delegation.role !== 'worker') throw Error('expected worker');
    store.commitDelegation([{ id: family.workerId, delegation: { ...delegation,
      destroy: { requestedAt: delegation.destroy?.requestedAt ?? new Date().toISOString(), phase, remaining: phase === 'complete' ? [] : ['worktree', 'branch'] } } }]);
  };

  it('a destroy-progress checkpoint skips the family reconcile', () => {
    destroyPhase('terminating');
    const reconcile = vi.spyOn(manager, 'reconcileWorkerWaits');
    destroyPhase('cleaning');
    destroyPhase('cleaning');
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('the first destroy request and its completion still reconcile', () => {
    const reconcile = vi.spyOn(manager, 'reconcileWorkerWaits');
    destroyPhase('terminating');
    expect(reconcile).toHaveBeenCalledTimes(1);
    destroyPhase('complete');
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it('collectWorkerEvidence reads an archived worker asynchronously', async () => {
    store.appendEvent(family.workerId, { type: 'text', text: 'the worker summary' });
    const paths = historyPaths(join(root, '.ai/cezar'), family.workerId);
    writeFileSync(paths.compressed, brotliCompressSync(readFileSync(paths.plain)));
    rmSync(paths.plain);
    const reads = countTranscriptReads(familyPaths);
    const { result } = await collectWorkerEvidence(root, store, store.getRun(family.workerId)!);
    expect(result.summary).toMatchObject({ state: 'available', text: 'the worker summary' });
    expect(reads.counts).toEqual({ files: [], decompress: 0 });
  });
});

describe('delivering a message to a worker reads no transcript (#880)', { timeout: 45_000 }, () => {
  afterEach(() => restoreTranscriptReads());
  useWorkerWaitFixture();

  it('refuses a human message on a routed question from the index', async () => {
    process.env.CEZ_DELEGATION = '1';
    const p = await parent();
    const delegation = liveStore.getRun(p.id)!.delegation!;
    if (delegation.role !== 'root') throw Error('missing root');
    liveStore.commitDelegation([{ id: p.id, delegation: { ...delegation, permissions: [...delegation.permissions, 'steer'] } }]);
    await until(() => liveStore.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id, 'mock:ask'); liveManager.enqueueOwnedRun(w.id);
    await until(() => liveStore.readEvents(w.id).some((event) => event.type === 'worker-question-routed') && liveStore.getRun(w.id)?.status === 'waiting');
    const reads = countTranscriptReads((path) => path.includes(w.id));
    expect(liveManager.sendMessage(w.id, [{ type: 'text', text: 'a human answer' }])).toBe(false);
    expect(reads.counts).toEqual({ files: [], decompress: 0 });
  });
});
