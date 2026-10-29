import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { withIdleTestApp } from './idle-test-app.ts';

const probes = vi.hoisted(() => ({ owned: vi.fn(), stop: vi.fn() }));
vi.mock('./windows-test-app.ts', () => ({ windowsStartToken: () => '123', windowsTestAppHolds: probes.owned }));
vi.mock('../detached-process.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../detached-process.ts')>(), processStartToken: () => '123', leaseIdentity: () => ({ start: '123' }), stopGroup: probes.stop,
}));
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

it('retains a Windows environment when its app descriptor is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-missing-app-'));
  try {
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }));
    const qa = join(root, '.ai/qa'); await mkdir(qa, { recursive: true });
    const db = new DatabaseSync(join(qa, 'test-env-lease.sqlite'));
    try { db.exec('CREATE TABLE holders (id TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL, start TEXT, pgid INTEGER)'); }
    finally { db.close(); }
    await withIdleTestApp(root, async (stopped, busy) => {
      expect(stopped).toBe(false); expect(busy).toBe(true);
    });
    expect(probes.stop).not.toHaveBeenCalled();
  } finally { await rm(root, { recursive: true, force: true }); }
});

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
