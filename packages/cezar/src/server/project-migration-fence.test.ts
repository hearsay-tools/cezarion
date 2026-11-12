import { Home } from '../home/home.ts';
import { testHome, useTestHome } from '../home/test-home.testkit.ts';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activitySnapshotSchema } from '@open-mercato/cezar-contract/activity';
import { makeRunRecord, RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { runsIndexResponseSchema } from '@open-mercato/cezar-contract/workspace-events';
import { runArtifactCommand } from '../artifacts/cli.ts';
import { AutomationStore } from '../automations/store.ts';
import { AutomationCoordinator } from '../automations/coordinator.ts';
import { rebaselineIdleAutomations } from '../automations/task-template.ts';
import { publishArtifact } from '../artifacts/store.ts';
import { CredentialRegistry } from '../delegation/credentials.ts';
import { createDelegationRoutes } from '../delegation/routes.ts';
import { ArchiveOnMergeCoordinator } from './archive-on-merge.ts';
import { ProjectAutomationScheduler, WorkspaceAutomationScheduler } from '../automations/scheduler.ts';
import type { GithubAutomationDefinition } from '../automations/types.ts';
import { hostname } from 'node:os';
import { defaultCliDeps, main, type CliDeps } from '../cli-dispatch.ts';
import { initCommand, openStore } from '../project-commands.ts';
import { createRunner } from '../core/runner-factory.ts';
import { processStartToken } from '../delegation/process-liveness.ts';
import { seedRuns, setRunStatus } from '../runs/run-store.testkit.ts';
import { closeClaimSession, openClaimSession } from '../runs/run-claims.ts';
import { RUNS_DB_FILE, RunDatabase } from '../runs/run-database.ts';
import { RunStore } from '../runs/store.ts';
import { healthConfig } from '../config.ts';
import { defaultServeDeps, serveCommand, type ServeDeps } from '../serve-command.ts';
import type { RunManager } from '../workflows/run.ts';
import { clearProjectProbeCache, registerProject } from '../workspace/projects.ts';
import {
  CockpitAlreadyRunningError, CockpitOwnership, MIGRATION_JOURNAL_FILE, ProjectMigrationBusyError, ProjectMigrationFencedError, assertProjectAdmitted,
  migrationFencePaths, projectAdmissionRefusal,
} from './cockpit-ownership.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { ProjectContexts, projectLiveTasks, sweepRegisteredPreviewLeftovers } from './project-context.ts';
import { createApp } from './server.ts';
import { createWorkspaceProjects } from './workspace-projects.ts';

/**
 * The exclusive project migration fence (hearsay-tools/cezarion#3087): one claim file beside both
 * project directory names, taken through `CockpitOwnership`, refused by every admission point.
 */

const roots: string[] = [];
const owners: CockpitOwnership[] = [];
const disposers: Array<() => void> = [];
const none = { liveTasks: () => [] };

function project() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'cez-fence-'));
  roots.push(root);
  return { root, dataDir: join(root, '.ai/cezar'), legacy: join(root, '.ai/squawk'), ai: join(root, '.ai') };
}

function owner(): CockpitOwnership {
  const created = new CockpitOwnership();
  owners.push(created);
  return created;
}

function contextsFor(ownership: CockpitOwnership | undefined, ...projects: Array<{ id: string; root: string }>): ProjectContexts {
  const contexts = new ProjectContexts({ createRunner, home: testHome(), ownership, rebrand: false,
    listProjects: async () => projects.map(({ id, root }) => ({ id, root, status: 'not-git' as const })) });
  disposers.push(() => contexts.disposeAll());
  return contexts;
}

