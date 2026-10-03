import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { automationLogRecordSchema as contractLogRecordSchema } from '@open-mercato/cezar-contract';
import { AutomationCoordinator } from './coordinator.ts';
import { AutomationStore } from './store.ts';
import type { GithubAutomationDefinition, ScheduleAutomationDefinition } from './types.ts';
import * as scheduleRunner from './schedule-runner.ts';
import { LeaseHeldError, ProjectAutomationScheduler, WORKSPACE_TIMER_CAP_MS, WorkspaceAutomationScheduler } from './scheduler.ts';

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
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: { poll: async () => ({ candidates: [candidate], truncated: false, pages: 1 }) } as never }, launch });
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
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: { poll: async () => ({ candidates: [candidate], truncated: false, pages: 1 }) } as never }, launch });
    await scheduler.check(definition);
    await scheduler.check(definition);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(store.latestReceipts().get('one:event')).toMatchObject({ status: 'launched', runId: 'run' });
  });

  it('does not advance the cursor on failure and applies bounded backoff', async () => {
    const { store, definition } = await setup();
    store.setState(definition.id, (current) => ({ ...current, cursor: { timestamp: '2026-07-26T01:00:00.000Z' } }));
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: { poll: async () => { throw new Error('rate limited'); } } as never }, launch: async () => ({ runId: 'unused' }) });
    await expect(scheduler.check(definition)).rejects.toThrow('rate limited');
    expect(store.state(definition.id)?.cursor?.timestamp).toBe('2026-07-26T01:00:00.000Z');
    expect(store.state(definition.id)).toMatchObject({ consecutiveFailures: 1, backoffUntil: expect.any(String) });
  });

  it('records a held lease as skipped without writing polling state', async () => {
    const { store, definition } = await setup();
    const held = store.acquireLease();
    const poll = vi.fn(async () => ({ candidates: [], truncated: false, pages: 1 }));
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: { poll } as never }, launch: async () => ({ runId: 'unused' }) });
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
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store: contender, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: { poll: async () => ({ candidates: [], truncated: false, pages: 1 }) } as never }, launch: async () => ({ runId: 'unused' }) });
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
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: { poll: async () => ({ candidates: [], truncated: false, pages: 1 }) } as never }, launch: async () => ({ runId: 'unused' }) });
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
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: { poll: async () => ({ candidates: [], truncated: false, pages: 1 }) } as never }, launch: async () => ({ runId: 'unused' }) });
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
      store,
      timeZone: 'UTC',
      github: { owner: 'acme', repo: 'demo', poller: { poll } as never },
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
      store,
      timeZone: 'UTC',
      github: {
        owner: 'acme',
        repo: 'demo',
        poller: {
          poll: async () => ({
            candidates: [],
            truncated: false,
            pages: 1,
            cursor: { timestamp: '2026-07-26T02:00:00.000Z', tieBreaker: 'scanned' },
          }),
        } as never,
      },
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
      // No idle wake here: this case pins the reschedule path a local enable takes.
      hasProjects: () => false,
    };
    const scheduler = new WorkspaceAutomationScheduler({
      coordinator: coordinator as never,
      handle: () => ({ projectId: 'p', store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: { poll: async () => ({ candidates: [], truncated: false, pages: 1 }) } as never } }),
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
        handle: () => ({ projectId: 'p', store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: { poll: async () => ({ candidates: [], truncated: false, pages: 1 }) } as never } }),
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
        handle: (id, store) => ({ projectId: id, store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: { poll: id === 'a' ? failing : healthy } as never }, launch: async () => ({ runId: 'unused' }) }),
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

  it('a project without github arms only schedule items', async () => {
    vi.useFakeTimers();
    try {
      const now = Date.parse('2026-09-14T03:59:00Z');
      vi.setSystemTime(now);
      const { store, definition: poll } = await setup();
      store.setState(poll.id, (current) => ({ ...current, nextCheckAt: new Date(now - 60_000).toISOString() }));
      const nightly = store.create({ name: 'Nightly', enabled: true, kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 }, task: { prompt: 'Bump deps' } }, 'nightly') as ScheduleAutomationDefinition;
      const launchSchedule = vi.fn(async () => ({ runId: 'scheduled' }));
      const scheduler = new WorkspaceAutomationScheduler({
        coordinator: { refresh: async () => undefined, enabledProjectIds: () => ['p'], store: () => store } as never,
        // No `github`: this project has no GitHub remote. The past-due poll must not fire.
        handle: () => ({ projectId: 'p', store, timeZone: 'UTC', launchSchedule }),
        now: () => Date.now(),
      });
      await scheduler.start();
      expect(store.state(nightly.id)?.nextRunAt).toBe('2026-09-14T04:00:00.000Z');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(launchSchedule).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(31_000);
      expect(launchSchedule).toHaveBeenCalledTimes(1);
      expect(launchSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: 'nightly' }), { at: '2026-09-14T04:00:00.000Z', trigger: 'schedule' }, expect.any(String));
      expect(store.logs({ automationId: poll.id })).toEqual([]);
      scheduler.stop();
    } finally { vi.useRealTimers(); }
  });

  it('mixed kinds arm the earlier due item', async () => {
    vi.useFakeTimers();
    try {
      const now = Date.parse('2026-09-14T03:59:00Z');
      vi.setSystemTime(now);
      const { store, definition: poll } = await setup();
      store.setState(poll.id, (current) => ({ ...current, nextCheckAt: new Date(now + 10 * 60_000).toISOString() }));
      store.create({ name: 'Nightly', enabled: true, kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 }, task: { prompt: 'Bump deps' } }, 'nightly');
      const pollFn = vi.fn(async () => ({ candidates: [], truncated: false, pages: 1 }));
      const launchSchedule = vi.fn(async () => ({ runId: 'scheduled' }));
      const scheduler = new WorkspaceAutomationScheduler({
        coordinator: { refresh: async () => undefined, enabledProjectIds: () => ['p'], store: () => store } as never,
        handle: () => ({ projectId: 'p', store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: { poll: pollFn } as never }, launch: async () => ({ runId: 'unused' }), launchSchedule }),
        now: () => Date.now(),
      });
      await scheduler.start();
      await vi.advanceTimersByTimeAsync(61_000);
      expect(launchSchedule).toHaveBeenCalledTimes(1);
      expect(pollFn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(pollFn).toHaveBeenCalledTimes(1);
      scheduler.stop();
    } finally { vi.useRealTimers(); }
  });

  it('a fire that rejects with ScheduleLeaseHeldError re-arms at the retry floor', async () => {
    vi.useFakeTimers();
    try {
      const now = Date.parse('2026-09-14T04:00:00Z');
      vi.setSystemTime(now);
      const { store } = await setup();
      const poll = store.list()[0]!;
      store.update(poll.id, poll.revision, { ...poll, enabled: false });
      store.create({ name: 'Nightly', enabled: true, kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 }, task: { prompt: 'Bump deps' } }, 'nightly');
      store.setState('nightly', (current) => ({ ...current, nextRunAt: new Date(now).toISOString() }));
      const fire = vi.spyOn(scheduleRunner.ScheduleRunner.prototype, 'fire').mockRejectedValue(new scheduleRunner.ScheduleLeaseHeldError());
      const scheduler = new WorkspaceAutomationScheduler({
        coordinator: { refresh: async () => undefined, enabledProjectIds: () => ['p'], store: () => store } as never,
        handle: () => ({ projectId: 'p', store, timeZone: 'UTC', launchSchedule: async () => ({ runId: 'unused' }) }),
        now: () => Date.now(),
      });
      try {
        await scheduler.start();
        await vi.advanceTimersByTimeAsync(1);
        expect(fire).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(59_000);
        expect(fire).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(fire).toHaveBeenCalledTimes(2);
      } finally {
        scheduler.stop();
        fire.mockRestore();
      }
    } finally { vi.useRealTimers(); }
  });

  it('a weekly schedule fires on time after the machine slept past its occurrence', async () => {
    // A suspend stops the monotonic clock Node timers count on: wall time jumps, timers do not
    // advance. One timer armed for the whole week would wake days late; the capped wake notices.
    vi.useFakeTimers();
    try {
      const now = Date.parse('2026-09-14T04:00:00Z'); // a Monday
      vi.setSystemTime(now);
      const { store } = await setup();
      const poll = store.list()[0]!;
      store.update(poll.id, poll.revision, { ...poll, enabled: false });
      store.create({ name: 'Weekly', enabled: true, kind: 'schedule', schedule: { type: 'weekly', day: 4, hour: 9, minute: 0 }, task: { prompt: 'Report' } }, 'weekly');
      const launchSchedule = vi.fn(async () => ({ runId: 'scheduled' }));
      const scheduler = new WorkspaceAutomationScheduler({
        coordinator: { refresh: async () => undefined, enabledProjectIds: () => ['p'], store: () => store } as never,
        handle: () => ({ projectId: 'p', store, timeZone: 'UTC', launchSchedule }),
        now: () => Date.now(),
      });
      try {
        await scheduler.start();
        expect(store.state('weekly')?.nextRunAt).toBe('2026-09-17T09:00:00.000Z');
        // Asleep until a minute before Thursday 09:00; the timers saw none of it.
        vi.setSystemTime(Date.parse('2026-09-17T08:59:30Z'));
        await vi.advanceTimersByTimeAsync(WORKSPACE_TIMER_CAP_MS);
        expect(launchSchedule).toHaveBeenCalledTimes(1);
        expect(launchSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: 'weekly' }), { at: '2026-09-17T09:00:00.000Z', trigger: 'schedule' }, expect.any(String));
      } finally { scheduler.stop(); }
    } finally { vi.useRealTimers(); }
  });

  it('a capped wake before a poll is due re-arms without firing it', async () => {
    vi.useFakeTimers();
    try {
      const now = Date.parse('2026-09-14T06:00:00Z');
      vi.setSystemTime(now);
      const { store, definition } = await setup();
      // Backed off for two hours: far beyond one capped wake.
      store.setState(definition.id, (current) => ({ ...current, nextCheckAt: new Date(now + 2 * 60 * 60_000).toISOString() }));
      const pollFn = vi.fn(async () => ({ candidates: [], truncated: false, pages: 1 }));
      const scheduler = new WorkspaceAutomationScheduler({
        coordinator: { refresh: async () => undefined, enabledProjectIds: () => ['p'], store: () => store } as never,
        handle: () => ({ projectId: 'p', store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: { poll: pollFn } as never }, launch: async () => ({ runId: 'unused' }) }),
        now: () => Date.now(),
      });
      try {
        await scheduler.start();
        await vi.advanceTimersByTimeAsync(2 * 60 * 60_000 - 1_000);
        expect(pollFn).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(pollFn).toHaveBeenCalledTimes(1);
        // And a wall-clock jump past the due instant is noticed within one cap.
        store.setState(definition.id, (current) => ({ ...current, nextCheckAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString() }));
        await scheduler.reschedule();
        vi.setSystemTime(Date.now() + 3 * 60 * 60_000);
        await vi.advanceTimersByTimeAsync(WORKSPACE_TIMER_CAP_MS);
        expect(pollFn).toHaveBeenCalledTimes(2);
      } finally { scheduler.stop(); }
    } finally { vi.useRealTimers(); }
  });

  describe('a definition changed by another process (finding 4172021393)', () => {
    async function workspace() {
      const root = await mkdtemp(join(tmpdir(), 'cezar-scheduler-ws-')); dirs.push(root);
      const coordinator = new AutomationCoordinator({ listProjects: async () => [{ id: 'p', root, status: 'ok' }] });
      return { root, dataDir: join(root, '.ai/cezar'), coordinator };
    }

    it('arms and fires a schedule another process enabled while this one had nothing armed', async () => {
      vi.useFakeTimers();
      try {
        const now = Date.parse('2026-09-14T03:58:00Z');
        vi.setSystemTime(now);
        const { dataDir, coordinator } = await workspace();
        // The other process (B) owns the definition; it starts paused.
        const other = AutomationStore.open(dataDir);
        const paused = other.create({ name: 'Nightly', enabled: false, kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 }, task: { prompt: 'Bump deps' } }, 'nightly');
        const launchSchedule = vi.fn(async () => ({ runId: 'scheduled' }));
        const scheduler = new WorkspaceAutomationScheduler({
          coordinator,
          handle: (projectId, store) => ({ projectId, store, timeZone: 'UTC', launchSchedule }),
          now: () => Date.now(),
        });
        try {
          await scheduler.start();
          const mine = coordinator.store('p')!;
          expect(mine.get('nightly')?.enabled).toBe(false);
          // B enables it and exits: no event reaches this process, only the file changes.
          other.update(paused.id, paused.revision, { ...paused, enabled: true });
          await vi.advanceTimersByTimeAsync(WORKSPACE_TIMER_CAP_MS);
          expect(mine.get('nightly')?.enabled).toBe(true);
          expect(mine.state('nightly')?.nextRunAt).toBe('2026-09-14T04:00:00.000Z');
          expect(scheduler.hasTimer()).toBe(true);
          expect(launchSchedule).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(Date.parse('2026-09-14T04:00:00Z') - Date.now());
          expect(launchSchedule).toHaveBeenCalledTimes(1);
          expect(launchSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: 'nightly' }), { at: '2026-09-14T04:00:00.000Z', trigger: 'schedule' }, expect.any(String));
        } finally { scheduler.stop(); }
      } finally { vi.useRealTimers(); }
    });

    it('discovers a project whose definitions file another process created after boot', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(Date.parse('2026-09-14T03:58:00Z'));
        const { root, dataDir } = await workspace();
        const second = await mkdtemp(join(tmpdir(), 'cezar-scheduler-ws-')); dirs.push(second);
        // Project `a` already has a (paused) automation, so this workspace keeps its idle wake.
        AutomationStore.open(dataDir).create({ name: 'Paused', enabled: false, kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 }, task: { prompt: 'x' } }, 'paused');
        const coordinator = new AutomationCoordinator({ listProjects: async () => [{ id: 'a', root, status: 'ok' }, { id: 'b', root: second, status: 'ok' }] });
        const launchSchedule = vi.fn(async () => ({ runId: 'scheduled' }));
        const scheduler = new WorkspaceAutomationScheduler({
          coordinator,
          handle: (projectId, store) => ({ projectId, store, timeZone: 'UTC', launchSchedule }),
          now: () => Date.now(),
        });
        try {
          await scheduler.start();
          expect(coordinator.ids()).toEqual(['a']);
          AutomationStore.open(join(second, '.ai/cezar')).create({ name: 'Nightly', enabled: true, kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 }, task: { prompt: 'x' } }, 'nightly');
          await vi.advanceTimersByTimeAsync(WORKSPACE_TIMER_CAP_MS);
          expect(coordinator.ids()).toEqual(['a', 'b']);
          await vi.advanceTimersByTimeAsync(Date.parse('2026-09-14T04:00:00Z') - Date.now());
          expect(launchSchedule).toHaveBeenCalledTimes(1);
        } finally { scheduler.stop(); }
      } finally { vi.useRealTimers(); }
    });

    it('a workspace with no registered project arms no timer', async () => {
      vi.useFakeTimers();
      try {
        const coordinator = new AutomationCoordinator({ listProjects: async () => [] });
        const scheduler = new WorkspaceAutomationScheduler({
          coordinator,
          handle: (projectId, store) => ({ projectId, store, timeZone: 'UTC' }),
        });
        try {
          await scheduler.start();
          expect(scheduler.hasTimer()).toBe(false);
          expect(vi.getTimerCount()).toBe(0);
        } finally { scheduler.stop(); }
      } finally { vi.useRealTimers(); }
    });

    it('a registered project without definitions keeps an idle wake that discovers a schedule another process creates and exits (finding 4172236277)', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(Date.parse('2026-09-14T03:58:00Z'));
        const { root, dataDir, coordinator } = await workspace();
        await mkdir(dataDir, { recursive: true });
        const launchSchedule = vi.fn(async () => ({ runId: 'scheduled' }));
        const scheduler = new WorkspaceAutomationScheduler({
          coordinator,
          handle: (projectId, store) => ({ projectId, store, timeZone: 'UTC', launchSchedule }),
          now: () => Date.now(),
        });
        try {
          await scheduler.start();
          expect(coordinator.ids()).toEqual([]);
          expect(scheduler.hasTimer()).toBe(true);
          // Another cockpit creates and enables the first automation, then is gone.
          AutomationStore.open(join(root, '.ai/cezar')).create({ name: 'Nightly', enabled: true, kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 }, task: { prompt: 'x' } }, 'nightly');
          await vi.advanceTimersByTimeAsync(WORKSPACE_TIMER_CAP_MS);
          expect(coordinator.ids()).toEqual(['p']);
          await vi.advanceTimersByTimeAsync(Date.parse('2026-09-14T04:00:00Z') - Date.now());
          expect(launchSchedule).toHaveBeenCalledTimes(1);
        } finally { scheduler.stop(); }
      } finally { vi.useRealTimers(); }
    });
  });

  it('hands the project\'s receipt reconciliation to the schedule runner (finding 4172021394)', async () => {
    vi.useFakeTimers();
    try {
      const now = Date.parse('2026-09-14T04:00:01Z');
      vi.setSystemTime(now);
      const { store } = await setup();
      const poll = store.list()[0]!;
      store.update(poll.id, poll.revision, { ...poll, enabled: false });
      store.create({ name: 'Nightly', enabled: true, kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 }, task: { prompt: 'Bump deps' } }, 'nightly');
      const at = '2026-09-14T04:00:00.000Z';
      store.setState('nightly', (current) => ({ ...current, nextRunAt: at }));
      await appendFile(join(store.dataDir, 'automation-receipts.ndjson'), `${JSON.stringify({ receiptId: 'lost', receiptKey: `nightly:schedule:${at}`, eventId: `schedule:${at}`, automationId: 'nightly', revision: 1, status: 'reserved', occurrenceAt: at, observedAt: at, updatedAt: at })}\n`);
      const reconcileReceipts = vi.fn(async () => undefined);
      const launchSchedule = vi.fn(async () => ({ runId: 'unused' }));
      const scheduler = new WorkspaceAutomationScheduler({
        coordinator: { refresh: async () => undefined, enabledProjectIds: () => ['p'], store: () => store, hasProjects: () => true } as never,
        handle: () => ({ projectId: 'p', store, timeZone: 'UTC', launchSchedule, reconcileReceipts }),
        now: () => Date.now(),
      });
      try {
        await scheduler.start();
        await vi.advanceTimersByTimeAsync(1);
        expect(reconcileReceipts).toHaveBeenCalledTimes(1);
        expect(launchSchedule).not.toHaveBeenCalled();
      } finally { scheduler.stop(); }
    } finally { vi.useRealTimers(); }
  });

  it('check refuses a project without a GitHub remote', async () => {
    const { store, definition } = await setup();
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC' });
    await expect(scheduler.check(definition)).rejects.toThrow('No GitHub remote is configured');
  });
});
