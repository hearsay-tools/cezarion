import { chmodSync, mkdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
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
