import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { automationLogRecordSchema as contractLogRecordSchema } from '@open-mercato/cezar-contract';
import { AutomationStore } from './store.ts';
import type { GithubAutomationDefinition } from './types.ts';
import { LeaseHeldError, ProjectAutomationScheduler, WorkspaceAutomationScheduler } from './scheduler.ts';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'cezar-scheduler-')); dirs.push(dir);
  const store = AutomationStore.open(dir);
  const definition = store.create({ name: 'Issues', enabled: true, events: ['issue.opened'], intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'Review' } }, 'one') as GithubAutomationDefinition;
  return { store, definition };
}
const candidate = { eventId: 'event', event: 'issue.opened' as const, timestamp: '2026-07-26T02:00:00.000Z', tieBreaker: 'I', repo: 'acme/demo', nodeId: 'I', number: 7, title: 'Issue', url: 'https://github.com/acme/demo/issues/7', author: 'alice', assignees: [], labels: [] };

describe('ProjectAutomationScheduler', () => {
  it('previews without cursor, receipt, or launch mutation', async () => {
    const { store, definition } = await setup();
    const launch = vi.fn(async () => ({ runId: 'run' }));
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', owner: 'acme', repo: 'demo', store, poller: { poll: async () => ({ candidates: [candidate], truncated: false, pages: 1 }) } as never, launch });
    await scheduler.check(definition, 'preview');
    expect(store.state(definition.id)).toBeUndefined();
    expect(store.receipts()).toEqual([]);
    expect(launch).not.toHaveBeenCalled();
    expect(store.logs({ automationId: definition.id })[0]).toMatchObject({
      result: 'preview',
      reason: 'Bounded preview found 1 match; no tasks were launched.',
    });
  });

  it('reserves before launch and deduplicates the overlap window', async () => {
    const { store, definition } = await setup();
    const launch = vi.fn(async () => ({ runId: 'run' }));
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', owner: 'acme', repo: 'demo', store, poller: { poll: async () => ({ candidates: [candidate], truncated: false, pages: 1 }) } as never, launch });
    await scheduler.check(definition);
    await scheduler.check(definition);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(store.latestReceipts().get('one:event')).toMatchObject({ status: 'launched', runId: 'run' });
  });

  it('does not advance the cursor on failure and applies bounded backoff', async () => {
    const { store, definition } = await setup();
    store.setState(definition.id, (current) => ({ ...current, cursor: { timestamp: '2026-07-26T01:00:00.000Z' } }));
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', owner: 'acme', repo: 'demo', store, poller: { poll: async () => { throw new Error('rate limited'); } } as never, launch: async () => ({ runId: 'unused' }) });
    await expect(scheduler.check(definition)).rejects.toThrow('rate limited');
    expect(store.state(definition.id)?.cursor?.timestamp).toBe('2026-07-26T01:00:00.000Z');
    expect(store.state(definition.id)).toMatchObject({ consecutiveFailures: 1, backoffUntil: expect.any(String) });
  });

  it('records a held lease as skipped without writing polling state', async () => {
    const { store, definition } = await setup();
    const held = store.acquireLease();
    const poll = vi.fn(async () => ({ candidates: [], truncated: false, pages: 1 }));
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', owner: 'acme', repo: 'demo', store, poller: { poll } as never, launch: async () => ({ runId: 'unused' }) });
    try {
      const error = await scheduler.check(definition).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(LeaseHeldError);
      expect((error as Error).message).toContain('lease is held by another process');
      expect(poll).not.toHaveBeenCalled();
      expect(store.logs({ automationId: definition.id })[0]).toMatchObject({ result: 'skipped', reason: 'automation polling lease is held by another process' });
      expect(contractLogRecordSchema.safeParse(store.logs({ automationId: definition.id })[0]).success).toBe(true);
      expect(store.state(definition.id)).toBeUndefined();
    } finally { held?.release(); }
  });

  it('does not overwrite the lease owner\'s persisted state from a stale store', async () => {
    const { store: owner, definition } = await setup();
    const other = owner.create({ name: 'Other', enabled: true, events: ['issue.opened'], intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'Other' } }, 'two');
    const contender = AutomationStore.open(owner.dataDir);
    const held = owner.acquireLease();
    await owner.appendLog({ automationId: definition.id, revision: definition.revision, result: 'no-match' });
    owner.setState(definition.id, (current) => ({ ...current, baselineAt: '2026-09-14T06:00:00.000Z', cursor: { timestamp: '2026-09-14T06:01:00.000Z' }, consecutiveFailures: 3, backoffUntil: '2026-09-14T07:00:00.000Z' }));
    owner.setState(other.id, (current) => ({ ...current, baselineAt: '2026-09-14T06:02:00.000Z' }));
    const path = join(owner.dataDir, 'automation-state.json');
    const before = await readFile(path, 'utf8');
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', owner: 'acme', repo: 'demo', store: contender, poller: { poll: async () => ({ candidates: [], truncated: false, pages: 1 }) } as never, launch: async () => ({ runId: 'unused' }) });
    try {
      await expect(scheduler.check(definition)).rejects.toBeInstanceOf(LeaseHeldError);
      expect(await readFile(path, 'utf8')).toBe(before);
      expect(contender.logs({ automationId: definition.id })[0]?.result).toBe('skipped');
      const newest = contender.logs({ automationId: definition.id, limit: 1 })[0]!;
      expect(newest.seq).toBe(2);
      expect(contender.logs({ automationId: definition.id, cursor: newest.seq, limit: 1 })[0]?.result).toBe('no-match');
    } finally { held?.release(); }
  });

  it('records a preview blocked by a held lease without changing state', async () => {
    const { store, definition } = await setup();
    const held = store.acquireLease();
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', owner: 'acme', repo: 'demo', store, poller: { poll: async () => ({ candidates: [], truncated: false, pages: 1 }) } as never, launch: async () => ({ runId: 'unused' }) });
    try {
      await expect(scheduler.check(definition, 'preview')).rejects.toThrow('lease is held by another process');
      expect(store.logs({ automationId: definition.id })[0]).toMatchObject({ result: 'skipped' });
      expect(store.state(definition.id)).toBeUndefined();
    } finally { held?.release(); }
  });

  it('releases the polling lease when completion logging times out', async () => {
    const { store, definition } = await setup();
    await writeFile(join(store.dataDir, 'automation-log.lock'), JSON.stringify({ pid: process.pid }));
    const realNow = Date.now;
    let advanced = realNow();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => (advanced += 2_000));
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', owner: 'acme', repo: 'demo', store, poller: { poll: async () => ({ candidates: [], truncated: false, pages: 1 }) } as never, launch: async () => ({ runId: 'unused' }) });
    try {
      await expect(scheduler.check(definition)).rejects.toThrow('automation log lock is busy');
      const next = store.acquireLease();
      expect(next).toBeDefined();
      next?.release();
    } finally {
      clock.mockRestore();
    }
  });

  it('starts provider discovery from the durable cursor overlap', async () => {
    const { store, definition } = await setup();
    store.setState(definition.id, (current) => ({
      ...current,
      cursor: { timestamp: '2026-07-26T01:00:00.000Z' },
    }));
    const poll = vi.fn(async () => ({ candidates: [], truncated: false, pages: 1 }));
    const scheduler = new ProjectAutomationScheduler({
      projectId: 'p',
      owner: 'acme',
      repo: 'demo',
      store,
      poller: { poll } as never,
      launch: async () => ({ runId: 'unused' }),
    });
    await scheduler.check(definition);
    expect(poll).toHaveBeenCalledWith('acme', 'demo', definition, {
      since: '2026-07-26T00:58:00.000Z',
    });
  });

  it('advances through scanned non-matches without moving a cursor backwards', async () => {
    const { store, definition } = await setup();
    store.setState(definition.id, (current) => ({
      ...current,
      cursor: { timestamp: '2026-07-26T01:00:00.000Z', tieBreaker: 'current' },
    }));
    const scheduler = new ProjectAutomationScheduler({
      projectId: 'p',
      owner: 'acme',
      repo: 'demo',
      store,
      poller: {
        poll: async () => ({
          candidates: [],
          truncated: false,
          pages: 1,
          cursor: { timestamp: '2026-07-26T02:00:00.000Z', tieBreaker: 'scanned' },
        }),
      } as never,
      launch: async () => ({ runId: 'unused' }),
    });
    await scheduler.check(definition);
    expect(store.state(definition.id)?.cursor).toEqual({
      timestamp: '2026-07-26T02:00:00.000Z',
      tieBreaker: 'scanned',
    });
  });
});