const fenced = (promise: Promise<unknown>) => expect(promise).rejects.toBeInstanceOf(ProjectMigrationFencedError);

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const created of owners.splice(0)) created.releaseAll();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('one migration owner', () => {
  it('excludes competing CLIs, cockpit boot and lazy contexts under both names, through the move, until release', async () => {
    const { root, dataDir, legacy } = project();
    const migrator = owner();
    // No cockpit owns the project: the CLI takes the ownership lock itself.
    const fence = await migrator.fenceProject(dataDir, none);
    expect(fence.lock).toBe(join(root, '.ai/squawk-migration.lock'));
    expect(JSON.parse(readFileSync(join(dataDir, 'cockpit.lock'), 'utf8')).pid).toBe(process.pid);
    const contexts = contextsFor(owner(), { id: 'p', root });
    const everyEntry = async () => {
      for (const directory of [dataDir, legacy]) {
        await fenced(owner().fenceProject(directory, none));
        await fenced(owner().acquire(directory));
      }
      await fenced(contexts.context('p'));
    };
    await everyEntry();
    // P4b2 moves the directory under the fence; the moved cockpit.lock never makes a second owner.
    renameSync(dataDir, legacy);
    await everyEntry();
    expect(existsSync(dataDir)).toBe(false);
    mkdirSync(dataDir);
    await everyEntry();
    rmdirSync(dataDir);
    // Still exclusive while later rewrites run: only release reopens the project.
    await Promise.resolve();
    expect(projectAdmissionRefusal(dataDir)?.reason).toBe('migrating');
    fence.release();
    expect(existsSync(fence.lock)).toBe(false);
    expect(projectAdmissionRefusal(dataDir)).toBeUndefined();
    // The moved claim still names the live migrator: boot meets P4a's fallback-owner check.
    await expect(owner().acquire(dataDir)).rejects.toBeInstanceOf(CockpitAlreadyRunningError);
    expect(contexts.ids()).toEqual([]);
  });

  it('resumes after the move without recreating the old name; the journal blocks everyone else', async () => {
    const { ai, dataDir, legacy } = project();
    mkdirSync(legacy, { recursive: true });
    const journal = join(ai, MIGRATION_JOURNAL_FILE);
    writeFileSync(journal, '{}');
    const refusal = projectAdmissionRefusal(dataDir);
    expect(refusal?.reason).toBe('journal');
    expect(refusal?.message).toContain(journal);
    expect(refusal?.message).toContain('binary that migrated the project');
    const fence = await owner().fenceProject(dataDir, none);
    expect(existsSync(dataDir)).toBe(false);
    expect(existsSync(join(legacy, 'cockpit.lock'))).toBe(true);
    fence.release();
    expect(projectAdmissionRefusal(legacy)?.reason).toBe('journal');
    await fenced(owner().acquire(dataDir));
    expect(existsSync(dataDir)).toBe(false);
  });

  it('reclaims a dead owner conservatively and writes nothing while dormant', async () => {
    const { ai, dataDir } = project();
    mkdirSync(ai);
    const child = spawnSync(process.execPath, ['-e', ''], { timeout: 5_000 });
    expect(child.status).toBe(0);
    const dead = JSON.stringify({ pid: child.pid, token: randomUUID() });
    const lock = migrationFencePaths(dataDir)!.lock;
    writeFileSync(lock, dead);
    writeFileSync(`${lock}.reclaim`, dead);
    const before = readdirSync(ai).sort();
    expect(projectAdmissionRefusal(dataDir)).toBeUndefined();
    assertProjectAdmitted(dataDir);
    expect(readdirSync(ai).sort()).toEqual(before);
    expect(readFileSync(lock, 'utf8')).toBe(dead);
    const fence = await owner().fenceProject(dataDir, none);
    expect(JSON.parse(readFileSync(lock, 'utf8')).pid).toBe(process.pid);
    expect(existsSync(`${lock}.reclaim`)).toBe(false);
    fence.release();
    // A project without any fence: nothing is created by admission.
    const quiet = project();
    assertProjectAdmitted(quiet.dataDir);
    expect(readdirSync(quiet.root)).toEqual([]);
    expect(migrationFencePaths(join(quiet.root, 'fixture-data'))).toBeUndefined();
  });

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')('treats a reused PID with another start identity as gone', async () => {
    const { ai, dataDir } = project();
    mkdirSync(ai);
    const startToken = processStartToken(process.pid);
    expect(startToken).toBeTruthy();
    writeFileSync(migrationFencePaths(dataDir)!.lock, JSON.stringify({ pid: process.pid, token: randomUUID(), startToken: `${startToken}0` }));
    expect(projectAdmissionRefusal(dataDir)).toBeUndefined();
    (await owner().fenceProject(dataDir, none)).release();
  });

  it('refuses an unreadable lock with its path and when it is safe to remove, and keeps it unchanged', async () => {
    const { ai, dataDir } = project();
    mkdirSync(ai);
    const lock = migrationFencePaths(dataDir)!.lock;
    writeFileSync(lock, '{"schema":"from a newer binary"}');
    const refusal = projectAdmissionRefusal(dataDir);
    expect(refusal?.reason).toBe('unreadable');
    expect(refusal?.message).toContain(lock);
    expect(refusal?.message).toContain('Remove the file only if no migration runs for this project');
    await fenced(owner().fenceProject(dataDir, none));
    await fenced(owner().acquire(dataDir));
    expect(existsSync(dataDir)).toBe(false);
    expect(readFileSync(lock, 'utf8')).toBe('{"schema":"from a newer binary"}');
  });

  it('releases only its own claim and leaves unrelated projects available', async () => {
    const { root, dataDir } = project();
    const free = project();
    const first = owner();
    const fence = await first.fenceProject(dataDir, none);
    const successor = { pid: process.pid, token: randomUUID(), startToken: processStartToken(process.pid) };
    writeFileSync(fence.lock, JSON.stringify(successor));
    fence.release();
    first.releaseAll();
    expect(JSON.parse(readFileSync(fence.lock, 'utf8')).token).toBe(successor.token);
    expect(projectAdmissionRefusal(dataDir)?.reason).toBe('migrating');
    assertProjectAdmitted(free.dataDir);
    await owner().acquire(free.dataDir);
    const contexts = contextsFor(undefined, { id: 'fenced', root }, { id: 'free', root: free.root });
    await fenced(contexts.context('fenced'));
    expect((await contexts.context('free')).dataDir).toBe(free.dataDir);
  });
});

describe('the write backstop', () => {
  it('skips every write of an open store while another process fences its project, then writes after', async () => {
    const { dataDir } = project();
    const id = randomUUID();
    seedRuns(dataDir, [makeRunRecord({ id, title: 'referenced', status: RUN_STATUS.done, referencedPullRequestUrl: 'https://github.com/other/elsewhere/pull/3' })]);
    // A headless `cez run` opened its store before another process took the fence.
    const store = RunStore.open(dataDir, { retryBusy: true });
    disposers.push(() => store.close());
    const early = store.createRun({ title: 'before', workflow: 'w', task: 't', steps: [] });
    store.flush();
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const startToken = processStartToken(other.pid!);
      writeFileSync(migrationFencePaths(dataDir)!.lock, JSON.stringify({ pid: other.pid, token: randomUUID(), ...(startToken ? { startToken } : {}) }));
      const stored = () => {
        const db = RunDatabase.openReadOnly(join(dataDir, RUNS_DB_FILE))!;
        try { return { referenced: db.get(id)?.data.includes('other/elsewhere'), claims: db.listClaims().length, title: db.get(early.id)?.data.match(/"title":"(\w+)"/)?.[1] }; }
        finally { db.close(); }
      };
      // The delayed repository discovery repairs the foreign reference: nothing reaches the project.
      store.setRepoHandle({ owner: 'acme', name: 'demo' });
      // A family claimed before the fence: its debounced save is skipped and kept.
      store.updateRun(early.id, { title: 'during' });
      store.flush();
      // A new family cannot be claimed: the start is refused and writes nothing.
      expect(() => store.createRun({ title: 'late', workflow: 'w', task: 't', steps: [] })).toThrow();
      expect(stored()).toEqual({ referenced: true, claims: 1, title: 'before' });
      expect(warn.mock.calls.filter(([line]) => String(line).includes('was skipped'))).toHaveLength(1);
      const exited = once(other, 'exit');
      other.kill('SIGKILL');
      await exited;
      store.flush();
      expect(stored().title).toBe('during');
    } finally {
      warn.mockRestore();
      if (other.exitCode === null && other.signalCode === null) other.kill('SIGKILL');
    }
  });
});

