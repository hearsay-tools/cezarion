import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireTestEnvLease } from '../../../../.ai/scripts/test-env-lease.mjs';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { processStartToken } from '../detached-process.ts';
import { windowsStartToken } from './windows-test-app.ts';
import { withIdleTestApp } from './idle-test-app.ts';
import { createOwnedWorkspace, removeOwnedWorkspace } from './workspace.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function rootDir() { const root = mkdtempSync(join(tmpdir(), 'cez-stale-lease-')); roots.push(root); return root; }
function lease(root: string, descriptor = true) {
  const qa = join(root, '.ai/qa'); mkdirSync(qa, { recursive: true });
  if (descriptor) writeFileSync(join(qa, 'test-env.json'), JSON.stringify({ startedByThisRepo: true, status: 'stopped', app: {} }));
  const db = new DatabaseSync(join(qa, 'test-env-lease.sqlite'));
  db.exec('CREATE TABLE holders (id TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL, start TEXT, pgid INTEGER)');
  return db;
}
async function ownedWorkspace() {
  const root = rootDir();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@local');
  writeFileSync(join(root, 'tracked'), 'test'); git('add', 'tracked'); git('commit', '-qm', 'initial');
  const workspace = await createOwnedWorkspace(root, randomUUID(), git('rev-parse', 'HEAD'));
  return { root, workspace };
}
it.each(['dead', 'missing-descriptor', 'reused', 'interrupted-destroy'])('claims an idle lease after %s', async mode => {
  const root = rootDir(); const db = lease(root, mode !== 'missing-descriptor');
  if (mode !== 'missing-descriptor') db.prepare('INSERT INTO holders VALUES (?, ?, ?, ?, NULL)')
    .run(mode === 'interrupted-destroy' ? 'destroy-old' : 'old', 'old', mode === 'reused' ? process.pid : 2147483647, 'old-incarnation');
  try {
    await withIdleTestApp(root, async (stopped, busy) => {
      expect(stopped).toBe(false); expect(busy).toBe(false);
      expect(db.prepare('SELECT id FROM holders').all()).toEqual([{ id: expect.stringMatching(/^destroy-/) }]);
      // The callback sees a durable claim even though the writer handle was closed.
      await expect(acquireTestEnvLease(root, { timeoutMs: 20 })).rejects.toThrow(/timed out/);
      return false;
    });
    expect(db.prepare('SELECT * FROM holders').all()).toEqual([]);
  } finally { db.close(); }
});
it.each([false, true])('completes owned worker destroy with stale lease (descriptor: %s)', async descriptor => {
  const { root, workspace } = await ownedWorkspace();
  const db = lease(workspace.path, descriptor);
  db.prepare('INSERT INTO holders VALUES (?, ?, ?, ?, NULL)').run('dead', 'old', 2147483647, 'gone'); db.close();
  expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'complete', remaining: [] });
});
it('names a live holder and lease path when worker destroy is blocked', async () => {
  const { root, workspace } = await ownedWorkspace();
  const db = lease(workspace.path, false);
  const start = process.platform === 'win32' ? windowsStartToken(process.pid) : processStartToken(process.pid);
  db.prepare('INSERT INTO holders VALUES (?, ?, ?, ?, NULL)').run('live', 'live', process.pid, start!); db.close();
  const result = await removeOwnedWorkspace(root, workspace);
  expect(result.state).toBe('incomplete'); expect(result.error).toContain(join(workspace.path, '.ai/qa/test-env-lease.sqlite'));
  expect(result.error).toContain(`pid ${process.pid}`); expect(result.error).toContain(start);
});
it.skipIf(process.platform === 'win32')('down releases its joined shell row on the no-descriptor exit', () => {
  const root = rootDir(); const scripts = join(root, '.ai/scripts'); mkdirSync(scripts, { recursive: true });
  for (const name of ['test-env-down.sh', 'test-env-lease.mjs']) copyFileSync(resolve('.ai/scripts', name), join(scripts, name));
  symlinkSync(resolve('packages'), join(root, 'packages'), 'dir');
  const env = { ...process.env }; delete env.TEST_ENV_LEASE_ENTRY; delete env.TEST_ENV_LEASE_TOKEN;
  execFileSync('sh', [join(scripts, 'test-env-down.sh')], { timeout: 15000, stdio: 'pipe', env });
  const db = new DatabaseSync(join(root, '.ai/qa/test-env-lease.sqlite'));
  try { expect(db.prepare('SELECT * FROM holders').all()).toEqual([]); } finally { db.close(); }
});

it.each(['corrupt', 'redirected', 'invalid-database'])('retains uncertain metadata: %s', async mode => {
  const root = rootDir(); const db = lease(root); db.close();
  const descriptor = join(root, '.ai/qa/test-env.json');
  if (mode === 'corrupt') writeFileSync(descriptor, '{');
  if (mode === 'redirected') { rmSync(descriptor); symlinkSync(join(root, 'absent.json'), descriptor); }
  if (mode === 'invalid-database') writeFileSync(join(root, '.ai/qa/test-env-lease.sqlite'), 'invalid');
  await withIdleTestApp(root, async (stopped, busy, reason) => {
    expect(stopped).toBe(false); expect(busy).toBe(true); expect(reason).toContain('metadata could not be verified');
  });
});
it.skipIf(process.platform === 'win32').each(['error', 'SIGINT', 'SIGTERM'] as const)(
  'supervision releases joined shells after %s', async mode => {
    const root = rootDir(); const scripts = join(root, '.ai/scripts'); mkdirSync(scripts, { recursive: true });
    copyFileSync(resolve('.ai/scripts/test-env-lease.mjs'), join(scripts, 'test-env-lease.mjs'));
    symlinkSync(resolve('packages'), join(root, 'packages'), 'dir');
    const script = join(root, 'command.sh');
    writeFileSync(script, `node .ai/scripts/test-env-lease.mjs join "$$"
trap 'exit 130' INT
trap 'exit 143' TERM
echo ready
${mode === 'error' ? 'exit 7' : 'while :; do sleep 1; done'}
`);
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('TEST_ENV_LEASE_')) delete env[key];
    const child = spawn(process.execPath, [join(scripts, 'test-env-lease.mjs'), 'run', 'sh', script], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    try {
      await once(child.stdout!, 'data');
      if (mode !== 'error') child.kill(mode);
      const [code] = await exited;
      expect(code).toBe(mode === 'error' ? 7 : mode === 'SIGINT' ? 130 : 143);
      const db = new DatabaseSync(join(root, '.ai/qa/test-env-lease.sqlite'));
      try { expect(db.prepare('SELECT * FROM holders').all()).toEqual([]); } finally { db.close(); }
    } finally { if (child.exitCode === null) child.kill('SIGKILL'); await exited; }
  },
);
