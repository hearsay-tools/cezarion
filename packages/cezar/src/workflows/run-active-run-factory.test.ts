import { runInternals } from './run-internals.testkit.ts';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { Skill } from '../skills.ts';
import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { createActiveRun, type ActiveRun } from './active-run.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * One factory builds every `ActiveRun`, and one loader writes its skill registry
 * (hearsay-tools/cezarion#1806). open-mercato/cezar#811 set `state.skills` in `execute` and not in
 * `runContinuation`, so registry `/skill` expansion failed on every Continue and every restart
 * recovery. These cases pin what each entry path gets, with no live session to lean on.
 *
 * Which existing tests cover which path:
 * - `execute`: `run.test.ts` "registry /skill expansion on a fresh run's opening prompt", and
 *   harness parity R48, which drives both construction sites on every runner.
 * - Continue: `run.test.ts` "registry /skill expansion survives a continuation", on a finished run that
 *   has no live session.
 * - Restart recovery: the case below; no earlier test reached the skill registry after `recover()`.
 */
describe('createActiveRun', () => {
  it('sets every field a run starts with, to what the two literals set before the factory', () => {
    const state = createActiveRun({ cwd: '/work/tree', pendingHumanAsk: true, autonomous: true });
    // The keys the `execute` and `runContinuation` literals both set. A field added to `ActiveRun`
    // as required fails to compile in the factory; an optional one lands here.
    expect(Object.keys(state).sort()).toEqual([
      'autonomous', 'cancelled', 'cwd', 'delegationSettings', 'interrupt', 'pendingHumanAsk',
      'pendingPermissions', 'revokeDelegation',
    ]);
    expect(state).toMatchObject({ cwd: '/work/tree', pendingHumanAsk: true, autonomous: true, cancelled: false });
    expect(state.delegationSettings).toBeUndefined();
    expect(state.revokeDelegation).toBeUndefined();
    expect(state.interrupt()).toBeUndefined();
    expect(state.pendingPermissions).toEqual(new Set());
    // The registry is loaded after the run is registered, by `loadRunSkills`, never by the factory.
    expect(state.skills).toBeUndefined();
  });

  it('takes cwd, the pending ask and the mode from its caller, and shares no mutable state', () => {
    const first = createActiveRun({ cwd: '/a', pendingHumanAsk: false, autonomous: false });
    const second = createActiveRun({ cwd: '/b', pendingHumanAsk: true, autonomous: true });
    expect(first).toMatchObject({ cwd: '/a', pendingHumanAsk: false, autonomous: false });
    expect(second).toMatchObject({ cwd: '/b', pendingHumanAsk: true, autonomous: true });
    first.pendingPermissions?.add('p');
    expect(second.pendingPermissions?.size).toBe(0);
  });
});

describe('loading a run\'s skill registry', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const skill = (name: string): Skill => ({ name, description: name, body: `${name} body`, path: `/skills/${name}.md`, source: 'cezar' });
  const internals = () => runInternals(manager).runSkills;
  const freshState = () => createActiveRun({ cwd: repoRoot, pendingHumanAsk: false, autonomous: false });

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-1806-loader-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot);
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    const discover = runInternals(manager).runSkills.discoverSkills;
    if (vi.isMockFunction(discover)) expect(discover).toHaveBeenCalled();
    vi.restoreAllMocks();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('stores the discovered registry', async () => {
    vi.spyOn(runInternals(manager).runSkills, 'discoverSkills').mockResolvedValue([skill('a')]);
    const state = freshState();
    await internals().loadRunSkills(state, 'throw');
    expect(internals().enabledSkills(state).map((s) => s.name)).toEqual(['a']);
  });

  it("a failed discovery with 'throw' rejects and leaves the registry as it was (a fresh run fails, as before)", async () => {
    vi.spyOn(runInternals(manager).runSkills, 'discoverSkills').mockResolvedValueOnce([skill('a')]).mockRejectedValueOnce(new Error('boom'));
    const state = freshState();
    await internals().loadRunSkills(state, 'throw');
    await expect(internals().loadRunSkills(state, 'throw')).rejects.toThrow('boom');
    expect(internals().enabledSkills(state).map((s) => s.name)).toEqual(['a']);
  });

  it("a failed discovery with 'ignore' resolves and keeps the registry it had (a Continue never breaks)", async () => {
    vi.spyOn(runInternals(manager).runSkills, 'discoverSkills').mockResolvedValueOnce([skill('a')]).mockRejectedValueOnce(new Error('boom'));
    const state = freshState();
    await internals().loadRunSkills(state, 'ignore');
    await expect(internals().loadRunSkills(state, 'ignore')).resolves.toBeUndefined();
    expect(internals().enabledSkills(state).map((s) => s.name)).toEqual(['a']);
  });

  it("a failed first discovery with 'ignore' leaves an empty registry", async () => {
    vi.spyOn(runInternals(manager).runSkills, 'discoverSkills').mockRejectedValue(new Error('boom'));
    const state = freshState();
    await expect(internals().loadRunSkills(state, 'ignore')).resolves.toBeUndefined();
    expect(internals().enabledSkills(state)).toEqual([]);
  });
});

