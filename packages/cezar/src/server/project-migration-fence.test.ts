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
import { REBRAND_SWITCH } from '../home/switch.ts';
import { healthConfig } from '../config.ts';
import { defaultServeDeps, serveCommand, type ServeDeps } from '../serve-command.ts';
import { loadSubcommand, SUBCOMMAND_NAMES } from '../subcommands.ts';
import type { RunManager } from '../workflows/run.ts';
import { clearProjectProbeCache, registerProject } from '../workspace/projects.ts';
import {
  CockpitAlreadyRunningError, CockpitOwnership, MIGRATION_JOURNAL_FILE, ProjectMigrationBusyError, ProjectMigrationFencedError, admitProject,
  holdProjectWork, migrationFencePaths, projectAdmissionRefusal, withProjectAdmission,
} from './cockpit-ownership.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { ProjectContexts, fenceProjectContext, sweepRegisteredPreviewLeftovers } from './project-context.ts';
import { createApp } from './server.ts';
import { createWorkspaceProjects } from './workspace-projects.ts';

/**
 * The exclusive project migration fence (hearsay-tools/cezarion#3087): one claim file beside both
 * project directory names, taken through `CockpitOwnership`, refused by every admission point.
 */

const roots: string[] = [];
const owners: CockpitOwnership[] = [];
const disposers: Array<() => void> = [];
const none = { liveTasks: () => [], inFlight: () => 0 };

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
  const contexts = new ProjectContexts({ createRunner, home: testHome(), ownership,
    listProjects: async () => projects.map(({ id, root }) => ({ id, root, status: 'not-git' as const })) });
  disposers.push(() => contexts.disposeAll());
  return contexts;
}

const fenced = (promise: Promise<unknown>) => expect(promise).rejects.toBeInstanceOf(ProjectMigrationFencedError);

