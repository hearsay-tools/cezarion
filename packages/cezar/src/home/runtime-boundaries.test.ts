import { expect, it, vi } from 'vitest';
import { runtimeHomes } from './runtime-isolation.testkit.ts';
import { reconcileServeWorktrees } from '../serve-boot.ts';
import { classifyInputFor, type BranchForge } from '../server/repo-branches.ts';
import { createWorkspaceProjectContexts } from '../server/workspace-projects.ts';
import { ProjectContexts, type ProjectContextDeps } from '../server/project-context.ts';
import * as config from '../config.ts';
import type { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';

vi.mock('../server/project-context.ts', async original => ({ ...await original<typeof import('../server/project-context.ts')>(),
  ProjectContexts: vi.fn(function (this: { deps: ProjectContextDeps }, deps: ProjectContextDeps) { this.deps = deps; }),
}));
vi.mock('../server/git.ts', () => ({ getRepoInfo: vi.fn(async (root: string) => ({ root, branch: 'main' })) }));

it('passes the selected Home to boot retention and background branch sweeping', async () => {
  const { root, selected } = runtimeHomes();
  const store = { listRunIds: () => [] } as unknown as RunStore;
  const manager = {} as RunManager;
  const retention = vi.fn(async () => 17);
  const sweep = vi.fn(async () => null);
  await reconcileServeWorktrees(root, { root } as Parameters<typeof reconcileServeWorktrees>[1], store, manager, undefined, {
    pruneOrphans: vi.fn(async () => []), resolveWorktreeRetention: retention,
    reclaimWorktrees: vi.fn(async () => []), sweepMergedBranches: sweep, log: vi.fn(),
  }, selected);
  expect(retention).toHaveBeenCalledWith(root, selected);
  expect(sweep).toHaveBeenCalledWith(expect.objectContaining({ home: selected }), { keep: 17 });
});

it('passes the selected Home to branch-classification config loading', async () => {
  const { root, selected } = runtimeHomes();
  const load = vi.spyOn(config, 'loadConfig');
  const project = { root, home: selected, store: { listBranchOwners: () => [] }, manager: { isActive: () => false, claimForBranchCleanup: () => null } };
  await classifyInputFor(project, {} as BranchForge);
  expect(load).toHaveBeenCalledWith(root, selected);
});

it('passes the selected Home to lazy project contexts', () => {
  const { selected } = runtimeHomes();
  createWorkspaceProjectContexts({ home: selected }, { attach: vi.fn() }, { listProjects: async () => [] });
  expect(ProjectContexts).toHaveBeenCalledWith(expect.objectContaining({ home: selected }));
});
