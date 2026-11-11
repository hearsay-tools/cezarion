import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeRunRecord, RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { runsIndexResponseSchema } from '@open-mercato/cezar-contract/workspace-events';
import { runArtifactCommand } from '../artifacts/cli.ts';
import { defaultCliDeps, main, type CliDeps } from '../cli-dispatch.ts';
import { createRunner } from '../core/runner-factory.ts';
import { processStartToken } from '../delegation/process-liveness.ts';
import { Home } from '../home/home.ts';
import { testHome, useTestHome } from '../home/test-home.testkit.ts';
import { seedRuns } from '../runs/run-store.testkit.ts';
import { defaultServeDeps, serveCommand, type ServeDeps } from '../serve-command.ts';
import { CockpitOwnership, projectAdmissionRefusal, withProjectAdmission } from '../server/cockpit-ownership.ts';
import { apiRequest } from '../server/loopback-request.testkit.ts';
import { ArchiveOnMergeCoordinator } from '../server/archive-on-merge.ts';
import { CompletionActionCoordinator } from '../server/completion-actions.ts';
import { ProjectContexts } from '../server/project-context.ts';
import { projectPaths } from '../project-paths.ts';
import { createApp } from '../server/server.ts';
import { clearProjectProbeCache, registerProject } from '../workspace/projects.ts';
import { writeSettledJournal } from './project-migration.testkit.ts';
import { ProjectMigrationRecoveryError, recoverProjectMigration } from './recovery.ts';
import { prepareBeforeTicks, prepareProjects } from './auto.ts';
import { REBRAND_SWITCH } from '../home/switch.ts';

/**
 * Early recovery of an unfinished project migration (hearsay-tools/cezarion#3089): every entry
 * finishes the journal under the exclusive fence before it reads the project, with the release switch off,
 * and a journal that cannot finish keeps the project closed with a usable error.
 */

const roots: string[] = [];
const owners: CockpitOwnership[] = [];
const disposers: Array<() => void> = [];
const savedHome = process.env.CEZ_HOME;
const savedDryRun = process.env.CEZ_DRY_RUN;
const TASK = '70000000-0000-4000-8000-000000000007';

beforeEach(() => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-recovery-home-'));
  roots.push(home);
  useTestHome(Home.sandbox(home));
  process.env.CEZ_DRY_RUN = '1';
  clearProjectProbeCache();
});

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const owner of owners.splice(0)) owner.releaseAll();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  useTestHome(savedHome ? Home.sandbox(savedHome) : undefined);
  if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
  else process.env.CEZ_DRY_RUN = savedDryRun;
});

/** A project with one finished task and an unfinished journal; `broken` writes one no binary can read. */
function journaled(options: { broken?: boolean } = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'cez-recovery-'));
  roots.push(root);
  const dataDir = join(root, '.ai/cezar');
  seedRuns(dataDir, [makeRunRecord({ id: TASK, title: 'kept', status: RUN_STATUS.done })]);
  const journal = writeSettledJournal(root);
  if (options.broken) writeFileSync(journal, '{"version":2}\n');
  return { root, dataDir, journal };
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

function cliDeps(root: string, args: string[]) {
  return { ...defaultCliDeps, process: { argv: ['/bin/node', '/bin/cez', ...args, '--repo', root], env: {}, cwd: () => root, exitCode: undefined as number | undefined },
    console: { log: vi.fn(), error: vi.fn() }, productEnv: () => undefined, resolveCliHome: () => testHome(), prepareOperatorHome: () => testHome(),
    runSubcommand: vi.fn().mockResolvedValue(undefined), getRepoInfo: vi.fn().mockResolvedValue(null),
    runProjectsCommand: vi.fn().mockResolvedValue(0), readOwnVersion: () => '1.2.3', serveCommand: vi.fn(), serverCommand: vi.fn(),
    runCommand: vi.fn(async () => { expect(existsSync(join(root, '.ai/squawk-migration.json'))).toBe(false); }),
    initCommand: vi.fn(), initWorkspace: vi.fn().mockResolvedValue(undefined) };
}

function serve(root: string) {
  const listener = vi.fn().mockRejectedValue(new Error('listener reached'));
  const process = new EventEmitter();
  // The process exit releases boot's claim, as a failed boot's exit does.
  const done = serveCommand(testHome(), root, 0, false, undefined, false,
    { ...defaultServeDeps, acquireServeListener: listener, process } as unknown as ServeDeps).finally(() => process.emit('exit'));
  return { listener, done };
}