describe('the write backstop over automation and artifact files', () => {
  it('drops the writes of a poll that was waiting on the network when another owner took the fence', async () => {
    const { dataDir } = project();
    const store = AutomationStore.open(dataDir);
    const definition = store.create({ name: 'Issues', enabled: true, events: ['issue.opened'], intervalSeconds: 300,
      filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'Review' } }, 'issues') as GithubAutomationDefinition;
    let resume!: () => void;
    const network = new Promise<void>((resolve) => { resume = resolve; });
    let parked!: () => void;
    const polling = new Promise<void>((resolve) => { parked = resolve; });
    const poller = { poll: async () => { parked(); await network; return { candidates: [], truncated: false, pages: 1 }; }, matchesCurrentLabels: async () => true };
    // A cockpit that does not own the project polls it (no lease of the owner's process).
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: poller as never }, launch: vi.fn() });
    const files = () => readdirSync(dataDir).filter((name) => name.startsWith('automation') && !name.endsWith('.lock')).sort().map((name) => [name, readFileSync(join(dataDir, name), 'utf8')]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const check = scheduler.check(definition).catch((error: unknown) => error);
      await polling;
      const before = files();
      const fence = await owner().fenceProject(dataDir, none);
      resume();
      await check;
      expect(files()).toEqual(before);
      expect(warn.mock.calls.some(([line]) => String(line).includes('was skipped'))).toBe(true);
      fence.release();
      store.setState(definition.id, (current) => ({ ...current, lastSuccessAt: '2026-11-10T00:00:00.000Z' }));
      expect(files()).not.toEqual(before);
    } finally { warn.mockRestore(); }
  });

  it('refuses an admitted timer fire once a fence of another process holds the project', async () => {
    const { root, dataDir } = project();
    const store = AutomationStore.open(dataDir);
    const definition = store.create({ name: 'Issues', enabled: true, events: ['issue.opened'], intervalSeconds: 300,
      filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'Review' } }, 'issues');
    store.setState(definition.id, (current) => ({ ...current, nextCheckAt: '2026-01-01T00:00:00.000Z' }));
    let resume!: () => void;
    const network = new Promise<void>((resolve) => { resume = resolve; });
    let parked!: () => void;
    const polling = new Promise<void>((resolve) => { parked = resolve; });
    const poller = { poll: async () => { parked(); await network; return { candidates: [], truncated: false, pages: 1 }; }, matchesCurrentLabels: async () => true };
    const coordinator = new AutomationCoordinator({ listProjects: async () => [{ id: 'p', root, status: 'not-git' }] });
    const refreshed = vi.spyOn(coordinator, 'refresh');
    // The production wrapper: the fire holds this process's lease while it waits on the network.
    const scheduler = new WorkspaceAutomationScheduler({
      coordinator, handle: (_projectId, automations) => ({ projectId: 'p', store: automations, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: poller as never }, launch: vi.fn() }),
    });
    const files = () => readdirSync(dataDir).filter((name) => name.startsWith('automation') && !name.endsWith('.lock')).sort().map((name) => [name, readFileSync(join(dataDir, name), 'utf8')]);
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await scheduler.start();
      await polling;
      const before = files();
      // Another process (the owning cockpit) takes and drains its fence: it cannot see this lease.
      const startToken = processStartToken(other.pid!);
      writeFileSync(migrationFencePaths(dataDir)!.lock, JSON.stringify({ pid: other.pid, token: randomUUID(), ...(startToken ? { startToken } : {}) }));
      const calls = refreshed.mock.calls.length;
      const setState = vi.spyOn(AutomationStore.prototype, 'setState');
      resume();
      // bound: hang guard; the fire has ended when the scheduler re-arms through refresh.
      await vi.waitFor(() => expect(refreshed.mock.calls.length).toBeGreaterThan(calls), { timeout: 5_000 });
      // The success write was refused (thrown), the error path recorded no failure or backoff,
      // the rejection was the scheduler's (no unhandled rejection), and nothing was written.
      expect(setState.mock.results.some((result) => result.type === 'throw' && result.value instanceof ProjectMigrationFencedError)).toBe(true);
      expect(setState.mock.results.filter((result) => result.type === 'return')).toEqual([]);
      // The refusal is a skip, not a failure: recordFailure never tries its write.
      expect(setState).toHaveBeenCalledTimes(1);
      expect(files()).toEqual(before);
      setState.mockRestore();
    } finally {
      scheduler.stop();
      warn.mockRestore();
      other.kill('SIGKILL');
    }
  });

  it('records nothing when a schedule fire meets another process\'s fence while its launch returns', async () => {
    const { root, dataDir } = project();
    const store = AutomationStore.open(dataDir);
    store.create({ name: 'Nightly', enabled: true, kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 }, task: { prompt: 'Bump deps' } }, 'nightly');
    store.setState('nightly', (current) => ({ ...current, nextRunAt: new Date(Date.now() - 1_000).toISOString() }));
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    let parked!: () => void;
    const launching = new Promise<void>((resolve) => { parked = resolve; });
    const launchSchedule = vi.fn(async () => {
      parked();
      await gate;
      return { runId: 'nightly-run' };
    });
    const coordinator = new AutomationCoordinator({ listProjects: async () => [{ id: 'p', root, status: 'not-git' }] });
    const refreshed = vi.spyOn(coordinator, 'refresh');
    const scheduler = new WorkspaceAutomationScheduler({ coordinator, handle: (_projectId, automations) => ({ projectId: 'p', store: automations, timeZone: 'UTC', launchSchedule }) });
    const files = () => readdirSync(dataDir).filter((name) => name.startsWith('automation') && !name.endsWith('.lock')).sort().map((name) => [name, readFileSync(join(dataDir, name), 'utf8')]);
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await scheduler.start();
      await launching;
      const before = files();
      const startToken = processStartToken(other.pid!);
      writeFileSync(migrationFencePaths(dataDir)!.lock, JSON.stringify({ pid: other.pid, token: randomUUID(), ...(startToken ? { startToken } : {}) }));
      const calls = refreshed.mock.calls.length;
      resume();
      // bound: hang guard; the fire has ended when the scheduler re-arms through refresh.
      await vi.waitFor(() => expect(refreshed.mock.calls.length).toBeGreaterThan(calls), { timeout: 5_000 });
      expect(files()).toEqual(before);
    } finally {
      scheduler.stop();
      warn.mockRestore();
      other.kill('SIGKILL');
    }
  });

  it('keeps a boot rebaseline going when another process fences a project', async () => {
    const { dataDir } = project();
    const store = AutomationStore.open(dataDir);
    const definition = store.create({ name: 'Issues', enabled: true, events: ['issue.opened'], intervalSeconds: 300,
      filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'Review' } }, 'issues');
    // Idle long enough that the boot brake re-baselines it.
    store.setState(definition.id, (current) => ({ ...current, lastSuccessAt: '2026-01-01T00:00:00.000Z', baselineAt: '2026-01-01T00:00:00.000Z' }));
    const before = readFileSync(join(dataDir, 'automation-state.json'), 'utf8');
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const startToken = processStartToken(other.pid!);
      writeFileSync(migrationFencePaths(dataDir)!.lock, JSON.stringify({ pid: other.pid, token: randomUUID(), ...(startToken ? { startToken } : {}) }));
      expect(rebaselineIdleAutomations(store)).toBe(0);
      expect(readFileSync(join(dataDir, 'automation-state.json'), 'utf8')).toBe(before);
    } finally {
      warn.mockRestore();
      other.kill('SIGKILL');
    }
  });

  it('takes no automation lock or reclaim guard while another owner fences the project', async () => {
    const { dataDir } = project();
    const store = AutomationStore.open(dataDir);
    const definition = store.create({ name: 'Issues', enabled: true, events: ['issue.opened'], intervalSeconds: 300,
      filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'Review' } }, 'issues');
    // A stale reclaim guard would make the next lock attempt create its own guard and owner file.
    mkdirSync(join(dataDir, 'automation-log.reclaim'), { recursive: true });
    const fence = await owner().fenceProject(dataDir, none);
    const before = readdirSync(dataDir).sort();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(store.acquireLease()).toBeUndefined();
      await store.appendLog({ automationId: definition.id, revision: definition.revision, result: 'skipped', reason: 'fenced' });
      expect(readdirSync(dataDir).sort()).toEqual(before);
      expect(readdirSync(join(dataDir, 'automation-log.reclaim'))).toEqual([]);
    } finally {
      warn.mockRestore();
      fence.release();
    }
  });

  it('refuses automation definition and state writes before memory changes, and logs the first skip of every fence', async () => {
    const { dataDir } = project();
    const store = AutomationStore.open(dataDir);
    const definition = store.create({ name: 'Issues', enabled: true, events: ['issue.opened'], intervalSeconds: 300,
      filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'Review' } }, 'issues');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const skips = () => warn.mock.calls.filter(([line]) => String(line).includes('was skipped')).length;
    const migrator = owner();
    try {
      for (const round of [1, 2]) {
        const before = { state: store.state(definition.id), list: store.list().map((item) => item.id) };
        const fence = await migrator.fenceProject(dataDir, none);
        expect(() => store.setState(definition.id, (current) => ({ ...current, lastSuccessAt: `2026-11-10T00:0${round}:00.000Z` }))).toThrow(ProjectMigrationFencedError);
        expect(() => store.create({ name: 'Late', enabled: true, events: ['issue.opened'], intervalSeconds: 300,
          filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'Late' } }, `late-${round}`)).toThrow(ProjectMigrationFencedError);
        expect({ state: store.state(definition.id), list: store.list().map((item) => item.id) }).toEqual(before);
        expect(skips()).toBe(round);
        fence.release();
        // Admitted again: the write lands and the marker clears, so the next fence logs once more.
        store.setState(definition.id, (current) => ({ ...current, lastSuccessAt: `2026-11-10T01:0${round}:00.000Z` }));
        expect(store.state(definition.id)?.lastSuccessAt).toBe(`2026-11-10T01:0${round}:00.000Z`);
      }
    } finally { warn.mockRestore(); }
  });

  it('leaves the publication lock candidate in place when the fence comes while the lock is awaited', async () => {
    const { root, dataDir } = project();
    const task = randomUUID();
    const directory = join(dataDir, 'runs', `${task}-artifacts`);
    mkdirSync(join(directory, '.publish.lock'), { recursive: true });
    // A live publisher holds the lock, so this one waits in its retry loop.
    writeFileSync(join(directory, '.publish.lock', 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname() }));
    writeFileSync(join(root, 'report.html'), '<p>report</p>');
    const publishing = publishArtifact(directory, task, join(root, 'report.html')).then(() => undefined, (error: unknown) => error);
    // bound: hang guard while the publisher creates its lock candidate.
    await vi.waitFor(() => expect(readdirSync(directory).some((name) => name.startsWith('.lock-candidate-'))).toBe(true), { timeout: 5_000 });
    const fence = await owner().fenceProject(dataDir, none);
    expect(await publishing).toBeInstanceOf(ProjectMigrationFencedError);
    expect(readdirSync(directory).filter((name) => name.startsWith('.lock-candidate-'))).toHaveLength(1);
    expect(readFileSync(join(directory, '.publish.lock', 'owner.json'), 'utf8')).toContain(String(process.pid));
    fence.release();
  });
});

