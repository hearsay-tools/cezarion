import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

let template: Promise<string> | undefined;

async function seed(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cez-workspace-template-'));
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('config', 'gc.auto', '0');
    git('config', 'maintenance.auto', 'false');
    git('config', 'user.name', 'test');
    git('config', 'user.email', 'test@local');
    await writeFile(join(root, 'tracked.txt'), 'base');
    git('add', '.');
    git('commit', '-qm', 'one');
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

/** The immutable initial root only; never seed worktree registrations here. */
export function workspaceSeed(): Promise<string> {
  return template ??= seed();
}

export async function copyWorkspaceSeed(destination: string): Promise<void> {
  // cp copies mutable Git files; neither refs nor the index may be hardlinked.
  await cp(await workspaceSeed(), destination, { recursive: true });
}

afterAll(async () => {
  if (template) await rm(await template, { recursive: true, force: true });
});
