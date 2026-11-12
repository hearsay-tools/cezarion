import { testHome } from '../home/test-home.testkit.ts';
import { createFixtureManager, drainFixtureManagers, fixtureWork } from './fixture-cleanup.testkit.ts';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeEach, vi } from 'vitest';
import { observationClock } from '../core/observation-clock.testkit.ts';
import { IDLE_TIMEOUT_MS } from './run/constants.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import type { UiEvent } from '../core/ui-events.ts';
import type { AgentRunner } from '../core/agent-runner.ts';
import * as runnerFactory from '../core/runner-factory.ts';
import { useRunners } from '../core/runners-under-test.testkit.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';
import type { TimerWaitEntry } from '@open-mercato/cezar-contract/waits';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { readPersistedRuns } from '../runs/run-store.testkit.ts';


const hoistedRunnerHook = vi.hoisted(() => ({ runner: undefined as AgentRunner | undefined, ui: undefined as ((event: UiEvent) => void) | undefined }));

const originalStarts = new WeakMap<AgentRunner, AgentRunner['startSession']>();
useRunners((...args) => {
  const runner = hoistedRunnerHook.runner ?? runnerFactory.createRunner(...args);
  const start = originalStarts.get(runner) ?? runner.startSession.bind(runner);
  originalStarts.set(runner, start);
  runner.startSession = (spec, ...rest) => {
    hoistedRunnerHook.ui = rest[1]?.onUiEvent;
    return start(spec, ...rest);
  };
  return runner;
});

export const runnerHook = {
  uiEvent(event: UiEvent) { if (!hoistedRunnerHook.ui) throw new Error("No runner UI channel observed"); hoistedRunnerHook.ui(event); },
  get runner(): AgentRunner | undefined { return hoistedRunnerHook.runner; },
  set runner(value: AgentRunner | undefined) { hoistedRunnerHook.runner = value; hoistedRunnerHook.ui = undefined; },
};

// Naming has its own suite; no background LLM call may outlive these fixtures. The mocks answer
// Cezar's no-wait nudge in plain text (hearsay-tools/cezarion#1234), so a turn end with no wait
// reaches Cezar's own wait, not a question the mock made up.
const fixtureAutoname = process.env.CEZ_AUTONAME;
const fixtureNudgeReply = process.env.CEZ_MOCK_NUDGE_REPLY;
beforeEach(() => { process.env.CEZ_AUTONAME = '0'; process.env.CEZ_MOCK_NUDGE_REPLY = 'plain'; });
afterAll(() => {
  if (fixtureNudgeReply === undefined) delete process.env.CEZ_MOCK_NUDGE_REPLY;
  else process.env.CEZ_MOCK_NUDGE_REPLY = fixtureNudgeReply;
  if (fixtureAutoname === undefined) delete process.env.CEZ_AUTONAME;
  else process.env.CEZ_AUTONAME = fixtureAutoname;
});

export const run = promisify(execFile);
export const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
export const FINISHED_RUN_STATUSES: ReadonlySet<RunRecord['status']> = new Set([RUN_STATUS.done, RUN_STATUS.review, RUN_STATUS.failed, RUN_STATUS.cancelled]);

/** Observe durable updates and owned operation settlement; time only bounds a missing signal. */
export function waitForProduct(manager: RunManager, store: RunStore, predicate: () => boolean, ms = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let queued = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      store.off('run', schedule);
      store.off('event', schedule);
      offWork();
      if (error) reject(error); else resolve();
    };
    const check = () => {
      queued = false;
      if (settled) return;
      try { if (predicate()) finish(); } catch (error) { finish(error); }
    };
    const schedule = () => {
      if (queued || settled) return;
      queued = true;
      queueMicrotask(check);
    };
    const offWork = fixtureWork(manager).onSettle(schedule);
    // bound: preserve the caller's original per-transition hang guard without polling.
    const timer = setTimeout(() => finish(new Error('condition not met in time')), ms);
    store.on('run', schedule);
    store.on('event', schedule);
    check();
  });
}