describe('health while fenced', () => {
  it('answers the last config read without reading the project', async () => {
    const { root, dataDir } = project();
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ maxParallel: 3 }));
    expect((await healthConfig(root, testHome())).maxParallel).toBe(3);
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ maxParallel: 5 }));
    const fence = await owner().fenceProject(dataDir, none);
    expect((await healthConfig(root, testHome())).maxParallel).toBe(3);
    fence.release();
    expect((await healthConfig(root, testHome())).maxParallel).toBe(5);
  });
});

describe('with the release switch off', () => {
  it('offers no migration command and a normal project build writes no fence or journal', async () => {
    vi.resetModules();
    vi.doMock('../home/switch.ts', () => ({ REBRAND_SWITCH: false }));
    try {
      const { SUBCOMMAND_NAMES: names, loadSubcommand: load } = await import('../subcommands.ts');
      const { ProjectContexts: SwitchOffContexts } = await import('./project-context.ts');
      expect(names.includes('migrate-project')).toBe(false);
      expect(await load('migrate-project', undefined, false)).toBeUndefined();
      const { ai, root } = project();
      const contexts = new SwitchOffContexts({ createRunner, home: testHome(), ownership: owner(), rebrand: false,
        listProjects: async () => [{ id: 'p', root, status: 'not-git' as const }] });
      disposers.push(() => contexts.disposeAll());
      await contexts.context('p');
      expect(readdirSync(ai)).toEqual(['cezar']);
    } finally {
      vi.doUnmock('../home/switch.ts');
      vi.resetModules();
    }
  });
});

