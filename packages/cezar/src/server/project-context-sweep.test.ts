import { testHome } from '../home/test-home.testkit.ts';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRunner } from '../core/runner-factory.ts';
import { ProjectContexts, ProjectContextsClosedError } from './project-context.ts';
import { createRunManager } from './run-manager.testkit.ts';

const sweeps = vi.hoisted(() => ({ started: 0 }));
vi.mock('./repo-branch-sweep.ts', async (original) => {
  const real = await original<typeof import('./repo-branch-sweep.ts')>();
  return { ...real, sweepMergedBranches: async () => { sweeps.started += 1; return null; } };
});

/** A project context owns its branch sweeps (hearsay-tools/squawk#911): disposal stops them, and a
 *  build that disposal overtook starts none, since nothing would abort or await it. */
describe('the branch sweep of a project context', () => {
  const roots: string[] = [];
  afterEach(() => {
    sweeps.started = 0;
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function repository(): string {
    const root = mkdtempSync(join(tmpdir(), 'cez-context-sweep-'));
    roots.push(root);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@local', 'commit', '-qm', 'base', '--allow-empty'], { cwd: root });
    return root;
  }

  function contexts(root: string, disposeWhileBuilding: boolean): ProjectContexts {
    const made: ProjectContexts = new ProjectContexts({ createRunner, createManager: createRunManager, home: testHome(),
      listProjects: async () => [{ id: 'p', root, status: 'ok' as const }],
      // Runs before the build's awaits: disposal overtakes the build there.
      prepareManager: () => { if (disposeWhileBuilding) void made.disposeAll(); } });
    return made;
  }

  it('starts one sweep when a project opens', async () => {
    const built = contexts(repository(), false);
    await built.context('p');
    expect(sweeps.started).toBe(1);
    await built.disposeAll();
  });

  it('starts none from a build that disposal overtook', async () => {
    const built = contexts(repository(), true);
    await expect(built.context('p')).rejects.toBeInstanceOf(ProjectContextsClosedError);
    expect(sweeps.started).toBe(0);
  });
});
