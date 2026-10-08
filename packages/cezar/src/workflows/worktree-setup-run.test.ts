import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withOwnedInputRun } from '../core/harness-parity.testkit.ts';
import { handoffPath } from '../handoff.ts';
import { reclaimWorktree } from '../runs/retention.ts';
import { readPersistedRuns, seedRuns } from '../runs/run-store.testkit.ts';
import { RunStore } from '../runs/store.ts';
import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import type { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

/**
 * Worktree setup through the real engine (#917, spec `.ai/specs/2026-10-07-worktree-setup.md`):
 * a new task's isolated worktree runs `worktreeSetup` before the first agent turn, the thread
 * shows it, the agent is told, and a restart during setup requeues the run instead of stranding
 * it. The dry-run claude mock records each opening message through CEZ_MOCK_STDIN_FILE.
 */
const execFileAsync = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const TERMINAL = ['done', 'review', 'failed', 'cancelled'];
/** An agent step and a trailing check, so the run ends on its own instead of parking. */
const WORKFLOW: WorkflowDef = {
  name: 'setup-test',
  source: 'built-in',
  steps: [
    { id: 'work', prompt: '{{task}}' },
    { id: 'verify', command: 'true' },
  ],
};

const roots: string[] = [];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ['CEZ_DRY_RUN', 'CEZ_MOCK_STDIN_FILE', 'CEZ_AUTONAME']) saved[key] = process.env[key];
  process.env.CEZ_DRY_RUN = '1';
  process.env.CEZ_AUTONAME = '0';
});

afterEach(async () => {
  for (const root of roots) await drainFixtureManagers(root);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

interface Fixture { repoRoot: string; dataDir: string; stdinFile: string; store: RunStore; manager: RunManager }

async function fixture(config?: unknown): Promise<Fixture> {
  const repoRoot = mkdtempSync(join(tmpdir(), 'cez-wsetup-'));
  roots.push(repoRoot);
  const dataDir = join(repoRoot, '.ai/cezar');
  const stdinFile = join(repoRoot, '.mock-stdin.ndjson');
  writeFileSync(stdinFile, '');
  process.env.CEZ_MOCK_STDIN_FILE = stdinFile;
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'gc.auto', '0'], ['config', 'maintenance.auto', 'false']]) {
    await execFileAsync('git', args, { cwd: repoRoot });
  }
  writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
  writeFileSync(join(repoRoot, '.gitignore'), '.ai/\n.mock-*\n.setup-*\n.gate\n');
  await execFileAsync('git', ['add', '-A'], { cwd: repoRoot });
  await execFileAsync('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
  mkdirSync(dataDir, { recursive: true });
  if (config !== undefined) writeFileSync(join(dataDir, 'config.json'), JSON.stringify(config));
  const store = RunStore.open(dataDir);
  return { repoRoot, dataDir, stdinFile, store, manager: createFixtureManager(store, repoRoot) };
}

