import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const resolveRepoHandle = vi.hoisted(() => vi.fn());
vi.mock('./forge/github.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('./forge/github.ts')>(),
  resolveRepoHandle,
}));

import { ProjectContexts } from './project-context.ts';
import type { RepoHandle } from '../runs/store.ts';

const handle = { owner: 'acme', name: 'service' };
const foreignPr = 'https://github.com/other/repo/pull/42';

describe('project repository discovery lifetime', () => {
  let root: string;
  let contexts: ProjectContexts;

  afterEach(() => {
    contexts?.disposeAll();
    if (root) rmSync(root, { recursive: true, force: true });
    resolveRepoHandle.mockReset();
  });

  it.each(['dispose', 'disposeAll'] as const)(
    '%s prevents a late lookup from overwriting a reopened project',
    async (dispose) => {
      root = mkdtempSync(join(tmpdir(), 'cez-ctx-repo-lifetime-'));
      let release!: (value: RepoHandle) => void;
      resolveRepoHandle.mockReturnValueOnce(new Promise<RepoHandle>((resolve) => { release = resolve; }));
      resolveRepoHandle.mockResolvedValue(handle);
      contexts = new ProjectContexts({
        listProjects: async () => [{ id: 'project', root, status: 'not-git' }],
      });
      // Context construction must finish while the first lookup is still pending.
      const old = await contexts.context('project');
      const task = old.store.createRun({ title: 'old title', workflow: 'w', task: 'research', steps: [] });
      old.store.updateRun(task.id, { status: 'done', referencedPullRequestUrl: foreignPr });
      if (dispose === 'dispose') contexts.dispose('project');
      else contexts.disposeAll();

      const current = await contexts.context('project');
      // The new context still discovers its repository and repairs old references.
      expect(current.store.getRun(task.id)?.referencedPullRequestUrl).toBeUndefined();
      current.store.updateRun(task.id, { title: 'updated by current context' });
      const added = current.store.createRun({ title: 'new task', workflow: 'w', task: 'new task', steps: [] });
      current.store.updateRun(added.id, { status: 'done' });
      current.store.flush();
      const indexPath = join(current.dataDir, 'runs.json');
      const beforeLateLookup = readFileSync(indexPath, 'utf8');

      release(handle);
      await new Promise((resolve) => setImmediate(resolve));

      expect(readFileSync(indexPath, 'utf8')).toBe(beforeLateLookup);
      expect(old.store.getRun(task.id)?.referencedPullRequestUrl).toBe(foreignPr);
    },
  );
});
