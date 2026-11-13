import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AutomationToolService, RunManager } from '../workflows/run.ts';
import type { ProjectContext } from './project-context.ts';
import { AutomationStore } from '../automations/store.ts';
import { WorkspaceAutomationScheduler } from '../automations/scheduler.ts';
import { GithubPoller } from '../automations/github-poller.ts';
import { RunStore } from '../runs/store.ts';
import { Home } from '../home/home.ts';
import { projectPaths } from '../project-paths.ts';
import { registerProject, listProjects } from '../workspace/projects.ts';
import { CockpitOwnership } from './cockpit-ownership.ts';
import { ProjectContexts } from './project-context.ts';
import { createRunner } from '../core/runner-factory.ts';
import { RunnerModelCatalog } from '../core/runner-model-catalog.ts';
import { ProviderAuthService } from '../core/provider-auth.ts';
import { startServer } from './start-server.ts';
import { WorkspaceEventBus } from './server.ts';

const temporary: string[] = [];
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'automation-move-'));
  temporary.push(path);
  return path;
}
function repository(): string {
  const root = directory();
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  execFileSync('git', ['-C', root, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return root;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

it.each(['registered', 'added', 'busy'] as const)('keeps poll and schedule state for a %s project', async (moment) => {
  vi.stubEnv('CEZ_DRY_RUN', '1');
  vi.stubEnv('HSQ_DRY_RUN', '1');
  vi.stubEnv('CEZ_PROJECT_WARMUP', '0');
  vi.stubEnv('HSQ_PROJECT_WARMUP', '0');
  const home = Home.sandbox(directory());
  const root = repository();
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/acme/demo.git']);
  const legacy = join(root, '.ai/cezar');
  mkdirSync(legacy, { recursive: true });
  const runs = RunStore.open(legacy);
  const initial = AutomationStore.open(legacy);
  const stale = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const occurrence = new Date(Date.now() - 180_000).toISOString();
  initial.create({ name: 'Poll', enabled: true, events: ['issue.opened'], intervalSeconds: 300,
    filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'Review {{github.url}}' } }, 'poll');
  initial.setState('poll', () => ({ revision: 1, baselineAt: stale, cursor: { timestamp: stale }, lastSuccessAt: stale, nextCheckAt: stale }));
  initial.create({ name: 'Schedule', kind: 'schedule', enabled: true, schedule: { type: 'daily', hour: 4, minute: 0 },
    task: { prompt: 'Scheduled task' } }, 'schedule');
  initial.setState('schedule', () => ({ revision: 1, nextRunAt: occurrence }));
  const poll = vi.spyOn(GithubPoller.prototype, 'poll').mockResolvedValue({ candidates: [], truncated: false, pages: 1 });
  const manager = { isActive: () => false, startRun: vi.fn(() => runs.createRun({ title: 'scheduled', task: 'Scheduled task', workflow: 'test', steps: [] })) } as unknown as RunManager;
  const bootRoot = repository();
  const boot = await registerProject(bootRoot, undefined, home);
  const bootRuns = RunStore.open(projectPaths(bootRoot).write);
  const ownership = new CockpitOwnership();
  const contexts = new ProjectContexts({ createRunner, home, ownership, listProjects: () => listProjects(undefined, home) });
  vi.spyOn(contexts, 'context').mockImplementation(async id => ({ id, home, root, dataDir: projectPaths(root).write,
    store: runs, manager, automationStore: AutomationStore.open(projectPaths(root).write), launchKey: 'test' }) as ProjectContext);
  let release = moment === 'busy' ? initial.acquireLease() : undefined;
  if (moment !== 'added') await registerProject(root, undefined, home);
  const events = new WorkspaceEventBus();
  const startScheduler = WorkspaceAutomationScheduler.prototype.start;
  const start = vi.spyOn(WorkspaceAutomationScheduler.prototype, 'start').mockImplementation(function (this: InstanceType<typeof WorkspaceAutomationScheduler>) {
    // Preparation already refused the busy move. Release before the scheduler's first fire.
    release?.release();
    release = undefined;
    return startScheduler.call(this);
  });
  const server = startServer({ home, repoRoot: bootRoot, bootProjectId: boot.id, store: bootRuns, manager,
    ownership, contexts, workspaceEvents: events, version: 'test', modelCatalog: new RunnerModelCatalog({ adapters: {} }), detectEnvironment: async () => [],
    providerAuth: new ProviderAuthService({ runCommand: async () => ({ stdout: '', stderr: '', exitCode: 1 }) }) }, 0);
  try {
    if (!server.listening) await once(server, 'listening');
    // bound: the scheduler starts only after all initial project preparation and braking finish.
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1), { timeout: 15_000 });
    if (moment === 'added') {
      const added = await registerProject(root, undefined, home);
      events.emit('project-added', { project: { ...added, root, status: 'ok' } });
    }
    release?.release();
    release = undefined;
    const scheduler = start.mock.contexts[0] as InstanceType<typeof WorkspaceAutomationScheduler>;
    await scheduler.reschedule();
    // bound: schedule completion is signalled by its persisted launched log, after the state write.
    await vi.waitFor(() => expect(AutomationStore.open(projectPaths(root).write).logs({ automationId: 'schedule' })[0]?.result).toBe('launched'), { timeout: 15_000 });
    const current = AutomationStore.open(projectPaths(root).write);
    expect(current.dataDir).toBe(join(root, moment === 'busy' ? '.ai/cezar' : '.ai/squawk'));
    expect(current.logs({ automationId: 'poll' })[0]?.result).toBe('baseline');
    expect(Date.parse(current.state('poll')!.cursor!.timestamp)).toBeGreaterThan(Date.now() - 60_000);
    expect(Date.parse(current.state('schedule')!.nextRunAt!)).toBeGreaterThan(Date.now());
    expect(poll).not.toHaveBeenCalled();
    expect(manager.startRun).toHaveBeenCalledTimes(1);
    // Replay the same occurrence as a restart after a launch/state-write crash would do.
    current.setState('schedule', state => ({ ...state, nextRunAt: occurrence }));
    await scheduler.reschedule();
    // bound: the receipt produces a durable duplicate log once the replay has settled.
    await vi.waitFor(() => expect(AutomationStore.open(projectPaths(root).write).logs({ automationId: 'schedule' })[0]?.result).toBe('duplicate'), { timeout: 15_000 });
    expect(manager.startRun).toHaveBeenCalledTimes(1);
    expect(Date.parse(AutomationStore.open(projectPaths(root).write).state('schedule')!.nextRunAt!)).toBeGreaterThan(Date.now());
  } finally {
    release?.release();
    await new Promise<void>(resolve => server.close(() => resolve()));
    contexts.disposeAll();
    ownership.releaseAll();
    runs.close();
    bootRuns.close();
  }
}, 30_000);