describe('the live-task check under the fence', () => {
  function cockpitStore() {
    const { root, dataDir } = project();
    const store = RunStore.open(dataDir, { keepLive: true });
    disposers.push(() => store.close());
    const create = (title: string) => store.createRun({ title, workflow: 'w', task: 't', steps: [] }).id;
    return { root, dataDir, store, create };
  }

  it('refuses to fence while any task is live, lists each one, and releases the fence at once', async () => {
    const { dataDir, store, create } = cockpitStore();
    const cockpit = owner();
    await cockpit.acquire(dataDir);
    const queued = create('queued start');
    const running = create('running');
    setRunStatus(store, running, RUN_STATUS.running);
    const human = create('parked on a human');
    setRunStatus(store, human, RUN_STATUS.waiting);
    const usage = create('usage-limit hold');
    setRunStatus(store, usage, RUN_STATUS.waiting, { autoResumeAt: '2026-11-10T00:00:00.000Z' });
    setRunStatus(store, create('finished'), RUN_STATUS.done);
    // Another process's store (a headless `cez run`) running a task in the same database.
    const other = RunStore.open(dataDir, { keepLive: true });
    const headless = other.createRun({ title: 'headless', workflow: 'w', task: 't', steps: [] }).id;
    setRunStatus(other, headless, RUN_STATUS.running);
    other.flush();
    const refusal = await cockpit.fenceProject(dataDir, { liveTasks: () => projectLiveTasks(store) }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ProjectMigrationBusyError);
    const busy = refusal as ProjectMigrationBusyError;
    expect(new Map(busy.tasks.map((task) => [task.id, task.state]))).toEqual(new Map([
      [queued, 'queued'], [running, 'running'], [human, 'waiting'],
      [usage, 'waiting, usage-limit auto-resume'], [headless, 'running'],
    ]));
    expect(busy.message).toContain('Finish or cancel each one');
    expect(busy.message).toContain(`${usage} usage-limit hold`);
    expect(projectAdmissionRefusal(dataDir)).toBeUndefined();
    other.close();
  });

  it('refuses a task another owner left live after the cockpit opened', async () => {
    const { root, dataDir } = project();
    // Another process (a headless `cez run`) owns a queued task while the cockpit opens.
    const other = RunStore.open(dataDir, { keepLive: true });
    const theirs = other.createRun({ title: 'left queued', workflow: 'w', task: 't', steps: [] }).id;
    other.flush();
    const cockpit = owner();
    const ctx = await contextsFor(cockpit, { id: 'p', root }).context('p');
    // That owner ends: its row is no longer claimed by a live process and this store never held it.
    other.close();
    const refusal = await cockpit.fenceProject(ctx.dataDir, { liveTasks: () => projectLiveTasks(ctx.store) }).catch((error: unknown) => error);
    expect((refusal as ProjectMigrationBusyError).tasks).toEqual([{ id: theirs, title: 'left queued', state: 'queued' }]);
    expect(projectAdmissionRefusal(dataDir)).toBeUndefined();
  });

  it('refuses a family whose fallback claim is live while a stale legacy claim shadows it', async () => {
    const { root, dataDir, legacy } = project();
    const id = randomUUID();
    const record = makeRunRecord({ id, title: 'finalizing elsewhere', status: RUN_STATUS.done });
    seedRuns(dataDir, [record]);
    seedRuns(legacy, [record]);
    const child = spawnSync(process.execPath, ['-e', ''], { timeout: 5_000 });
    const claim = (directory: string, owner: { session: string; pid: number; startToken: string | null }) => {
      const db = RunDatabase.open(join(directory, RUNS_DB_FILE));
      try { db.takeClaims(owner, [{ family: id, expect: null }]); } finally { db.close(); }
    };
    claim(dataDir, { session: randomUUID(), pid: child.pid!, startToken: null });
    // The binary that migrated the project still finishes that family in `.ai/squawk/`.
    const fallbackOwner = openClaimSession();
    claim(legacy, fallbackOwner);
    try {
      const cockpit = owner();
      const ctx = await contextsFor(cockpit, { id: 'p', root }).context('p');
      const refusal = await cockpit.fenceProject(ctx.dataDir, { liveTasks: () => projectLiveTasks(ctx.store) }).catch((error: unknown) => error);
      expect((refusal as ProjectMigrationBusyError).tasks).toEqual([{ id, title: 'finalizing elsewhere', state: 'done' }]);
      expect(projectAdmissionRefusal(dataDir)).toBeUndefined();
    } finally { closeClaimSession(fallbackOwner.session); }
  });

  it('skips an automation timer that meets the fence without recording anything, then fires it after release', async () => {
    const { dataDir } = project();
    const store = AutomationStore.open(dataDir);
    store.create({ name: 'Nightly', enabled: true, kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 }, task: { prompt: 'Bump deps' } }, 'nightly');
    const at = '2026-09-14T04:00:00.000Z';
    store.setState('nightly', (current) => ({ ...current, nextRunAt: at }));
    const before = { state: store.state('nightly'), receipts: [...store.latestReceipts().values()], logs: store.logs({ automationId: 'nightly' }) };
    const fence = await owner().fenceProject(dataDir, none);
    const launchSchedule = vi.fn(async () => ({ runId: 'nightly-run' }));
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-09-14T04:00:01Z'));
    const scheduler = new WorkspaceAutomationScheduler({
      coordinator: { refresh: async () => undefined, enabledProjectIds: () => ['p'], store: () => store, hasProjects: () => true } as never,
      handle: () => ({ projectId: 'p', store, timeZone: 'UTC', launchSchedule }),
      now: () => Date.now(),
    });
    try {
      await scheduler.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(launchSchedule).not.toHaveBeenCalled();
      expect({ state: store.state('nightly'), receipts: [...store.latestReceipts().values()], logs: store.logs({ automationId: 'nightly' }) }).toEqual(before);
      fence.release();
      await vi.advanceTimersByTimeAsync(61_000);
      expect(launchSchedule).toHaveBeenCalledTimes(1);
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it('defers an automation occurrence through a cockpit restart and runs it exactly once after release', async () => {
    const { root, dataDir } = project();
    const seeded = AutomationStore.open(dataDir);
    seeded.create({ name: 'Nightly', enabled: true, kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 }, task: { prompt: 'Bump deps' } }, 'nightly');
    seeded.setState('nightly', (current) => ({ ...current, nextRunAt: '2026-09-14T04:00:00.000Z' }));
    const files = () => readdirSync(dataDir).filter((name) => name.startsWith('automation') && !name.endsWith('.lock')).sort().map((name) => [name, readFileSync(join(dataDir, name), 'utf8')]);
    const before = files();
    const migrator = owner();
    const fence = await migrator.fenceProject(dataDir, none);
    const launchSchedule = vi.fn(async () => ({ runId: 'nightly-run' }));
    const warn = vi.fn();
    const cockpit = () => new WorkspaceAutomationScheduler({
      coordinator: new AutomationCoordinator({ listProjects: async () => [{ id: 'p', root, status: 'not-git' }], warn }),
      handle: (_projectId, store) => ({ projectId: 'p', store, timeZone: 'UTC', launchSchedule }),
      now: () => Date.now(),
    });
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-09-14T04:00:01Z'));
    const first = cockpit();
    try {
      await first.start();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(launchSchedule).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('deferred until its migration ends'));
      expect(files()).toEqual(before);
    } finally { first.stop(); }
    // The cockpit stops while the migration still runs, then the migration ends.
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    fence.release();
    migrator.releaseAll();
    const second = cockpit();
    try {
      await second.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(launchSchedule).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
      expect(launchSchedule).toHaveBeenCalledTimes(1);
    } finally {
      second.stop();
      vi.useRealTimers();
    }
  });

  it('never refuses an automatic resume of a run that is already live', async () => {
    const { root, dataDir } = project();
    const cockpit = owner();
    const contexts = contextsFor(cockpit, { id: 'p', root });
    const ctx = await contexts.context('p');
    const held = ctx.store.createRun({ title: 'usage-limit hold', workflow: 'w', task: 't', steps: [] }).id;
    setRunStatus(ctx.store, held, RUN_STATUS.waiting, { autoResumeAt: '2026-11-10T00:00:00.000Z' });
    const finished = ctx.store.createRun({ title: 'finished', workflow: 'w', task: 't', steps: [] }).id;
    setRunStatus(ctx.store, finished, RUN_STATUS.done);
    // The preflight refuses a fence over live work; this one is taken without it, as in a race.
    const fence = await cockpit.fenceProject(dataDir, none);
    try {
      expect(ctx.manager.continueRun(finished).error).toContain('project migration');
      const pin = vi.spyOn(ctx.store, 'pin').mockReturnValue(undefined);
      expect(ctx.manager.continueRun(held, { text: 'resume' }, true).error ?? '').not.toContain('project migration');
      pin.mockRestore();
      expect(ctx.store.getRun(held)?.autoResumeAt).toBe('2026-11-10T00:00:00.000Z');
    } finally { fence.release(); }
  });

});

