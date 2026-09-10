import { execFile as execFileCallback, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerCollectedResult, WorkerDestroyResult, WorkerInspection, WorkerSpawnResult, WorkerWaitResult } from '@open-mercato/cezar-contract';
import { DelegationController } from '../delegation/provision.ts';
import { RunStore } from '../runs/store.ts';
import { createApp } from '../server/server.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';

const execFile = promisify(execFileCallback);
const entry = fileURLToPath(new URL('../index.ts', import.meta.url));

describe('public delegation completion integration', () => {
  let root: string, repo: string, control: string, store: RunStore, manager: RunManager, controller: DelegationController;
  const environments = new Map<string, Record<string, string>>();
  const executions: Promise<unknown>[] = [];
  const turns: Promise<unknown>[] = [];
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  async function until(predicate: () => boolean, label: string) {
    await vi.waitFor(() => expect(predicate(), `${label}: ${JSON.stringify(store.listRuns().map(r => ({ id: r.id, status: r.status, error: r.error })))}`).toBe(true), { timeout: 15_000, interval: 20 });
  }
  function track() {
    // Observe actual session provisioning and await existing asynchronous lifecycle
    // tasks at teardown; no scheduling, result, or runner method is replaced.
    const provision = manager.setDelegationProvisioner.bind(manager);
    manager.setDelegationProvisioner = factory => provision(id => {
      const session = factory(id);
      if (session) environments.set(id, session.env);
      return session;
    });
    const engine = manager as unknown as Record<'execute' | 'runContinuation' | 'recordTurnEnd', (...args: unknown[]) => Promise<unknown>>;
    for (const name of ['execute', 'runContinuation', 'recordTurnEnd'] as const) {
      const original = engine[name].bind(manager);
      engine[name] = (...args) => { const result = original(...args); (name === 'recordTurnEnd' ? turns : executions).push(result); return result; };
    }
  }
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cez-delegation-integration-'));
    repo = join(root, 'repo'); control = join(root, 'wire'); mkdirSync(repo); mkdirSync(control);
    git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.name', 'test'); git(repo, 'config', 'user.email', 'test@local');
    writeFileSync(join(repo, 'shared.txt'), 'baseline\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
    const wire = join(root, 'agent.mjs');
    writeFileSync(wire, `#!${process.execPath}\nimport { runWire } from ${JSON.stringify(new URL('./__fixtures__/delegation-wire.mjs', import.meta.url).href)};\nrunWire(${JSON.stringify(control)});\n`, { mode: 0o755 });
    const claudeHome = join(root, 'claude'); const codexHome = join(root, 'codex'); mkdirSync(claudeHome); mkdirSync(codexHome);
    for (const [name, value] of Object.entries({ CEZ_HOME: join(root, 'home'), CEZ_DRY_RUN: '0', CEZ_DELEGATION: '1', CEZ_AUTONAME: '0', CEZ_REVIEW_GATE: '1',
      CEZ_CLAUDE_BIN: wire, CEZ_CODEX_BIN: wire, CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome })) vi.stubEnv(name, value);
    store = RunStore.open(join(repo, '.ai/cezar'), { keepLive: true });
    manager = new RunManager(store, repo, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 3 } }) }); track();
    controller = await DelegationController.start(); controller.attachProject({ id: 'integration', root: repo, store, manager });
  });
  afterEach(async () => {
    for (const run of store.listRuns()) manager.cancel(run.id);
    await until(() => store.listRuns().every(run => !manager.isActive(run.id)), 'all sessions stopped');
    await Promise.all(executions.splice(0)); await Promise.all(turns.splice(0));
    manager.dispose(); store.flush(); await controller.close();
    environments.clear(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
  }, 30_000);
  async function input(id: string, turn = 1) {
    const path = join(control, `${id}.${turn}.input.json`);
    await until(() => existsSync(path), `wire receives ${id} turn ${turn}`);
    return JSON.parse(readFileSync(path, 'utf8')) as { text: string; cwd: string; backend: string };
  }
  function reply(id: string, turn: number, value: { text?: string; commit?: string; error?: string } = {}) {
    const path = join(control, `${id}.${turn}.reply.json`);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, path);
  }
  async function command<T = Record<string, unknown>>(id: string, args: string[], code = 0): Promise<T> {
    const result = await execFile(process.execPath, ['--import', import.meta.resolve('tsx'), entry, 'worker', ...args], {
      cwd: root, env: { ...process.env, ...environments.get(id), PATH: '' }, timeout: 45_000,
    }).then(value => ({ ...value, code: 0 }), (error: { stdout: string; stderr: string; code: number }) => error);
    expect(result.stderr).toBe(''); expect(result.code, result.stdout).toBe(code);
    return JSON.parse(result.stdout) as T;
  }
  async function parent() {
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'Coordinate independent implementations', runner: 'claude' });
    await input(run.id); return run;
  }
  async function spawn(parentId: string, backend: 'claude' | 'codex', task: string, context = 'Only selected context') {
    const result = await command<WorkerSpawnResult>(parentId, ['spawn', '--baseline', 'parent-head', '--request-id', randomUUID(), '--backend', backend, '--context', context, task]);
    await input(result.workerId); return result.workerId;
  }
  async function settled(id: string, status = 'review') {
    await until(() => store.getRun(id)?.status === status, `${id} reaches ${status}`);
    expect(await manager.awaitRunTermination(id, 15_000)).toBe(true);
  }
  async function finishWorker(parentId: string, id: string, change: string) {
    reply(id, 1); await until(() => store.getRun(id)?.status === 'waiting', 'worker ready for steering');
    expect(['queued', 'delivered']).toContain((await command(parentId, ['steer', id, `Commit ${change} and report the result`])).state);
    expect((await input(id, 2)).text).toContain(`Commit ${change}`);
    await until(() => store.getRun(id)?.agentInputs?.some(item => item.source === 'agent' && !!item.deliveredAt) === true, 'steering delivery persisted');
    expect(store.readEvents(id).filter(event => event.type === 'user-message')).toEqual([]);
    reply(id, 2, { commit: change, text: `Implemented ${change}; Git commit ready for inspection.\nCEZ:DONE` });
    await settled(id);
  }
  const collect = (parentId: string, id: string) => command<WorkerCollectedResult>(parentId, ['collect', id]);
  const destroy = (parentId: string, id: string, code = 0) => command<WorkerDestroyResult>(parentId, ['destroy', id], code);

  // Catches lost gate/wake wiring, backend/context mixing, mistaken auto-integration,
  // and removal of the only retained evidence during real branch cleanup failure.
  it('coordinates two isolated backends, explicitly integrates a reviewed commit, and retries cleanup after restart', async () => {
    const p = await parent(); const parentPath = (await input(p.id)).cwd;
    const baseline = git(parentPath, 'rev-parse', 'HEAD');
    writeFileSync(join(parentPath, 'untracked-parent.txt'), 'private parent scratch');
    const a = await spawn(p.id, 'claude', 'Implement alpha', 'Alpha selected context');
    const b = await spawn(p.id, 'codex', 'Implement beta', 'Beta selected context');
    const firstA = await input(a); const firstB = await input(b);
    expect(firstA).toMatchObject({ backend: 'claude', text: expect.stringContaining('Alpha selected context') });
    expect(firstB).toMatchObject({ backend: 'codex', text: expect.stringContaining('Beta selected context') });
    expect(firstB.text).not.toContain('Alpha selected context');
    expect(new Set([parentPath, firstA.cwd, firstB.cwd]).size).toBe(3);
    for (const path of [firstA.cwd, firstB.cwd]) {
      expect(git(path, 'rev-parse', 'HEAD')).toBe(baseline);
      expect(existsSync(join(path, 'untracked-parent.txt'))).toBe(false);
    }
    rmSync(join(parentPath, 'untracked-parent.txt'));
    expect(environments.get(a)?.CEZ_DELEGATION_TOKEN).not.toBe(environments.get(p.id)?.CEZ_DELEGATION_TOKEN);
    expect(environments.get(b)?.CEZ_DELEGATION_TOKEN).not.toBe(environments.get(a)?.CEZ_DELEGATION_TOKEN);

    reply(p.id, 1, { text: 'Attempted completion before observing workers\nCEZ:DONE' });
    await until(() => store.getRun(p.id)?.delegation?.role === 'root' && store.getRun(p.id)?.status === 'waiting', 'early completion parks');
    const gate = store.getRun(p.id)!.delegation;
    if (gate?.role !== 'root' || !gate.wait) throw Error('completion wait absent');
    expect(gate).toMatchObject({ completion: { phase: 'waiting' }, wait: { mode: 'all', phase: 'parked' } });
    expect(new Set(gate.wait.workerIds)).toEqual(new Set([a, b]));
    expect(manager.finish(p.id)).toBe(false);
    const cancelledWait = await command(p.id, ['cancel-wait', gate.wait.id]);
    expect(cancelledWait).toHaveProperty('wait.reason', 'cancelled');
    await input(p.id, 2); reply(p.id, 2);
    await until(() => store.getRun(p.id)?.status === 'waiting', 'parent finishes cancellation receipt');
    const wait = await command<WorkerWaitResult>(p.id, ['wait', a, b, '--mode', 'any']);
    expect(wait.wait.mode).toBe('any');
    await finishWorker(p.id, a, 'alpha');
    await input(p.id, 3); reply(p.id, 3);
    await until(() => store.getRun(p.id)?.status === 'waiting', 'parent observes wait-any wake');
    expect(store.getRun(p.id)?.agentInputs?.filter(item => item.id === wait.wait.id && item.deliveredAt)).toHaveLength(1);
    expect(store.getRun(b)?.status).toBe('running');
    expect(await collect(p.id, b)).toMatchObject({ backend: 'codex', settled: false, partial: true });
    const resultA = await collect(p.id, a);
    expect(resultA).toMatchObject({ status: 'review', outcome: 'review-ready', settled: true, partial: false, summary: { text: expect.stringContaining('Implemented alpha') }, head: { state: 'available' }, diff: { state: 'available' } });
    expect(await command<WorkerInspection>(p.id, ['inspect', a])).toMatchObject({ status: 'review', backend: 'claude', parentRunId: p.id });
    expect(manager.finish(p.id)).toBe(false);
    await finishWorker(p.id, b, 'beta');
    const resultB = await collect(p.id, b);
    expect(resultB).toMatchObject({ backend: 'codex', settled: true, partial: false, summary: { text: expect.stringContaining('Implemented beta') } });
    if (resultA.head.state !== 'available' || resultB.head.state !== 'available' || resultA.diff.state !== 'available') throw Error('review evidence absent');
    const betaHead = resultB.head.sha;
    expect(JSON.parse(readFileSync(resultA.diff.path, 'utf8')).diffSnapshot).toContain('+alpha');
    expect(git(parentPath, 'rev-parse', 'HEAD')).toBe(baseline);
    expect(readFileSync(join(parentPath, 'shared.txt'), 'utf8')).toBe('baseline\n');
    git(parentPath, 'cherry-pick', resultA.head.sha);
    const integratedHead = git(parentPath, 'rev-parse', 'HEAD');
    expect(readFileSync(join(parentPath, 'shared.txt'), 'utf8')).toBe('alpha\n');
    expect(() => git(parentPath, 'cherry-pick', betaHead)).toThrow();
    expect(git(parentPath, 'diff', '--name-only', '--diff-filter=U')).toBe('shared.txt');
    git(parentPath, 'cherry-pick', '--abort');
    expect(git(parentPath, 'rev-parse', 'HEAD')).toBe(integratedHead);
    expect(git(parentPath, 'diff', '--name-only', '--diff-filter=U')).toBe('');
    expect(readFileSync(join(parentPath, 'shared.txt'), 'utf8')).toBe('alpha\n');

    // Actual Git CAS failure after worktree removal, not a stubbed cleanup result.
    const branchLock = git(repo, 'rev-parse', '--git-path', `refs/heads/${resultA.workspace.branch}.lock`);
    const lockPath = join(repo, branchLock); writeFileSync(lockPath, 'held by integration test');
    expect(await destroy(p.id, a, 1)).toMatchObject({ state: 'incomplete', remaining: ['branch'], deleted: [{ kind: 'worktree', path: firstA.cwd }] });
    expect(existsSync(firstA.cwd)).toBe(false);
    expect(git(repo, 'rev-parse', `refs/heads/${resultA.workspace.branch}`)).toBe(resultA.head.sha);
    expect(store.canDeleteRun(a)).toBe(false);
    expect(store.readWorkerResultDiff(p.id, a)).toContain('+alpha');
    expect(await destroy(p.id, b)).toMatchObject({ state: 'complete', remaining: [] });
    expect(manager.finish(p.id)).toBe(true);
    await until(() => !manager.isActive(p.id), 'parent session closes at review');
    expect(store.getRun(p.id)?.status).toBe('review');
    await Promise.all(executions.splice(0)); await Promise.all(turns.splice(0));
    manager.dispose(); store.flush(); await controller.close();
    store = RunStore.open(join(repo, '.ai/cezar'), { keepLive: true });
    manager = new RunManager(store, repo); track();
    controller = await DelegationController.start(); controller.attachProject({ id: 'integration', root: repo, store, manager });
    await manager.recover();
    expect(store.getRun(p.id)?.status).toBe('review');
    expect(store.readWorkerResultDiff(p.id, a)).toContain('+alpha');
    expect(store.getRun(a)?.delegation).toMatchObject({ destroy: { phase: 'incomplete', remaining: ['branch'] } });
    for (const path of readdirSync(control).filter(path => path.startsWith(p.id))) rmSync(join(control, path));
    expect(manager.continueRun(p.id, { text: 'Retry owned cleanup and inspect retained evidence' }).ok).toBe(true);
    await input(p.id); rmSync(lockPath);
    expect(await destroy(p.id, a)).toMatchObject({ state: 'complete', remaining: [] });
    expect(await destroy(p.id, a)).toMatchObject({ state: 'complete', remaining: [] });
    const app = createApp({ repoRoot: repo, store, manager, version: 'test', bootProjectId: 'integration' });
    for (const id of [a, b]) {
      const response = await app.request(`http://127.0.0.1/api/v1/runs/${id}`, { method: 'DELETE', headers: { host: '127.0.0.1' } });
      expect(response.status, await response.text()).toBe(200);
      expect(store.getRun(id)).toBeUndefined();
      expect(existsSync(join(repo, '.ai/cezar/runs', `${id}.ndjson`))).toBe(false);
      expect(await collect(p.id, id)).toMatchObject({ outcome: 'destroyed', settled: true, cleanup: 'complete', workspace: { state: 'deleted' }, summary: { state: 'available' }, diff: { state: 'available' }, head: { state: 'deleted' } });
    }
    expect(store.readWorkerResultDiff(p.id, a)).toContain('+alpha');
    expect(store.readWorkerResultDiff(p.id, b)).toContain('+beta');
    expect(git(parentPath, 'show', 'HEAD:shared.txt')).toBe('alpha');
    expect(git(parentPath, 'rev-parse', 'HEAD')).toBe(integratedHead);
    const publicState = JSON.stringify([store.listRuns(), ...store.listRuns().map(run => store.readEvents(run.id))]);
    for (const env of environments.values()) expect(publicState).not.toContain(env.CEZ_DELEGATION_TOKEN!);
    reply(p.id, 1, { text: 'Reviewed alpha integration; beta conflict deliberately aborted.\nCEZ:DONE' });
    await until(() => store.getRun(p.id)?.status === 'review', 'collected deleted workers permit honest parent review');
  }, 120_000);

  it('reports a real provider failure and a stopped worker without allowing peer authority or premature success', async () => {
    const p = await parent(); const failed = await spawn(p.id, 'codex', 'Exercise provider failure'); const stopped = await spawn(p.id, 'claude', 'Exercise explicit stop');
    expect(await command(failed, ['steer', stopped, 'Unauthorized peer steering'], 1)).toMatchObject({ code: 'denied_scope' });
    expect(store.getRun(stopped)?.agentInputs).toBeUndefined();
    expect(await command(failed, ['spawn', '--baseline', 'parent-head', '--request-id', randomUUID(), 'Unauthorized nested worker'], 1)).toMatchObject({ code: 'denied_scope' });
    expect(store.listRuns()).toHaveLength(3);
    reply(p.id, 1); await until(() => store.getRun(p.id)?.status === 'waiting', 'parent idle');
    const wait = await command<WorkerWaitResult>(p.id, ['wait', failed, stopped, '--mode', 'all']);
    reply(failed, 1, { error: 'integration provider unavailable' }); await settled(failed, 'failed');
    expect(store.getRun(p.id)?.agentInputs?.some(item => item.id === wait.wait.id && item.deliveredAt)).not.toBe(true);
    expect(['stopping', 'terminated']).toContain((await command(p.id, ['stop', stopped])).state); await settled(stopped, 'cancelled');
    expect(await command(p.id, ['stop', stopped])).toMatchObject({ state: 'terminated' });
    await input(p.id, 2); reply(p.id, 2);
    expect(manager.finish(p.id)).toBe(false);
    expect(await collect(p.id, failed)).toMatchObject({ outcome: 'failed', lastExecutionOutcome: 'failed', partial: true, settled: true, error: expect.stringContaining('integration provider unavailable') });
    expect(await collect(p.id, stopped)).toMatchObject({ outcome: 'cancelled', partial: true, settled: true });
    expect(await command(p.id, ['steer', stopped, 'Late input must not reopen'], 1)).toMatchObject({ code: 'incompatible_state' });
    expect(store.getRun(stopped)?.status).toBe('cancelled');
    expect(manager.finish(p.id)).toBe(true);
    await until(() => store.getRun(p.id)?.status === 'done', 'collected failures allow explicit human Finish');
  }, 90_000);

  it('parent cancellation proves live child termination while preserving another child review worktree', async () => {
    const p = await parent(); const completed = await spawn(p.id, 'claude', 'Complete useful work'); const live = await spawn(p.id, 'codex', 'Long running work');
    await finishWorker(p.id, completed, 'retained');
    const result = await collect(p.id, completed);
    manager.cancel(p.id);
    await settled(live, 'cancelled');
    await until(() => !manager.isActive(p.id), 'cancelled parent closes');
    expect(store.getRun(p.id)?.status).toBe('cancelled');
    expect(store.getRun(completed)?.status).toBe('review');
    expect(readFileSync(join(result.workspace.path, 'shared.txt'), 'utf8')).toBe('retained\n');
    expect(store.readWorkerResultDiff(p.id, completed)).toContain('+retained');
    expect(store.readWorkerExecution(live)?.phase).toBe('complete');
    expect(store.getRun(live)?.worktreePath && existsSync(store.getRun(live)!.worktreePath!)).toBe(true);
  }, 90_000);
});