it('replaces a handle opened before a move at lookup and refresh', async () => {
  const { AutomationCoordinator } = await import('../automations/coordinator.ts');
  const { prepareProject } = await import('../project-migration/auto.ts');
  const root = repository();
  mkdirSync(join(root, '.ai/cezar'), { recursive: true });
  const ownership = new CockpitOwnership();
  const coordinator = new AutomationCoordinator({ listProjects: async () => [{ id: 'p', root, status: 'ok' }] });
  const before = coordinator.store('p', root)!;
  const refreshed = new AutomationCoordinator({ listProjects: async () => [{ id: 'p', root, status: 'ok' }] });
  const beforeRefresh = refreshed.store('p', root)!;
  before.create({ name: 'Poll', enabled: false, events: ['issue.opened'], intervalSeconds: 300,
    task: { prompt: 'Review' } }, 'poll');
  before.setState('poll', () => ({ revision: 1, cursor: { timestamp: '2026-01-01T00:00:00.000Z' } }));
  try {
    await prepareProject(root, { ownership, homes: [] });
    await refreshed.refresh();
    expect(refreshed.store('p')).not.toBe(beforeRefresh);
    expect(refreshed.store('p')?.dataDir).toBe(join(root, '.ai/squawk'));
    const after = coordinator.store('p')!;
    expect(after).not.toBe(before);
    expect(after.dataDir).toBe(join(root, '.ai/squawk'));
    expect(after.state('poll')?.cursor).toEqual({ timestamp: '2026-01-01T00:00:00.000Z' });
    after.setState('poll', state => ({ ...state, lastSuccessAt: '2026-02-01T00:00:00.000Z' }));
    await coordinator.refresh();
    expect(coordinator.store('p')).toBe(after);
    expect(AutomationStore.open(projectPaths(root).write).state('poll')?.lastSuccessAt).toBe('2026-02-01T00:00:00.000Z');
  } finally { ownership.releaseAll(); }
});


