import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createAutomationService, ONCE_ARCHIVED, onceStatus, type AutomationServiceProject } from './service.ts';
import { AutomationStore } from './store.ts';
import { reconcileAutomationReceipts } from './task-template.ts';
import type { AutomationDefinition } from './types.ts';

const once = {
  id: 'once', revision: 1, name: 'Once', enabled: false, kind: 'schedule',
  schedule: { type: 'once', at: '2026-10-29T09:00', timeZone: 'UTC' },
  task: { prompt: 'Go' }, createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
} as AutomationDefinition;

describe('onceStatus', () => {
  it.each([
    ['paused', once, undefined],
    ['waiting', { ...once, enabled: true }, undefined],
    ['failed', once, { onceOutcome: 'failed' as const }],
    ['missed', once, { onceOutcome: 'missed' as const }],
    ['archived', { ...once, archived: { at: '2026-10-29T09:00:01.000Z', outcome: 'launched' as const } }, { onceOutcome: 'failed' as const }],
  ])('%s', (expected, definition, state) => {
    expect(onceStatus(definition, state)).toBe(expected);
  });

  it('is absent for a repeating schedule', () => {
    expect(onceStatus({ ...once, schedule: { type: 'daily', hour: 4 } }, undefined)).toBeUndefined();
  });
});

// Review of #1465: another cockpit reserved a launch, created the task and crashed before it
// settled the receipt. This cockpit booted earlier, so boot never saw the reservation. Every
// one-time write settles it first: the task exists, so the schedule archives and the write is
// refused. Nothing is cancelled beside a task, and no edit opens a second key.
describe('one-time writes after a crash-left reservation', () => {
  const NOW = Date.parse('2026-10-22T13:00:00Z');
  const AT = '2026-10-29T09:00';
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  async function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'cez-once-service-')); dirs.push(dir);
    const automationStore = AutomationStore.open(join(dir, 'automations'), { now: () => new Date(NOW) });
    const runs = RunStore.open(join(dir, 'runs'));
    const project: AutomationServiceProject = { id: 'p', root: dir, automationStore, store: runs, manager: {} as RunManager };
    const launch = vi.fn(async () => ({ runId: 'second-task' }));
    const service = createAutomationService({
      timeZone: () => 'UTC',
      scheduleHandle: () => ({ projectId: 'p', store: automationStore, timeZone: 'UTC', now: () => NOW, launch, reconcile: async () => { reconcileAutomationReceipts(automationStore, runs); } }),
      emitChange: () => {}, changed: () => {},
      githubAvailability: async () => ({ available: false, reason: 'none' }),
      hasGithubRemote: async () => false,
      now: () => NOW,
    });
    const created = await service.create(project, { name: 'Once', kind: 'schedule', schedule: { type: 'once', at: AT, timeZone: 'UTC' }, task: { prompt: 'Go' }, enable: true });
    if (!created.ok) throw new Error(created.error);
    const id = created.automation.id;
    const eventId = `once:${AT}|UTC`;
    appendFileSync(join(automationStore.dataDir, 'automation-receipts.ndjson'), `${JSON.stringify({ receiptId: 'claimed', receiptKey: `${id}:${eventId}`, eventId, automationId: id, revision: 1, status: 'reserved', occurrenceAt: '2026-10-29T09:00:00.000Z', observedAt: '2026-10-29T09:00:00.000Z', updatedAt: '2026-10-29T09:00:00.000Z' })}\n`);
    const task = runs.createRun({ title: 't', workflow: 'quick-task', task: 'Go', steps: [], automationTrigger: { automationId: id, automationRevision: 1, receiptId: 'claimed', trigger: 'manual', occurrenceAt: '2026-10-29T09:00:00.000Z' } });
    return { service, project, id, task, launch, automationStore };
  }

  it('cancel archives as launched with the existing task and is refused', async () => {
    const { service, project, id, task, automationStore } = await fixture();
    await expect(service.cancel(project, id)).resolves.toMatchObject({ ok: false, status: 409, error: ONCE_ARCHIVED });
    expect(automationStore.get(id)?.archived).toMatchObject({ outcome: 'launched', runId: task.id });
  });

  it('an edit of the due time is refused, and Run now starts no second task', async () => {
    const { service, project, id, launch, automationStore } = await fixture();
    const stored = automationStore.get(id)!;
    const moved = await service.update(project, id, { name: stored.name, enabled: stored.enabled, kind: 'schedule', schedule: { type: 'once', at: '2026-10-30T09:00', timeZone: 'UTC' }, task: { ...stored.task, variants: 1 }, expectedRevision: stored.revision });
    expect(moved).toMatchObject({ ok: false, status: 409, error: ONCE_ARCHIVED });
    await expect(service.runNow(project, id)).resolves.toMatchObject({ ok: false, status: 409 });
    expect(launch).not.toHaveBeenCalled();
  });
});

describe('one-time writes that race or keep the due time (#1465 review)', () => {
  const NOW = Date.parse('2026-10-22T13:00:00Z');
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'cez-once-service-')); dirs.push(dir);
    const automationStore = AutomationStore.open(join(dir, 'automations'), { now: () => new Date(NOW) });
    const runs = RunStore.open(join(dir, 'runs'));
    const project: AutomationServiceProject = { id: 'p', root: dir, automationStore, store: runs, manager: {} as RunManager };
    const service = createAutomationService({
      timeZone: () => 'UTC',
      scheduleHandle: () => ({ projectId: 'p', store: automationStore, timeZone: 'UTC', now: () => NOW, launch: async () => ({ runId: 'task' }) }),
      emitChange: () => {}, changed: () => {},
      githubAvailability: async () => ({ available: false, reason: 'none' }),
      hasGithubRemote: async () => false,
      now: () => NOW,
    });
    return { service, project, automationStore };
  }

  it('an edit of only the latest start on a past-due Missed schedule is saved', async () => {
    const { service, project, automationStore } = fixture();
    const stored = automationStore.create({ name: 'Once', enabled: false, kind: 'schedule', schedule: { type: 'once', at: '2026-10-20T09:00', timeZone: 'UTC' }, task: { prompt: 'Go' } });
    automationStore.setState(stored.id, (state) => ({ ...state, onceOutcome: 'missed' }));
    const saved = await service.update(project, stored.id, { name: stored.name, enabled: false, kind: 'schedule', schedule: { type: 'once', at: '2026-10-20T09:00', timeZone: 'UTC', latestStartMinutes: 30 }, task: { ...stored.task, variants: 1 }, expectedRevision: stored.revision });
    expect(saved).toMatchObject({ ok: true, automation: { schedule: { latestStartMinutes: 30 } } });
  });

  it('cancel refuses a schedule another cockpit changed to recurring before the lease', async () => {
    const { service, project, automationStore } = fixture();
    const stored = automationStore.create({ name: 'Daily', enabled: false, kind: 'schedule', schedule: { type: 'daily', hour: 4 }, task: { prompt: 'Go' } });
    vi.spyOn(automationStore, 'get').mockReturnValueOnce({ ...stored, schedule: { type: 'once', at: '2026-10-29T09:00', timeZone: 'UTC' } } as AutomationDefinition);
    await expect(service.cancel(project, stored.id)).resolves.toMatchObject({ ok: false, status: 409 });
    expect(automationStore.get(stored.id)?.archived).toBeUndefined();
  });
});