describe('every entry path loads the registry, with no live session before it (open-mercato/cezar#811)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let runId: string | undefined;
  let savedDryRun: string | undefined;
  const SINGLE_STEP: WorkflowDef = {
    name: 'quick-task',
    source: 'built-in',
    steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-1806-'));
    savedDryRun = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await run('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await run('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.ai/cezar/skills'), { recursive: true });
    writeFileSync(
      join(repoRoot, '.ai/cezar/skills/demo-review.md'),
      '---\nname: demo-review\ndescription: Review a diff.\n---\n\nRun the demo review playbook.\n',
    );
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot);
    runId = undefined;
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    if (runId) manager.cancel(runId);
    const discover = runInternals(manager).runSkills.discoverSkills;
    if (vi.isMockFunction(discover)) expect(discover).toHaveBeenCalled();
    vi.restoreAllMocks();
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  // bound: a hang guard for a loaded host; each wait ends on the run's own status or registry.
  const waitFor = async (predicate: () => boolean, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() > deadline) {
        const run = runId ? store.getRun(runId) : undefined;
        const lifecycle = runId ? eventsOf(runId).filter((e) => e.type === 'lifecycle').slice(-6) : [];
        throw new Error(`condition not met in time; status ${run?.status}, error ${run?.error}, lifecycle ${JSON.stringify(lifecycle)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const eventsOf = (id: string) =>
    readFileSync(join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; text?: string; stepId?: string });
  const registryOf = (id: string): string[] | undefined => {
    const live = (manager as unknown as { active: Map<string, { skills?: Skill[] }> }).active.get(id);
    return live?.skills?.map((s) => s.name);
  };
  const expandedFollowUp = (id: string) =>
    eventsOf(id).some((e) => e.type === 'text' && e.text?.includes('Selected skill: /demo-review'));

  it('a fresh run (execute) loads it before its first step', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'do the first thing', worktree: false });
    runId = record.id;
    await waitFor(() => store.getRun(record.id)?.status === 'waiting');
    expect(registryOf(record.id)).toContain('demo-review');
  }, 40_000);

  it('a Continue of a finished run, which has no live session, loads it', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'do the first thing', worktree: false });
    runId = record.id;
    await waitFor(() => store.getRun(record.id)?.status === 'waiting');
    expect(manager.finish(record.id)).toBe(true);
    await waitFor(() => ['done', 'review'].includes(store.getRun(record.id)?.status ?? ''));
    expect((manager as unknown as { active: Map<string, unknown> }).active.has(record.id)).toBe(false);

    expect(manager.continueRun(record.id, { text: 'keep going' })).toEqual({ ok: true });
    await waitFor(() => store.getRun(record.id)?.status === 'waiting');
    expect(registryOf(record.id)).toContain('demo-review');
  }, 40_000);

  it('restart recovery of an interrupted run, in a manager that never held it, loads it', async () => {
    // The process died mid-turn: the record says `running` on a saved session and nothing else
    // survives, so the manager recovering it has no live session and no earlier ActiveRun.
    const record = store.createRun({
      title: 'interrupted', workflow: 'quick-task', task: 'do the first thing', runner: 'claude',
      steps: [{ id: 'task', name: 'Task', kind: 'agent' }],
    });
    runId = record.id;
    store.updateRun(record.id, { status: 'running', currentStepId: 'task', workflowDef: SINGLE_STEP });
    store.updateStep(record.id, 'task', { status: 'running', sessionId: 'sess-interrupted', backend: 'claude' });
    expect((manager as unknown as { active: Map<string, unknown> }).active.has(record.id)).toBe(false);

    await manager.recover();
    await waitFor(() => registryOf(record.id) !== undefined && store.getRun(record.id)?.status === 'waiting');
    expect(registryOf(record.id)).toContain('demo-review');
    expect(expandedFollowUp(record.id)).toBe(false);
    // The registry is what expands a follow-up: without it the backend answers "Unknown skill".
    expect(manager.sendMessage(record.id, [{ type: 'text', text: '/demo-review now review it' }])).toBe(true);
    await waitFor(() => expandedFollowUp(record.id));
  }, 60_000);

  it('a failed discovery fails a fresh run, as before the loader', async () => {
    vi.spyOn(runInternals(manager).runSkills, 'discoverSkills').mockRejectedValue(new Error('discovery boom'));
    const record = manager.startRun(SINGLE_STEP, { task: 'do the first thing', worktree: false });
    runId = record.id;
    await waitFor(() => store.getRun(record.id)?.status === 'failed');
    expect(store.getRun(record.id)?.error).toContain('engine crashed: discovery boom');
  }, 40_000);

  it('a failed discovery does not break a Continue, which runs with an empty registry', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'do the first thing', worktree: false });
    runId = record.id;
    await waitFor(() => store.getRun(record.id)?.status === 'waiting');
    expect(manager.finish(record.id)).toBe(true);
    await waitFor(() => ['done', 'review'].includes(store.getRun(record.id)?.status ?? ''));

    vi.spyOn(runInternals(manager).runSkills, 'discoverSkills').mockRejectedValue(new Error('discovery boom'));
    expect(manager.continueRun(record.id, { text: 'keep going' })).toEqual({ ok: true });
    await waitFor(() => store.getRun(record.id)?.status === 'waiting');
    expect(store.getRun(record.id)?.error).toBeUndefined();
    expect(registryOf(record.id) ?? []).toEqual([]);
  }, 40_000);
});