describe('admission sweep', () => {
  const savedHome = process.env.CEZ_HOME;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  beforeEach(() => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-fence-home-'));
    roots.push(home);
    useTestHome(Home.sandbox(home));
    process.env.CEZ_DRY_RUN = '1';
    clearProjectProbeCache();
  });
  afterEach(() => {
    if (savedHome === undefined) useTestHome(undefined);
    else useTestHome(savedHome ? Home.sandbox(savedHome) : undefined);
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  /**
   * Every admission point reachable in one process, against two fenced projects: `owned` is fenced
   * by its owning cockpit (built context, boot project of the app), `cold` by a CLI that took the
   * ownership lock itself. Each probe answers whether the point refused or skipped; an admitted
   * point fails the sweep.
   */
  it('refuses or skips at every reachable admission point while a fence is held, and admits after release', async () => {
    const owned = project(), cold = project(), free = project();
    const record = (id: string) => makeRunRecord({ id, title: id, status: RUN_STATUS.done, createdAt: '2026-11-01T10:00:00.000Z' });
    seedRuns(owned.dataDir, [record('owned-run')]);
    seedRuns(cold.dataDir, [record('cold-run')]);
    seedRuns(free.dataDir, [record('free-run')]);
    const [ownedId, coldId, freeId] = await Promise.all([owned, cold, free].map(async ({ root }) => { return (await registerProject(root, undefined, testHome())).id; }));
    const cockpit = owner();
    await cockpit.acquire(owned.dataDir);
    cockpit.publishUrl('http://127.0.0.1:4321');
    const contexts = contextsFor(cockpit, { id: ownedId!, root: owned.root });
    const ctx = await contexts.context(ownedId!);
    const app = createApp({ home: testHome(), repoRoot: owned.root, store: ctx.store, manager: ctx.manager, ownership: cockpit, version: '0.0.0-test' });
    const migrator = owner();
    const fences = [await cockpit.fenceProject(ctx.dataDir, { liveTasks: () => projectLiveTasks(ctx.store) }), await migrator.fenceProject(cold.dataDir, none)];
    const leftover = join(cold.dataDir, 'preview', 'run-x', '3000.pid.json');
    mkdirSync(join(cold.dataDir, 'preview', 'run-x'), { recursive: true });
    writeFileSync(leftover, '{}');
    const lazy = contextsFor(owner(), { id: coldId!, root: cold.root });
    const lazyContext = vi.spyOn(lazy, 'context');
    const cli = (args: string[], env: Record<string, string> = {}) => {
      const deps = { ...defaultCliDeps, process: { argv: ['/bin/node', '/bin/cez', ...args, '--repo', cold.root], env: {}, cwd: () => cold.root, exitCode: undefined as number | undefined },
        console: { log: vi.fn(), error: vi.fn() }, productEnv: (name: string) => env[name], resolveCliHome: () => testHome(), prepareOperatorHome: () => testHome(),
        runSubcommand: vi.fn().mockResolvedValue(undefined), getRepoInfo: vi.fn().mockResolvedValue(null),
        runProjectsCommand: vi.fn().mockResolvedValue(0), readOwnVersion: () => '1.2.3', serveCommand: vi.fn(), serverCommand: vi.fn(),
        runCommand: vi.fn().mockResolvedValue(undefined), initCommand: vi.fn(), initWorkspace: vi.fn().mockResolvedValue(coldId) };
      return main(deps as unknown as CliDeps).then(() => [deps.runCommand, deps.initCommand, deps.initWorkspace].every((spy) => spy.mock.calls.length === 0), (error) => error instanceof ProjectMigrationFencedError);
    };
    const serveListener = vi.fn().mockRejectedValue(new Error('listener reached'));
    const serve = () => serveCommand(testHome(), cold.root, 0, false, undefined, false,
      { ...defaultServeDeps, acquireServeListener: serveListener, process: new EventEmitter() } as unknown as ServeDeps)
      .then(() => false, (error: Error) => error instanceof ProjectMigrationFencedError && !error.message.includes('\n') && serveListener.mock.calls.length === 0);
    const route = async (path: string) => { return (await apiRequest(app, path)).status; };
    const indexIds = async () => runsIndexResponseSchema.parse(await (await apiRequest(app, '/api/v1/workspace/runs-index')).json()).runs.map((run) => run.id);
    const activity = async () => activitySnapshotSchema.parse(await (await apiRequest(app, '/api/v1/workspace/activity')).json())
      .projects.find((entry) => entry.projectId === ownedId);
    const maintenanceWork = vi.fn(async () => 'maintained');
    const finiteRead = async () => {
      const response = await apiRequest(app, '/api/v1/workspace/run-event-batches', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runs: [{ projectId: ownedId, runId: 'owned-run', afterSeq: 0 }] }) });
      return ((await response.json()) as { results: Array<{ type: string; status?: number }> }).results[0];
    };
    const automations = new AutomationCoordinator({ listProjects: async () => [{ id: coldId!, root: cold.root, status: 'not-git' }] });
    writeFileSync(join(cold.dataDir, 'automations.json'), '{"version":1,"automations":[]}');
    const live = createWorkspaceProjects({ bootRoot: owned.root, bootProjectId: ownedId, home: testHome() });
    live.bindContexts(ctx, lazy);
    const artifactError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const probes: Record<string, () => Promise<boolean>> = {
      'cockpit boot claim': () => { return owner().acquire(cold.dataDir).then(() => false, (error) => error instanceof ProjectMigrationFencedError); },
      'serve: one-line refusal before the listener': serve,
      'built lazy context': () => { return contexts.context(ownedId!).then(() => false, (error) => error instanceof ProjectMigrationFencedError); },
      'cold lazy context and recovery': () => { return lazy.context(coldId!).then(() => false, (error) => error instanceof ProjectMigrationFencedError); },
      'background warm-up': async () => { lazyContext.mockClear(); return (await lazy.warmAll([{ id: coldId!, root: cold.root, status: 'not-git' }])).length === 0 && lazyContext.mock.calls.length === 0; },
      'maintenance over a built context': async () => { return (await contexts.withMaintenanceStore(ownedId!, maintenanceWork)) === undefined && maintenanceWork.mock.calls.length === 0; },
      'cold maintenance': async () => { return (await lazy.withMaintenanceStore(coldId!, maintenanceWork)) === undefined && maintenanceWork.mock.calls.length === 0; },
      'registered preview sweep': async () => { return (await sweepRegisteredPreviewLeftovers([{ root: cold.root }], undefined)) === 0 && existsSync(leftover); },
      'boot project route': async () => { return (await route('/api/v1/runs')) === 409; },
      'lazy project route': async () => { return (await route(`/api/v1/p/${coldId}/runs`)) === 409; },
      'workspace runs index (owned and cold reads)': async () => { const ids = await indexIds(); return !ids.includes('owned-run') && !ids.includes('cold-run'); },
      'workspace activity': async () => { return (await activity())?.unavailable?.status === 409; },
      'socket upgrade (boot)': async () => { return (await live.lookupProject(ownedId)) === undefined; },
      'socket upgrade (lazy)': async () => { return (await live.lookupProject(coldId)) === undefined; },
      'live feed (boot)': () => { return live.resolveLiveProject(ownedId!).then(() => false, (error) => error instanceof ProjectMigrationFencedError); },
      'live feed (lazy)': () => { return live.resolveLiveProject(coldId!).then(() => false, (error) => error instanceof ProjectMigrationFencedError); },
      'task start': async () => { try { ctx.manager.startRun({} as Parameters<RunManager['startRun']>[0], { task: 'x' } as Parameters<RunManager['startRun']>[1]); return false; } catch (error) { return error instanceof ProjectMigrationFencedError; } },
      'task continue and recovery continuation': async () => { return ctx.manager.continueRun('owned-run').error?.includes('project migration') === true; },
      'finite run-event read': async () => { const result = await finiteRead(); return result?.type === 'error' && result.status === 409; },
      'automation store lookup': async () => { return automations.store(coldId!, cold.root) === undefined; },
      'delegation listener': async () => {
        const service = { projectDataDir: () => cold.dataDir, list: vi.fn(async () => ({ workers: [] })) };
        const credentials = new CredentialRegistry();
        const response = await createDelegationRoutes(service as never, credentials).request('/list', { headers: { host: '127.0.0.1', authorization: `Bearer ${credentials.issue(coldId!, randomUUID(), 'g')}` } });
        return response.status === 409 && service.list.mock.calls.length === 0;
      },
      'archive-on-merge tick': async () => {
        const enabled = vi.fn(async () => true);
        await new ArchiveOnMergeCoordinator({ projects: async () => [{ id: coldId!, root: cold.root, status: 'ok' }], enabled, repository: async () => undefined,
          withStore: async () => undefined, lookup: async () => [] }).tick();
        return enabled.mock.calls.length === 0;
      },
      'artifact storage write': () => { const task = randomUUID(); return publishArtifact(join(cold.dataDir, 'runs', `${task}-artifacts`), task, join(cold.root, 'missing.txt')).then(() => false, (error) => error instanceof ProjectMigrationFencedError && !existsSync(join(cold.dataDir, 'runs'))); },
      'init write site': () => { return initCommand(cold.root).then(() => false, (error) => error instanceof ProjectMigrationFencedError && !existsSync(join(cold.dataDir, 'workflows'))); },
      'headless store open': async () => { try { openStore(cold.root).close(); return false; } catch (error) { return error instanceof ProjectMigrationFencedError && !existsSync(join(cold.dataDir, '.gitignore')); } },
      'cli run': () => { return cli(['run', 'task']); },
      'cli init': () => { return cli(['init']); },
      'cli single-project listing': () => { return cli(['projects'], { SINGLE_PROJECT: '1' }); },
      'artifact publish': async () => {
        const code = await runArtifactCommand(['publish', join(cold.root, 'missing.txt')], { CEZ_ARTIFACTS_DIR: join(cold.dataDir, 'runs', 'task-artifacts'), CEZ_TASK_ID: 'task' });
        return code === 1 && String(artifactError.mock.calls.at(-1)?.[0]).includes('project migration') && !existsSync(join(cold.dataDir, 'runs'));
      },
    };
    const admitted: string[] = [];
    for (const [name, probe] of Object.entries(probes)) if (!(await probe())) admitted.push(name);
    expect(admitted).toEqual([]);
    // Unrelated projects and workspace routes keep working.
    expect(await route('/api/v1/health')).toBe(200);
    expect(await route(`/api/v1/p/${freeId}/runs`)).toBe(200);
    expect(await indexIds()).toContain('free-run');

    for (const fence of fences) fence.release();
    migrator.releaseAll();
    expect(await route('/api/v1/runs')).toBe(200);
    expect(await indexIds()).toEqual(expect.arrayContaining(['owned-run', 'cold-run', 'free-run']));
    expect((await activity())?.unavailable).toBeUndefined();
    expect((await live.lookupProject(ownedId))?.dataDir).toBe(owned.dataDir);
    expect((await finiteRead())?.type).toBe('batch');
    expect(automations.store(coldId!, cold.root)).toBeDefined();
    expect(await sweepRegisteredPreviewLeftovers([{ root: cold.root }], undefined)).toBe(0);
    expect(existsSync(leftover)).toBe(false);
    expect(await cli(['run', 'task'])).toBe(false);
    expect(await contexts.withMaintenanceStore(ownedId!, maintenanceWork)).toBe('maintained');
    artifactError.mockRestore();
  });
});
