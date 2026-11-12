import { testHome } from '../home/test-home.testkit.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SCHEDULED_TASK_NOTE , scheduledTaskSchema } from '@open-mercato/cezar-contract/scheduled-tasks';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createAutomationService, ONCE_PAST_DUE, type AutomationServiceProject } from './service.ts';
import { AutomationStore } from './store.ts';
import { createAutomationToolService } from './tool-adapter.ts';

// hearsay-tools/cezarion#1465: the agent's view of one-time schedules, over the same service the
// HTTP routes call. 2026-10-22T13:00Z is 15:00 in Warsaw; DST ends there on 25 October. The agent
// gives and reads UTC; the store keeps a wall time in the cockpit's zone for the cockpit.
const NOW = Date.parse('2026-10-22T13:00:00Z');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(address?: { origin: string; projectId: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'cez-tool-adapter-')); dirs.push(dir);
  const project: AutomationServiceProject = {
    id: 'cezar', root: dir,
    automationStore: AutomationStore.open(join(dir, 'automations'), { now: () => new Date(NOW) }),
    store: RunStore.open(join(dir, 'runs')),
    manager: { cockpitAddress: () => address } as unknown as RunManager,
  };
  const service = createAutomationService({ home: testHome(),
    timeZone: () => 'Europe/Warsaw',
    // Detection only: no launcher, so nothing here starts a task.
    scheduleHandle: () => ({ projectId: 'cezar', store: project.automationStore, timeZone: 'Europe/Warsaw', now: () => NOW }),
    emitChange: () => {}, changed: () => {},
    githubAvailability: async () => ({ available: false, reason: 'none' }),
    hasGithubRemote: async () => false,
    now: () => NOW,
  });
  return { project, tools: createAutomationToolService(service, project, { timeZone: () => 'Europe/Warsaw', now: () => NOW }) };
}

