import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import { cleanupCheckpoint, seedSettledFamily } from './delegation-reconcile.testkit.ts';

describe('terminal delegation checkpoint reconciliation (#661)', () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  let a: ReturnType<typeof seedSettledFamily>;
  let b: ReturnType<typeof seedSettledFamily>;
  beforeEach(() => {
    vi.stubEnv('CEZ_DELEGATION', '1');
    root = mkdtempSync(join(tmpdir(), 'cez-reconcile-'));
    store = RunStore.open(join(root, '.ai/cezar'));
    a = seedSettledFamily(store, root); b = seedSettledFamily(store, root);
    manager = new RunManager(store, root);
  });
  afterEach(() => {
    manager.dispose(); store.flush(); vi.restoreAllMocks(); vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it.each(['parent', 'worker'] as const)('%s checkpoint projects its family without reading unrelated histories', target => {
    const reads = vi.spyOn(store, 'readEvents');
    if (target === 'worker') cleanupCheckpoint(store, a.workerId);
    else store.commitDelegation([{ id: a.parentId, delegation: store.getRun(a.parentId)!.delegation! }]);
    expect(reads.mock.calls.map(([id]) => id)).not.toContain(b.parentId);
    expect(reads.mock.calls.map(([id]) => id)).not.toContain(b.workerId);
    for (const id of [a.parentId, a.workerId]) {
      expect(store.readEvents(id).some(e => e.type === 'conversation-message' && e.projectionId === `conversation-message:${a.messageId}:not-delivered`)).toBe(true);
    }
  });

  it.each(['0', undefined])('does not enter checkpoint reconciliation when CEZ_DELEGATION=%s', flag => {
    vi.stubEnv('CEZ_DELEGATION', flag);
    const reconcile = vi.spyOn(manager, 'reconcileWorkerWaits');
    const reads = vi.spyOn(store, 'readEvents');
    cleanupCheckpoint(store, a.workerId);
    // Retained-result publication updates the terminal parent through this same
    // checkpoint channel; it must not restart global projection either.
    store.commitDelegation([{ id: a.parentId, delegation: store.getRun(a.parentId)!.delegation! }]);
    expect(reconcile).not.toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
    expect(store.getRun(a.workerId)?.delegation).toHaveProperty('destroy.phase', 'terminating');
  });

  it('retains global reconciliation for recovery and explicit callers', () => {
    // The full pass recovery runs (#779): settled families are no longer in memory, and the
    // pass over live families would skip them.
    manager.reconcileAllWorkerFamilies();
    for (const family of [a, b]) expect(store.readEvents(family.parentId).some(e => e.type === 'conversation-message')).toBe(true);
  });

  it('reconciles only the families with a live member when no family is named', () => {
    store.updateRun(b.workerId, { status: 'running' });
    manager.reconcileWorkerWaits();
    expect(store.readEvents(a.parentId).some(e => e.type === 'conversation-message')).toBe(false);
    expect(store.readEvents(b.parentId).some(e => e.type === 'conversation-message')).toBe(true);
  });

  it.each(['family', 'full', 'live'] as const)('does not lose a %s request emitted during reconciliation', scope => {
    // A live family is reached by the unnamed pass; the settled one only by name or the full pass.
    if (scope === 'live') store.updateRun(b.workerId, { status: 'running' });
    const append = store.appendEvent.bind(store);
    let changed = false;
    vi.spyOn(store, 'appendEvent').mockImplementation((id, event) => {
      if (!changed && id === a.parentId && event.type === 'conversation-message') {
        changed = true;
        if (scope === 'family') cleanupCheckpoint(store, b.workerId);
        else if (scope === 'full') manager.reconcileAllWorkerFamilies();
        else manager.reconcileWorkerWaits();
      }
      return append(id, event);
    });
    cleanupCheckpoint(store, a.workerId);
    expect(changed).toBe(true);
    expect(store.readEvents(b.parentId).some(e => e.type === 'conversation-message')).toBe(true);
  });
});
