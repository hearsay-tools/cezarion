import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { installIdentityFileStore, type IdentityFileStore } from './identity-file-store.ts';
import { createOwnedWorkspace, verifyOwnedWorkspace } from './workspace.ts';
import { ownedWorkspaceRecordFiles } from './workspace-record.ts';
import { removeOwnedWorkspace } from './workspace-removal.ts';

// The ownership policy runs on Linux through a store that, like the Windows store, keeps no POSIX
// mode bits: it writes world-readable files and replaces in place. The store alone decides which
// identity files are safe, so the policy must still prove ownership through it.
type Operation = { op: keyof IdentityFileStore; name: string; flag?: boolean };
function windowsStyleStore() {
  const log: Operation[] = [];
  const unsafe = new Set<string>();
  const refuse = (path: string) => { if (unsafe.has(path)) throw new Error('Identity grants access to Everyone'); };
  const store: IdentityFileStore = {
    async directory(path, create) { log.push({ op: 'directory', name: basename(path), flag: create }); refuse(path); if (create) await mkdir(path, { recursive: true, mode: 0o755 }); },
    async read(path, cap, privateParent) { log.push({ op: 'read', name: basename(path), flag: privateParent }); refuse(path); return (await readFile(path, 'utf8')).slice(0, cap); },
    async write(path, content, privateParent) { log.push({ op: 'write', name: basename(path), flag: privateParent }); await writeFile(path, content, { flag: 'wx', mode: 0o644 }); },
    async replace(path, content) { log.push({ op: 'replace', name: basename(path) }); refuse(path); await writeFile(path, content, { mode: 0o644 }); },
  };
  return { store, log, unsafe };
}

const roots: string[] = [];
afterEach(async () => {
  installIdentityFileStore(undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cez-store-receipt-'))); roots.push(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@local');
  await writeFile(join(root, 'tracked'), 'test'); git('add', 'tracked'); git('commit', '-qm', 'initial');
  const fake = windowsStyleStore();
  installIdentityFileStore(fake.store);
  const workspace = await createOwnedWorkspace(root, randomUUID(), git('rev-parse', 'HEAD'));
  return { root, git, workspace, ...fake };
}

it('creates, verifies and removes an owned workspace through the installed store', async () => {
  const f = await fixture();
  const receipt = `${f.workspace.resourceId}.json`;
  expect(f.log).toEqual(expect.arrayContaining([
    { op: 'directory', name: 'cezar-owned-workspaces', flag: true },
    { op: 'write', name: 'cezar-owned-resource', flag: false },
    { op: 'write', name: receipt, flag: true },
  ]));
  expect(await ownedWorkspaceRecordFiles(f.root)).toEqual([join(f.root, '.git', 'cezar-owned-workspaces', receipt)]);
  const run = { id: f.workspace.ownerRunId, delegation: { role: 'worker', parentRunId: randomUUID(), permissions: [], workspace: f.workspace } };
  await expect(verifyOwnedWorkspace(f.root, run as never)).resolves.toEqual(f.workspace);
  f.log.length = 0;

  expect(await removeOwnedWorkspace(f.root, f.workspace)).toMatchObject({ state: 'complete', remaining: [] });
  expect(f.log).toEqual(expect.arrayContaining([
    { op: 'read', name: receipt, flag: true },
    { op: 'replace', name: `${f.workspace.resourceId}.cleanup.json` },
  ]));
  expect(() => f.git('rev-parse', '--verify', `refs/heads/${f.workspace.branch}`)).toThrow();
});

it('retains the worker when the store refuses its receipt', async () => {
  const f = await fixture();
  f.unsafe.add(join(f.root, '.git', 'cezar-owned-workspaces', `${f.workspace.resourceId}.json`));
  expect(await removeOwnedWorkspace(f.root, f.workspace)).toMatchObject({ state: 'incomplete' });
  expect(f.git('rev-parse', '--verify', `refs/heads/${f.workspace.branch}`)).toBe(f.workspace.baselineSha);
});