describe('createAutomationToolService', () => {
  it('delay 7d at 2026-10-22T13:00Z in Europe/Warsaw answers 2026-10-29T13:00Z and stores 14:00 local', async () => {
    const { project, tools } = fixture();
    const answer = await tools.scheduleTask({ name: 'Check', prompt: 'Check it', delay: '7d' });
    expect(answer).toEqual({ ok: true, note: SCHEDULED_TASK_NOTE, task: expect.objectContaining({ status: 'paused', due_at: '2026-10-29T13:00Z' }) });
    expect(project.automationStore.get(answer.ok ? answer.task.id : '')?.schedule).toMatchObject({ at: '2026-10-29T14:00', timeZone: 'Europe/Warsaw' });
  });

  // An agent read UTC from Squawk's waits and local time from `date`, and mixed them. `at` is UTC
  // like every other Squawk time; the cockpit still shows the schedule in its own zone.
  it('takes at in UTC, answers it unchanged and stores the wall time in the cockpit zone', async () => {
    const { project, tools } = fixture();
    const answer = await tools.scheduleTask({ name: 'Check', prompt: 'Check it', at: '2026-10-29T08:00Z' });
    expect(answer.ok && answer.task).toMatchObject({ due_at: '2026-10-29T08:00Z' });
    expect(project.automationStore.get(answer.ok ? answer.task.id : '')?.schedule).toMatchObject({ at: '2026-10-29T09:00', timeZone: 'Europe/Warsaw' });
  });

  // Review of #1469: nobody waits on a scheduled task, so it runs autonomous, as from the CLI and
  // the cockpit, and never parks on a question.
  it('creates the task autonomous, as the CLI and the cockpit do', async () => {
    const { project, tools } = fixture();
    const answer = await tools.scheduleTask({ name: 'Check', prompt: 'Check it', delay: '1d' });
    expect(project.automationStore.get(answer.ok ? answer.task.id : '')?.task).toMatchObject({ autonomous: true });
  });

  it('enables only when asked and reports the cockpit link and latest start', async () => {
    const { tools } = fixture({ origin: 'http://127.0.0.1:4100', projectId: 'cezar' });
    const answer = await tools.scheduleTask({ name: 'Check', prompt: 'Check it', at: '2026-10-29T13:00Z', latest_start: '6h', enable: true });
    expect(answer.ok && answer.task).toMatchObject({ status: scheduledTaskSchema.shape.status.enum.waiting, due_at: '2026-10-29T13:00Z', latest_start_minutes: 360 });
    expect(answer.ok && answer.task.url).toBe(`http://127.0.0.1:4100/p/cezar/automations/${answer.ok ? answer.task.id : ''}`);
  });

  it('refuses a past time and a latest start below 10 minutes as invalid_request', async () => {
    const { tools } = fixture();
    await expect(tools.scheduleTask({ name: 'n', prompt: 'p', at: '2026-10-01T09:00Z' })).resolves.toEqual({ ok: false, code: 'invalid_request', message: ONCE_PAST_DUE });
    await expect(tools.scheduleTask({ name: 'n', prompt: 'p', delay: '1h', latest_start: '5m' })).resolves.toMatchObject({ ok: false, code: 'invalid_request' });
  });

  it('lists only one-time schedules and treats a repeating id as not found', async () => {
    const { project, tools } = fixture();
    const daily = project.automationStore.create({ name: 'Daily', kind: 'schedule', enabled: false, schedule: { type: 'daily', hour: 4 }, task: { prompt: 'p' } });
    const once = await tools.scheduleTask({ name: 'Once', prompt: 'p', delay: '1d' });
    const listed = await tools.scheduledTasks({ action: 'list' });
    expect(listed.ok && 'tasks' in listed ? listed.tasks.map(task => task.name) : []).toEqual(['Once']);
    for (const action of ['show', 'pause', 'enable', 'cancel'] as const) {
      await expect(tools.scheduledTasks({ action, id: daily.id })).resolves.toMatchObject({ ok: false, code: 'not_found' });
    }
    await expect(tools.scheduledTasks({ action: 'update', id: daily.id, name: 'x' })).resolves.toMatchObject({ ok: false, code: 'not_found' });
    expect(once.ok).toBe(true);
  });

  it('updates, enables, pauses and cancels one schedule, then refuses a change to the archive', async () => {
    const { tools } = fixture();
    const created = await tools.scheduleTask({ name: 'Once', prompt: 'p', delay: '1d' });
    const id = created.ok ? created.task.id : '';
    const moved = await tools.scheduledTasks({ action: 'update', id, delay: '2d', prompt: 'new prompt' });
    expect(moved.ok && 'task' in moved && moved.task).toMatchObject({ due_at: '2026-10-24T13:00Z', status: 'paused' });
    await expect(tools.scheduledTasks({ action: 'enable', id })).resolves.toMatchObject({ ok: true, task: { status: scheduledTaskSchema.shape.status.enum.waiting } });
    await expect(tools.scheduledTasks({ action: 'pause', id })).resolves.toMatchObject({ ok: true, task: { status: 'paused' } });
    await expect(tools.scheduledTasks({ action: 'cancel', id })).resolves.toMatchObject({ ok: true, task: { status: 'archived' } });
    await expect(tools.scheduledTasks({ action: 'update', id, name: 'again' })).resolves.toMatchObject({ ok: false, code: 'conflict', message: 'this one-time schedule is archived' });
    expect((await tools.scheduledTasks({ action: 'list' })).ok && (await tools.scheduledTasks({ action: 'list' }))).toMatchObject({ tasks: [] });
    await expect(tools.scheduledTasks({ action: 'list', archived: 'only' })).resolves.toMatchObject({ ok: true, tasks: [{ id, status: 'archived' }] });
    await expect(tools.scheduledTasks({ action: 'show', id: 'missing' })).resolves.toMatchObject({ ok: false, code: 'not_found' });
  });

  // A schedule made in the CLI with --tz keeps its zone when an agent moves it, so the cockpit
  // still shows it in the zone its author chose.
  it('a UTC at moves a schedule within the zone it already has', async () => {
    const { project, tools } = fixture();
    const { id } = project.automationStore.create({ name: 'Once', kind: 'schedule', enabled: false, schedule: { type: 'once', at: '2026-10-29T05:00', timeZone: 'America/New_York' }, task: { prompt: 'p' } });
    const moved = await tools.scheduledTasks({ action: 'update', id, at: '2026-10-30T15:00Z' });
    expect(moved.ok && 'task' in moved && moved.task).toMatchObject({ due_at: '2026-10-30T15:00Z' });
    expect(project.automationStore.get(id)?.schedule).toMatchObject({ at: '2026-10-30T11:00', timeZone: 'America/New_York' });
  });

  // The fall-back hour happens twice in Warsaw on 25 October. A wall time names the first; a UTC
  // time inside the second is never stored earlier than asked.
  it('a UTC at in the repeated hour of a DST change is never stored earlier', async () => {
    const { tools } = fixture();
    const answer = await tools.scheduleTask({ name: 'Once', prompt: 'p', at: '2026-10-25T01:30Z' });
    expect(answer.ok && Date.parse(answer.task.due_at)).toBeGreaterThanOrEqual(Date.parse('2026-10-25T01:30Z'));
  });
});
