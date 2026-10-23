import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import type { ScheduleTaskAnswer, ScheduledTasksAnswer } from '@open-mercato/cezar-contract/scheduled-tasks';
import { CiToolController, type CezarToolHandlers } from './controller.ts';
import { callScheduleTask, callScheduledTasks } from './client.ts';

// hearsay-tools/cezarion#1465: `cezar_schedule_task` and `cezar_scheduled_tasks` on the session's
// private tool socket. The run and project come from the capability, never from the arguments.
const task = { id: 'a1', name: 'Check the rollout', status: 'waiting' as const, due_at: '2026-10-29T09:00', time_zone: 'Europe/Warsaw', resolved_instant: '2026-10-29T08:00:00.000Z' };
const created: ScheduleTaskAnswer = { ok: true, task, note: 'n' };
const listed: ScheduledTasksAnswer = { ok: true, tasks: [task] };
const notUsed = async (): Promise<never> => { throw new Error('not used'); };
const controllers: CiToolController[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(controllers.splice(0).map(owner => owner.close())); });

async function session(overrides: Partial<CezarToolHandlers> = {}) {
  const owner = await CiToolController.start(); controllers.push(owner);
  return owner.provision({ registerWait: notUsed, ask: notUsed, cancelWait: notUsed, finishTurn: notUsed, ...overrides });
}
function post(env: Record<string, string>, route: string, body: string, token = env.CEZ_TOOL_TOKEN!) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ socketPath: env.CEZ_TOOL_SOCKET, path: `/api/v1/tools/${route}`, method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, res => {
      let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode!, body: text }));
    }); req.on('error', reject); req.end(body);
  });
}
const valid = { name: 'Check the rollout', prompt: 'Check it', delay: '7d' };

describe('schedule-task route', () => {
  it('forwards a valid schedule-task call and answers the handler\'s result', async () => {
    vi.stubEnv('CEZ_AUTOMATIONS', '1');
    const scheduleTask = vi.fn(async () => created);
    const { env } = await session({ scheduleTask });
    await expect(callScheduleTask(valid, env)).resolves.toEqual(created);
    expect(scheduleTask).toHaveBeenCalledWith(valid, expect.any(AbortSignal));
  });

  it('accepts a 100 000-character prompt', async () => {
    vi.stubEnv('CEZ_AUTOMATIONS', '1');
    const scheduleTask = vi.fn(async () => created);
    const { env } = await session({ scheduleTask });
    await expect(callScheduleTask({ ...valid, prompt: 'x'.repeat(100_000) }, env)).resolves.toEqual(created);
    expect(scheduleTask).toHaveBeenCalledOnce();
  });

  // Review of #1465: the cap is in bytes, the prompt limit in characters. A prompt of 100 000
  // three-byte or JSON-escaped characters is valid and must reach the handler, on create and update.
  it.each([['CJK', '漢'], ['escaped control', '\u0001']])('accepts a 100 000-character %s prompt on create and update', async (_kind, char) => {
    vi.stubEnv('CEZ_AUTOMATIONS', '1');
    const scheduleTask = vi.fn(async () => created);
    const scheduledTasks = vi.fn(async () => listed);
    const { env } = await session({ scheduleTask, scheduledTasks });
    const prompt = char.repeat(100_000);
    await expect(callScheduleTask({ ...valid, prompt }, env)).resolves.toEqual(created);
    await expect(callScheduledTasks({ action: 'update', id: 'a1', prompt }, env)).resolves.toEqual(listed);
    expect(scheduleTask).toHaveBeenCalledOnce();
    expect(scheduledTasks).toHaveBeenCalledOnce();
  });

  it('refuses at plus delay with invalid_request naming the field', async () => {
    vi.stubEnv('CEZ_AUTOMATIONS', '1');
    const scheduleTask = vi.fn(async () => created);
    const { env } = await session({ scheduleTask });
    const answer = await callScheduleTask({ ...valid, at: '2026-10-29T09:00' }, env);
    expect(answer).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(answer.ok ? '' : answer.message).toMatch(/`delay`/);
    const unknown = await callScheduleTask({ ...valid, project_id: 'other' }, env);
    expect(unknown.ok ? '' : unknown.message).toMatch(/Unknown field "project_id"/);
    expect(scheduleTask).not.toHaveBeenCalled();
  });

  it('answers unavailable when the handler is absent', async () => {
    vi.stubEnv('CEZ_AUTOMATIONS', '1');
    const { env } = await session();
    await expect(callScheduleTask(valid, env)).resolves.toMatchObject({ ok: false, code: 'unavailable' });
    await expect(callScheduledTasks({ action: 'list' }, env)).resolves.toMatchObject({ ok: false, code: 'unavailable' });
  });

  it('answers automations_off when the flag is unset', async () => {
    const scheduleTask = vi.fn(async () => created);
    const scheduledTasks = vi.fn(async () => listed);
    const { env } = await session({ scheduleTask, scheduledTasks });
    for (const value of ['', '0', 'true']) {
      vi.stubEnv('CEZ_AUTOMATIONS', value);
      await expect(callScheduleTask(valid, env)).resolves.toMatchObject({ ok: false, code: 'automations_off' });
      await expect(callScheduledTasks({ action: 'list' }, env)).resolves.toMatchObject({ ok: false, code: 'automations_off' });
    }
    expect(scheduleTask).not.toHaveBeenCalled();
    expect(scheduledTasks).not.toHaveBeenCalled();
  });

  it('refuses an unknown token with 401', async () => {
    vi.stubEnv('CEZ_AUTOMATIONS', '1');
    const scheduleTask = vi.fn(async () => created);
    const { env } = await session({ scheduleTask });
    expect((await post(env, 'schedule-task', JSON.stringify(valid), 'invalid')).status).toBe(401);
    expect((await post(env, 'scheduled-tasks', JSON.stringify({ action: 'list' }), 'invalid')).status).toBe(401);
    expect(scheduleTask).not.toHaveBeenCalled();
  });
});

describe('scheduled-tasks route', () => {
  it('forwards one action to the handler and answers its result', async () => {
    vi.stubEnv('CEZ_AUTOMATIONS', '1');
    const scheduledTasks = vi.fn(async () => listed);
    const { env } = await session({ scheduledTasks });
    await expect(callScheduledTasks({ action: 'list', archived: 'include' }, env)).resolves.toEqual(listed);
    expect(scheduledTasks).toHaveBeenCalledWith({ action: 'list', archived: 'include' }, expect.any(AbortSignal));
    const answer = await callScheduledTasks({ action: 'delete', id: 'a1' }, env);
    expect(answer).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(answer.ok ? '' : answer.message).toMatch(/`action`/);
  });

  // A full list passes the 32 KiB answer cap the other tools keep.
  it('answers a list of 50 tasks with long names in full', async () => {
    vi.stubEnv('CEZ_AUTOMATIONS', '1');
    const many: ScheduledTasksAnswer = { ok: true, tasks: Array.from({ length: 50 }, (_, index) => ({ ...task, id: `a${index}`, name: 'n'.repeat(200), url: `http://127.0.0.1:4100/p/cezar/automations/${'u'.repeat(500)}` })) };
    const { env } = await session({ scheduledTasks: async () => many });
    await expect(callScheduledTasks({ action: 'list' }, env)).resolves.toEqual(many);
  });
});
