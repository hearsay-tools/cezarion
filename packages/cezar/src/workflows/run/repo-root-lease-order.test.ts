import { testHome } from '../../home/test-home.testkit.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RunStore } from '../../runs/store.ts';
import { WorkspaceSemaphore } from '../../workspace/semaphore.ts';
import { createActiveRun } from '../active-run.ts';
import { RepoRootLease } from './repo-root-lease.ts';
import { TrackedWork } from './tracked-work.ts';
import { noRunners } from '../../core/runners-under-test.testkit.ts';

it('installs the waiter interrupt before park/release and restores it before unpark on cancellation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-lease-order-'));
  const store = RunStore.open(root);
  const owner = createActiveRun({ cwd: root, pendingHumanAsk: false, autonomous: false });
  const waiter = createActiveRun({ cwd: root, pendingHumanAsk: false, autonomous: false });
  const log: string[] = [];
  const original = () => { log.push('interrupt'); };
  waiter.liveSession.installInterrupt(original);
  const lease = new RepoRootLease({ createRunner: noRunners, home: testHome(), store, repoRoot: root, dataDir: root, semaphore: new WorkspaceSemaphore({ home: testHome() }),
    work: new TrackedWork(), disposed: () => false }, {
    park(id) {
      if (id !== 'waiter') return;
      log.push('park');
      expect(waiter.liveSession.interrupt).not.toBe(original);
      expect(waiter.liveSession.releaseRepoRoot).toBeTypeOf('function');
    },
    releaseSlot() { log.push('release'); },
    unpark(id) {
      if (id !== 'waiter') return;
      expect(waiter.liveSession.interrupt).toBe(original);
      log.push('unpark');
    },
  });
  try {
    expect(await lease.acquireRepoRoot('owner', owner)).toBe(true);
    log.length = 0;
    const pending = lease.acquireRepoRoot('waiter', waiter);
    expect(log).toEqual(['park', 'release']);
    waiter.liveSession.cancel();
    waiter.liveSession.interrupt();
    expect(await pending).toBe(false);
    expect(log).toEqual(['park', 'release', 'interrupt', 'unpark']);
    // A cancelled waiter chains its release behind the owner; it cannot hand the tree on early.
    waiter.liveSession.releaseRepoRoot?.();
    owner.liveSession.releaseRepoRoot?.();
  } finally {
    store.flush();
    rmSync(root, { recursive: true, force: true });
  }
});
