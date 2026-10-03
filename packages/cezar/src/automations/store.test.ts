import { chmodSync, mkdirSync, readdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AutomationStore } from './store.ts';

const dirs: string[] = [];
const input = {
  name: 'Review new PRs',
  enabled: false,
  events: ['pull_request.opened'] as const,
  intervalSeconds: 300,
  filters: { lookbackDays: 7, maxRecords: 25 },
  task: { prompt: 'Review {{github.url}}' },
};

async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cezar-automations-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('AutomationStore', () => {
  it('writes definitions atomically at private permissions and preserves unknown fields', async () => {
    const dir = await directory();
    const store = AutomationStore.open(dir);
    const created = store.create(input, 'review-prs');
    const path = join(dir, 'automations.json');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.future = { kept: true };
    raw.automations[0].futureDefinition = true;
    writeFileSync(path, JSON.stringify(raw));

    const reopened = AutomationStore.open(dir);
    reopened.update('review-prs', created.revision, { ...input, name: 'Updated' });
    const persisted = JSON.parse(readFileSync(path, 'utf8'));
    expect(persisted.future).toEqual({ kept: true });
    expect(persisted.automations[0].futureDefinition).toBe(true);
    await expect((await import('node:fs/promises')).stat(path).then((stat) => stat.mode & 0o777)).resolves.toBe(
      0o600,
    );
  });

  it('salvages valid entries and malformed NDJSON rows with one warning per file', async () => {
    const dir = await directory();
    const valid = AutomationStore.open(dir).create(input, 'valid');
    writeFileSync(
      join(dir, 'automations.json'),
      JSON.stringify({ version: 1, automations: [valid, { id: 'broken' }] }),
    );
    writeFileSync(join(dir, 'automation-receipts.ndjson'), '{bad json}\n{}\n');
    const warnings: string[] = [];
    const store = AutomationStore.open(dir, { warn: (warning) => warnings.push(warning) });
    expect(store.list().map((item) => item.id)).toEqual(['valid']);
    expect(store.receipts()).toEqual([]);
    expect(warnings).toHaveLength(2);
  });

  it('enforces optimistic revisions and tombstones deleted ids', async () => {
    const store = AutomationStore.open(await directory());
    store.create(input, 'one');
    expect(() => store.update('one', 9, input)).toThrow('revision conflict');
    expect(store.delete('one')).toBe(true);
    expect(() => store.create(input, 'one')).toThrow('unavailable');
  });

  describe('definitions writes from a stale store (another cockpit on the same directory)', () => {
    const onDisk = (dir: string) =>
      JSON.parse(readFileSync(join(dir, 'automations.json'), 'utf8')) as { automations: { id: string; name: string; revision: number }[]; tombstones?: Record<string, string> };

    it('an update of another id never resurrects a definition deleted elsewhere', async () => {
      const dir = await directory();
      const a = AutomationStore.open(dir);
      a.create(input, 'x');
      const y = a.create(input, 'y');
      const b = AutomationStore.open(dir);
      expect(b.delete('x')).toBe(true);
      a.update('y', y.revision, { ...input, name: 'Y edited' });
      const file = onDisk(dir);
      expect(file.automations.map((row) => row.id)).toEqual(['y']);
      expect(file.tombstones?.x).toBeDefined();
      expect(a.get('x')).toBeUndefined();
    });

    it('a stale update of an id edited elsewhere is a revision conflict and leaves the edit intact', async () => {
      const dir = await directory();
      const a = AutomationStore.open(dir);
      const x = a.create(input, 'x');
      const b = AutomationStore.open(dir);
      b.update('x', x.revision, { ...input, name: 'B edit' });
      expect(() => a.update('x', x.revision, { ...input, name: 'A edit' })).toThrow('automation revision conflict');
      expect(onDisk(dir).automations).toEqual([expect.objectContaining({ id: 'x', name: 'B edit', revision: 2 })]);
    });

    it('a stale update of an id deleted elsewhere is not found and writes nothing back', async () => {
      const dir = await directory();
      const a = AutomationStore.open(dir);
      const x = a.create(input, 'x');
      AutomationStore.open(dir).delete('x');
      expect(() => a.update('x', x.revision, { ...input, name: 'A edit' })).toThrow('automation not found');
      expect(onDisk(dir).automations).toEqual([]);
    });

    it('creates from two stores both land on disk, and a tombstone written elsewhere blocks the id', async () => {
      const dir = await directory();
      const a = AutomationStore.open(dir);
      const b = AutomationStore.open(dir);
      b.create(input, 'z');
      a.create(input, 'w');
      expect(onDisk(dir).automations.map((row) => row.id).sort()).toEqual(['w', 'z']);
      expect(() => a.create(input, 'z')).toThrow('automation id unavailable');
      b.delete('w');
      expect(() => a.create(input, 'w')).toThrow('automation id unavailable');
    });

    it('a stale delete keeps definitions created elsewhere', async () => {
      const dir = await directory();
      const a = AutomationStore.open(dir);
      a.create(input, 'x');
      AutomationStore.open(dir).create(input, 'z');
      expect(a.delete('x')).toBe(true);
      expect(onDisk(dir).automations.map((row) => row.id)).toEqual(['z']);
    });
  });

  it('reloadIfChanged re-reads only after another store wrote either file', async () => {
    const dir = await directory();
    const mine = AutomationStore.open(dir);
    const other = AutomationStore.open(dir);
    const created = other.create(input, 'one');
    expect(mine.hasDefinitionsFile()).toBe(true);
    expect(mine.get('one')).toBeUndefined();
    expect(mine.reloadIfChanged()).toBe(true);
    expect(mine.get('one')?.enabled).toBe(false);
    expect(mine.reloadIfChanged()).toBe(false);
    other.update(created.id, created.revision, { ...input, enabled: true });
    expect(mine.reloadIfChanged()).toBe(true);
    expect(mine.get('one')?.enabled).toBe(true);
    other.setState('one', (current) => ({ ...current, nextCheckAt: '2026-09-14T04:00:00.000Z' }));
    expect(mine.reloadIfChanged()).toBe(true);
    expect(mine.state('one')?.nextCheckAt).toBe('2026-09-14T04:00:00.000Z');
    expect(mine.reloadIfChanged()).toBe(false);
  });

  it('hasDefinitionsFile is false for a project without automations', async () => {
    expect(AutomationStore.open(await directory()).hasDefinitionsFile()).toBe(false);
  });

  it('reserves one receipt per automation event and appends finalized rows', async () => {
    const store = AutomationStore.open(await directory());
    const receipt = store.reserveReceipt({ automationId: 'one', revision: 1, eventId: 'event' });
    expect(receipt?.receiptKey).toBe('one:event');
    expect(store.reserveReceipt({ automationId: 'one', revision: 1, eventId: 'event' })).toBeUndefined();
    store.appendReceipt({
      ...receipt!,
      status: 'launched',
      runId: 'run-1',
      updatedAt: '2026-07-26T01:00:00.000Z',
    });
    expect(store.latestReceipts().get('one:event')?.runId).toBe('run-1');
  });

  it('keeps numeric log pages complete when stale stores both append', async () => {
    const dir = await directory();
    const owner = AutomationStore.open(dir);
    const contender = AutomationStore.open(dir);
    await owner.appendLog({ automationId: 'one', revision: 1, result: 'no-match' });
    await contender.appendLog({ automationId: 'one', revision: 1, result: 'skipped' });
    await owner.appendLog({ automationId: 'one', revision: 1, result: 'preview' });

    const reader = AutomationStore.open(dir);
    const first = reader.logs({ limit: 2 });
    const second = reader.logs({ cursor: first.at(-1)!.seq, limit: 2 });
    expect([...first, ...second].map((row) => [row.seq, row.result])).toEqual([
      [3, 'preview'], [2, 'skipped'], [1, 'no-match'],
    ]);
  });

  it('allocates the next log seq after another process appends', async () => {
    const dir = await directory();
    const stale = AutomationStore.open(dir);
    const modulePath = fileURLToPath(new URL('./store.ts', import.meta.url));
    execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      `import { AutomationStore } from ${JSON.stringify(modulePath)}; await AutomationStore.open(${JSON.stringify(dir)}).appendLog({ automationId: 'one', revision: 1, result: 'no-match' });`,
    ]);
    await stale.appendLog({ automationId: 'one', revision: 1, result: 'skipped' });

    const reader = AutomationStore.open(dir);
    const first = reader.logs({ limit: 1 });
    const second = reader.logs({ cursor: first[0]!.seq, limit: 1 });
    expect([...first, ...second].map((row) => [row.seq, row.result])).toEqual([
      [2, 'skipped'], [1, 'no-match'],
    ]);
  });

  it('serializes concurrent log appends from separate processes', async () => {
    const dir = await directory();
    const barrier = join(dir, 'start');
    const modulePath = fileURLToPath(new URL('./store.ts', import.meta.url));
    const script = `
      import { access } from 'node:fs/promises';
      import { AutomationStore } from ${JSON.stringify(modulePath)};
      const store = AutomationStore.open(${JSON.stringify(dir)});
      process.stdout.write('ready\\n');
      while (true) { try { await access(${JSON.stringify(barrier)}); break; } catch { await new Promise(resolve => setTimeout(resolve, 5)); } }
      for (let i = 0; i < 10; i++) await store.appendLog({ automationId: process.argv[1], revision: 1, result: 'no-match' });
    `;
    const children = ['one', 'two'].map((id) => spawn(process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script, id], { stdio: ['ignore', 'pipe', 'pipe'] }));
    try {
      await Promise.all(children.map((child) => new Promise<void>((resolve, reject) => {
        child.stdout.once('data', () => resolve());
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`child exited before barrier: ${code}`)));
      })));
      writeFileSync(barrier, 'go');
      const codes = await Promise.all(children.map((child) => new Promise<number | null>((resolve) => child.once('exit', resolve))));
      expect(codes).toEqual([0, 0]);
      expect(AutomationStore.open(dir).logs({ limit: 100 }).map((row) => row.seq)).toEqual(
        Array.from({ length: 20 }, (_, index) => 20 - index),
      );
    } finally {
      for (const child of children) child.kill();
    }
  });

  it('recovers a log lock left by a terminated writer', async () => {
    const dir = await directory();
    writeFileSync(join(dir, 'automation-log.lock'), JSON.stringify({ pid: 424242 }));
    const store = AutomationStore.open(dir, { processAlive: () => false });
    expect((await store.appendLog({ automationId: 'one', revision: 1, result: 'skipped' })).seq).toBe(1);
    expect(store.logs().map((row) => row.result)).toEqual(['skipped']);
  });

  it('keeps every row when compaction overlaps an append from another store', async () => {
    const dir = await directory();
    const owner = AutomationStore.open(dir);
    const other = AutomationStore.open(dir);
    await owner.appendLog({ automationId: 'one', revision: 1, result: 'no-match' });
    await Promise.all([
      owner.compact(),
      other.appendLog({ automationId: 'one', revision: 1, result: 'skipped' }),
    ]);
    expect(AutomationStore.open(dir).logs().map((row) => [row.seq, row.result])).toEqual([
      [2, 'skipped'], [1, 'no-match'],
    ]);
  });

  it('lets event-loop timers run while another process holds the log lock', async () => {
    const dir = await directory();
    writeFileSync(join(dir, 'automation-log.lock'), JSON.stringify({ pid: process.pid }));
    const releaser = spawn(process.execPath, ['-e', `
      const fs = require('node:fs');
      process.stdout.write('ready\\n');
      setTimeout(() => fs.unlinkSync(${JSON.stringify(join(dir, 'automation-log.lock'))}), 600);
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise<void>((resolve) => releaser.stdout.once('data', () => resolve()));
      const started = Date.now();
      const timer = new Promise<number>((resolve) => setTimeout(() => resolve(Date.now() - started), 20));
      await AutomationStore.open(dir).appendLog({ automationId: 'one', revision: 1, result: 'skipped' });
      expect(await timer).toBeLessThan(300);
    } finally {
      releaser.kill();
    }
  });

  it('holds an exclusive recoverable project polling lease', async () => {
    const dir = await directory();
    const store = AutomationStore.open(dir);
    const first = store.acquireLease();
    expect(first).toBeDefined();
    expect(store.acquireLease()).toBeUndefined();
    first?.release();
    expect(store.acquireLease()).toBeDefined();
    chmodSync(dir, 0o700);
  });
});

describe('AutomationStore.acquireLease', () => {
  it('reclaims a fresh lock when its writer is gone', async () => {
    const dir = await directory();
    writeFileSync(join(dir, 'automation-poll.lock'), JSON.stringify({ pid: 424242, startedAt: new Date().toISOString() }));
    const probed: number[] = [];
    const store = AutomationStore.open(dir, { processAlive: (pid) => { probed.push(pid); return false; } });
    const lease = store.acquireLease();
    expect(lease).toBeDefined();
    expect(probed).toEqual([424242]);
    lease?.release();
  });

  it('respects a fresh lock held by a live process', async () => {
    const dir = await directory();
    writeFileSync(join(dir, 'automation-poll.lock'), JSON.stringify({ pid: 424242, startedAt: new Date().toISOString() }));
    const store = AutomationStore.open(dir, { processAlive: () => true });
    expect(store.acquireLease()).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dir, 'automation-poll.lock'), 'utf8')).pid).toBe(424242);
  });

  it('retains the age fallback when lock metadata is unreadable', async () => {
    const dir = await directory();
    writeFileSync(join(dir, 'automation-poll.lock'), '{half-written');
    const store = AutomationStore.open(dir, { processAlive: () => false });
    expect(store.acquireLease()).toBeUndefined();
    const lease = store.acquireLease(-1);
    expect(lease).toBeDefined();
    lease?.release();
  });

  it('uses the real liveness probe for live and absent processes', async () => {
    const dir = await directory();
    const path = join(dir, 'automation-poll.lock');
    writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const store = AutomationStore.open(dir);
    expect(store.acquireLease()).toBeUndefined();
    writeFileSync(path, JSON.stringify({ pid: 2147483647, startedAt: new Date().toISOString() }));
    const lease = store.acquireLease();
    expect(lease).toBeDefined();
    lease?.release();
  });

  it('does not remove a new live lock after another contender reclaims the dead one', async () => {
    const dir = await directory();
    const path = join(dir, 'automation-poll.lock');
    writeFileSync(path, JSON.stringify({ pid: 424242, startedAt: new Date().toISOString() }));
    let winner: ReturnType<AutomationStore['acquireLease']>;
    const first = AutomationStore.open(dir, {
      processAlive: () => {
        winner = AutomationStore.open(dir, { processAlive: () => false }).acquireLease();
        return false;
      },
    });
    const losing = first.acquireLease();
    try {
      expect(Number(Boolean(winner)) + Number(Boolean(losing))).toBe(1);
      expect(AutomationStore.open(dir).acquireLease()).toBeUndefined();
    } finally {
      losing?.release();
      winner?.release();
    }
    const next = AutomationStore.open(dir).acquireLease();
    expect(next).toBeDefined();
    next?.release();
  });

  it('revalidates the observed lock identity after a liveness probe', async () => {
    const dir = await directory();
    const path = join(dir, 'automation-poll.lock');
    writeFileSync(path, JSON.stringify({ pid: 424242, startedAt: new Date().toISOString() }));
    const store = AutomationStore.open(dir, {
      processAlive: () => {
        unlinkSync(path);
        writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
        return false;
      },
    });
    expect(store.acquireLease()).toBeUndefined();
    expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(process.pid);
  });

  it('does not remove another owner\'s replacement lock on release', async () => {
    const dir = await directory();
    const path = join(dir, 'automation-poll.lock');
    const store = AutomationStore.open(dir);
    const first = store.acquireLease();
    expect(first).toBeDefined();
    unlinkSync(path);
    writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    first?.release();
    expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(process.pid);
  });

  it('does not reclaim while another process holds the reclaim guard', async () => {
    const dir = await directory();
    writeFileSync(join(dir, 'automation-poll.lock'), JSON.stringify({ pid: 424242, startedAt: new Date().toISOString() }));
    const guard = join(dir, 'automation-poll.reclaim');
    mkdirSync(guard);
    writeFileSync(join(guard, 'owner.json'), JSON.stringify({ pid: process.pid }));
    expect(AutomationStore.open(dir, { processAlive: () => false }).acquireLease()).toBeUndefined();
  });

  it('recovers a reclaim guard left by a dead process', async () => {
    const dir = await directory();
    writeFileSync(join(dir, 'automation-poll.lock'), JSON.stringify({ pid: 424242, startedAt: new Date().toISOString() }));
    const guard = join(dir, 'automation-poll.reclaim');
    mkdirSync(guard);
    writeFileSync(join(guard, 'owner.json'), JSON.stringify({ pid: 2147483647 }));
    const lease = AutomationStore.open(dir, { processAlive: () => false }).acquireLease();
    expect(lease).toBeDefined();
    lease?.release();
  });

  it('recovers when a dead reclaimer removed the old lock before crashing', async () => {
    const dir = await directory();
    const guard = join(dir, 'automation-poll.reclaim');
    mkdirSync(guard);
    writeFileSync(join(guard, 'owner.json'), JSON.stringify({ pid: 2147483647 }));
    const lease = AutomationStore.open(dir, { processAlive: () => false }).acquireLease();
    expect(lease).toBeDefined();
    lease?.release();
  });

  it('eventually clears a crashed reaper marker instead of leaving a permanent guard', async () => {
    const dir = await directory();
    const guard = join(dir, 'automation-poll.reclaim');
    mkdirSync(guard);
    writeFileSync(join(guard, 'owner.json'), JSON.stringify({ pid: 2147483647 }));
    const marker = join(guard, '.reaping');
    writeFileSync(marker, JSON.stringify({ pid: 2147483647 }));
    utimesSync(marker, new Date(0), new Date(0));
    const store = AutomationStore.open(dir, { processAlive: () => false });
    expect(store.acquireLease(1_000)).toBeUndefined();
    const lease = store.acquireLease(1_000);
    expect(lease).toBeDefined();
    lease?.release();
  });

  it('uses the age fallback when a crashed guard pid has been reused', async () => {
    const dir = await directory();
    const guard = join(dir, 'automation-poll.reclaim');
    mkdirSync(guard);
    writeFileSync(join(guard, 'owner.json'), JSON.stringify({ pid: process.pid }));
    utimesSync(guard, new Date(0), new Date(0));
    const lease = AutomationStore.open(dir).acquireLease(1_000);
    expect(lease).toBeDefined();
    lease?.release();
  });
});

describe('AutomationStore.setState (read-modify-write)', () => {
  it('lets two stores on one directory interleave writes without clobbering each other', async () => {
    const dir = await directory();
    const one = AutomationStore.open(dir);
    const two = AutomationStore.open(dir);
    one.setState('a', (current) => ({ ...current, nextRunAt: '2026-10-03T02:00:00.000Z' }));
    two.setState('b', (current) => ({ ...current, cursor: { timestamp: '2026-10-02T00:00:00.000Z' } }));
    one.setState('a', (current) => ({ ...current, nextRunAt: '2026-10-04T02:00:00.000Z' }));
    const fresh = AutomationStore.open(dir);
    expect(fresh.state('a')).toEqual({ nextRunAt: '2026-10-04T02:00:00.000Z' });
    expect(fresh.state('b')).toEqual({ cursor: { timestamp: '2026-10-02T00:00:00.000Z' } });
    // Each in-memory copy also sees the other's id after its own next write.
    expect(one.state('b')).toEqual({ cursor: { timestamp: '2026-10-02T00:00:00.000Z' } });
  });

  it('two stores racing on the SAME id: the loser updates from a fresh disk read, not its stale snapshot', async () => {
    const dir = await directory();
    const one = AutomationStore.open(dir);
    const two = AutomationStore.open(dir);
    // `two` only knows 'a' as absent.
    expect(two.state('a')).toBeUndefined();
    one.setState('a', (current) => ({ ...current, lastRunAt: '2026-10-02T02:00:00.000Z' }));
    two.setState('a', (current) => ({ ...current, nextRunAt: '2026-10-03T02:00:00.000Z' }));
    expect(AutomationStore.open(dir).state('a')).toEqual({ lastRunAt: '2026-10-02T02:00:00.000Z', nextRunAt: '2026-10-03T02:00:00.000Z' });
  });

  it('keeps this process\'s last good view of other ids when the state file is unreadable', async () => {
    const dir = await directory();
    const one = AutomationStore.open(dir);
    const two = AutomationStore.open(dir);
    two.setState('b', (current) => ({ ...current, baselineAt: '2026-10-02T00:00:00.000Z' }));
    one.setState('a', (current) => ({ ...current, lastRunAt: '2026-10-02T01:00:00.000Z' }));
    writeFileSync(join(dir, 'automation-state.json'), '{not json');
    one.setState('a', (current) => ({ ...current, consecutiveFailures: 1 }));
    const fresh = AutomationStore.open(dir);
    expect(fresh.state('b')).toEqual({ baselineAt: '2026-10-02T00:00:00.000Z' });
    expect(fresh.state('a')).toEqual({ lastRunAt: '2026-10-02T01:00:00.000Z', consecutiveFailures: 1 });
  });

  it('returns the next record', async () => {
    const store = AutomationStore.open(await directory());
    expect(store.setState('a', (current) => ({ ...current, consecutiveFailures: 1 }))).toEqual({ consecutiveFailures: 1 });
  });

  it('persists the occurrence a receipt reserved', async () => {
    const store = AutomationStore.open(await directory());
    const receipt = store.reserveReceipt({
      automationId: 'a',
      revision: 1,
      eventId: 'schedule:2026-10-03T02:00:00.000Z',
      occurrenceAt: '2026-10-03T02:00:00.000Z',
    });
    expect(receipt?.receiptKey).toBe('a:schedule:2026-10-03T02:00:00.000Z');
    expect(store.receipts()[0]?.occurrenceAt).toBe('2026-10-03T02:00:00.000Z');
  });
});

describe('AutomationStore arm (state before definition)', () => {
  const schedule = { ...input, kind: 'schedule' as const, schedule: { type: 'daily' as const, hour: 4, minute: 0 }, events: undefined, intervalSeconds: undefined, filters: undefined, task: { prompt: 'Nightly' } };

  it('writes the armed state before the definition, from the on-disk previous definition', async () => {
    const dir = await directory();
    const store = AutomationStore.open(dir);
    const created = store.create(schedule as never, 'nightly');
    store.setState('nightly', (current) => ({ ...current, revision: 1, nextRunAt: '2026-01-01T04:00:00.000Z' }));
    const order: string[] = [];
    const write = (store as any).atomicJson.bind(store) as (filename: string, value: unknown) => void;
    (store as any).atomicJson = (filename: string, value: unknown) => { order.push(filename); write(filename, value); };
    const seen: unknown[] = [];
    const updated = store.update('nightly', created.revision, { ...schedule, enabled: true } as never, (definition, previous) => {
      seen.push(previous?.enabled, definition.enabled);
      return { nextRunAt: '2026-10-04T04:00:00.000Z' };
    });
    expect(order).toEqual(['automation-state.json', 'automations.json']);
    expect(seen).toEqual([false, true]);
    expect(AutomationStore.open(dir).state('nightly')).toMatchObject({ revision: updated.revision, nextRunAt: '2026-10-04T04:00:00.000Z' });
  });

  it('a revision conflict or a missing id arms nothing', async () => {
    const dir = await directory();
    const store = AutomationStore.open(dir);
    store.create(schedule as never, 'nightly');
    store.setState('nightly', (current) => ({ ...current, revision: 1, nextRunAt: '2026-01-01T04:00:00.000Z' }));
    const arm = () => ({ nextRunAt: '2026-10-04T04:00:00.000Z' });
    expect(() => store.update('nightly', 7, schedule as never, arm)).toThrow('revision conflict');
    expect(() => store.update('gone', 1, schedule as never, arm)).toThrow('not found');
    const fresh = AutomationStore.open(dir);
    expect(fresh.state('nightly')).toEqual({ revision: 1, nextRunAt: '2026-01-01T04:00:00.000Z' });
    expect(fresh.state('gone')).toBeUndefined();
  });

  it('restores the armed keys when the definition write fails', async () => {
    const dir = await directory();
    const store = AutomationStore.open(dir);
    const created = store.create(schedule as never, 'nightly');
    store.setState('nightly', (current) => ({ ...current, revision: 1, nextRunAt: '2026-01-01T04:00:00.000Z', consecutiveFailures: 2 }));
    const write = (store as any).atomicJson.bind(store) as (filename: string, value: unknown) => void;
    (store as any).atomicJson = (filename: string, value: unknown) => {
      if (filename === 'automations.json') throw new Error('disk full');
      write(filename, value);
    };
    expect(() => store.update('nightly', created.revision, { ...schedule, enabled: true } as never, () => ({ nextRunAt: '2026-10-04T04:00:00.000Z' }))).toThrow('disk full');
    const fresh = AutomationStore.open(dir);
    expect(fresh.state('nightly')).toEqual({ revision: 1, nextRunAt: '2026-01-01T04:00:00.000Z', consecutiveFailures: 2 });
    expect(fresh.get('nightly')).toMatchObject({ revision: 1, enabled: false });
    expect(store.get('nightly')).toMatchObject({ revision: 1, enabled: false });
  });
});

/**
 * Runs `body` in two real OS processes released by one barrier file. `body` sees `store` (an
 * AutomationStore on `dir`) and `who` ('one' | 'two'), and runs synchronously, as the callers do.
 */
async function hammerFromTwoProcesses(dir: string, body: string): Promise<void> {
  const barrier = join(dir, 'start');
  const modulePath = fileURLToPath(new URL('./store.ts', import.meta.url));
  const script = `
    import { access } from 'node:fs/promises';
    import { AutomationStore } from ${JSON.stringify(modulePath)};
    const store = AutomationStore.open(${JSON.stringify(dir)});
    const who = process.argv[1];
    process.stdout.write('ready\\n');
    while (true) { try { await access(${JSON.stringify(barrier)}); break; } catch { await new Promise(resolve => setTimeout(resolve, 2)); } }
    ${body}
  `;
  const children = ['one', 'two'].map((who) => spawn(process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script, who], { stdio: ['ignore', 'pipe', 'pipe'] }));
  const stderr = children.map((child) => {
    let text = '';
    child.stderr.on('data', (chunk) => { text += String(chunk); });
    return () => text;
  });
  try {
    await Promise.all(children.map((child) => new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve());
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`child exited before barrier: ${code}`)));
    })));
    writeFileSync(barrier, 'go');
    const codes = await Promise.all(children.map((child) => new Promise<number | null>((resolve) => {
      if (child.exitCode !== null) resolve(child.exitCode);
      else child.once('exit', resolve);
    })));
    expect(codes, stderr.map((read) => read()).join('\n')).toEqual([0, 0]);
  } finally {
    for (const child of children) child.kill();
  }
}

describe('AutomationStore cross-process write lock', () => {
  const N = 40;

  it('keeps every id when two processes setState different ids concurrently', async () => {
    const dir = await directory();
    await hammerFromTwoProcesses(dir, `
      for (let i = 0; i < ${N}; i++) store.setState(who + '-' + i, (current) => ({ ...current, consecutiveFailures: i }));
    `);
    const states = JSON.parse(readFileSync(join(dir, 'automation-state.json'), 'utf8')).states;
    const expected = ['one', 'two'].flatMap((who) => Array.from({ length: N }, (_, i) => `${who}-${i}`));
    expect(Object.keys(states).sort()).toEqual(expected.sort());
    expect(readdirSync(dir).filter((name) => name.endsWith('.lock'))).toEqual([]);
  }, 60_000);

  it('keeps every definition when two processes create concurrently', async () => {
    const dir = await directory();
    await hammerFromTwoProcesses(dir, `
      for (let i = 0; i < ${N}; i++) store.create(${JSON.stringify(input)}, who + '-' + i);
    `);
    const ids = JSON.parse(readFileSync(join(dir, 'automations.json'), 'utf8')).automations.map((row: { id: string }) => row.id);
    const expected = ['one', 'two'].flatMap((who) => Array.from({ length: N }, (_, i) => `${who}-${i}`));
    expect(ids.sort()).toEqual(expected.sort());
  }, 60_000);

  it('keeps every edit when two processes update and delete their own definitions concurrently', async () => {
    const dir = await directory();
    const seed = AutomationStore.open(dir);
    for (const who of ['one', 'two']) for (let i = 0; i < 10; i++) seed.create(input, `${who}-${i}`);
    await hammerFromTwoProcesses(dir, `
      for (let i = 0; i < 10; i++) {
        const id = who + '-' + i;
        if (i % 2) store.delete(id);
        else store.update(id, 1, { ...${JSON.stringify(input)}, name: 'edited ' + id });
      }
    `);
    const file = JSON.parse(readFileSync(join(dir, 'automations.json'), 'utf8'));
    const expected = ['one', 'two'].flatMap((who) => [0, 2, 4, 6, 8].map((i) => `${who}-${i}`));
    expect(file.automations.map((row: { id: string; name: string }) => [row.id, row.name]).sort())
      .toEqual(expected.sort().map((id) => [id, `edited ${id}`]));
    expect(Object.keys(file.tombstones).length).toBe(10);
  }, 60_000);

  it('recovers a write lock left by a dead process', async () => {
    const dir = await directory();
    writeFileSync(join(dir, 'automation-state.lock'), JSON.stringify({ pid: 424242 }));
    writeFileSync(join(dir, 'automations.lock'), JSON.stringify({ pid: 424242 }));
    const store = AutomationStore.open(dir, { processAlive: () => false });
    expect(store.setState('a', () => ({ consecutiveFailures: 1 }))).toEqual({ consecutiveFailures: 1 });
    expect(store.create(input, 'one').id).toBe('one');
  });

  it('recovers an aged-out write lock even when its pid looks alive', async () => {
    const dir = await directory();
    const lock = join(dir, 'automation-state.lock');
    writeFileSync(lock, JSON.stringify({ pid: 424242 }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const store = AutomationStore.open(dir, { processAlive: () => true });
    expect(store.setState('a', () => ({ consecutiveFailures: 1 }))).toEqual({ consecutiveFailures: 1 });
  });

  it('throws rather than writing unserialized when a live holder keeps the lock past the bounded wait', async () => {
    const dir = await directory();
    const store = AutomationStore.open(dir, { processAlive: () => true, writeLockTimeoutMs: 50 });
    store.setState('a', () => ({ consecutiveFailures: 1 }));
    writeFileSync(join(dir, 'automation-state.lock'), JSON.stringify({ pid: 424242 }));
    expect(() => store.setState('b', () => ({ consecutiveFailures: 2 }))).toThrow(/busy/);
    expect(Object.keys(JSON.parse(readFileSync(join(dir, 'automation-state.json'), 'utf8')).states)).toEqual(['a']);
  });
});
