import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScheduleTaskAnswer, ScheduledTasksAnswer } from '@open-mercato/cezar-contract/scheduled-tasks';
import { RunStore } from '../runs/store.ts';
import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';

// hearsay-tools/cezarion#1465: the schedule tools reach a project-level service, not the run. The
// server sets it after the boot manager recovers, so a session provisioned before the setter (a
// recovered run) must still reach it: the handlers read it at call time.
const task = { id: 'a1', name: 'n', status: 'paused' as const, due_at: '2026-10-29T09:00', time_zone: 'UTC', resolved_instant: '2026-10-29T09:00:00.000Z' };
const created: ScheduleTaskAnswer = { ok: true, task, note: 'note' };
const listed: ScheduledTasksAnswer = { ok: true, tasks: [task] };
const signal = new AbortController().signal;
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) { await drainFixtureManagers(root); rmSync(root, { recursive: true, force: true }); }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cez-automation-tools-')); roots.push(root);
  const store = RunStore.open(root);
  const manager = createFixtureManager(store, root);
  manager.setCockpitAddress({ origin: 'http://127.0.0.1:4100', projectId: 'p' });
  return { store, manager };
}

describe('RunManager automation tools', () => {
  it('a handler provisioned before setAutomationTools reaches the service set afterwards', async () => {
    const { store, manager } = fixture();
    const run = store.createRun({ title: 'task', task: 'task', workflow: 'quick-task', steps: [] });
    // No live session entry: the handlers are built for a run nothing has started.
    expect(manager.isActive(run.id)).toBe(false);
    const handlers = manager.cezarToolHandlers(run.id, 'generation');
    const scheduleTask = vi.fn(async () => created);
    const scheduledTasks = vi.fn(async () => listed);
    manager.setAutomationTools({ scheduleTask, scheduledTasks });
    await expect(handlers.scheduleTask!({ name: 'n', prompt: 'p', delay: '1h' }, signal)).resolves.toEqual(created);
    await expect(handlers.scheduledTasks!({ action: 'list' }, signal)).resolves.toEqual(listed);
    expect(scheduleTask).toHaveBeenCalledWith({ name: 'n', prompt: 'p', delay: '1h' });
  });

  // Review of #1465: recovery resumes a session before the server attaches the service. A call in
  // that window waits for it instead of answering unavailable, which the agent must not retry.
  it('a call made before the service is attached waits for it', async () => {
    const { store, manager } = fixture();
    const run = store.createRun({ title: 'task', task: 'task', workflow: 'quick-task', steps: [] });
    const handlers = manager.cezarToolHandlers(run.id, 'generation');
    const answer = handlers.scheduleTask!({ name: 'n', prompt: 'p', delay: '1h' }, signal);
    manager.setAutomationTools({ scheduleTask: async () => created, scheduledTasks: async () => listed });
    await expect(answer).resolves.toEqual(created);
  });

  it('no service within the startup window answers unavailable', async () => {
    const { store, manager } = fixture();
    const run = store.createRun({ title: 'task', task: 'task', workflow: 'quick-task', steps: [] });
    const handlers = manager.cezarToolHandlers(run.id, 'generation');
    vi.useFakeTimers();
    try {
      const first = handlers.scheduleTask!({ name: 'n', prompt: 'p', delay: '1h' }, signal);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(first).resolves.toMatchObject({ ok: false, code: 'unavailable' });
      manager.setAutomationTools({ scheduleTask: async () => created, scheduledTasks: async () => listed });
      manager.setAutomationTools(undefined);
      const second = handlers.scheduledTasks!({ action: 'list' }, signal);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(second).resolves.toMatchObject({ ok: false, code: 'unavailable' });
    } finally { vi.useRealTimers(); }
  });

  it('headless, with no cockpit address, answers unavailable at once', async () => {
    const { store, manager } = fixture();
    manager.setCockpitAddress(undefined);
    const run = store.createRun({ title: 'task', task: 'task', workflow: 'quick-task', steps: [] });
    await expect(manager.cezarToolHandlers(run.id, 'generation').scheduleTask!({ name: 'n', prompt: 'p', delay: '1h' }, signal)).resolves.toMatchObject({ ok: false, code: 'unavailable' });
  });
});
