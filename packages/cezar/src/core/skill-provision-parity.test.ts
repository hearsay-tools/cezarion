/**
 * hearsay-tools/cezarion#1408 (port of upstream open-mercato/cezar#1429): a task's selected skill and the
 * companions its body names are installed in the run's own task worktree on Start, Continue and
 * restart recovery, a live `/name` gets its companions and one agent input naming them, and Stop
 * during that preparation launches nothing — on every runner's own native mock wire.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUNNER_IDS, type RunnerId } from './agent-runner.ts';
import { HARNESS_ADAPTERS, SKILL_PROVISION_CRITERIA, promptFor, waitFor } from './harness-parity.testkit.ts';
import { readPersistedRuns, seedRuns } from '../runs/run-store.testkit.ts';
import { RunStore } from '../runs/store.ts';
import * as provision from '../skills-provision.ts';
import { createFixtureManager, drainFixtureManagers } from '../workflows/fixture-cleanup.testkit.ts';
import type { RunManager } from '../workflows/run.ts';
import { plannedWorkflow, skillTaskSteps } from '../workflows/types.ts';

const execFileAsync = promisify(execFile);
const GIT_IDENTITY = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const AGENT_DIRS = ['.claude', '.agents', '.cursor'];
const LEAD = 'lead-1408';
const HELPER = 'helper-1408';
const LIVE = 'live-1408';
const EXTRA = 'extra-1408';
const LIVE_NOTE = `Skills installed for /${LIVE}: ${LIVE}, ${EXTRA}.`;

afterEach(() => { vi.restoreAllMocks(); });

const fileText = (path: string) => existsSync(path) ? readFileSync(path, 'utf8') : '';

function writeSkill(repoRoot: string, name: string, body: string): void {
  mkdirSync(join(repoRoot, '.ai/cezar/skills', name), { recursive: true });
  writeFileSync(join(repoRoot, '.ai/cezar/skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n${body}\n`);
}

function installed(worktree: string, name: string): boolean {
  return AGENT_DIRS.every((dir) => fileText(join(worktree, dir, 'skills', name, 'SKILL.md')).includes(name));
}

function removeInstalled(worktree: string, name: string): void {
  for (const dir of AGENT_DIRS) rmSync(join(worktree, dir, 'skills', name), { recursive: true, force: true });
}

async function idleClose(manager: RunManager, runId: string): Promise<void> {
  type State = { idleTimer?: NodeJS.Timeout & { _onTimeout?: () => void } };
  const stateOf = () => (manager as unknown as { active: Map<string, State> }).active.get(runId);
  await waitFor(() => typeof stateOf()?.idleTimer?._onTimeout === 'function');
  stateOf()!.idleTimer!._onTimeout!();
  await waitFor(() => !manager.isActive(runId));
}

interface Fixture {
  repoRoot: string;
  runId: string;
  worktree: string;
  readonly store: RunStore;
  readonly manager: RunManager;
  wire(): string;
  restart(): Promise<void>;
}

async function withProvisionRun(
  backend: RunnerId,
  body: (fixture: Fixture) => Promise<void>,
  opts: { waitForPark?: boolean } = {},
): Promise<void> {
  const adapter = HARNESS_ADAPTERS[backend];
  const saved: Array<[string, string | undefined]> = [];
  const remember = (name: string, value: string | undefined) => {
    saved.push([name, process.env[name]]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  const repoRoot = mkdtempSync(join(tmpdir(), `cez-skill-provision-${backend}-`));
  const argsFile = join(repoRoot, 'wire.args.ndjson');
  const stdinFile = join(repoRoot, 'wire.stdin.ndjson');
  remember(adapter.binEnv, adapter.mockBin);
  remember('CEZ_AUTONAME', '0');
  remember('CEZ_MOCK_ARGS_FILE', argsFile);
  remember('CEZ_MOCK_STDIN_FILE', stdinFile);
  remember('CEZ_DRY_RUN', undefined);
  let store: RunStore | undefined;
  let manager: RunManager | undefined;
  try {
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    writeFileSync(join(repoRoot, '.gitignore'), 'wire.*\n');
    await execFileAsync('git', ['add', '-A'], { cwd: repoRoot });
    await execFileAsync('git', [...GIT_IDENTITY, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    // Untracked in the main checkout, so a fresh task worktree has none of them.
    writeSkill(repoRoot, LEAD, `then run ${HELPER}`);
    writeSkill(repoRoot, HELPER, 'HELPER-BODY-1408');
    writeSkill(repoRoot, LIVE, `then run ${EXTRA}`);
    writeSkill(repoRoot, EXTRA, 'EXTRA-BODY-1408');
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot);
    const started = manager.startRun(plannedWorkflow(skillTaskSteps(LEAD)), {
      task: promptFor(backend, 'baseline'),
      runner: backend,
      worktree: true,
    });
    if (opts.waitForPark !== false) await waitFor(() => store!.getRun(started.id)?.status === 'waiting', 30_000);
    const restart = async () => {
      store!.flush();
      const dataDir = join(repoRoot, '.ai/cezar');
      const checkpoint = readPersistedRuns(dataDir);
      await drainFixtureManagers(repoRoot);
      store!.close();
      seedRuns(dataDir, checkpoint);
      store = RunStore.open(dataDir, { keepLive: true });
      manager = createFixtureManager(store, repoRoot);
      await manager.recover();
    };
    await body({
      repoRoot,
      runId: started.id,
      get worktree() { return store!.getRun(started.id)?.worktreePath ?? ''; },
      get store() { return store!; },
      get manager() { return manager!; },
      wire: () => fileText(argsFile) + fileText(stdinFile),
      restart,
    });
  } finally {
    await drainFixtureManagers(repoRoot);
    store?.close();
    for (const [name, value] of saved.reverse()) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

const parked = (fixture: Fixture) => fixture.store.getRun(fixture.runId)?.status === 'waiting' && fixture.manager.isActive(fixture.runId);

function liveProvisioning(fixture: Fixture): Promise<void> | undefined {
  return (fixture.manager as unknown as { active: Map<string, { liveSkillProvisioning?: Promise<void> }> })
    .active.get(fixture.runId)?.liveSkillProvisioning;
}

describe('harness parity — skill provisioning (#1408)', () => {
  expect(SKILL_PROVISION_CRITERIA.map((row) => row.id)).toEqual(['R92', 'R93', 'R94', 'R95', 'R96']);

  for (const backend of RUNNER_IDS) {
    it(`${backend} R92 provisions the selected skill and its companions on Start`, async () => {
      await withProvisionRun(backend, async (fixture) => {
        expect(fixture.worktree).not.toBe('');
        expect(installed(fixture.worktree, LEAD)).toBe(true);
        expect(installed(fixture.worktree, HELPER)).toBe(true);
        // Mock runners may leave files of their own; nothing under a skills dir shows.
        const status = await execFileAsync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: fixture.worktree });
        expect(status.stdout.split('\n').filter((line) => line.includes('skills/'))).toEqual([]);
      });
    }, 60_000);

    it(`${backend} R93 provisions the selected skill's companions on an ordinary Continue`, async () => {
      await withProvisionRun(backend, async (fixture) => {
        await idleClose(fixture.manager, fixture.runId);
        removeInstalled(fixture.worktree, HELPER);
        expect(fixture.manager.continueRun(fixture.runId, { text: promptFor(backend, 'baseline') }).ok).toBe(true);
        await waitFor(() => parked(fixture), 30_000);
        expect(installed(fixture.worktree, HELPER)).toBe(true);
      });
    }, 60_000);

    it(`${backend} R94 provisions them when recover() resumes a continuation with no live session`, async () => {
      await withProvisionRun(backend, async (fixture) => {
        await idleClose(fixture.manager, fixture.runId);
        removeInstalled(fixture.worktree, HELPER);
        expect(fixture.manager.continueRun(fixture.runId, { text: promptFor(backend, 'baseline') }).ok).toBe(true);
        expect(fixture.store.getRun(fixture.runId)?.continuationMessage).toBeDefined();
        await fixture.restart();
        await waitFor(() => parked(fixture), 30_000);
        expect(installed(fixture.worktree, HELPER)).toBe(true);
      });
    }, 90_000);

    it(`${backend} R95 delivers a live /name, then one input naming what was installed`, async () => {
      await withProvisionRun(backend, async (fixture) => {
        expect(fixture.manager.sendMessage(fixture.runId, [{ type: 'text', text: `/${LIVE} go${backend === 'codex' ? ' mock:steer-race' : ''}` }])).toBe(true);
        await liveProvisioning(fixture);
        expect(installed(fixture.worktree, EXTRA)).toBe(true);
        // A fast mock turn can park on a new question first; the input then waits for its answer,
        // which this second message is. Nothing new installs for it, so no second input follows.
        expect(fixture.manager.sendMessage(fixture.runId, [{ type: 'text', text: `/${LIVE} again` }])).toBe(true);
        await liveProvisioning(fixture);
        await waitFor(() => fixture.wire().includes(LIVE_NOTE) && fixture.wire().includes('again'), 30_000);
        await waitFor(() => parked(fixture), 30_000);
        const notes = fixture.store.getRun(fixture.runId)?.agentInputs?.filter(input => input.text === LIVE_NOTE);
        expect(notes).toHaveLength(1);
        expect(notes![0]!.deliveredAt).toBeDefined();
        if (backend === 'codex') {
          // A refused steer is retried as turn/start with the SAME client id. Counting RPC
          // text counts that unread attempt twice. Keep one durable input and one wire identity.
          // hearsay-tools/cezarion#2071: proof_base=f389b6838; mock:steer-race gives
          // 1 failed / 4 skipped before this fix, 1 passed / 4 skipped after it.
          const requests = fixture.wire().trim().split('\n').map(line => JSON.parse(line))
            .filter(request => request.params?.input?.some((part: { text?: string }) => part.text === LIVE_NOTE));
          expect(requests[0].params.clientUserMessageId).toBeTruthy();
          expect(new Set(requests.map(request => request.params.clientUserMessageId)).size).toBe(1);
          expect(notes![0]!.consumedAt).toBeDefined();
        } else {
          expect(fixture.wire().split(LIVE_NOTE).length - 1).toBe(1);
        }
      });
    }, 90_000);

    it(`${backend} R96 Stop during skill preparation launches nothing`, async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const real = provision.provisionSkills;
      const spy = vi.spyOn(provision, 'provisionSkills').mockImplementation(async (...args) => {
        await held;
        return real(...args);
      });
      await withProvisionRun(backend, async (fixture) => {
        await waitFor(() => spy.mock.calls.length > 0, 30_000);
        expect(fixture.manager.cancel(fixture.runId)).toBe(true);
        release();
        await waitFor(() => !fixture.manager.isActive(fixture.runId), 30_000);
        expect(fixture.store.getRun(fixture.runId)?.status).toBe('cancelled');
        expect(fixture.wire()).toBe('');
        // The held preparation resumed after Stop: it wrote nothing either.
        expect(fixture.worktree).not.toBe('');
        expect(existsSync(fixture.worktree)).toBe(true);
        expect(installed(fixture.worktree, LEAD)).toBe(false);
      }, { waitForPark: false });
    }, 60_000);
  }
});
