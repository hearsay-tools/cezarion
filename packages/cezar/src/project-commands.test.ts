import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const lookup = vi.hoisted(() => ({ gate: undefined as Promise<void> | undefined, reached: undefined as (() => void) | undefined }));
vi.mock('./workflows/load.ts', async (original) => ({
  ...(await original<typeof import('./workflows/load.ts')>()),
  // The fallback scan reads every legacy workflow: a pause here is a real await of `init`.
  fallbackWorkflowPath: async () => { lookup.reached?.(); await lookup.gate; return undefined; },
}));

const { initCommand } = await import('./project-commands.ts');
const { CockpitOwnership, ProjectMigrationFencedError } = await import('./server/cockpit-ownership.ts');

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('re-checks the migration fence before each write that follows an await, so init writes nothing once fenced', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'cez-init-fence-'));
  roots.push(root);
  const dataDir = join(root, '.ai', 'cezar');
  let resume!: () => void;
  lookup.gate = new Promise<void>((resolve) => { resume = resolve; });
  const reached = new Promise<void>((resolve) => { lookup.reached = resolve; });
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const migrator = new CockpitOwnership();
  try {
    const init = initCommand(root).then(() => undefined, (error: unknown) => error);
    await reached;
    // Another process takes and drains the fence while init scans the fallback workflows.
    const fence = await migrator.fenceProject(dataDir, { liveTasks: () => [] });
    resume();
    expect(await init).toBeInstanceOf(ProjectMigrationFencedError);
    expect(existsSync(join(dataDir, 'workflows', 'fix-and-verify.yaml'))).toBe(false);
    expect(existsSync(join(dataDir, 'skills', 'project-conventions.md'))).toBe(false);
    expect(existsSync(join(dataDir, '.gitignore'))).toBe(false);
    fence.release();
  } finally {
    migrator.releaseAll();
    log.mockRestore();
  }
});
