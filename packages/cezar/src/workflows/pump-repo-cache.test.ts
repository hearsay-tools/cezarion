import { testHome } from '../home/test-home.testkit.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import * as git from '../server/git.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import { acquireInertCiResources } from '../ci-wait/inert-ci-resources.testkit.ts';
import { createRunner } from '../core/runner-factory.ts';

describe('scheduler repository probe budget (#364)', () => {
  const fixtures: Array<{ root: string; store: RunStore; manager: RunManager }> = [];

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'cez-pump-repo-'));
    const store = RunStore.open(join(root, '.ai/cezar'));
    const semaphore = new WorkspaceSemaphore({ home: testHome(), initial: { maxParallel: 0 } });
    const manager = new RunManager(store, root, { acquireCiResources: acquireInertCiResources, createRunner, home: testHome(), semaphore });
    fixtures.push({ root, store, manager });
    return { root, pump: () => semaphore.release() };
  }

  afterEach(() => {
    for (const { root, store, manager } of fixtures.splice(0)) {
      manager.dispose();
      store.flush();
      rmSync(root, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it.each([true, false])('probes once across repeated pumps (repository: %s)', async (isRepo) => {
    const { root, pump } = fixture();
    const probe = vi.spyOn(git, 'getRepoInfo').mockResolvedValue(
      isRepo ? { root, branch: 'main' } : null,
    );

    await pump();
    await pump();
    await pump();

    expect(probe).toHaveBeenCalledExactlyOnceWith(root);
  });

  it('reuses the first probe when another pump arrives before it resolves', async () => {
    const { root, pump } = fixture();
    let resolve!: (repo: git.RepoInfo | null) => void;
    const probe = vi.spyOn(git, 'getRepoInfo').mockReturnValue(
      new Promise((done) => { resolve = done; }),
    );

    const first = pump();
    await pump();
    resolve({ root, branch: 'main' });
    await first;

    expect(probe).toHaveBeenCalledExactlyOnceWith(root);
  });

  it('keeps the probe local to each manager', async () => {
    const first = fixture();
    const second = fixture();
    const probe = vi.spyOn(git, 'getRepoInfo').mockImplementation(async (root) =>
      root === first.root ? { root, branch: 'main' } : null,
    );

    await first.pump();
    await second.pump();
    await first.pump();
    await second.pump();

    expect(probe.mock.calls).toEqual([[first.root], [second.root]]);
  });
});