async function waitFor(pred: () => boolean, what: string, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const openingMessages = (f: Fixture): string[] =>
  readFileSync(f.stdinFile, 'utf8').split('\n').filter(Boolean).map((line) => (JSON.parse(line) as { userText: string }).userText);

const messages = (f: Fixture, id: string) =>
  f.store.readEvents(id).map((event) => String((event as { message?: unknown }).message ?? ''));

async function runToEnd(f: Fixture, task: string, worktree?: false): Promise<string> {
  const record = f.manager.startRun(WORKFLOW, { task, ...(worktree === false ? { worktree } : {}) });
  await waitFor(() => TERMINAL.includes(f.store.getRun(record.id)?.status ?? ''), `run ${record.id} to finish`);
  return record.id;
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('worktree setup on task start (#917)', () => {
  it('runs worktreeSetup in the task worktree before the first agent turn', async () => {
    const f = await fixture({ worktreeSetup: { commands: ['pwd > "$CEZ_PROJECT_ROOT/.setup-cwd"'] } });
    const id = await runToEnd(f, 'do the thing');
    const record = f.store.getRun(id)!;
    expect(realpathSync(readFileSync(join(f.repoRoot, '.setup-cwd'), 'utf8').trim())).toBe(realpathSync(record.worktreePath!));
    const events = f.store.readEvents(id) as Array<Record<string, unknown>>;
    const at = (pred: (e: Record<string, unknown>) => boolean) => events.findIndex(pred);
    const start = at((e) => e.type === 'note' && String(e.message).startsWith('preparing the worktree — 1 command'));
    const output = at((e) => e.type === 'check-output' && String(e.command).startsWith('pwd >'));
    const end = at((e) => e.type === 'note' && String(e.message).startsWith('worktree setup done in'));
    const firstStep = at((e) => e.type === 'step-start');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(start).toBeLessThan(output);
    expect(output).toBeLessThan(end);
    expect(end).toBeLessThan(firstStep);
    expect(record.worktreeSetup?.status).toBe('done');
    expect(typeof record.worktreeSetup?.durationMs).toBe('number');
    const [opening] = openingMessages(f);
    expect(opening).toContain('Cezar prepared this worktree before your session started:');
    expect(opening).toContain('`pwd > "$CEZ_PROJECT_ROOT/.setup-cwd"`');
    expect(readFileSync(handoffPath(f.dataDir, id), 'utf8')).toContain('worktree setup done in');
  }, 60_000);

  it('a failing setup still starts the agent and tells it', async () => {
    const f = await fixture({ worktreeSetup: { commands: ['echo boom-output; exit 3', 'echo never'] } });
    const id = await runToEnd(f, 'do the thing');
    const outputs = f.store.readEvents(id).filter((e) => e.type === 'check-output' && String((e as { command?: unknown }).command).startsWith('echo'));
    expect(outputs).toHaveLength(1);
    expect((outputs[0] as { exitCode?: unknown }).exitCode).toBe(3);
    const record = f.store.getRun(id)!;
    expect(record.worktreeSetup).toMatchObject({ status: 'failed', error: '`echo boom-output; exit 3` exited 3' });
    const [opening] = openingMessages(f);
    expect(opening).toContain('boom-output');
    expect(opening).toContain('The remaining commands did not run: `echo never`.');
    expect(record.steps.find((s) => s.id === 'work')?.sessionId).toBeDefined();
  }, 60_000);

  it('an invalid worktreeSetup is reported and skipped', async () => {
    const f = await fixture({ worktreeSetup: { commands: 'npm ci' } });
    const id = await runToEnd(f, 'do the thing');
    expect(messages(f, id).some((m) => m.startsWith('worktree setup skipped — worktreeSetup in .ai/cezar/config.json is invalid (commands:'))).toBe(true);
    expect(f.store.readEvents(id).filter((e) => e.type === 'check-output' && (e as { stepId?: unknown }).stepId === undefined)).toHaveLength(0);
    expect(openingMessages(f)[0]).toContain("Cezar's worktree setup did not run");
    expect(f.store.getRun(id)?.worktreeSetup?.status).toBe('failed');
  }, 60_000);

  it('without worktreeSetup nothing changes', async () => {
    const f = await fixture();
    const id = await runToEnd(f, 'do the thing');
    expect(f.store.getRun(id)?.worktreeSetup).toBeUndefined();
    expect(messages(f, id).some((m) => m.includes('worktree setup'))).toBe(false);
    expect(openingMessages(f)[0]).toBe('do the thing');
  }, 60_000);

  it('an in-place run never runs setup', async () => {
    const f = await fixture({ worktreeSetup: { commands: ['echo setup-ran'] } });
    const id = await runToEnd(f, 'do the thing', false);
    expect(f.store.getRun(id)?.worktreeSetup).toBeUndefined();
    expect(f.store.readEvents(id).some((e) => e.type === 'check-output' && (e as { command?: unknown }).command === 'echo setup-ran')).toBe(false);
  }, 60_000);

  it('Stop during setup cancels the run and kills the group', async () => {
    const pidFile = join(tmpdir(), `cez-wsetup-pid-${process.pid}-${Date.now()}`);
    const f = await fixture({ worktreeSetup: { commands: [`trap '' TERM; echo $$ > ${pidFile}; while true; do sleep 0.1; done`] } });
    const record = f.manager.startRun(WORKFLOW, { task: 'do the thing' });
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', 'setup to start');
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    rmSync(pidFile, { force: true });
    expect(f.manager.cancel(record.id)).toBe(true);
    await waitFor(() => f.store.getRun(record.id)?.status === 'cancelled', 'run to cancel');
    expect(alive(pid)).toBe(false);
    expect(f.store.getRun(record.id)?.worktreeSetup?.error).toBe('stopped');
    expect(openingMessages(f)).toEqual([]);
  }, 60_000);

  it('a restart during setup requeues the run and reruns setup', async () => {
    const f = await fixture({
      worktreeSetup: { commands: ['echo x >> "$CEZ_PROJECT_ROOT/.setup-count"; while [ ! -f "$CEZ_PROJECT_ROOT/.gate" ]; do sleep 0.05; done'] },
    });
    const countLines = () => (existsSync(join(f.repoRoot, '.setup-count')) ? readFileSync(join(f.repoRoot, '.setup-count'), 'utf8').split('\n').filter(Boolean).length : 0);
    const record = f.manager.startRun(WORKFLOW, { task: 'do the thing' });
    await waitFor(() => f.store.getRun(record.id)?.worktreeSetup?.status === 'running' && countLines() === 1, 'setup to start');
    // The crash: snapshot what was on disk while setup ran, stop this process's work, then
    // restore the snapshot under a fresh store and manager, as a restarted cezar finds it.
    f.store.flush();
    const snapshot = readPersistedRuns(f.dataDir);
    f.manager.cancel(record.id);
    await waitFor(() => !f.manager.isActive(record.id), 'the first manager to let go');
    f.manager.dispose();
    f.store.close();
    seedRuns(f.dataDir, snapshot);
    const store = RunStore.open(f.dataDir, { keepLive: true });
    const manager = createFixtureManager(store, f.repoRoot);
    await manager.recover();
    await waitFor(() => countLines() === 2, 'setup to run again');
    writeFileSync(join(f.repoRoot, '.gate'), '');
    const statuses: string[] = [];
    await waitFor(() => {
      const status = store.getRun(record.id)?.status ?? '';
      if (statuses.at(-1) !== status) statuses.push(status);
      return TERMINAL.includes(status);
    }, 'the recovered run to finish');
    const finished = store.getRun(record.id)!;
    expect(statuses).not.toContain('failed');
    expect(finished.worktreeSetup?.status).toBe('done');
    expect(finished.steps.find((s) => s.id === 'work')?.sessionId).toBeDefined();
  }, 90_000);

  it('an interrupted setup whose config was removed is cleared', async () => {
    const f = await fixture({
      worktreeSetup: { commands: ['echo x >> "$CEZ_PROJECT_ROOT/.setup-count"; while [ ! -f "$CEZ_PROJECT_ROOT/.gate" ]; do sleep 0.05; done'] },
    });
    const countLines = () => (existsSync(join(f.repoRoot, '.setup-count')) ? readFileSync(join(f.repoRoot, '.setup-count'), 'utf8').split('\n').filter(Boolean).length : 0);
    const record = f.manager.startRun(WORKFLOW, { task: 'do the thing' });
    await waitFor(() => f.store.getRun(record.id)?.worktreeSetup?.status === 'running' && countLines() === 1, 'setup to start');
    f.store.flush();
    const snapshot = readPersistedRuns(f.dataDir);
    f.manager.cancel(record.id);
    await waitFor(() => !f.manager.isActive(record.id), 'the first manager to let go');
    f.manager.dispose();
    f.store.close();
    seedRuns(f.dataDir, snapshot);
    rmSync(join(f.dataDir, 'config.json'));
    const store = RunStore.open(f.dataDir, { keepLive: true });
    const manager = createFixtureManager(store, f.repoRoot);
    await manager.recover();
    await waitFor(() => TERMINAL.includes(store.getRun(record.id)?.status ?? ''), 'the recovered run to finish');
    const finished = store.getRun(record.id)!;
    expect(finished.worktreeSetup).toBeUndefined();
    expect(countLines()).toBe(1);
    expect(finished.steps.find((s) => s.id === 'work')?.sessionId).toBeDefined();
  }, 90_000);
});

describe('worktree setup on Continue (#917)', () => {
  const COMMAND = 'echo again >> "$CEZ_PROJECT_ROOT/.setup-count"';
  const countLines = (f: Fixture) =>
    (existsSync(join(f.repoRoot, '.setup-count')) ? readFileSync(join(f.repoRoot, '.setup-count'), 'utf8').split('\n').filter(Boolean).length : 0);

  it('Continue after retention reclaimed the worktree runs setup again', async () => {
    const f = await fixture({ worktreeSetup: { commands: [COMMAND] } });
    const id = await runToEnd(f, 'do the thing');
    expect(countLines(f)).toBe(1);
    const worktreePath = f.store.getRun(id)!.worktreePath!;
    await reclaimWorktree(f.repoRoot, f.store, f.store.getRun(id)!);
    expect(f.store.getRun(id)?.worktreeReclaimedAt).toBeDefined();
    expect(existsSync(worktreePath)).toBe(false);
    writeFileSync(f.stdinFile, '');
    expect(f.manager.continueRun(id, { text: 'go on' }).ok).toBe(true);
    await waitFor(() => openingMessages(f).length > 0, 'the continuation to open');
    expect(countLines(f)).toBe(2);
    expect(existsSync(worktreePath)).toBe(true);
    expect(openingMessages(f)[0]).toContain('go on');
    expect(openingMessages(f)[0]).toContain('Cezar prepared this worktree before your session started:');
    expect(f.store.getRun(id)?.worktreeSetup?.status).toBe('done');
  }, 90_000);

  it('Continue on a live worktree does not run setup', async () => {
    const f = await fixture({ worktreeSetup: { commands: [COMMAND] } });
    const id = await runToEnd(f, 'do the thing');
    writeFileSync(f.stdinFile, '');
    expect(f.manager.continueRun(id, { text: 'go on' }).ok).toBe(true);
    await waitFor(() => openingMessages(f).length > 0, 'the continuation to open');
    expect(countLines(f)).toBe(1);
    expect(openingMessages(f)[0]).not.toContain('Cezar prepared');
  }, 90_000);
});

describe('worktree setup in an owned worker (#917)', () => {
  it('a worker runs setup in its owned worktree', async () => {
    await withOwnedInputRun('claude', 'baseline', async ({ repoRoot, store, manager, runId }) => {
      mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
      writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), JSON.stringify({ worktreeSetup: { commands: ['echo worker-setup'] } }));
      manager.enqueueOwnedRun(runId);
      await waitFor(() => store.getRun(runId)?.worktreeSetup?.status === 'done', 'the worker setup to finish', 30_000);
      expect(store.readEvents(runId).some((e) => e.type === 'check-output' && (e as { command?: unknown }).command === 'echo worker-setup')).toBe(true);
    });
  }, 60_000);
});
