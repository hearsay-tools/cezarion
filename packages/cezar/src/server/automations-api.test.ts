import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localTimeZone, nextOccurrence } from '@open-mercato/cezar-contract';
import { AutomationCoordinator } from '../automations/coordinator.ts';
import { GithubPoller } from '../automations/github-poller.ts';
import { ScheduleRunner } from '../automations/schedule-runner.ts';
import { WorkspaceAutomationScheduler } from '../automations/scheduler.ts';
import { AutomationStore } from '../automations/store.ts';
import { isScheduleAutomation } from '../automations/types.ts';
import { RunStore } from '../runs/store.ts';
import { registerProject } from '../workspace/projects.ts';
import { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp, startServer, WorkspaceEventBus } from './server.ts';

/** A git checkout whose `origin` is on github.com — what a GitHub automation needs at create. */
function withGithubRemote(root: string): void {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  git('remote', 'add', 'origin', 'https://github.com/acme/demo.git');
}

describe('GitHub automation API', () => {
  let root: string;
  let home: string;
  let store: RunStore;
  // #801 turned the whole family into an opt-in capability. This suite is about what the routes
  // DO, so it opts in explicitly; what they answer while the flag is off is `automations-gate.test.ts`.
  const savedAutomations = process.env.CEZ_AUTOMATIONS;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cezar-automation-api-'));
    home = mkdtempSync(join(tmpdir(), 'cezar-automation-home-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_AUTOMATIONS = '1';
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(root, '.ai/cezar'));
  });
  afterEach(() => {
    store.flush();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    delete process.env.CEZ_HOME;
    if (savedAutomations === undefined) delete process.env.CEZ_AUTOMATIONS;
    else process.env.CEZ_AUTOMATIONS = savedAutomations;
  });

  const input = {
    name: 'Review new issues',
    events: ['issue.opened'],
    intervalSeconds: 300,
    filters: { lookbackDays: 7, maxRecords: 25 },
    task: { prompt: 'Review {{github.url}}' },
  };
  const scheduleInput = {
    name: 'Nightly deps',
    kind: 'schedule',
    schedule: { type: 'daily', hour: 4, minute: 0 },
    task: { prompt: 'Bump {{project}} deps on {{date}}' },
  };
  /** A manager that creates the run record and nothing else — enough for a launch to land. */
  const recordingManager = () => ({
    startRun: vi.fn((workflow: { name: string }, start: { task: string }) =>
      store.createRun({ title: 'automation', workflow: workflow.name, task: start.task, steps: [] })),
  }) as unknown as RunManager & { startRun: ReturnType<typeof vi.fn> };
  const app = (over: Partial<Parameters<typeof createApp>[0]> = {}) =>
    createApp({ repoRoot: root, store, manager: {} as RunManager, version: 'test', ...over });
  const json = (body: unknown, method = 'POST'): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('answers GitHub availability from a settled probe on a cold cache', async () => {
    withGithubRemote(root);
    // A stub `gh` that succeeds: the first read must wait for the probe instead of answering
    // "still being checked", which the cockpit never refetches.
    const bin = mkdtempSync(join(tmpdir(), 'cezar-fake-gh-'));
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho \'{"nameWithOwner":"acme/demo"}\'\n', { mode: 0o755 });
    const savedPath = process.env.PATH;
    const savedDry = process.env.CEZ_DRY_RUN;
    delete process.env.CEZ_DRY_RUN;
    process.env.PATH = `${bin}:${savedPath}`;
    try {
      const first = await apiRequest(app(), '/api/v1/automations');
      expect(((await first.json()) as any)).toMatchObject({ available: true });
    } finally {
      process.env.PATH = savedPath;
      if (savedDry !== undefined) process.env.CEZ_DRY_RUN = savedDry;
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('answers available under CEZ_DRY_RUN without probing', async () => {
    withGithubRemote(root);
    const savedDry = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    try {
      const res = await apiRequest(app(), '/api/v1/automations');
      expect(((await res.json()) as any)).toMatchObject({ available: true });
    } finally {
      if (savedDry === undefined) delete process.env.CEZ_DRY_RUN;
      else process.env.CEZ_DRY_RUN = savedDry;
    }
  });

  it('creates paused definitions and rejects malformed bounds', async () => {
    withGithubRemote(root);
    const bad = await apiRequest(app(), '/api/v1/automations', json({ ...input, intervalSeconds: 5 }));
    expect(bad.status).toBe(400);
    const response = await apiRequest(app(), '/api/v1/automations', json(input));
    expect(response.status).toBe(201);
    expect(((await response.json()) as any).automation).toMatchObject({ enabled: false, revision: 1 });
  });

  it('enforces optimistic concurrency and establishes a baseline on enable', async () => {
    withGithubRemote(root);
    const created = ((await (await apiRequest(app(), '/api/v1/automations', json(input))).json()) as any).automation;
    const stale = await apiRequest(
      app(),
      `/api/v1/automations/${created.id}`,
      json({ ...input, expectedRevision: 9 }, 'PUT'),
    );
    expect(stale.status).toBe(409);
    const enabled = await apiRequest(app(), `/api/v1/automations/${created.id}/enable`, { method: 'POST' });
    expect(enabled.status).toBe(200);
    const detail = await apiRequest(app(), `/api/v1/automations/${created.id}`);
    expect(((await detail.json()) as any).state).toMatchObject({ revision: 2, baselineAt: expect.any(String) });
  });

  it('runs preview checks asynchronously without writing receipts', async () => {
    // Created in the store, not through the API: the checkout has no GitHub remote, which is the
    // failure this check has to report.
    const automationStore = AutomationStore.open(join(root, '.ai/cezar'));
    const server = app({ automationStore });
    const created = automationStore.create({ ...input, events: ['issue.opened'] });
    const queued = await apiRequest(server, `/api/v1/automations/${created.id}/check`, json({ mode: 'preview' }));
    expect(queued.status).toBe(202);
    const { checkId } = (await queued.json()) as { checkId: string };
    let check: { status: string } = { status: 'queued' };
    // Up to 2s, exiting the moment the check fails. The background pass shells out to `git` to
    // read the repo's remote before it can decide there is none, and 200ms of budget was under
    // that spawn's cost whenever the rest of the server suites were running beside this one.
    for (let attempt = 0; attempt < 200 && check.status !== 'error'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      check = (await (await apiRequest(server, `/api/v1/automation-checks/${checkId}`)).json()) as { status: string };
    }
    expect(check.status).toBe('error');
    const list = await apiRequest(server, '/api/v1/automations');
    expect(((await list.json()) as any).automations).toHaveLength(1);
    expect(readFileOrEmpty(join(root, '.ai/cezar/automation-receipts.ndjson'))).toBe('');
  });

  it('shares API mutations with the workspace scheduler store', async () => {
    const coordinator = new AutomationCoordinator({
      listProjects: async () => [{ id: 'default', root, status: 'ok' }],
    });
    const automationStore = coordinator.store('default', root)!;
    let rescheduled: Promise<void> | undefined;
    const scheduler = new WorkspaceAutomationScheduler({
      coordinator,
      handle: (_projectId, sharedStore) => ({
        projectId: 'default',
        store: sharedStore,
        timeZone: 'UTC',
        github: { owner: 'open-mercato', repo: 'cezar', poller: { poll: async () => ({ candidates: [], truncated: false, pages: 1 }) } as never },
      }),
    });
    const server = app({
      automationStore,
      automationsChanged: () => {
        rescheduled = scheduler.reschedule();
      },
    });

    await scheduler.start();
    withGithubRemote(root);
    // A registered project keeps the idle wake before it has any definitions file, so another
    // cockpit's first automation is discovered (finding 4172236277).
    expect(scheduler.hasTimer()).toBe(true);
    const created = ((await (await apiRequest(server, '/api/v1/automations', json(input))).json()) as any).automation;
    // Created paused: the idle wake still watches for edits made by another cockpit (finding 4172021393).
    await rescheduled;
    expect(scheduler.hasTimer()).toBe(true);

    const enabled = await apiRequest(server, `/api/v1/automations/${created.id}/enable`, { method: 'POST' });
    expect(enabled.status).toBe(200);
    await rescheduled;
    expect(coordinator.store('default')).toBe(automationStore);
    expect(coordinator.store('default')?.get(created.id)?.enabled).toBe(true);
    expect(scheduler.hasTimer()).toBe(true);

    coordinator.store('default')?.setState(created.id, (current) => ({
      ...current,
      revision: 2,
      lastSuccessAt: '2026-07-27T00:00:00.000Z',
    }));
    const detail = await apiRequest(server, `/api/v1/automations/${created.id}`);
    expect(((await detail.json()) as any).state.lastSuccessAt).toBe('2026-07-27T00:00:00.000Z');
    scheduler.stop();
  });

  it('creates a schedule automation without poll keys and refuses one with filters (400)', async () => {
    const server = app();
    const created = await apiRequest(server, '/api/v1/automations', json(scheduleInput));
    expect(created.status).toBe(201);
    const automation = ((await created.json()) as any).automation;
    expect(automation).toMatchObject({ kind: 'schedule', enabled: false, schedule: { type: 'daily', hour: 4, minute: 0 } });
    expect(automation).not.toHaveProperty('events');
    expect(automation).not.toHaveProperty('intervalSeconds');
    expect(automation).not.toHaveProperty('filters');

    const filtered = await apiRequest(server, '/api/v1/automations', json({ ...scheduleInput, filters: { lookbackDays: 7 } }));
    expect(filtered.status).toBe(400);
    expect(((await filtered.json()) as any).error).toBe('a scheduled automation has no GitHub filter');
    const unscheduled = await apiRequest(server, '/api/v1/automations', json({ ...scheduleInput, schedule: undefined }));
    expect(unscheduled.status).toBe(400);
    const githubPlaceholder = await apiRequest(server, '/api/v1/automations', json({ ...scheduleInput, task: { prompt: 'Open {{github.url}}' } }));
    expect(githubPlaceholder.status).toBe(400);
    expect(((await githubPlaceholder.json()) as any).error).toContain('unknown automation placeholder');
    // No `kind` is a GitHub automation, and this checkout has no GitHub remote to poll.
    const noRemote = await apiRequest(server, '/api/v1/automations', json(input));
    expect(noRemote.status).toBe(400);
    expect(((await noRemote.json()) as any).error).toBe('No GitHub remote is configured');
  });

  it('a PUT without kind inherits schedule and a PUT switching kind answers 409', async () => {
    const server = app();
    const created = ((await (await apiRequest(server, '/api/v1/automations', json(scheduleInput))).json()) as any).automation;
    // An old client sends no `kind` and no poll keys: that is an edit of the schedule it read.
    const { kind: _kind, ...oldClientBody } = scheduleInput;
    const renamed = await apiRequest(server, `/api/v1/automations/${created.id}`, json({ ...oldClientBody, name: 'Renamed', expectedRevision: 1 }, 'PUT'));
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as any).automation).toMatchObject({ kind: 'schedule', name: 'Renamed', revision: 2 });
    // Inheriting `schedule` also means a poll key is refused rather than read as a GitHub edit.
    const polled = await apiRequest(server, `/api/v1/automations/${created.id}`, json({ ...oldClientBody, intervalSeconds: 300, expectedRevision: 2 }, 'PUT'));
    expect(polled.status).toBe(400);
    expect(((await polled.json()) as any).error).toBe('a scheduled automation has no GitHub filter');
    const switched = await apiRequest(server, `/api/v1/automations/${created.id}`, json({ ...input, kind: 'github', expectedRevision: 2 }, 'PUT'));
    expect(switched.status).toBe(409);
    expect(((await switched.json()) as any).error).toBe('change the kind by creating a new automation');
    expect(((await (await apiRequest(server, `/api/v1/automations/${created.id}`)).json()) as any).automation).toMatchObject({ kind: 'schedule', revision: 2 });
  });

  it('POST /automations/:id/run launches a schedule (202 runId) and 409s a github automation', async () => {
    const bus = new WorkspaceEventBus();
    const changes: unknown[] = [];
    bus.on((event, data) => { if (event === 'automation-change') changes.push(data); });
    const automationStore = AutomationStore.open(join(root, '.ai/cezar'));
    const manager = recordingManager();
    const server = app({ automationStore, manager, workspaceEvents: bus });
    const created = ((await (await apiRequest(server, '/api/v1/automations', json(scheduleInput))).json()) as any).automation;

    const ran = await apiRequest(server, `/api/v1/automations/${created.id}/run`, { method: 'POST' });
    expect(ran.status).toBe(202);
    const { runId } = (await ran.json()) as { runId: string };
    expect(store.getRun(runId)?.automationTrigger).toMatchObject({ automationId: created.id, trigger: 'manual' });
    expect(store.getRun(runId)?.task).toContain('Scheduled run context');
    expect(automationStore.logs({ automationId: created.id })[0]).toMatchObject({ result: 'manual', runId });
    // Run now leaves the timer alone: still paused, nothing armed.
    expect(automationStore.get(created.id)?.enabled).toBe(false);
    expect(automationStore.state(created.id)?.nextRunAt).toBeUndefined();
    expect(changes.at(-1)).toMatchObject({ project: 'default', automationId: created.id });

    const held = automationStore.acquireLease();
    try {
      const busy = await apiRequest(server, `/api/v1/automations/${created.id}/run`, { method: 'POST' });
      expect(busy.status).toBe(409);
    } finally { held?.release(); }

    const poll = automationStore.create({ ...input, events: ['issue.opened'] });
    const refused = await apiRequest(server, `/api/v1/automations/${poll.id}/run`, { method: 'POST' });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as any).error).toContain('use check with mode execute');
    expect((await apiRequest(server, '/api/v1/automations/nope/run', { method: 'POST' })).status).toBe(404);
    expect(manager.startRun).toHaveBeenCalledTimes(1);
  });

  it('POST /automations/:id/run answers 404 and launches nothing when another process deleted the schedule', async () => {
    const automationStore = AutomationStore.open(join(root, '.ai/cezar'));
    const manager = recordingManager();
    const server = app({ automationStore, manager });
    const created = ((await (await apiRequest(server, '/api/v1/automations', json(scheduleInput))).json()) as any).automation;
    AutomationStore.open(join(root, '.ai/cezar')).delete(created.id);
    const ran = await apiRequest(server, `/api/v1/automations/${created.id}/run`, { method: 'POST' });
    expect(ran.status).toBe(404);
    expect(((await ran.json()) as any).error).toBe('not found');
    expect(manager.startRun).not.toHaveBeenCalled();
  });

  it('check 409s a schedule', async () => {
    const server = app();
    const created = ((await (await apiRequest(server, '/api/v1/automations', json(scheduleInput))).json()) as any).automation;
    const check = await apiRequest(server, `/api/v1/automations/${created.id}/check`, json({ mode: 'preview' }));
    expect(check.status).toBe(409);
    expect(((await check.json()) as any).error).toBe('a schedule has nothing to preview; use run');
  });

  it('enable arms nextRunAt for a schedule and the list answers timeZone and nextRunAt', async () => {
    const automationStore = AutomationStore.open(join(root, '.ai/cezar'));
    const server = app({ automationStore });
    const created = ((await (await apiRequest(server, '/api/v1/automations', json(scheduleInput))).json()) as any).automation;
    const before = Date.now();
    const enabled = await apiRequest(server, `/api/v1/automations/${created.id}/enable`, { method: 'POST' });
    expect(enabled.status).toBe(200);
    const state = automationStore.state(created.id)!;
    const expected = nextOccurrence(scheduleInput.schedule as never, before, localTimeZone())!;
    expect(Math.abs(Date.parse(state.nextRunAt!) - expected)).toBeLessThan(60_000);
    expect(state.nextRunAt! > new Date().toISOString()).toBe(true);
    // A schedule has no backlog to baseline against.
    expect(state.baselineAt).toBeUndefined();
    expect(automationStore.logs({ automationId: created.id })).toEqual([]);

    const poll = automationStore.create({ ...input, events: ['issue.opened'] });
    expect((await apiRequest(server, `/api/v1/automations/${poll.id}/enable`, { method: 'POST' })).status).toBe(200);
    const list = (await (await apiRequest(server, '/api/v1/automations')).json()) as any;
    expect(list.timeZone).toBe(localTimeZone());
    const entry = (id: string) => list.automations.find((item: { id: string }) => item.id === id);
    expect(entry(created.id).nextRunAt).toBe(state.nextRunAt);
    expect(entry(poll.id).nextRunAt).toBe(automationStore.state(poll.id)?.nextCheckAt);

    // Editing the schedule re-arms from the new one in the same request, so the list the cockpit
    // refetches on the change event never answers "Next run: —" for an enabled schedule.
    const current = automationStore.get(created.id)!;
    const editedAt = Date.now();
    const edited = await apiRequest(server, `/api/v1/automations/${created.id}`, json({ ...scheduleInput, schedule: { type: 'weekdays', hour: 9 }, enabled: true, expectedRevision: current.revision }, 'PUT'));
    expect(edited.status).toBe(200);
    const rearmed = nextOccurrence({ type: 'weekdays', hour: 9, minute: 0 }, editedAt, localTimeZone())!;
    expect(Math.abs(Date.parse(automationStore.state(created.id)!.nextRunAt!) - rearmed)).toBeLessThan(60_000);
    const afterEdit = (await (await apiRequest(server, '/api/v1/automations')).json()) as any;
    expect(afterEdit.automations.find((item: { id: string }) => item.id === created.id).nextRunAt).toBe(automationStore.state(created.id)!.nextRunAt);
    // An edit that leaves it paused arms nothing.
    const stillPaused = automationStore.update(created.id, automationStore.get(created.id)!.revision, { ...scheduleInput, kind: 'schedule', schedule: { type: 'weekdays', hour: 9 }, enabled: false } as never);
    const pausedEdit = await apiRequest(server, `/api/v1/automations/${created.id}`, json({ ...scheduleInput, schedule: { type: 'daily', hour: 7 }, enabled: false, expectedRevision: stillPaused.revision }, 'PUT'));
    expect(pausedEdit.status).toBe(200);
    expect(automationStore.state(created.id)?.nextRunAt).toBeUndefined();
    const resumed = await apiRequest(server, `/api/v1/automations/${created.id}`, json({ ...scheduleInput, schedule: { type: 'daily', hour: 7 }, enabled: true, expectedRevision: stillPaused.revision + 1 }, 'PUT'));
    expect(resumed.status).toBe(200);
    expect(automationStore.state(created.id)?.nextRunAt).toBe(new Date(nextOccurrence({ type: 'daily', hour: 7, minute: 0 }, Date.now(), localTimeZone())!).toISOString());
    const paused = await apiRequest(server, `/api/v1/automations/${created.id}/pause`, { method: 'POST' });
    expect(paused.status).toBe(200);
    const afterPause = (await (await apiRequest(server, '/api/v1/automations')).json()) as any;
    expect(afterPause.automations.find((item: { id: string }) => item.id === created.id)).not.toHaveProperty('nextRunAt');
  });

  /**
   * What a schedule fire in ANOTHER process would do at every point in a route's writes: after
   * each rename of `automations.json` or `automation-state.json`, both files are copied to a fresh
   * directory, and once the route answered a `ScheduleRunner` on a store opened there fires the
   * definition that copy holds — as another cockpit's timer would, had it reloaded right then.
   */
  async function launchesMidRoute(automationStore: AutomationStore, id: string, route: () => Promise<Response>): Promise<{ response: Response; launches: number; copies: number }> {
    const copies: string[] = [];
    const write = (automationStore as any).atomicJson.bind(automationStore) as (filename: string, value: unknown) => void;
    const spy = vi.spyOn(automationStore as any, 'atomicJson').mockImplementation(((filename: string, value: unknown) => {
      write(filename, value);
      const copy = mkdtempSync(join(tmpdir(), 'cezar-automation-mid-route-'));
      for (const name of ['automations.json', 'automation-state.json']) {
        const path = join(automationStore.dataDir, name);
        if (existsSync(path)) copyFileSync(path, join(copy, name));
      }
      copies.push(copy);
    }) as never);
    let response: Response;
    try { response = await route(); } finally { spy.mockRestore(); }
    let launches = 0;
    for (const copy of copies) {
      try {
        const reader = AutomationStore.open(copy);
        const definition = reader.get(id);
        if (!definition || !isScheduleAutomation(definition)) continue;
        const launch = vi.fn(async () => ({ runId: 'mid-route' }));
        await new ScheduleRunner({ projectId: 'other', store: reader, timeZone: localTimeZone(), launch }).fire(definition);
        launches += launch.mock.calls.length;
      } finally {
        rmSync(copy, { recursive: true, force: true });
      }
    }
    return { response, launches, copies: copies.length };
  }
  /** A paused schedule whose state still holds an instant that is due now (five minutes ago). */
  function pausedWithStaleInstant(automationStore: AutomationStore) {
    const created = automationStore.create({ ...scheduleInput, kind: 'schedule', enabled: false } as never);
    const stale = new Date(Date.now() - 5 * 60_000).toISOString();
    automationStore.setState(created.id, (current) => ({ ...current, revision: created.revision, nextRunAt: stale }));
    return { created, stale };
  }

  it('enable never shows another process the enabled schedule beside its stale nextRunAt', async () => {
    const automationStore = AutomationStore.open(join(root, '.ai/cezar'));
    const server = app({ automationStore });
    const { created } = pausedWithStaleInstant(automationStore);
    const before = Date.now();
    const { response, launches, copies } = await launchesMidRoute(automationStore, created.id, () =>
      apiRequest(server, `/api/v1/automations/${created.id}/enable`, { method: 'POST' }));
    expect(response.status).toBe(200);
    expect(copies).toBeGreaterThanOrEqual(2);
    expect(launches).toBe(0);
    const armed = automationStore.state(created.id)!.nextRunAt!;
    expect(Math.abs(Date.parse(armed) - nextOccurrence(scheduleInput.schedule as never, before, localTimeZone())!)).toBeLessThan(60_000);
    expect(Date.parse(armed)).toBeGreaterThan(Date.now());
  });

  it('a PUT that resumes a schedule never shows another process the new definition beside its stale nextRunAt', async () => {
    const automationStore = AutomationStore.open(join(root, '.ai/cezar'));
    const server = app({ automationStore });
    const { created } = pausedWithStaleInstant(automationStore);
    const schedule = { type: 'weekdays', hour: 9, minute: 0 } as const;
    const before = Date.now();
    const { response, launches, copies } = await launchesMidRoute(automationStore, created.id, () =>
      apiRequest(server, `/api/v1/automations/${created.id}`, json({ ...scheduleInput, schedule, enabled: true, expectedRevision: created.revision }, 'PUT')));
    expect(response.status).toBe(200);
    expect(copies).toBeGreaterThanOrEqual(2);
    expect(launches).toBe(0);
    const armed = automationStore.state(created.id)!.nextRunAt!;
    expect(Math.abs(Date.parse(armed) - nextOccurrence(schedule, before, localTimeZone())!)).toBeLessThan(60_000);
    expect(Date.parse(armed)).toBeGreaterThan(Date.now());
  });

  /** An enabled schedule whose state holds an instant that is due now (five minutes ago). */
  function enabledWithDueInstant(automationStore: AutomationStore) {
    const created = automationStore.create({ ...scheduleInput, kind: 'schedule', enabled: true } as never);
    const due = new Date(Date.now() - 5 * 60_000).toISOString();
    automationStore.setState(created.id, (current) => ({ ...current, revision: created.revision, nextRunAt: due }));
    return created;
  }

  it('a PUT that pauses a schedule never shows another process the enabled definition beside a due nextRunAt', async () => {
    const automationStore = AutomationStore.open(join(root, '.ai/cezar'));
    const server = app({ automationStore });
    const created = enabledWithDueInstant(automationStore);
    const { response, launches, copies } = await launchesMidRoute(automationStore, created.id, () =>
      apiRequest(server, `/api/v1/automations/${created.id}`, json({ ...scheduleInput, enabled: false, expectedRevision: created.revision }, 'PUT')));
    expect(response.status).toBe(200);
    expect(copies).toBeGreaterThanOrEqual(2);
    expect(launches).toBe(0);
    expect(automationStore.state(created.id)?.nextRunAt).toBeUndefined();
    expect(automationStore.get(created.id)?.enabled).toBe(false);
  });

  it('the pause route never shows another process the enabled definition beside a due nextRunAt', async () => {
    const automationStore = AutomationStore.open(join(root, '.ai/cezar'));
    const server = app({ automationStore });
    const created = enabledWithDueInstant(automationStore);
    const { response, launches, copies } = await launchesMidRoute(automationStore, created.id, () =>
      apiRequest(server, `/api/v1/automations/${created.id}/pause`, { method: 'POST' }));
    expect(response.status).toBe(200);
    expect(copies).toBeGreaterThanOrEqual(2);
    expect(launches).toBe(0);
    expect(AutomationStore.open(join(root, '.ai/cezar')).state(created.id)).not.toHaveProperty('nextRunAt');
    expect(automationStore.get(created.id)?.enabled).toBe(false);
  });

  it('a PUT that loses the revision race leaves the armed nextRunAt alone', async () => {
    const automationStore = AutomationStore.open(join(root, '.ai/cezar'));
    const server = app({ automationStore });
    const { created, stale } = pausedWithStaleInstant(automationStore);
    const conflict = await apiRequest(server, `/api/v1/automations/${created.id}`, json({ ...scheduleInput, enabled: true, expectedRevision: created.revision + 5 }, 'PUT'));
    expect(conflict.status).toBe(409);
    expect(AutomationStore.open(join(root, '.ai/cezar')).state(created.id)?.nextRunAt).toBe(stale);
  });

  it('enable and pause toggle the current revision when another store edited the definition', async () => {
    const dir = join(root, '.ai/cezar');
    const stale = AutomationStore.open(dir);
    const other = AutomationStore.open(dir);
    const server = app({ automationStore: stale });
    const created = stale.create({ ...scheduleInput, enabled: false } as never);
    other.reload();
    const edited = other.update(created.id, created.revision, { ...scheduleInput, name: 'Edited elsewhere', enabled: false } as never);
    const enabled = await apiRequest(server, `/api/v1/automations/${created.id}/enable`, { method: 'POST' });
    expect(enabled.status).toBe(200);
    expect(((await enabled.json()) as any).automation).toMatchObject({ name: 'Edited elsewhere', enabled: true, revision: edited.revision + 1 });
    other.reload();
    const edited2 = other.update(created.id, other.get(created.id)!.revision, { ...scheduleInput, name: 'Edited again', enabled: true } as never);
    const paused = await apiRequest(server, `/api/v1/automations/${created.id}/pause`, { method: 'POST' });
    expect(paused.status).toBe(200);
    expect(((await paused.json()) as any).automation).toMatchObject({ name: 'Edited again', enabled: false, revision: edited2.revision + 1 });
  });

  it('enable and pause answer 409, never 500, when the write races another edit', async () => {
    const automationStore = AutomationStore.open(join(root, '.ai/cezar'));
    const server = app({ automationStore });
    const created = automationStore.create({ ...scheduleInput, enabled: false } as never);
    for (const action of ['enable', 'pause']) {
      const spy = vi.spyOn(automationStore, 'update').mockImplementationOnce(() => { throw new Error('automation revision conflict'); });
      const response = await apiRequest(server, `/api/v1/automations/${created.id}/${action}`, { method: 'POST' });
      expect(response.status).toBe(409);
      expect(((await response.json()) as any).error).toBe('the automation changed elsewhere; reload and try again');
      spy.mockRestore();
    }
    const gone = vi.spyOn(automationStore, 'update').mockImplementationOnce(() => { throw new Error('automation not found'); });
    expect((await apiRequest(server, `/api/v1/automations/${created.id}/pause`, { method: 'POST' })).status).toBe(404);
    gone.mockRestore();
  });

  it('retry fires a launch-error schedule receipt', async () => {
    const automationStore = AutomationStore.open(join(root, '.ai/cezar'));
    const manager = recordingManager();
    const server = app({ automationStore, manager });
    const created = ((await (await apiRequest(server, '/api/v1/automations', json(scheduleInput))).json()) as any).automation;
    const occurrenceAt = '2026-10-02T04:00:00.000Z';
    automationStore.appendReceipt({
      receiptId: 'sched-receipt', receiptKey: `${created.id}:schedule:${occurrenceAt}`, eventId: `schedule:${occurrenceAt}`,
      automationId: created.id, revision: created.revision, status: 'launch-error', error: 'unknown workflow: gone',
      occurrenceAt, observedAt: occurrenceAt, updatedAt: occurrenceAt,
    });
    const retried = await apiRequest(server, '/api/v1/automation-log/sched-receipt/retry', { method: 'POST' });
    expect(retried.status).toBe(202);
    const body = (await retried.json()) as { receiptId: string; runId: string };
    expect(body.receiptId).toBe('sched-receipt');
    expect(automationStore.latestReceipts().get(`${created.id}:schedule:${occurrenceAt}`)).toMatchObject({ status: 'launched', runId: body.runId });
    expect(store.getRun(body.runId)?.automationTrigger).toMatchObject({ receiptId: 'sched-receipt', trigger: 'manual', occurrenceAt });
    const again = await apiRequest(server, '/api/v1/automation-log/sched-receipt/retry', { method: 'POST' });
    expect(again.status).toBe(409);
    expect(manager.startRun).toHaveBeenCalledTimes(1);
  });

  /**
   * Boots `startServer` on a pre-schedule `automations.json` whose one enabled poll last succeeded
   * 30 days ago, waits for the timer to start plus long enough for a past-due poll to fire, and
   * hands back what happened. `remote: false` is a git checkout with no remote at all.
   */
  const bootIdlePoll = async (remote: boolean) => {
    const savedDryRun = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    if (remote) withGithubRemote(root);
    else {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root, stdio: 'ignore' });
    }
    const DAY = 86_400_000;
    const stale = new Date(Date.now() - 30 * DAY).toISOString();
    // A pre-schedule file: no `kind`, enabled, last polled a month ago.
    writeFileSync(join(root, '.ai/cezar/automations.json'), JSON.stringify({
      version: 1,
      automations: [{
        id: 'idle-poll', revision: 1, name: 'Old poll', enabled: true, events: ['issue.opened'], intervalSeconds: 300,
        filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'Review {{github.url}}' },
        createdAt: stale, updatedAt: stale,
      }],
    }));
    writeFileSync(join(root, '.ai/cezar/automation-state.json'), JSON.stringify({
      version: 1,
      states: { 'idle-poll': { revision: 1, baselineAt: stale, cursor: { timestamp: stale }, lastSuccessAt: stale, nextCheckAt: stale } },
    }));
    // The backlog a stale cursor would launch: an issue opened 20 days ago, after the cursor.
    const backlog = { eventId: 'old', event: 'issue.opened' as const, timestamp: new Date(Date.now() - 20 * DAY).toISOString(), tieBreaker: 'I', repo: 'acme/demo', nodeId: 'I', number: 7, title: 'Old', url: 'https://github.com/acme/demo/issues/7', author: 'alice', assignees: [], labels: [] };
    const poll = vi.spyOn(GithubPoller.prototype, 'poll').mockResolvedValue({ candidates: [backlog], truncated: false, pages: 1 });
    const started = vi.spyOn(WorkspaceAutomationScheduler.prototype, 'start');
    const manager = Object.assign(recordingManager(), { isActive: () => false });
    // Registered, as `cez` registers the repo it boots in: the coordinator only keeps a store for
    // a project the registry lists, so an unregistered root would never reach the timer at all.
    const project = await registerProject(root);
    const server = startServer({ repoRoot: project.root, bootProjectId: project.id, store, manager, version: '0.0.0-test' }, 0);
    try {
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1), { timeout: 15_000, interval: 10 });
      // Long enough for a past-due poll armed at boot to fire and launch.
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { stale, poll: poll.mock.calls.length, launches: manager.startRun.mock.calls.length };
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      vi.restoreAllMocks();
      if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
      else process.env.CEZ_DRY_RUN = savedDryRun;
    }
  };

  it('boot re-baselines an idle enabled poll and launches nothing', async () => {
    const booted = await bootIdlePoll(true);
    expect(booted.launches).toBe(0);
    expect(booted.poll).toBe(0);
    const automations = AutomationStore.open(join(root, '.ai/cezar'));
    expect(automations.logs({ automationId: 'idle-poll' })[0]).toMatchObject({ result: 'baseline', reason: expect.stringContaining('30 days idle') });
    const state = automations.state('idle-poll')!;
    expect(Date.parse(state.cursor!.timestamp)).toBeGreaterThan(Date.now() - 60_000);
    expect(Date.parse(state.nextCheckAt!)).toBeGreaterThan(Date.now());
  }, 20_000);

  // A poll on a project without a github.com remote is never armed, so it never succeeds: braking
  // it would append a fresh `baseline` row on every boot, forever, for a poll that cannot run.
  it('boot leaves an idle poll alone on a project without a GitHub remote', async () => {
    const booted = await bootIdlePoll(false);
    expect(booted.launches).toBe(0);
    expect(booted.poll).toBe(0);
    const automations = AutomationStore.open(join(root, '.ai/cezar'));
    expect(automations.logs({ automationId: 'idle-poll' })).toEqual([]);
    expect(automations.state('idle-poll')?.cursor?.timestamp).toBe(booted.stale);
  }, 20_000);

  // The timer's own launcher (`startServer`'s handle → `launchScheduledRun`), not Run now's: a
  // past-due schedule on a project with no remote at all launches one ordinary run at boot, and
  // the occurrence's durable receipt stops a second boot that finds the same due instant.
  it('boot fires a past-due schedule on a project without a remote, once across two boots', async () => {
    const savedDryRun = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root, stdio: 'ignore' });
    const created = new Date(Date.now() - 86_400_000).toISOString();
    // Inside the 10-minute grace window, so this is an on-time `schedule` fire, not a catch-up.
    const occurrenceAt = new Date(Date.now() - 3 * 60_000).toISOString();
    writeFileSync(join(root, '.ai/cezar/automations.json'), JSON.stringify({
      version: 1,
      automations: [{
        id: 'nightly', revision: 1, kind: 'schedule', name: 'Nightly deps', enabled: true,
        schedule: { type: 'daily', hour: 4, minute: 0 }, task: { prompt: 'Bump {{project}} deps' },
        createdAt: created, updatedAt: created,
      }],
    }));
    const pastDue = () => {
      // Read-modify-write: keep whatever else the first boot persisted (a crash between the
      // launch and the state write is what leaves `nextRunAt` behind).
      const path = join(root, '.ai/cezar/automation-state.json');
      const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as { states?: Record<string, object> } : {};
      writeFileSync(path, JSON.stringify({ version: 1, states: { ...current.states, nightly: { ...current.states?.nightly, revision: 1, nextRunAt: occurrenceAt } } }));
    };
    pastDue();
    const manager = Object.assign(recordingManager(), { isActive: () => false });
    const project = await registerProject(root);
    const boot = async (awaited: 'launched' | 'duplicate') => {
      const started = vi.spyOn(WorkspaceAutomationScheduler.prototype, 'start');
      const server = startServer({ repoRoot: project.root, bootProjectId: project.id, store, manager, version: '0.0.0-test' }, 0);
      try {
        await new Promise<void>((resolve) => server.once('listening', () => resolve()));
        await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1), { timeout: 15_000, interval: 10 });
        await vi.waitFor(() => {
          const rows = AutomationStore.open(join(root, '.ai/cezar')).logs({ automationId: 'nightly' });
          expect(rows.some((row) => row.result === awaited)).toBe(true);
        }, { timeout: 5_000, interval: 20 });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        started.mockRestore();
      }
    };
    try {
      await boot('launched');
      const launched = store.listRuns().filter((run) => run.automationTrigger);
      expect(launched).toHaveLength(1);
      expect(launched[0]!.automationTrigger).toMatchObject({ automationId: 'nightly', automationRevision: 1, trigger: 'schedule', occurrenceAt });
      expect(launched[0]!.task).toContain('Scheduled run context');
      const automations = AutomationStore.open(join(root, '.ai/cezar'));
      expect(automations.latestReceipts().get(`nightly:schedule:${occurrenceAt}`)).toMatchObject({ status: 'launched', runId: launched[0]!.id });
      expect(Date.parse(automations.state('nightly')!.nextRunAt!)).toBeGreaterThan(Date.now());

      // The second boot meets the same past-due instant; the receipt makes it a `duplicate`.
      pastDue();
      await boot('duplicate');
      expect(store.listRuns().filter((run) => run.automationTrigger)).toHaveLength(1);
      expect(manager.startRun).toHaveBeenCalledTimes(1);
      expect(AutomationStore.open(join(root, '.ai/cezar')).logs({ automationId: 'nightly' })[0]).toMatchObject({ result: 'duplicate' });
    } finally {
      vi.restoreAllMocks();
      if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
      else process.env.CEZ_DRY_RUN = savedDryRun;
    }
  }, 30_000);

  // The timer reserves the receipt, THEN its launcher builds a non-boot project's context
  // lazily — and building it reconciles receipts. The reservation this process is launching right
  // now is not a crash leftover: it must neither flip to launch-error nor log a false `failed`.
  it('the first launch in a non-boot project whose context is not built yet logs no failure', async () => {
    const savedDryRun = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    const other = mkdtempSync(join(tmpdir(), 'cezar-automation-other-'));
    const gitInit = (dir: string) => {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
      execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
    };
    gitInit(root);
    gitInit(other);
    const created = new Date(Date.now() - 86_400_000).toISOString();
    const occurrenceAt = new Date(Date.now() - 3 * 60_000).toISOString();
    const dataDir = join(other, '.ai/cezar');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'automations.json'), JSON.stringify({
      version: 1,
      automations: [{
        id: 'nightly', revision: 1, kind: 'schedule', name: 'Nightly deps', enabled: true,
        schedule: { type: 'daily', hour: 4, minute: 0 }, task: { prompt: 'Bump {{project}} deps' },
        createdAt: created, updatedAt: created,
      }],
    }));
    writeFileSync(join(dataDir, 'automation-state.json'), JSON.stringify({ version: 1, states: { nightly: { revision: 1, nextRunAt: occurrenceAt } } }));
    // The real context builds a real RunManager; only its run creation is stubbed to a record.
    const startRun = vi.spyOn(RunManager.prototype, 'startRun').mockImplementation(function (this: RunManager, workflow, input) {
      return (this as unknown as { store: RunStore }).store.createRun({ title: 'automation', workflow: workflow.name, task: input.task, steps: [] });
    });
    const boot = await registerProject(root);
    const second = await registerProject(other);
    const server = startServer({ repoRoot: boot.root, bootProjectId: boot.id, store, manager: Object.assign(recordingManager(), { isActive: () => false }), version: '0.0.0-test' }, 0);
    try {
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      const automations = AutomationStore.open(dataDir);
      await vi.waitFor(() => {
        expect(automations.logs({ automationId: 'nightly' }).some((row) => row.result === 'launched')).toBe(true);
      }, { timeout: 15_000, interval: 20 });
      expect(startRun).toHaveBeenCalledTimes(1);
      const receipt = automations.latestReceipts().get(`nightly:schedule:${occurrenceAt}`);
      expect(receipt).toMatchObject({ status: 'launched', runId: expect.any(String) });
      expect(automations.receipts().filter((row) => row.status === 'launch-error')).toEqual([]);
      // Give a best-effort reconcile row time to land before asserting it never did.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(automations.logs({ automationId: 'nightly' }).map((row) => row.result)).toEqual(['launched']);
      expect(second.id).not.toBe(boot.id);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      vi.restoreAllMocks();
      rmSync(other, { recursive: true, force: true });
      if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
      else process.env.CEZ_DRY_RUN = savedDryRun;
    }
  }, 30_000);

  it('the list tallies count schedule launches as launched and failed launches as errors', async () => {
    const automationStore = AutomationStore.open(join(root, '.ai/cezar'));
    const created = ((await (await apiRequest(app({ automationStore }), '/api/v1/automations', json(scheduleInput))).json()) as any).automation;
    for (const result of ['launched', 'manual', 'catch-up', 'failed', 'error', 'rate-limited', 'duplicate', 'no-match'] as const) {
      await automationStore.appendLog({ automationId: created.id, revision: 1, result });
    }
    const response = await apiRequest(app({ automationStore }), '/api/v1/automations');
    expect(response.status).toBe(200);
    const listed = ((await response.json()) as any).automations.find((row: { id: string }) => row.id === created.id);
    expect(listed.counts).toEqual({ matches: 2, launched: 3, duplicates: 1, errors: 3 });
  });

  it('accepts preview as an automation-log result filter', async () => {
    const automationStore = AutomationStore.open(join(root, '.ai/cezar'));
    await automationStore.appendLog({
      automationId: 'previewed',
      revision: 1,
      result: 'preview',
      reason: 'test preview',
    });
    const response = await apiRequest(
      app({ automationStore }),
      '/api/v1/automation-log?result=preview',
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as any).records).toEqual([
      expect.objectContaining({ automationId: 'previewed', result: 'preview' }),
    ]);
  });

  it('marks delete events explicitly while retaining a positive revision', async () => {
    const bus = new WorkspaceEventBus();
    const changes: unknown[] = [];
    bus.on((event, data) => {
      if (event === 'automation-change') changes.push(data);
    });
    const server = app({ workspaceEvents: bus });
    const created = ((await (await apiRequest(server, '/api/v1/automations', json(scheduleInput))).json()) as any).automation;
    const response = await apiRequest(server, `/api/v1/automations/${created.id}`, { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect(changes.at(-1)).toEqual({
      project: 'default',
      automationId: created.id,
      revision: 1,
      deleted: true,
    });
  });
});

function readFileOrEmpty(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}
