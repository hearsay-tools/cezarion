import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { withIdleTestApp } from './idle-test-app.ts';

const probes = vi.hoisted(() => ({ owned: vi.fn(), stop: vi.fn() }));
vi.mock('./windows-test-app.ts', () => ({ windowsStartToken: () => '123', windowsTestAppHolds: probes.owned }));
vi.mock('../detached-process.ts', () => ({ processStartToken: () => '123', stopGroup: probes.stop }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

it.each(['unverifiable owner', 'failed stop', 'corrupt descriptor'])(
  'blocks Windows cleanup after a lease claim with %s', async reason => {
    const root = await mkdtemp(join(tmpdir(), 'cez-refused-app-'));
    try {
      vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }));
      const qa = join(root, '.ai/qa'); await mkdir(qa, { recursive: true });
      await writeFile(join(qa, 'test-env.json'), reason === 'corrupt descriptor' ? '{' : JSON.stringify({ startedByThisRepo: true, app: { pid: 42, start: '123' } }));
      const db = new DatabaseSync(join(qa, 'test-env-lease.sqlite'));
      db.exec('CREATE TABLE holders (id TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL, start TEXT, pgid INTEGER)'); db.close();
      probes.owned.mockReturnValue(reason === 'failed stop'); probes.stop.mockResolvedValue(false);
      await withIdleTestApp(root, async (stopped, busy) => {
        expect(stopped).toBe(false); expect(busy, 'unverified app must block removal').toBe(true);
      });
      const observer = new DatabaseSync(join(qa, 'test-env-lease.sqlite'));
      try { expect(observer.prepare('SELECT count(*) AS count FROM holders').get()).toMatchObject({ count: 0 }); }
      finally { observer.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  },
);

it('retries a stopped app only after its last lease is released', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-stopped-app-'));
  try {
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }));
    const qa = join(root, '.ai/qa'); await mkdir(qa, { recursive: true });
    await writeFile(join(qa, 'test-env.json'), JSON.stringify({ startedByThisRepo: true, status: 'stopped', app: {} }));
    const db = new DatabaseSync(join(qa, 'test-env-lease.sqlite'));
    try {
      db.exec('CREATE TABLE holders (id TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL, start TEXT, pgid INTEGER)');
      db.prepare('INSERT INTO holders VALUES (?, ?, ?, ?, NULL)').run('live', 'live', process.pid, '123');
      await withIdleTestApp(root, async (stopped, busy) => { expect(stopped).toBe(false); expect(busy).toBe(true); });
      db.exec('DELETE FROM holders');
    } finally { db.close(); }
    await withIdleTestApp(root, async (stopped, busy) => { expect(stopped).toBe(false); expect(busy).toBe(false); });
    expect(probes.stop).not.toHaveBeenCalled();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('releases its own claim after a concurrent lease transaction ends', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-claim-release-'));
  try {
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }));
    const qa = join(root, '.ai/qa'); await mkdir(qa, { recursive: true });
    await writeFile(join(qa, 'test-env.json'), JSON.stringify({ startedByThisRepo: true, status: 'stopped', app: {} }));
    const path = join(qa, 'test-env-lease.sqlite');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE holders (id TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL, start TEXT, pgid INTEGER)'); db.close();
    let keeper: ReturnType<typeof spawn> | undefined;
    let exited: Promise<unknown> | undefined;
    await withIdleTestApp(root, async (_stopped, busy) => {
      expect(busy).toBe(false);
      keeper = spawn(process.execPath, ['--input-type=module', '-e',
        "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); console.log('locked'); setTimeout(()=>{db.exec('ROLLBACK'); db.close()},600)", path], { stdio: ['ignore', 'pipe', 'pipe'] });
      exited = once(keeper, 'exit');
      await once(keeper.stdout!, 'data');
    });
    await exited;
    const observer = new DatabaseSync(path, { readOnly: true });
    try { expect(observer.prepare('SELECT count(*) AS count FROM holders').get()).toMatchObject({ count: 0 }); }
    finally { observer.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(['retry', 'changed token', 'replaced database'] as const)(
  'keeps a busy own claim protected until %s', async scenario => {
    const root = await mkdtemp(join(tmpdir(), 'cez-pending-claim-'));
    let keeper: ReturnType<typeof spawn> | undefined;
    let exited: Promise<unknown> | undefined;
    try {
      vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }));
      const qa = join(root, '.ai/qa'); await mkdir(qa, { recursive: true });
      await writeFile(join(qa, 'test-env.json'), JSON.stringify({ startedByThisRepo: true, status: 'stopped', app: {} }));
      const path = join(qa, 'test-env-lease.sqlite');
      const setup = new DatabaseSync(path);
      setup.exec('CREATE TABLE holders (id TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL, start TEXT, pgid INTEGER)'); setup.close();
      await withIdleTestApp(root, async (_stopped, busy) => {
        expect(busy).toBe(false);
        // A second call must not reclaim a claim that is still in use.
        await withIdleTestApp(root, async (_nestedStopped, nestedBusy) => { expect(nestedBusy).toBe(true); });
        keeper = spawn(process.execPath, ['--input-type=module', '-e',
          "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); console.log('locked'); process.stdin.once('data',()=>{db.exec('ROLLBACK'); db.close()})", path], { stdio: ['pipe', 'pipe', 'pipe'] });
        exited = once(keeper, 'exit'); await once(keeper.stdout!, 'data');
      });
      keeper!.stdin!.end('release'); await exited;
      const db = new DatabaseSync(path);
      expect(db.prepare('SELECT count(*) AS count FROM holders').get()).toMatchObject({ count: 1 });
      if (scenario === 'changed token') db.exec("UPDATE holders SET token = 'foreign'");
      db.close();
      if (scenario === 'replaced database') {
        await rename(path, `${path}.old`);
        const replacement = new DatabaseSync(path);
        replacement.exec('CREATE TABLE holders (id TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL, start TEXT, pgid INTEGER)'); replacement.close();
      }
      await withIdleTestApp(root, async (_stopped, busy) => { expect(busy).toBe(scenario !== 'retry'); });
      const observer = new DatabaseSync(path, { readOnly: true });
      try { expect(observer.prepare('SELECT count(*) AS count FROM holders').get()).toMatchObject({ count: scenario === 'changed token' ? 1 : 0 }); }
      finally { observer.close(); }
    } finally {
      if (keeper && keeper.exitCode === null && keeper.signalCode === null) { keeper.stdin?.end('release'); await exited; }
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000,
);

it('keeps a claim with no controller proof after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-unowned-claim-'));
  try {
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }));
    const qa = join(root, '.ai/qa'); await mkdir(qa, { recursive: true });
    await writeFile(join(qa, 'test-env.json'), JSON.stringify({ startedByThisRepo: true, status: 'stopped', app: {} }));
    const db = new DatabaseSync(join(qa, 'test-env-lease.sqlite'));
    try {
      db.exec('CREATE TABLE holders (id TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL, start TEXT, pgid INTEGER)');
      db.prepare('INSERT INTO holders VALUES (?, ?, ?, ?, NULL)').run('destroy-foreign', 'foreign', 2147483001, null);
    } finally { db.close(); }
    await withIdleTestApp(root, async (_stopped, busy) => { expect(busy).toBe(true); });
    const observer = new DatabaseSync(join(qa, 'test-env-lease.sqlite'), { readOnly: true });
    try { expect(observer.prepare('SELECT count(*) AS count FROM holders').get()).toMatchObject({ count: 1 }); }
    finally { observer.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