describe('WorkspaceAutomationScheduler', () => {
  it('arms its first timer when a definition is enabled after startup', async () => {
    const { store, definition } = await setup();
    store.update(definition.id, definition.revision, { ...definition, enabled: false });
    const coordinator = {
      refresh: vi.fn(async () => undefined),
      enabledProjectIds: () => store.list().some((item) => item.enabled) ? ['p'] : [],
      store: () => store,
    };
    const scheduler = new WorkspaceAutomationScheduler({
      coordinator: coordinator as never,
      handle: () => ({ projectId: 'p', owner: 'acme', repo: 'demo', store, poller: { poll: async () => ({ candidates: [], truncated: false, pages: 1 }) } as never }),
    });
    await scheduler.start();
    expect(scheduler.hasTimer()).toBe(false);
    const paused = store.get(definition.id)!;
    store.update(paused.id, paused.revision, { ...paused, enabled: true });
    await scheduler.reschedule();
    expect(scheduler.hasTimer()).toBe(true);
    scheduler.stop();
  });

  it('keeps one timer when overlapping reschedules resolve out of order', async () => {
    vi.useFakeTimers();
    try {
      const { store } = await setup();
      const releases: Array<() => void> = [];
      const coordinator = {
        refresh: () => new Promise<void>((resolve) => releases.push(resolve)),
        enabledProjectIds: () => ['p'],
        store: () => store,
      };
      const scheduler = new WorkspaceAutomationScheduler({
        coordinator: coordinator as never,
        handle: () => ({ projectId: 'p', owner: 'acme', repo: 'demo', store, poller: { poll: async () => ({ candidates: [], truncated: false, pages: 1 }) } as never }),
      });
      const started = scheduler.start();
      releases.shift()!();
      await started;
      const first = scheduler.reschedule();
      const second = scheduler.reschedule();
      releases.pop()!();
      await second;
      releases.shift()!();
      await first;
      expect(vi.getTimerCount()).toBe(1);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('defers a rejected project so another due project can run', async () => {
    vi.useFakeTimers();
    try {
      const now = Date.parse('2026-09-14T06:00:00Z');
      vi.setSystemTime(now);
      const a = await setup();
      const b = await setup();
      a.store.setState(a.definition.id, (current) => ({ ...current, nextCheckAt: new Date(now - 60_000).toISOString() }));
      b.store.setState(b.definition.id, (current) => ({ ...current, nextCheckAt: new Date(now + 30_000).toISOString() }));
      a.store.setState = () => { throw new Error('read-only automation state'); };
      const failing = vi.fn(async () => { throw new Error('rate limited'); });
      const healthy = vi.fn(async () => ({ candidates: [], truncated: false, pages: 1 }));
      const stores = { a: a.store, b: b.store };
      const scheduler = new WorkspaceAutomationScheduler({
        coordinator: { refresh: async () => undefined, enabledProjectIds: () => ['a', 'b'], store: (id: 'a' | 'b') => stores[id] } as never,
        handle: (id, store) => ({ projectId: id, owner: 'acme', repo: 'demo', store, poller: { poll: id === 'a' ? failing : healthy } as never, launch: async () => ({ runId: 'unused' }) }),
        now: () => Date.now(),
      });
      await scheduler.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(failing).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(healthy).toHaveBeenCalledTimes(1);
      expect(failing).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(270_000);
      expect(failing).toHaveBeenCalledTimes(2);
      scheduler.stop();
    } finally { vi.useRealTimers(); }
  });
});