it('writes boot API state after the move and refuses scheduled-task tools under a fence', async () => {
  const home = Home.sandbox(directory());
  const root = repository();
  const legacy = join(root, '.ai/cezar');
  mkdirSync(legacy, { recursive: true });
  const runs = RunStore.open(legacy);
  const initial = AutomationStore.open(legacy);
  initial.create({ name: 'Boot schedule', kind: 'schedule', enabled: true,
    schedule: { type: 'daily', hour: 4, minute: 0 }, task: { prompt: 'Scheduled task' } }, 'boot-schedule');
  initial.setState('boot-schedule', () => ({ revision: 1, nextRunAt: new Date(Date.now() + 86_400_000).toISOString() }));
  const project = await registerProject(root, undefined, home);
  const ownership = new CockpitOwnership();
  const started = vi.spyOn(WorkspaceAutomationScheduler.prototype, 'start');
  let tools: AutomationToolService | undefined;
  const server = startServer({ home, repoRoot: root, bootProjectId: project.id, store: runs,
    manager: { isActive: () => false, setAutomationTools: (value: AutomationToolService) => { tools = value; } } as unknown as RunManager, ownership, version: 'test',
    modelCatalog: new RunnerModelCatalog({ adapters: {} }), detectEnvironment: async () => [],
    providerAuth: new ProviderAuthService({ runCommand: async () => ({ stdout: '', stderr: '', exitCode: 1 }) }) }, 0);
  try {
    if (!server.listening) await once(server, 'listening');
    // bound: scheduler startup signals that boot preparation and its automatic move finished.
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1), { timeout: 15_000 });
    expect(projectPaths(root).write).toBe(join(root, '.ai/squawk'));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const url = `http://127.0.0.1:${address.port}/api/v1/automations/boot-schedule`;
    const paused = await fetch(`${url}/pause`, { method: 'POST' });
    expect(paused.status).toBe(200);
    await paused.json();
    const disk = AutomationStore.open(join(root, '.ai/squawk'));
    expect(disk.get('boot-schedule')).toMatchObject({ enabled: false, revision: 2 });
    expect(disk.state('boot-schedule')).not.toHaveProperty('nextRunAt');
    expect(existsSync(join(legacy, 'automations.json'))).toBe(false);
    const read = await fetch(url);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ automation: { enabled: false, revision: 2 } });
    expect(tools).toBeDefined();
    const fence = await ownership.fenceProject(projectPaths(root).write, { liveTasks: () => [] });
    try {
      await expect(tools!.scheduledTasks({ action: 'list' })).resolves.toMatchObject({ ok: false, code: 'conflict', message: expect.stringContaining('migration') });
      await expect(tools!.scheduleTask({ name: 'Later', prompt: 'Task', delay: '1h' })).resolves.toMatchObject({ ok: false, code: 'conflict' });
    } finally { fence.release(); }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    ownership.releaseAll();
    runs.close();
  }
}, 30_000);