export const TURN_TEXT =
  "I'll catch the AuthError in the login handler so wrong passwords answer 401.\n\nDetails follow.";


export function setupMonitoringFixture() {
  // Fresh repo + manager per test: these runs PARK (they never reach a terminal
  // status), and a `worktree:false` parked run holds the exclusive repo-root
  // lock — so a shared manager would starve the next test. Isolation avoids that.
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let semaphore: WorkspaceSemaphore;
  let currentId: string | undefined;
  const clocks: Array<ReturnType<typeof observationClock>> = [];
  const savedEnv: Record<string, string | undefined> = {};
  const SINGLE_STEP: WorkflowDef = {
    name: 'quick-task',
    source: 'built-in',
    steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-490-'));
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    savedEnv.CEZ_CODEX_BIN = process.env.CEZ_CODEX_BIN;
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await run('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await run('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    semaphore = new WorkspaceSemaphore({ home: testHome() });
    manager = createFixtureManager(store, repoRoot, { home: testHome(), semaphore });
    currentId = undefined;
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    for (const clock of clocks.splice(0)) clock.restore();
    runnerHook.runner = undefined;
    if (currentId) manager.cancel(currentId); // release the session + repo lock
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const waitFor = (id: string, pred: (r: RunRecord | undefined) => boolean, ms = 15_000) =>
    waitForProduct(manager, store, () => {
      const record = store.getRun(id);
      const terminal = record && FINISHED_RUN_STATUSES.has(record.status);
      return pred(record) && (!terminal || !manager.isActive(id));
    }, ms);

  const publishedWaiting = (id: string, ready = () => true): Promise<RunRecord> =>
    new Promise((resolve) => {
      const onRun = (record: RunRecord) => {
        const current = record.steps.find((step) => step.id === record.currentStepId);
        if (!ready() || record.id !== id || record.status !== 'waiting' || current?.status !== 'waiting') return;
        store.off('run', onRun);
        resolve(structuredClone(record));
      };
      store.on('run', onRun);
    });

  /** The run's open timer: a `cezar_wait` timer or a monitoring one. */
  const openTimer = (r: RunRecord | undefined): TimerWaitEntry | undefined =>
    r?.waits?.find((wait): wait is TimerWaitEntry => wait.kind === 'timer' && wait.phase === 'open');

  const persistedRun = (id: string): RunRecord => {
    const records = readPersistedRuns(join(repoRoot, '.ai/cezar')) as RunRecord[];
    const record = records.find((candidate) => candidate.id === id);
    if (!record) throw new Error(`persisted run ${id} missing`);
    return record;
  };

  
  return {
    get repoRoot() { return repoRoot; },
    get store() { return store; },
    get manager() { return manager; },
    get semaphore() { return semaphore; },
    set manager(value: RunManager) { manager = value; },
    get currentId() { return currentId; },
    set currentId(value: string | undefined) { currentId = value; },
    observeWakeTimers() {
      let arming: TimerWaitEntry | undefined;
      const clock = observationClock(delay => {
        if (!arming || delay === undefined || delay <= 0 || delay > arming.seconds * 1000) return false;
        arming = undefined;
        return true;
      });
      clocks.push(clock);
      const commit = store.commitWait.bind(store);
      vi.spyOn(store, 'commitWait').mockImplementation((...args) => {
        const result = commit(...args);
        const wait = args[1];
        if (wait.kind === 'timer') {
          arming = wait;
          // The armer follows the synchronous checkpoint; other turns cannot claim this timer.
          queueMicrotask(() => { if (arming === wait) arming = undefined; });
        }
        return result;
      });
      return clock;
    },
    observeIdleTimers() {
      const clock = observationClock(delay => delay === IDLE_TIMEOUT_MS);
      clocks.push(clock);
      return clock;
    },
    SINGLE_STEP, waitFor, publishedWaiting, openTimer, persistedRun,
  };
}