describe('early recovery of an unfinished project migration', () => {
  it('runs with the release switch off, as shipped', () => {
    expect(REBRAND_SWITCH).toBe(false);
  });

  it('costs nothing without a journal and finishes one under a temporary claim', async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'cez-recovery-'));
    roots.push(root);
    expect(await recoverProjectMigration(root)).toBeUndefined();
    expect(existsSync(join(root, '.ai'))).toBe(false);

    const { dataDir, journal } = journaled();
    const result = await recoverProjectMigration(realpathSync(dataDir.replace(/\/\.ai\/cezar$/, '')));
    expect(result?.resumed).toBe(true);
    expect(existsSync(journal)).toBe(false);
    expect(existsSync(join(dataDir, 'cockpit.lock'))).toBe(false);
    expect(projectAdmissionRefusal(dataDir)).toBeUndefined();
  });

  it('leaves the journal to a live cockpit that owns the project', async () => {
    const { root, dataDir, journal } = journaled();
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
    try {
      const startToken = processStartToken(other.pid!);
      writeFileSync(join(dataDir, 'cockpit.lock'), JSON.stringify({ pid: other.pid, token: randomUUID(), ...(startToken ? { startToken } : {}) }));
      expect(await recoverProjectMigration(root)).toBeUndefined();
      expect(existsSync(journal)).toBe(true);
      expect(projectAdmissionRefusal(dataDir)?.reason).toBe('journal');
    } finally {
      const exited = once(other, 'exit');
      other.kill('SIGKILL');
      await exited;
    }
  });

  it('finishes the journal at cockpit boot before the listener', async () => {
    const { root, journal } = journaled();
    const { listener, done } = serve(root);
    await expect(done).rejects.toThrow('listener reached');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(existsSync(journal)).toBe(false);
  });

  it('opens a target-only project in the same process after recovery kept its claim in .ai/squawk', async () => {
    const targetOnly = () => {
      const root = mkdtempSync(join(realpathSync(tmpdir()), 'cez-recovery-target-'));
      roots.push(root);
      // The old directory is gone: the claim recovery keeps is taken in .ai/squawk.
      seedRuns(join(root, '.ai/squawk'), [makeRunRecord({ id: TASK, title: 'kept', status: RUN_STATUS.done })]);
      return { root, journal: writeSettledJournal(root) };
    };
    const booted = targetOnly();
    const { listener, done } = serve(booted.root);
    await expect(done).rejects.toThrow('listener reached');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(existsSync(booted.journal)).toBe(false);
    const lazy = targetOnly();
    const contexts = contextsFor(owner(), { id: 'lazy', root: lazy.root });
    expect((await contexts.context('lazy')).store.getRun(TASK)?.title).toBe('kept');
    expect(existsSync(lazy.journal)).toBe(false);
  });

  it('finishes the journal in a lazy build and in the warm-up before their reads', async () => {
    const lazy = journaled(), warm = journaled();
    const contexts = contextsFor(owner(), { id: 'lazy', root: lazy.root }, { id: 'warm', root: warm.root });
    expect((await contexts.context('lazy')).store.getRun(TASK)?.title).toBe('kept');
    expect(existsSync(lazy.journal)).toBe(false);
    expect(await contexts.warmAll([{ id: 'warm', root: warm.root, status: 'not-git' }])).toEqual(['warm']);
    expect(existsSync(warm.journal)).toBe(false);
  });

  it('stops preparing projects once the cockpit is closing', async () => {
    const first = journaled(), second = journaled();
    let closing = false;
    await prepareProjects([{ root: first.root }, { root: second.root }], { homes: [], stopped: () => {
      // The cockpit closes while the first project is prepared.
      const answer = closing;
      closing = true;
      return answer;
    } });
    expect(existsSync(first.journal)).toBe(false);
    expect(existsSync(second.journal)).toBe(true);
  });

  it('finishes the journal before the archive and completion ticks check admission', async () => {
    const archived = journaled(), completed = journaled();
    const ownership = owner();
    const ticks = (root: string, seen: string[]) => prepareBeforeTicks({ ownership, homes: [] }, {
      projects: async () => { return [{ id: 'p', root }]; },
      enabled: async () => { seen.push('admitted'); return false; },
      repository: async () => undefined,
      // As the cockpit's own store opener: refused under a fence or a journal.
      withStore: (project, work) => withProjectAdmission(projectPaths(project.root).write, () => { return work(undefined as never, () => false, () => true); }, () => undefined),
      lookup: async () => [],
    });
    const archive: string[] = [];
    await new ArchiveOnMergeCoordinator(ticks(archived.root, archive), 0).tick();
    expect(archive).toEqual(['admitted']);
    expect(existsSync(archived.journal)).toBe(false);

    const completion: string[] = [];
    const deps = ticks(completed.root, completion);
    await new CompletionActionCoordinator({ projects: deps.projects, forge: async () => undefined, head: async () => undefined,
      withStore: (project, work) => deps.withStore(project, (store, _active, valid) => { completion.push('store'); return work(store, valid); }) }, 0).tick();
    expect(completion).toEqual(['store']);
    expect(existsSync(completed.journal)).toBe(false);
  });

  it('finishes the journal before the cold workspace run index reads the project', async () => {
    const boot = journaled(), cold = journaled();
    rmSync(boot.journal);
    const [bootId] = await Promise.all([boot.root, cold.root].map(async (root) => { return (await registerProject(root, undefined, testHome())).id!; }));
    const ownership = owner();
    const contexts = contextsFor(ownership, { id: bootId!, root: boot.root });
    const ctx = await contexts.context(bootId!);
    const app = createApp({ home: testHome(), repoRoot: boot.root, store: ctx.store, manager: ctx.manager, ownership, contexts, bootProjectId: bootId!, version: '0.0.0-test' });
    const index = runsIndexResponseSchema.parse(await (await apiRequest(app, '/api/v1/workspace/runs-index')).json());
    expect(existsSync(cold.journal)).toBe(false);
    expect(index.runs.filter((run) => run.id === TASK)).toHaveLength(2);
  });

  it.each([['run', 'a task'], ['init']])('finishes the journal before the CLI command %s reads the project', async (...args) => {
    const { root, journal } = journaled();
    const deps = cliDeps(root, args);
    await main(deps as unknown as CliDeps);
    expect(existsSync(journal)).toBe(false);
    expect(args[0] === 'run' ? deps.runCommand : deps.initCommand).toHaveBeenCalledTimes(1);
  });

  it('finishes the journal before artifact publish writes', async () => {
    const { root, dataDir, journal } = journaled();
    const file = join(root, 'report.html');
    writeFileSync(file, '<title>r</title>');
    mkdirSync(join(dataDir, 'runs', `${TASK}-artifacts`), { recursive: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const code = await runArtifactCommand(['publish', file], { CEZ_ARTIFACTS_DIR: join(dataDir, 'runs', `${TASK}-artifacts`), CEZ_TASK_ID: TASK });
    log.mockRestore();
    expect(code).toBe(0);
    expect(existsSync(journal)).toBe(false);
  });
});

