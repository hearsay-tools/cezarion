import { testHome } from '../home/test-home.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { skillSchema } from '@open-mercato/cezar-contract/skills';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RUN_STATUS,
  STEP_KIND,
  STEP_STATUS,
} from '@open-mercato/cezar-contract/test-factories.testkit';
import { RunStore } from '../runs/store.ts';
import { discoverSkills, type Skill } from '../skills.ts';
import { RunSkills } from './run/run-skills.ts';
import { TrackedWork } from './run/tracked-work.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { createFixtureManager, drainFixtureManagers } from './fixture-claude.testkit.ts';
import { createActiveRun } from './active-run.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';
import { noRunners } from '../core/runners-under-test.testkit.ts';

vi.mock('../skills.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../skills.ts')>();
  return { ...actual, discoverSkills: vi.fn(actual.discoverSkills) };
});

const unused = (): never => { throw new Error('unused RunSkills host method called'); };
const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * One factory builds every `ActiveRun`, and one loader writes its skill registry
 * (hearsay-tools/cezarion#1806). open-mercato/cezar#811 set `state.skills` in `execute` and not in
 * `runContinuation`, so registry `/skill` expansion failed on every Continue and every restart
 * recovery. These cases pin what each entry path gets, with no live session to lean on.
 *
 * Which existing tests cover which path:
 * - `execute`: `run-continue-recovery.test.ts` "registry /skill expansion on a fresh run's opening prompt", and
 *   harness parity R48, which drives both construction sites on every runner.
 * - Continue: `run-continue-recovery.test.ts` "registry /skill expansion survives a continuation", on a finished run that
 *   has no live session.
 * - Restart recovery: the case below; no earlier test reached the skill registry after `recover()`.
 */
describe('createActiveRun', () => {
  it('sets every field a run starts with, to what the two literals set before the factory', () => {
    const state = createActiveRun({ cwd: '/work/tree', pendingHumanAsk: true, autonomous: true });
    // The keys the `execute` and `runContinuation` literals both set. A field added to `ActiveRun`
    // as required fails to compile in the factory; an optional one lands here.
    expect(Object.keys(state).sort()).toEqual([
      'autosave', 'boundary', 'children', 'inputState', 'liveSession', 'skills', 'usage', 'waitIdentity',
    ]);
    expect(state).toMatchObject({ liveSession: { cwd: '/work/tree', cancelled: false }, boundary: { pendingHumanAsk: true, autonomous: true } });
    expect(Object.isFrozen(state)).toBe(true);
    expect(state.waitIdentity.ciTurnId).toBeUndefined();
    expect(state.autosave.autosaveTimer).toBeUndefined();
    expect(state.liveSession.delegationSettings).toBeUndefined();
    expect(state.liveSession.revokeDelegation).toBeUndefined();
    expect(state.liveSession.interrupt()).toBeUndefined();
    expect([...state.liveSession.pendingPermissions]).toEqual([]);
    // No native subagent is known before a session reports one (hearsay-tools/cezarion#2431).
    expect([...state.children.backgroundChildren]).toEqual([]);
    // The registry is loaded after the run is registered, by `loadRunSkills`, never by the factory.
    expect(state.skills.catalog).toBeUndefined();
  });

  it('takes cwd, the pending ask and the mode from its caller, and shares no mutable state', () => {
    const first = createActiveRun({ cwd: '/a', pendingHumanAsk: false, autonomous: false });
    const second = createActiveRun({ cwd: '/b', pendingHumanAsk: true, autonomous: true });
    expect(first).toMatchObject({ liveSession: { cwd: '/a' }, boundary: { pendingHumanAsk: false, autonomous: false } });
    expect(second).toMatchObject({ liveSession: { cwd: '/b' }, boundary: { pendingHumanAsk: true, autonomous: true } });
    first.liveSession.requestPermission('p');
    expect(second.liveSession.pendingPermissions?.size).toBe(0);
    expect(first.children).not.toBe(second.children);
    expect(first.children.backgroundChildren).not.toBe(second.children.backgroundChildren);
    expect(second.children.backgroundChildren.size).toBe(0);
  });
});

describe('loading a run\'s skill registry', () => {
  let repoRoot: string;
  let store: RunStore;
  const skill = (name: string): Skill => ({ name, description: name, body: `${name} body`, path: `/skills/${name}.md`, source: skillSchema.shape.source.enum.cezar });
  let runSkills: RunSkills;
  const loader = () => runSkills;
  const freshState = () => createActiveRun({ cwd: repoRoot, pendingHumanAsk: false, autonomous: false });

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-1806-loader-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    runSkills = new RunSkills({ createRunner: noRunners, home: testHome(), store, repoRoot, dataDir: join(repoRoot, '.ai/cezar'),
      semaphore: new WorkspaceSemaphore({ home: testHome() }), work: new TrackedWork(), disposed: () => false }, {
      builtinSkills: () => [], workerExecutionStopped: unused, isCurrentState: unused, flushAgentInputs: unused,
    });
  });

  afterEach(() => {
    expect(discoverSkills).toHaveBeenCalled();
    vi.mocked(discoverSkills).mockReset();
    vi.restoreAllMocks();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('stores the discovered registry', async () => {
    vi.mocked(discoverSkills).mockResolvedValue([skill('a')]);
    const state = freshState();
    await loader().loadRunSkills(state, 'throw');
    expect(loader().enabledSkills(state).map((s) => s.name)).toEqual(['a']);
  });

  it("a failed discovery with 'throw' rejects and leaves the registry as it was (a fresh run fails, as before)", async () => {
    vi.mocked(discoverSkills).mockResolvedValueOnce([skill('a')]).mockRejectedValueOnce(new Error('boom'));
    const state = freshState();
    await loader().loadRunSkills(state, 'throw');
    await expect(loader().loadRunSkills(state, 'throw')).rejects.toThrow('boom');
    expect(loader().enabledSkills(state).map((s) => s.name)).toEqual(['a']);
  });

  it("a failed discovery with 'ignore' resolves and keeps the registry it had (a Continue never breaks)", async () => {
    vi.mocked(discoverSkills).mockResolvedValueOnce([skill('a')]).mockRejectedValueOnce(new Error('boom'));
    const state = freshState();
    await loader().loadRunSkills(state, 'ignore');
    await expect(loader().loadRunSkills(state, 'ignore')).resolves.toBeUndefined();
    expect(loader().enabledSkills(state).map((s) => s.name)).toEqual(['a']);
  });

  it('a team source disabled after the registry loaded drops its skills (hearsay-tools/cezarion#279)', async () => {
    const team = (name: string, repo: string): Skill => ({
      ...skill(name), source: 'team', team: { repo, ref: 'main', path: `commands/${name}.md`, dir: false },
    });
    vi.mocked(discoverSkills).mockResolvedValue([skill('a'), team('t', 'acme/one'), team('u', 'acme/two')]);
    const state = freshState();
    await loader().loadRunSkills(state, 'throw');
    expect(loader().enabledSkills(state).map((s) => s.name)).toEqual(['a', 't', 'u']);
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar/config.json'), JSON.stringify({
      skillsRepos: [{ repo: 'acme/one', enabled: false }, { repo: 'acme/two' }],
    }));
    expect(loader().enabledSkills(state).map((s) => s.name)).toEqual(['a', 'u']);
  });

  it("a failed first discovery with 'ignore' leaves an empty registry", async () => {
    vi.mocked(discoverSkills).mockRejectedValue(new Error('boom'));
    const state = freshState();
    await expect(loader().loadRunSkills(state, 'ignore')).resolves.toBeUndefined();
    expect(loader().enabledSkills(state)).toEqual([]);
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
    expect(discoverSkills).toHaveBeenCalled();
    vi.mocked(discoverSkills).mockReset();
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
  const expandedFollowUp = (id: string) =>
    eventsOf(id).some((e) => e.type === 'text' && e.text?.includes('Selected skill: /demo-review'));

  it('a fresh run (execute) loads it before its first step', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'do the first thing', worktree: false });
    runId = record.id;
    await waitFor(() => store.getRun(record.id)?.status === 'waiting');
    expect(manager.sendMessage(record.id, [{ type: 'text', text: '/demo-review now review it' }])).toBe(true);
    await waitFor(() => expandedFollowUp(record.id));
  }, 40_000);

  it('a Continue of a finished run, which has no live session, loads it', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'do the first thing', worktree: false });
    runId = record.id;
    await waitFor(() => store.getRun(record.id)?.status === 'waiting');
    expect(manager.finish(record.id)).toBe(true);
    await waitFor(() => ['done', 'review'].includes(store.getRun(record.id)?.status ?? ''));
    expect(store.getRun(record.id)?.currentStepId).toBeUndefined();

    expect(manager.continueRun(record.id, { text: 'keep going' })).toEqual({ ok: true });
    await waitFor(() => store.getRun(record.id)?.status === 'waiting');
    expect(manager.sendMessage(record.id, [{ type: 'text', text: '/demo-review now review it' }])).toBe(true);
    await waitFor(() => expandedFollowUp(record.id));
  }, 40_000);

  it('restart recovery of an interrupted run, in a manager that never held it, loads it', async () => {
    // The process died mid-turn: the record says `running` on a saved session and nothing else
    // survives, so the manager recovering it has no live session and no earlier ActiveRun.
    const record = store.createRun({
      title: 'interrupted', workflow: 'quick-task', task: 'do the first thing', runner: 'claude',
      steps: [{ id: 'task', name: 'Task', kind: STEP_KIND.agent }],
    });
    runId = record.id;
    setRunStatus(store, record.id, RUN_STATUS.running, { currentStepId: 'task', workflowDef: SINGLE_STEP });
    store.updateStep(record.id, 'task', { status: STEP_STATUS.running, sessionId: 'sess-interrupted', backend: 'claude' });
    expect(store.getRun(record.id)?.currentStepId).toBe('task');

    await manager.recover();
    await waitFor(() => store.getRun(record.id)?.status === 'waiting');
    expect(expandedFollowUp(record.id)).toBe(false);
    // The registry is what expands a follow-up: without it the backend answers "Unknown skill".
    expect(manager.sendMessage(record.id, [{ type: 'text', text: '/demo-review now review it' }])).toBe(true);
    await waitFor(() => expandedFollowUp(record.id));
  }, 60_000);

  it('a failed discovery fails a fresh run, as before the loader', async () => {
    vi.mocked(discoverSkills).mockRejectedValue(new Error('discovery boom'));
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

    vi.mocked(discoverSkills).mockRejectedValue(new Error('discovery boom'));
    expect(manager.continueRun(record.id, { text: 'keep going' })).toEqual({ ok: true });
    await waitFor(() => store.getRun(record.id)?.status === 'waiting');
    expect(store.getRun(record.id)?.error).toBeUndefined();
    expect(manager.sendMessage(record.id, [{ type: 'text', text: '/demo-review now review it mock:agent-echo' }])).toBe(true);
    await waitFor(() => eventsOf(record.id).some((event) => event.type === 'text' && event.text?.includes('/demo-review now review it mock:agent-echo')));
    expect(expandedFollowUp(record.id)).toBe(false);
  }, 40_000);
});
