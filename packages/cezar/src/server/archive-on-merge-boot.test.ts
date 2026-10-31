import type { ArchivePullRequestIdentity } from '@open-mercato/cezar-contract';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { seedRuns, readPersistedRuns } from '../runs/run-store.testkit.ts';
import { RunManager } from '../workflows/run.ts';
import { registerProject, listProjects, clearProjectProbeCache } from '../workspace/projects.ts';
import { ProjectContexts } from './project-context.ts';
import { ArchiveOnMergeCoordinator } from './archive-on-merge.ts';
import { resolveForgeRoot } from './forge/index.ts';
const discoverRepoHandle = vi.fn();
const lookupMergedPullRequests = vi.fn(async (_root: string, prs: ArchivePullRequestIdentity[], _signal?: AbortSignal) => prs.filter(pr => pr.repo === 'r').map(pr => ({ ...pr, mergedAt: '2026-01-02T00:00:00Z' })));
const forgeFactory = (root: string) => ({
  ...resolveForgeRoot(root),
  discoverRepository: () => discoverRepoHandle(),
  mergedPullRequests: (identities: ArchivePullRequestIdentity[], signal: AbortSignal) => lookupMergedPullRequests(root, identities, signal),
});
import { startServer } from './server.ts';

/** Hang guard for the waits below: each ends the moment its condition holds, so the bound only ends a hang. */
const HANG_GUARD_MS = 15_000;

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); dirs.splice(0).forEach(d => rmSync(d, { force: true, recursive: true })); clearProjectProbeCache(); });
function dir() { const path = mkdtempSync(join(tmpdir(), 'cez-merge-boot-')); dirs.push(path); return path; }
it.each([{ single: false, repository: 'r' }, { single: true, repository: 'r' }, { single: false, repository: 'upstream' }])('uses the verified gh default repository without recovery: %j', async ({ single, repository }) => {
  vi.mocked(discoverRepoHandle).mockResolvedValue({ status: 'resolved', handle: { owner: 'o', name: repository } });
  vi.mocked(lookupMergedPullRequests).mockClear();
  vi.stubEnv('CEZ_HOME', dir()); vi.stubEnv('CEZ_PROJECT_WARMUP', '0'); vi.stubEnv('CEZ_DRY_RUN', '1');
  vi.stubEnv('CEZ_ARCHIVE_ON_MERGE', '1'); vi.stubEnv('CEZ_SINGLE_PROJECT', single ? '1' : '0');
  const boot = dir(), cold = dir();
  for (const root of [boot, cold]) {
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '--no-gpg-sign', '-qm', 'initial']);
    execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/o/r.git']);
  }
  const bootProject = await registerProject(boot), other = await registerProject(cold);
  const id = randomUUID(), dataDir = join(cold, '.ai/cezar');
  seedRuns(dataDir, [{ id, title: 't', task: 't', workflow: 'quick-task', steps: [], tokensUsed: 0, status: 'done', archived: false, createdAt: '2026-01-01T00:00:00Z', pullRequests: [{ number: 42, source: 'declared' }] }]);
  const recover = vi.spyOn(RunManager.prototype, 'recover');
  const contexts = new ProjectContexts({ listProjects });
  const store = RunStore.open(join(boot, '.ai/cezar'), { keepLive: true });
  // The real post-listen hook starts the coordinator; drive an additional tick to avoid
  // waiting a minute for the project cursor to move beyond the empty boot project.
  let coordinator: ArchiveOnMergeCoordinator | undefined;
  const tick = ArchiveOnMergeCoordinator.prototype.tick;
  vi.spyOn(ArchiveOnMergeCoordinator.prototype, 'tick').mockImplementation(function (this: ArchiveOnMergeCoordinator) { coordinator = this; return tick.call(this); });
  const server = startServer({ repoRoot: boot, bootProjectId: bootProject.id, store, manager: { isActive: () => false } as unknown as RunManager, version: 'test', contexts, forgeFactory }, 0);
  try {
    await new Promise<void>(resolve => server.once('listening', () => resolve()));
    await vi.waitFor(() => expect(coordinator).toBeDefined(), { timeout: HANG_GUARD_MS });
    await vi.waitFor(async () => {
      await coordinator!.tick();
      expect(readPersistedRuns(dataDir)[0].archived).toBe(!single && repository === 'r');
    }, { timeout: HANG_GUARD_MS });
    expect(contexts.peek(other.id)).toBeUndefined(); expect(recover).not.toHaveBeenCalled();
    if (!single) {
      await vi.waitFor(async () => {
        await coordinator!.tick();
        expect(lookupMergedPullRequests).toHaveBeenCalledWith(cold, [{ owner: 'o', repo: repository, number: 42 }], expect.any(AbortSignal));
      }, { timeout: HANG_GUARD_MS });
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve())); contexts.disposeAll(); store.close();
  }
});