/** The drain polls the busy count through `listRuns`: each call is the signal that it looked and kept waiting. */
function drainPolls(store: RunStore): (count: number) => Promise<void> {
  const listRuns = store.listRuns.bind(store);
  let polls = 0;
  let wake: (() => void) | undefined;
  vi.spyOn(store, 'listRuns').mockImplementation(() => { polls += 1; wake?.(); return listRuns(); });
  return async (count) => {
    const target = polls + count;
    while (polls < target) await new Promise<void>((resolve) => { wake = resolve; });
  };
}

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
    admitProject(dataDir)();
    expect(readdirSync(ai).sort()).toEqual(before);
    expect(readFileSync(lock, 'utf8')).toBe(dead);
    const fence = await owner().fenceProject(dataDir, none);
    expect(JSON.parse(readFileSync(lock, 'utf8')).pid).toBe(process.pid);
    expect(existsSync(`${lock}.reclaim`)).toBe(false);
    fence.release();
    // A project without any fence: nothing is created by admission.
    const quiet = project();
    admitProject(quiet.dataDir)();
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
    admitProject(free.dataDir)();
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
    const files = () => readdirSync(dataDir).filter((name) => name.startsWith('automation')).sort().map((name) => [name, readFileSync(join(dataDir, name), 'utf8')]);
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
    const files = () => readdirSync(dataDir).filter((name) => name.startsWith('automation')).sort().map((name) => [name, readFileSync(join(dataDir, name), 'utf8')]);
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

  it.each(['returns', 'is refused'])('records nothing when a schedule fire meets another process\'s fence while its launch %s', async (launch) => {
    const { root, dataDir } = project();
    const store = AutomationStore.open(dataDir);
    store.create({ name: 'Nightly', enabled: true, kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 }, task: { prompt: 'Bump deps' } }, 'nightly');
    store.setState('nightly', (current) => ({ ...current, nextRunAt: new Date(Date.now() - 1_000).toISOString() }));
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    let parked!: () => void;
    const launching = new Promise<void>((resolve) => { parked = resolve; });
    let refuse = launch === 'is refused';
    const launchSchedule = vi.fn(async () => {
      parked();
      await gate;
      if (refuse) throw new ProjectMigrationFencedError('migrating', migrationFencePaths(dataDir)!.lock);
      return { runId: 'nightly-run' };
    });
    const coordinator = new AutomationCoordinator({ listProjects: async () => [{ id: 'p', root, status: 'not-git' }] });
    const refreshed = vi.spyOn(coordinator, 'refresh');
    const scheduler = new WorkspaceAutomationScheduler({ coordinator, handle: (_projectId, automations) => ({ projectId: 'p', store: automations, timeZone: 'UTC', launchSchedule }) });
    const files = () => readdirSync(dataDir).filter((name) => name.startsWith('automation')).sort().map((name) => [name, readFileSync(join(dataDir, name), 'utf8')]);
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await scheduler.start();
      await launching;
      const before = files();
      const startToken = processStartToken(other.pid!);
      writeFileSync(migrationFencePaths(dataDir)!.lock, JSON.stringify({ pid: other.pid, token: randomUUID(), ...(startToken ? { startToken } : {}) }));
      const calls = refreshed.mock.calls.length;
      const receipts = vi.spyOn(AutomationStore.prototype, 'appendReceipt');
      resume();
      // bound: hang guard; the fire has ended when the scheduler re-arms through refresh.
      await vi.waitFor(() => expect(refreshed.mock.calls.length).toBeGreaterThan(calls), { timeout: 5_000 });
      expect(files()).toEqual(before);
      // A refused launch is a skip: no launch-error receipt is even attempted.
      if (launch === 'is refused') expect(receipts.mock.calls.filter(([receipt]) => receipt.status === 'launch-error')).toEqual([]);
      receipts.mockRestore();
      if (launch === 'is refused') {
        // The fence ends: the same occurrence launches on the next fire, not as a duplicate.
        scheduler.stop();
        const exited = once(other, 'exit');
        other.kill('SIGKILL');
        await exited;
        refuse = false;
        // The poll lease the fenced fire could not unlink stays until it ages out: a declined,
        // fence-only limitation tracked in hearsay-tools/cezarion#3142. Removed here so this test
        // shows only that the released reservation launches.
        rmSync(join(dataDir, 'automation-poll.lock'), { force: true });
        const next = new WorkspaceAutomationScheduler({ coordinator, handle: (_projectId, automations) => ({ projectId: 'p', store: automations, timeZone: 'UTC', launchSchedule }) });
        try {
          await next.start();
          // bound: hang guard while the due occurrence fires again.
          await vi.waitFor(() => expect(launchSchedule).toHaveBeenCalledTimes(2), { timeout: 5_000 });
          // bound: hang guard while the launched receipt is written after the launch returns.
          await vi.waitFor(() => expect(readFileSync(join(dataDir, 'automation-receipts.ndjson'), 'utf8')).toContain('"runId":"nightly-run"'), { timeout: 5_000 });
        } finally { next.stop(); }
      }
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
    expect(REBRAND_SWITCH).toBe(false);
    expect(SUBCOMMAND_NAMES.filter((name) => name.includes('migrate'))).toEqual([]);
    expect(await loadSubcommand('migrate-project')).toBeUndefined();
    const { ai, root } = project();
    const contexts = contextsFor(owner(), { id: 'p', root });
    await contexts.context('p');
    expect(readdirSync(ai)).toEqual(['cezar']);
  });
});

