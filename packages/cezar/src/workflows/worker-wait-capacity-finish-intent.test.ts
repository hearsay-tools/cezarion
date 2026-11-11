import * as gitWorktree from '../git-worktree.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { bookkeeping, collect, manager, parent, restart, root, store, until, worker, work } from './worker-wait-claude.testkit.ts';
import { blockRunWrites, readPersistedRuns } from '../runs/run-store.testkit.ts';
import { useWorkerCapacityFixture } from './worker-wait-capacity.testkit.ts';

describe("worker waits through RunManager", { timeout: 30_000 }, () => {
  useWorkerCapacityFixture();

for (const review of [false, true]) {
    it(`inactive ready root Finish persists intent before async settlement and restart keeps review=${review}`, async () => {
      const p = await parent();
      await until(() => store.getRun(p.id)?.status === 'waiting');
      const w = await worker(p.id);
      manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15000)).toBe(true); await collect(w.id);
      await restart();
      process.env.CEZ_REVIEW_GATE = review ? '1' : '0';
      writeFileSync(join(store.getRun(p.id)!.worktreePath!, 'review-change.txt'), 'review me');
      const diff = gitWorktree.worktreeDiff;
      let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
      const delayedDiff = vi.spyOn(gitWorktree, 'worktreeDiff').mockImplementation(async (...args) => {
        await gate;
        return diff(...args);
      });
      let completion: Promise<unknown> | undefined;
      try {
        expect(manager.finish(p.id)).toBe(true);
        expect(delayedDiff).toHaveBeenCalled();
        completion = Promise.all([...work.pending.keys()]);
        expect(store.getRun(p.id)?.delegation).toHaveProperty('finishRequestedAt');
        expect(manager.continueRun(p.id, { text: 'too late' }).ok).toBe(false);
        store.flush(); const checkpoint = readPersistedRuns(join(root, '.ai/cezar'));
        manager.dispose(); release(); await completion; delayedDiff.mockRestore();
        expect(store.getRun(p.id)?.status).toBe(review ? 'review' : 'done');
        await restart(false, checkpoint);
        expect(store.getRun(p.id)?.status).toBe(review ? 'review' : 'done');
        expect(store.getRun(w.id)?.status).toBe('cancelled');
      } finally { release(); await completion; delayedDiff.mockRestore(); }
    });
  }

it('inactive Finish write failure leaves the root recoverable and children untouched', async () => {
    const p = await parent();
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id); await restart();
    await until(() => store.getRun(w.id)?.status === 'waiting');
    manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15000)).toBe(true); await collect(w.id);
    await Promise.all(bookkeeping.splice(0)); store.flush();
    const snapshot = JSON.stringify(store.getRun(p.id));
    const release = blockRunWrites(join(root, '.ai/cezar'));
    try { expect(manager.finish(p.id)).toBe(false); }
    finally { release(); }
    expect(JSON.stringify(store.getRun(p.id))).toBe(snapshot);
    expect(store.getRun(w.id)?.status).toBe('cancelled');
    expect(manager.continueRun(p.id, { text: 'mock:hold' }).ok).toBe(true);
    await until(() => store.getRun(p.id)?.status === 'waiting');
  });
});
