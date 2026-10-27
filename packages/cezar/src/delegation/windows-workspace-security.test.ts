import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createOwnedWorkspace, removeOwnedWorkspace } from './workspace.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cez-win-receipt-'))); roots.push(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@local');
  await writeFile(join(root, 'tracked'), 'test'); git('add', 'tracked'); git('commit', '-qm', 'initial');
  const workspace = await createOwnedWorkspace(root, randomUUID(), git('rev-parse', 'HEAD'));
  const dir = join(root, '.git', 'cezar-owned-workspaces');
  const receipt = join(dir, `${workspace.resourceId}.json`);
  const gitDir = (JSON.parse(await readFile(receipt, 'utf8')) as { gitDir: string }).gitDir;
  return { root, git, workspace, dir, receipt, marker: join(gitDir, 'cezar-owned-resource'), checkpoint: receipt.replace(/\.json$/, '.cleanup.json') };
}

it.runIf(process.platform === 'win32').each(['dir', 'receipt', 'marker', 'checkpoint'] as const)(
  'retains the worker when its %s grants access to Everyone', async target => {
    const f = await fixture();
    if (target === 'checkpoint') await removeOwnedWorkspace(f.root, f.workspace, undefined, async () => { throw new Error('interrupt before removal'); });
    execFileSync('icacls.exe', [f[target], '/grant', '*S-1-1-0:F']);
    expect(await removeOwnedWorkspace(f.root, f.workspace)).toMatchObject({ state: 'incomplete' });
    expect(f.git('rev-parse', '--verify', `refs/heads/${f.workspace.branch}`)).toBe(f.workspace.baselineSha);
  }, 120_000,
);

it.runIf(process.platform === 'win32').each(['dir', 'marker'] as const)(
  'refuses a substituted %s reparse point', async target => {
    const f = await fixture(); const saved = `${f[target]}-saved`;
    await rename(f[target], saved);
    await symlink(saved, f[target], target === 'dir' ? 'junction' : 'file');
    expect(await removeOwnedWorkspace(f.root, f.workspace)).toMatchObject({ state: 'incomplete' });
    expect(f.git('rev-parse', '--verify', `refs/heads/${f.workspace.branch}`)).toBe(f.workspace.baselineSha);
  }, 120_000,
);

it.runIf(process.platform === 'win32')('reuses private receipts and retries an interrupted checkpoint through completion', async () => {
  const f = await fixture(); const receipt = await readFile(f.receipt, 'utf8');
  expect(await removeOwnedWorkspace(f.root, f.workspace, undefined, async () => { throw new Error('interrupt before removal'); })).toMatchObject({ state: 'incomplete' });
  expect(JSON.parse(await readFile(f.checkpoint, 'utf8'))).toMatchObject({ phase: 'prepared' });
  expect(await removeOwnedWorkspace(f.root, f.workspace)).toMatchObject({ state: 'complete' });
  expect(JSON.parse(await readFile(f.checkpoint, 'utf8'))).toMatchObject({ phase: 'complete' });
  expect(await readFile(f.receipt, 'utf8')).toBe(receipt);
  expect(await removeOwnedWorkspace(f.root, f.workspace)).toMatchObject({ state: 'complete' });
}, 120_000);

it.runIf(process.platform === 'win32')('provisions and removes a worker under Restricted process execution policy', async () => {
  const previous = process.env.PSExecutionPolicyPreference;
  process.env.PSExecutionPolicyPreference = 'Restricted';
  try {
    const f = await fixture();
    expect(await removeOwnedWorkspace(f.root, f.workspace)).toMatchObject({ state: 'complete' });
  } finally {
    if (previous === undefined) delete process.env.PSExecutionPolicyPreference;
    else process.env.PSExecutionPolicyPreference = previous;
  }
}, 120_000);