describe('the owning cockpit', () => {
  function cockpitStore() {
    const { root, dataDir } = project();
    const store = RunStore.open(dataDir, { keepLive: true });
    disposers.push(() => store.close());
    const create = (title: string) => store.createRun({ title, workflow: 'w', task: 't', steps: [] }).id;
    return { root, dataDir, store, create };
  }
  const idleManager = { pendingWork: () => 0 } as unknown as RunManager;

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
    const refusal = await fenceProjectContext(cockpit, { dataDir, store, manager: idleManager }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ProjectMigrationBusyError);
    const busy = refusal as ProjectMigrationBusyError;
    expect(busy.reason).toBe('live');
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
    const refusal = await fenceProjectContext(cockpit, ctx).catch((error: unknown) => error);
    expect((refusal as ProjectMigrationBusyError).reason).toBe('live');
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
      const refusal = await fenceProjectContext(cockpit, ctx).catch((error: unknown) => error);
      expect((refusal as ProjectMigrationBusyError).reason).toBe('live');
      expect((refusal as ProjectMigrationBusyError).tasks).toEqual([{ id, title: 'finalizing elsewhere', state: 'done' }]);
      expect(projectAdmissionRefusal(dataDir)).toBeUndefined();
    } finally { closeClaimSession(fallbackOwner.session); }
  });

  it('stops the project\'s previews inside the drain bound', async () => {
    const { dataDir, store } = cockpitStore();
    const cockpit = owner();
    await cockpit.acquire(dataDir);
    let exited!: () => void;
    const exit = new Promise<void>((resolve) => { exited = resolve; });
    let asked!: () => void;
    const releasing = new Promise<void>((resolve) => { asked = resolve; });
    const preview = { releaseProject: vi.fn(async () => { asked(); await exit; }) };
    let held = false;
    const fencing = fenceProjectContext(cockpit, { dataDir, store, manager: idleManager }, { preview }).then((fence) => { held = true; return fence; });
    await releasing;
    expect(preview.releaseProject).toHaveBeenCalledWith(dataDir);
    expect(held).toBe(false);
    exited();
    (await fencing).release();
  });

  it('stops previews before it waits for history compression, and refuses when a preview never exits', async () => {
    const { dataDir, store } = cockpitStore();
    const cockpit = owner();
    await cockpit.acquire(dataDir);
    const order: string[] = [];
    const historyIdle = store.historyIdle.bind(store);
    vi.spyOn(store, 'historyIdle').mockImplementation(() => { order.push('history-idle'); return historyIdle(); });
    // Stopping a dev server records an event that can queue compression: the idle wait must come after.
    const preview = { releaseProject: vi.fn(async () => { order.push('preview-start'); await Promise.resolve(); order.push('preview-exited'); }) };
    (await fenceProjectContext(cockpit, { dataDir, store, manager: idleManager }, { preview })).release();
    expect(order).toEqual(['preview-start', 'preview-exited', 'history-idle']);
    const stuck = { releaseProject: vi.fn(() => new Promise<void>(() => undefined)) };
    const refusal = await fenceProjectContext(cockpit, { dataDir, store, manager: idleManager }, { preview: stuck, drainMs: 100 }).catch((error: unknown) => error);
    expect((refusal as ProjectMigrationBusyError).reason).toBe('drain-timeout');
    expect(projectAdmissionRefusal(dataDir)).toBeUndefined();
  });

  it('honours an abort that came before the claim or during a settled wait', async () => {
    const { dataDir } = project();
    const cockpit = owner();
    await cockpit.acquire(dataDir);
    const aborted = AbortSignal.abort();
    await expect(cockpit.fenceProject(dataDir, { liveTasks: () => [], inFlight: () => 0, signal: aborted })).rejects.toThrow();
    expect(projectAdmissionRefusal(dataDir)).toBeUndefined();
    const late = new AbortController();
    await expect(cockpit.fenceProject(dataDir, { liveTasks: () => [], inFlight: () => 0, settle: async () => { late.abort(); }, signal: late.signal })).rejects.toThrow();
    expect(projectAdmissionRefusal(dataDir)).toBeUndefined();
  });

  it('queues no report scan while fenced, so the captured idle covers every scan', async () => {
    const { dataDir, store } = cockpitStore();
    const cockpit = owner();
    await cockpit.acquire(dataDir);
    const reports = store.reports; // built first: its constructor flushes once
    const flush = vi.spyOn(store, 'flush');
    const fence = await cockpit.fenceProject(dataDir, none);
    await reports.backfill();
    expect(flush).not.toHaveBeenCalled();
    fence.release();
    await reports.backfill();
    expect(flush).toHaveBeenCalled();
  });

  it('drains work in flight before it returns, and refuses new reads and starts meanwhile', async () => {
    const { dataDir, store, create } = cockpitStore();
    const cockpit = owner();
    await cockpit.acquire(dataDir);
    // Retention, publish and branch cleanup pin a finished run while they touch its files.
    const settled = create('settled');
    setRunStatus(store, settled, RUN_STATUS.done);
    expect(store.pin(settled, 'maintenance')).toBeDefined();
    let managerWork = 1;
    const manager = { pendingWork: () => managerWork } as unknown as RunManager;
    const waitPolls = drainPolls(store);
    const inFlight = admitProject(dataDir);
    let held = false;
    const fencing = fenceProjectContext(cockpit, { dataDir, store, manager }).then((fence) => { held = true; return fence; });
    expect(() => admitProject(dataDir)).toThrow(ProjectMigrationFencedError);
    await fenced(contextsFor(cockpit, { id: 'p', root: dataDir.slice(0, -'/.ai/cezar'.length) }).context('p'));
    for (const finish of [() => inFlight(), () => store.unpin(settled, 'maintenance')]) {
      await waitPolls(2);
      expect(held).toBe(false);
      finish();
    }
    await waitPolls(2);
    expect(held).toBe(false);
    managerWork = 0;
    const fence = await fencing;
    expect(() => admitProject(dataDir)).toThrow(ProjectMigrationFencedError);
    fence.release();
    admitProject(dataDir)();
  });

  it('stops by itself when work is still in flight at the drain bound, releasing the fence', async () => {
    const { dataDir } = cockpitStore();
    const cockpit = owner();
    await cockpit.acquire(dataDir);
    const inFlight = admitProject(dataDir);
    const refusal = await cockpit.fenceProject(dataDir, { liveTasks: () => [], inFlight: () => 0, drainMs: 100 }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ProjectMigrationBusyError);
    expect((refusal as ProjectMigrationBusyError).reason).toBe('drain-timeout');
    expect((refusal as Error).message).toContain('Nothing was moved');
    expect(projectAdmissionRefusal(dataDir)).toBeUndefined();
    inFlight();
  });

  it('lets an operation admitted before the fence finish, and waits for it, while new ones are refused', async () => {
    const { root, dataDir } = project();
    seedRuns(dataDir, [makeRunRecord({ id: 'done', title: 'done', status: RUN_STATUS.done })]);
    const cockpit = owner();
    const contexts = contextsFor(cockpit, { id: 'p', root });
    const ctx = await contexts.context('p');
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const insideLease: Array<string | undefined> = [];
    const job = contexts.withMaintenanceStore('p', async () => {
      started();
      await gate;
      // A task start or a context read inside the admitted job still passes.
      insideLease.push(projectAdmissionRefusal(dataDir)?.reason);
      return 'maintained';
    });
    await running;
    const waitPolls = drainPolls(ctx.store);
    let held = false;
    const fencing = fenceProjectContext(cockpit, ctx).then((fence) => { held = true; return fence; });
    await waitPolls(2);
    expect(held).toBe(false);
    expect(projectAdmissionRefusal(dataDir)?.reason).toBe('migrating');
    expect(await contexts.withMaintenanceStore('p', async () => 'second')).toBeUndefined();
    finish();
    expect(await job).toBe('maintained');
    expect(insideLease).toEqual([undefined]);
    (await fencing).release();
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
    const files = () => readdirSync(dataDir).filter((name) => name.startsWith('automation')).sort().map((name) => [name, readFileSync(join(dataDir, name), 'utf8')]);
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

  it('keeps detached work admitted and drained after the request that started it answers', async () => {
    const { dataDir } = project();
    const cockpit = owner();
    await cockpit.acquire(dataDir);
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    let check!: Promise<string | undefined>;
    let delivery!: Promise<string | undefined>;
    // A request answers 202 and leaves a manual check and a webhook delivery running.
    await withProjectAdmission(dataDir, async function request() {
      check = withProjectAdmission(dataDir, async function manualCheck() { await gate; return projectAdmissionRefusal(dataDir)?.reason; }, () => 'refused');
      delivery = holdProjectWork(dataDir, async function webhookDelivery() { await gate; return projectAdmissionRefusal(dataDir)?.reason; });
    }, () => undefined);
    let polls = 0;
    let wake: (() => void) | undefined;
    const waitPolls = async (count: number) => {
      const target = polls + count;
      while (polls < target) await new Promise<void>((resolve) => { wake = resolve; });
    };
    let held = false;
    const fencing = cockpit.fenceProject(dataDir, { liveTasks: () => [], inFlight: () => { polls += 1; wake?.(); return 0; } })
      .then((fence) => { held = true; return fence; });
    await waitPolls(2);
    expect(held).toBe(false);
    expect(projectAdmissionRefusal(dataDir)?.reason).toBe('migrating');
    finish();
    expect(await check).toBeUndefined();
    expect(await delivery).toBeUndefined();
    (await fencing).release();
  });

  it('waits for work that settles on its own inside the drain bound and the abort', async () => {
    const { dataDir } = project();
    const cockpit = owner();
    await cockpit.acquire(dataDir);
    let finish!: () => void;
    const scan = new Promise<void>((resolve) => { finish = resolve; });
    let asked!: () => void;
    const settling = new Promise<void>((resolve) => { asked = resolve; });
    let held = false;
    const fencing = cockpit.fenceProject(dataDir, { liveTasks: () => [], inFlight: () => 0, settle: () => { asked(); return scan; } })
      .then((fence) => { held = true; return fence; });
    await settling;
    expect(held).toBe(false);
    finish();
    (await fencing).release();
    const never = () => new Promise<void>(() => undefined);
    const timedOut = await cockpit.fenceProject(dataDir, { liveTasks: () => [], inFlight: () => 0, settle: never, drainMs: 100 }).catch((error: unknown) => error);
    expect((timedOut as ProjectMigrationBusyError).reason).toBe('drain-timeout');
    expect(projectAdmissionRefusal(dataDir)).toBeUndefined();
    const abort = new AbortController();
    await expect(cockpit.fenceProject(dataDir, { liveTasks: () => [], inFlight: () => 0, settle: () => { abort.abort(); return never(); }, signal: abort.signal })).rejects.toThrow();
    expect(projectAdmissionRefusal(dataDir)).toBeUndefined();
  });

  it('gives up the fence when its wait is aborted', async () => {
    const { dataDir } = project();
    const cockpit = owner();
    await cockpit.acquire(dataDir);
    const abort = new AbortController();
    const fencing = cockpit.fenceProject(dataDir, { liveTasks: () => [], inFlight: () => { abort.abort(); return 1; }, signal: abort.signal });
    await expect(fencing).rejects.toThrow();
    expect(projectAdmissionRefusal(dataDir)).toBeUndefined();
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
   * point fails the sweep. `versions` is pinned in self-update/checkouts.test.ts.
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
    const fences = [await fenceProjectContext(cockpit, ctx), await migrator.fenceProject(cold.dataDir, none)];
    const leftover = join(cold.dataDir, 'preview', 'run-x', '3000.pid.json');
    mkdirSync(join(cold.dataDir, 'preview', 'run-x'), { recursive: true });
    writeFileSync(leftover, '{}');
    const lazy = contextsFor(owner(), { id: coldId!, root: cold.root });
    const lazyContext = vi.spyOn(lazy, 'context');
    const cli = (args: string[], env: Record<string, string> = {}) => {
      const deps = { ...defaultCliDeps, process: { argv: ['/bin/node', '/bin/cez', ...args, '--repo', cold.root], env: {}, cwd: () => cold.root, exitCode: undefined as number | undefined },
        console: { log: vi.fn(), error: vi.fn() }, productEnv: (name: string) => env[name], resolveCliHome: () => testHome(), prepareOperatorHome: () => testHome(),
        runManagedCommand: vi.fn().mockResolvedValue(undefined), runSubcommand: vi.fn().mockResolvedValue(undefined), getRepoInfo: vi.fn().mockResolvedValue(null),
        runProjectsCommand: vi.fn().mockResolvedValue(0), readOwnName: () => '@wjarka/cezarion', readOwnVersion: () => '1.2.3', serveCommand: vi.fn(), serverCommand: vi.fn(),
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