describe('a journal that cannot finish', () => {
  const failure = (journal: string, root: string) => `The unfinished project migration ${journal} of ${root} could not finish: `;

  it('keeps the project closed with a usable error at every entry', async () => {
    const { root, dataDir, journal } = journaled({ broken: true });
    const recovery = recoverProjectMigration(root);
    await expect(recovery).rejects.toBeInstanceOf(ProjectMigrationRecoveryError);
    await expect(recovery).rejects.toThrow(failure(journal, root));
    await expect(recovery).rejects.toThrow(/The project stays closed until it finishes\. Fix the cause, then open the project again to retry$/);

    const { listener, done } = serve(root);
    await expect(done).rejects.toThrow(failure(journal, root));
    expect(listener).not.toHaveBeenCalled();
    await expect(main(cliDeps(root, ['run', 'x']) as unknown as CliDeps)).rejects.toThrow(failure(journal, root));

    const boot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-recovery-boot-'));
    roots.push(boot);
    const [bootId, brokenId] = await Promise.all([boot, root].map(async (dir) => { return (await registerProject(dir, undefined, testHome())).id!; }));
    const ownership = owner();
    const contexts = contextsFor(ownership, { id: bootId!, root: boot }, { id: brokenId!, root });
    const ctx = await contexts.context(bootId!);
    const app = createApp({ home: testHome(), repoRoot: boot, store: ctx.store, manager: ctx.manager, ownership, contexts, bootProjectId: bootId!, version: '0.0.0-test' });
    const scoped = await apiRequest(app, `/api/v1/p/${brokenId}/runs`);
    expect(scoped.status).toBe(409);
    expect(((await scoped.json()) as { error: string }).error).toContain(failure(journal, root));
    // The other project and the workspace index still answer; the broken project is left out.
    expect((await apiRequest(app, `/api/v1/p/${bootId}/runs`)).status).toBe(200);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await apiRequest(app, '/api/v1/workspace/runs-index')).status).toBe(200);
    expect(warn.mock.calls.flat().join('\n')).toContain(failure(journal, root));
    warn.mockRestore();

    expect(existsSync(journal)).toBe(true);
    expect(projectAdmissionRefusal(dataDir)?.reason).toBe('journal');
    expect(existsSync(migrationLock(root))).toBe(false);
  });
});

function migrationLock(root: string): string {
  return join(root, '.ai/squawk-migration.lock');
}

// These cases pin the shipped disabled gate; enabled cases use the explicit rebrand seam.
vi.mock('../home/switch.ts', () => ({ REBRAND_SWITCH: false }));
