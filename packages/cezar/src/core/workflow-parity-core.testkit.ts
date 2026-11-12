/**
 * The run tier of the harness parity matrix: fixtures that drive each backend's offline mock
 * through a real `RunManager`, owned workers and skill parents.
 *
 * `harness-parity.testkit.ts` holds the adapter tier — scenarios, adapters and `driveSeam` —
 * and stays free of the workflow engine, so a runner-adapter test does not load it
 * (hearsay-tools/cezarion#2938). A test that needs a run imports this kit.
 */
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';
import { RUN_STATUS, STEP_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { scopeFixtureProcesses } from '../delegation/process-scope.testkit.ts';
import { DelegationController } from '../delegation/provision.ts';
import { workerWorkflowHash, type WorkerExecutionIdentity } from '../delegation/execution-identity.ts';
import { planOwnedWorkspace } from '../delegation/workspace.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { historyPaths } from '../runs/history-file.ts';
import { setRunStatus, readPersistedRuns, seedRuns } from '../runs/run-store.testkit.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { createFixtureManager, drainFixtureManagers, fixtureWork } from '../workflows/fixture-manager.testkit.ts';
import { RunManager } from '../workflows/run.ts';
import { plannedWorkflow, skillTaskSteps, stepKind, type WorkflowDef } from '../workflows/types.ts';
import type { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import type { RunnerId } from './agent-runner.ts';
import { profileEnv } from './agent-profiles.ts';
import { HARNESS_ADAPTERS, promptFor, waitFor, type ScenarioName } from './harness-parity-core.testkit.ts';
import { observationClock } from './observation-clock.testkit.ts';

const execFileAsync = promisify(execFile);
const GIT_IDENTITY = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** The zero-config single-agent-step workflow, which is what a quick task runs. */
const SINGLE_STEP: WorkflowDef = {
  name: 'quick-task',
  source: 'built-in',
  steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
};

export interface RunObservation {
  /** Every status the run passed through, in order. A row can then assert a
   *  state was never ENTERED, not merely that it is not the final one — which
   *  is what #53/#54 need, since the bug was a transient park. */
  readonly statuses: readonly string[];
  readonly record: RunRecord | undefined;
  /** The run's persisted NDJSON, parsed — v1 and v2 events in one file, the
   *  same bytes SSE replays to the cockpit. */
  readonly events: readonly Record<string, unknown>[];
}

/** Omit an absent dependency under exact optional property types. */
function optionalSemaphore(semaphore: WorkspaceSemaphore | undefined): { semaphore?: WorkspaceSemaphore } {
  return semaphore ? { semaphore } : {};
}

/**
 * Drive one backend through a real `RunManager` run against its offline mock.
 *
 * The run tier exists because three of the failure-mode groups are only uniform
 * ABOVE the seam: `workflows/run/` emits `ask.requested` for every runner's `cezar_ask`
 * card, while codex and opencode also emit it from the runner for a native ask, and
 * whether a provider failure fails the run or parks it is decided in the orchestrator.
 *
 * Modelled on the #565 suite in `workflows/run.test.ts`: a temp git repo, a
 * store, a manager, and the built-in single-step workflow with `worktree: false`.
 */
export async function driveRun(
  backend: RunnerId,
  scenario: ScenarioName | { prompt: string },
  settled: (record: RunRecord | undefined) => boolean,
  timeoutMs = 30_000,
  afterSettled?: (context: { store: RunStore; manager: RunManager; runId: string }) => Promise<void>,
  options: {
    autonomous?: boolean;
    semaphore?: WorkspaceSemaphore;
    workflowDef?: WorkflowDef;
    /** Called with the fresh store and manager before the run starts (to observe either), and
     *  the repo root, so a row can write the project's `.ai/cezar/config.json` (#917). */
    beforeStart?: (context: { store: RunStore; manager: RunManager; repoRoot: string }) => void;
    /** Restore a test-controlled clock before teardown measures its real cleanup bounds. */
    beforeCleanup?: () => void;
    /** Run in an isolated task worktree instead of in place (#917: worktree setup only runs
     *  there). Default false, which every earlier row relies on. */
    worktree?: boolean;
    /** Runs after startRun, in parallel with the settle loop — inject a mid-turn follow-up (#486). */
    during?: (context: { store: RunStore; manager: RunManager; runId: string }) => Promise<void>;
    /** Environment overrides restored after the run settles. */
    env?: Record<string, string>;
    /** Override the adapter mock binary (Codex coalesced-steer wrapper, #486). */
    mockBin?: string;
  } = {},
): Promise<RunObservation> {
  const { beforeStart, beforeCleanup, during, env: extraEnv, mockBin, worktree, semaphore, ...runOptions } = options;
  const adapter = HARNESS_ADAPTERS[backend];
  const savedBin = process.env[adapter.binEnv];
  const savedDry = process.env.CEZ_DRY_RUN;
  const savedAutoName = process.env.CEZ_AUTONAME;
  // The mock answers Squawk's no-wait nudge in plain text (hearsay-tools/cezarion#1234), so a row
  // that ends a turn with no wait reaches Squawk's own wait rather than a question the mock made
  // up. `options.env` may opt back in to the card.
  const env = { CEZ_MOCK_NUDGE_REPLY: 'plain', ...extraEnv };
  const savedEnv = Object.keys(env).map(name => [name, process.env[name]] as const);
  const restoreEnvironment = () => {
    if (savedBin === undefined) delete process.env[adapter.binEnv];
    else process.env[adapter.binEnv] = savedBin;
    if (savedDry !== undefined) process.env.CEZ_DRY_RUN = savedDry;
    if (savedAutoName === undefined) delete process.env.CEZ_AUTONAME;
    else process.env.CEZ_AUTONAME = savedAutoName;
    for (const [name, saved] of savedEnv) {
      if (saved === undefined) delete process.env[name]; else process.env[name] = saved;
    }
  };
  Object.assign(process.env, env);
  process.env.CEZ_AUTONAME = '0';
  process.env[adapter.binEnv] = mockBin ?? adapter.mockBin;
  delete process.env.CEZ_DRY_RUN;
  const repoRoot = mkdtempSync(join(tmpdir(), `cez-parity-run-${backend}-`));
  let store: RunStore | undefined;
  let manager: RunManager | undefined;
  try {
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await execFileAsync('git', ['add', '-A'], { cwd: repoRoot });
    await execFileAsync('git', [...GIT_IDENTITY, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot, optionalSemaphore(semaphore));
    beforeStart?.({ store, manager, repoRoot });
    const started = manager.startRun(runOptions.workflowDef ?? SINGLE_STEP, {
      ...runOptions,
      task: typeof scenario === 'string' ? promptFor(backend, scenario) : scenario.prompt,
      runner: backend,
      worktree: worktree === true,
    });
    let duringError: unknown;
    const duringWork = during
      ? during({ store, manager, runId: started.id }).catch((err: unknown) => { duringError = err; })
      : undefined;
    const statuses: string[] = [];
    const record = () => store!.getRun(started.id);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (duringError) break;
      const current = record();
      const status = current?.status;
      if (status !== undefined && statuses.at(-1) !== status) statuses.push(status);
      if (settled(current)) break;
      if (Date.now() > deadline) {
        throw new Error(
          `driveRun(${backend}, ${scenario}) never settled; statuses seen: ${statuses.join(' -> ')}`,
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (duringWork) await duringWork;
    if (duringError) throw duringError;
    if (afterSettled) await afterSettled({ store, manager, runId: started.id });
    store.flush();
    // Cleanup mutates the live record; return the observed state before cancellation.
    return { statuses, record: structuredClone(record()), events: readRunEvents(repoRoot, started.id) };
  } finally {
    beforeCleanup?.();
    await drainFixtureManagers(repoRoot);
    store?.close();
    restoreEnvironment();
    rmSync(repoRoot, { force: true, recursive: true });
  }
}

/** Parse a run's append-only NDJSON, skipping bad lines the way readers must. */
function readRunEvents(repoRoot: string, runId: string): Record<string, unknown>[] {
  let raw: string;
  try {
    raw = readFileSync(join(repoRoot, '.ai/cezar/runs', `${runId}.ndjson`), 'utf8');
  } catch {
    return [];
  }
  const events: Record<string, unknown>[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === 'object') {
        events.push(parsed as Record<string, unknown>);
      }
    } catch {
      // A reader skips a bad line; so does this.
    }
  }
  return events;
}

/** Observe, do not replace, the manager's fire-and-forget Git bookkeeping so
 * test-owned directories outlive every real write. */
function trackTurnBookkeeping(manager: RunManager): () => Promise<void> {
  const work = fixtureWork(manager);
  return async () => {
    for (;;) {
      const pending = [...work.pending].filter(([, label]) => label === 'recordTurnEnd');
      if (!pending.length) return;
      await Promise.all(pending.map(([promise]) => promise));
    }
  };
}

/** An owned worker, using real disk/Git state and the native wire mocks for `RUNNER_IDS`. */
/**
 * A parent's answer reopens a closed worker session through a continuation that waits for capacity,
 * and that continuation carries the current task (`hydrateQueuedContinuation`). A native mock picks
 * its scenario from anywhere in the prompt, so a task such as `mock:ask` would replace the answer's
 * own scenario. Call this before such an answer: the task keeps its meaning and loses the marker.
 */
export function withoutTaskScenario(store: RunStore, runId: string): void {
  store.updateRun(runId, { task: 'worker task' });
}

/**
 * The owning parent answers the worker's pending question (hearsay-tools/cezarion#2410): the reply is
 * committed with its outcome as `service.send` does, and goes to the worker through the answer seam a
 * human answer used before. A worker's question has one addressee, so no human answers it.
 */
export async function answerAsParent(store: RunStore, manager: RunManager, parentRunId: string, workerRunId: string, text: string): Promise<string> {
  await waitFor(() => store.transcriptFacts(workerRunId).pendingAsk?.routedMessageId !== undefined);
  const requestId = store.transcriptFacts(workerRunId).pendingAsk!.routedMessageId!;
  const root = store.getRun(parentRunId)?.delegation;
  if (root?.role !== 'root' || !root.conversation) throw Error('the parent has no conversation');
  const now = new Date().toISOString();
  const id = randomUUID();
  const attribution = { senderRunId: parentRunId, recipientRunId: workerRunId, kind: 'reply' as const, requestId };
  const state = root.conversation;
  store.commitConversation(parentRunId, {
    messages: [...state.messages, { id, ...attribution, text, createdAt: now, requestHash: 'b'.repeat(64), state: 'accepted' }],
    outcomes: [...state.outcomes, { requestId, status: 'replied', observedAt: now, replyId: id }],
  }, { recipientRunId: workerRunId, input: { id, source: agentInputSchema.shape.source.enum.agent, parentRunId, text, createdAt: now, conversation: attribution } });
  manager.deliverConversationInput(workerRunId);
  return id;
}

function readOptional(path: string): string | undefined {
  try { return readFileSync(path, 'utf8'); } catch { return undefined; }
}

type OwnedInputOptions = NonNullable<Parameters<typeof withOwnedInputRun>[3]>;

function prepareOwnedInputEnvironment(backend: RunnerId, options: OwnedInputOptions): () => void {
  const adapter = HARNESS_ADAPTERS[backend];
  const savedBin = process.env[adapter.binEnv];
  const savedExtraBins = (options.extraBackends ?? []).map(extra => [HARNESS_ADAPTERS[extra].binEnv, process.env[HARNESS_ADAPTERS[extra].binEnv]] as const);
  for (const extra of options.extraBackends ?? []) process.env[HARNESS_ADAPTERS[extra].binEnv] = HARNESS_ADAPTERS[extra].mockBin;
  const savedDry = process.env.CEZ_DRY_RUN;
  const savedAutoName = process.env.CEZ_AUTONAME;
  // The worker ignores Squawk's no-wait nudge (hearsay-tools/cezarion#1234) and reaches its plain
  // park, so input delivery is what these fixtures decide. `options.env` may opt back in.
  const env = { CEZ_MOCK_NUDGE_REPLY: 'plain', ...options.env };
  const savedEnv = Object.keys(env).map(name => [name, process.env[name]] as const);
  Object.assign(process.env, env);
  // Naming is a separate auxiliary invocation, not part of input delivery.
  process.env.CEZ_AUTONAME = '0';
  process.env[adapter.binEnv] = options.mockBin ?? adapter.mockBin;
  delete process.env.CEZ_DRY_RUN;
  return () => {
    if (savedBin === undefined) delete process.env[adapter.binEnv];
    else process.env[adapter.binEnv] = savedBin;
    for (const [name, saved] of savedExtraBins) {
      if (saved === undefined) delete process.env[name]; else process.env[name] = saved;
    }
    if (savedDry !== undefined) process.env.CEZ_DRY_RUN = savedDry;
    if (savedAutoName === undefined) delete process.env.CEZ_AUTONAME;
    else process.env.CEZ_AUTONAME = savedAutoName;
    for (const [name, saved] of savedEnv) {
      if (saved === undefined) delete process.env[name]; else process.env[name] = saved;
    }
  };
}

async function createOwnedInputRepository(repoRoot: string): Promise<string> {
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  await execFileAsync('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
  await execFileAsync('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
  await execFileAsync('git', ['config', 'user.name', 'test'], { cwd: repoRoot });
  await execFileAsync('git', ['config', 'user.email', 'test@local'], { cwd: repoRoot });
  writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
  await execFileAsync('git', ['add', '-A'], { cwd: repoRoot });
  await execFileAsync('git', ['commit', '-q', '-m', 'base'], { cwd: repoRoot });
  const sha = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim();
  return sha;
}

function createOwnedInputParent(store: RunStore): RunRecord {
  const parent = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [] });
  // A live root with its own unanswered question survives recovery without
  // launching a parent process. A terminal root correctly cancels its workers.
  setRunStatus(store, parent.id, RUN_STATUS.waiting);
  // It may message its workers, as provisioned roots do, so it answers their questions
  // (hearsay-tools/cezarion#2410).
  store.commitDelegation([{ id: parent.id, delegation: { role: 'root', permissions: ['spawn', 'steer'], receipts: [] } }]);
  store.appendEvent(parent.id, { type: 'ask.requested', requestId: randomUUID(), questions: [{
    header: 'Parent', question: 'Which parent task should follow?',
    options: [{ label: 'First task' }, { label: 'Second task' }],
  }] });
  return parent;
}

async function createOwnedInputWorker(
  store: RunStore, repoRoot: string, runId: string, parentRunId: string, sha: string,
  backend: RunnerId, scenario: ScenarioName, options: OwnedInputOptions,
): Promise<void> {
  const workspace = await planOwnedWorkspace(repoRoot, runId, sha);
  const workflowDef = options.workflowDef;
  store.createOwnedRun({ title: 'worker', task: promptFor(backend, scenario), workflow: workflowDef?.name ?? 'quick-task', runner: backend,
    ...(options.agentProfile === undefined ? {} : { agentProfile: options.agentProfile }),
    ...(workflowDef ? { workflowDef } : {}),
    steps: workflowDef
      ? workflowDef.steps.map(step => ({ id: step.id, name: step.name ?? step.id, kind: stepKind(step) }))
      : [{ id: 'task', name: 'Task', kind: STEP_KIND.agent }] }, parentRunId, randomUUID(), {
    role: 'worker', parentRunId, permissions: [], workspace,
  }, 'a'.repeat(64), options.identity ?? { kind: 'internal', ...(workflowDef ? { workflowHash: workerWorkflowHash(workflowDef) } : {}) });
}

interface OwnedInputState {
  store: RunStore | undefined;
  manager: RunManager | undefined;
  runId: string | undefined;
  drainBookkeeping: () => Promise<void>;
}

async function restartOwnedInputRun(
  state: OwnedInputState, repoRoot: string, parentRunId: string, options: OwnedInputOptions,
  beforeOpen?: (dataDir: string) => void,
): Promise<{ store: RunStore; manager: RunManager }> {
  state.store!.flush();
  const dataDir = join(repoRoot, '.ai/cezar');
  const index = readPersistedRuns(dataDir);
  // The transcripts belong to the checkpoint too: the cancel that stops the processes below
  // writes its own events (a worker's question closes when it stops,
  // hearsay-tools/cezarion#2410), which a real crash never wrote. Their facts are a cache
  // written behind them, so recovery rebuilds those from the restored transcripts.
  const histories = [parentRunId, state.runId!].map(id => [historyPaths(dataDir, id).plain, readOptional(historyPaths(dataDir, id).plain)] as const);
  // Stop only test-owned processes, then restore the precise pre-crash disk
  // checkpoint. No fake manager/session: recovery opens a new real store.
  state.manager!.cancel(state.runId!);
  await waitFor(() => !state.manager!.isActive(state.runId!));
  await state.drainBookkeeping();
  state.manager!.dispose();
  state.store!.close();
  seedRuns(dataDir, index);
  for (const [path, content] of histories) {
    if (content === undefined) rmSync(path, { force: true });
    else writeFileSync(path, content);
  }
  for (const id of [parentRunId, state.runId!]) rmSync(historyPaths(dataDir, id).facts, { force: true });
  beforeOpen?.(join(repoRoot, '.ai/cezar'));
  state.store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
  state.manager = createFixtureManager(state.store, repoRoot, options);
  state.drainBookkeeping = trackTurnBookkeeping(state.manager);
  await state.manager.recover();
  return { store: state.store, manager: state.manager };
}

async function teardownOwnedInputRun(
  state: OwnedInputState, repoRoot: string, restoreEnvironment: () => void, restoreProcesses: () => void,
): Promise<void> {
  try {
    if (state.runId && state.manager) {
      state.manager.cancel(state.runId);
      await waitFor(() => !state.manager!.isActive(state.runId!));
    }
    await state.drainBookkeeping();
    await drainFixtureManagers(repoRoot);
    state.manager?.dispose();
    state.store?.close();
    restoreEnvironment();
    rmSync(repoRoot, { recursive: true, force: true });
  } finally { restoreProcesses(); }
}

export async function withOwnedInputRun(
  backend: RunnerId,
  scenario: ScenarioName,
  body: (fixture: {
    repoRoot: string; runId: string; parentRunId: string;
    store: RunStore; manager: RunManager;
    /** The parent answers the worker's pending question; returns the reply's ID. */
    answer: (text: string) => Promise<string>;
    restart: (beforeOpen?: (dataDir: string) => void) => Promise<{ store: RunStore; manager: RunManager }>;
    /** Transfer fixture teardown to a reopened context without cancelling the old cleanup. */
    adoptContext: (context: { store: RunStore; manager: RunManager }) => Promise<void>;
  }) => Promise<void>,
  options: {
    /** A persisted catalog definition the worker runs instead of quick-task (#451). */
    workflowDef?: WorkflowDef | undefined;
    /** Internal runner deadlines for this fixture, including restarts. */
    timings?: Partial<import('./runner-runtime.ts').RunnerTimings>;
    /** The private identity evidence to write instead of the internal marker (#452); its run-level
     *  account must match `runner`/`agentProfile` on the record, as acceptance guarantees. */
    identity?: WorkerExecutionIdentity;
    agentProfile?: string;
    /** Further runners a mixed chain launches; their mocks are wired for the fixture's lifetime. */
    extraBackends?: readonly RunnerId[];
    /** Environment overrides restored after the native mock worker settles. */
    env?: Record<string, string>;
    /** Preserve a legacy native-wire fixture while the backend default changes. */
    mockBin?: string;
    noWaitNudgeReplyMs?: number;
    /** Admission capacity owned by the caller; omission keeps the manager default. */
    semaphore?: WorkspaceSemaphore;
  } = {},
): Promise<void> {
  const restoreEnvironment = prepareOwnedInputEnvironment(backend, options);
  const repoRoot = mkdtempSync(join(tmpdir(), `cez-owned-input-${backend}-`));
  // This fixture owns every native mock process; ambient host daemons cannot hold its new repo.
  const restoreProcesses = scopeFixtureProcesses();
  const state: OwnedInputState = { store: undefined, manager: undefined, runId: undefined, drainBookkeeping: async () => {} };
  try {
    const sha = await createOwnedInputRepository(repoRoot);
    state.store = RunStore.open(join(repoRoot, '.ai/cezar'));
    const parent = createOwnedInputParent(state.store);
    state.runId = randomUUID();
    await createOwnedInputWorker(state.store, repoRoot, state.runId, parent.id, sha, backend, scenario, options);
    state.manager = createFixtureManager(state.store, repoRoot, options);
    state.drainBookkeeping = trackTurnBookkeeping(state.manager);
    const adoptContext = async (context: { store: RunStore; manager: RunManager }) => {
      await state.drainBookkeeping();
      state.store = context.store;
      state.manager = context.manager;
      state.drainBookkeeping = trackTurnBookkeeping(state.manager);
    };
    const restart = (beforeOpen?: (dataDir: string) => void) => restartOwnedInputRun(state, repoRoot, parent.id, options, beforeOpen);
    const answer = (text: string) => answerAsParent(state.store!, state.manager!, parent.id, state.runId!, text);
    await body({ repoRoot, runId: state.runId, parentRunId: parent.id, store: state.store, manager: state.manager, answer, restart, adoptContext });
  } finally {
    await teardownOwnedInputRun(state, repoRoot, restoreEnvironment, restoreProcesses);
  }
}

/** Launch a skill-driven parent and accept its child through the real session settings/service.
 * Native mock recordings stay in each run's cwd; no worker prompt is supplied by the fixture. */
export async function withSkillParentRun(
  backend: RunnerId,
  env: Record<string, string>,
  body: (fixture: { repoRoot: string; parentRunId: string; runId: string; store: RunStore; manager: RunManager }) => Promise<void>,
): Promise<void> {
  const adapter = HARNESS_ADAPTERS[backend];
  const repoRoot = mkdtempSync(join(tmpdir(), `cez-skill-parent-${backend}-`));
  // Acceptance binds the live parent's account, and spawn requires that directory to exist.
  // Supply an empty test-owned home rather than relying on an installed host login.
  const accountHome = join(repoRoot, 'account');
  mkdirSync(accountHome);
  const overrides = { ...env, ...profileEnv(backend, accountHome), CEZ_HOME: join(repoRoot, 'workspace-home'),
    [adapter.binEnv]: adapter.mockBin, CEZ_AUTONAME: '0' };
  const saved = Object.keys({ ...overrides, CEZ_DRY_RUN: '' }).map(name => [name, process.env[name]] as const);
  Object.assign(process.env, overrides);
  delete process.env.CEZ_DRY_RUN;
  let store: RunStore | undefined;
  let manager: RunManager | undefined;
  let controller: DelegationController | undefined;
  let drainBookkeeping = async () => {};
  try {
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await execFileAsync('git', ['add', '-A'], { cwd: repoRoot });
    await execFileAsync('git', [...GIT_IDENTITY, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    const skillsDir = join(repoRoot, '.ai/cezar/skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'parent-skill.md'), 'PARENT SKILL BODY 778');
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot);
    drainBookkeeping = trackTurnBookkeeping(manager);
    controller = await DelegationController.start();
    controller.attachProject({ home: testHome(), id: 'project', root: repoRoot, store, manager });
    const parent = manager.startRun(plannedWorkflow(skillTaskSteps('parent-skill')), {
      task: promptFor(backend, 'baseline'), runner: backend, worktree: false, systemPrompt: 'parent extra',
    });
    await waitFor(() => store!.getRun(parent.id)?.status === 'waiting', 30_000);
    // Authenticate a test-owned caller through the real registry. Execution settings still
    // come exclusively from the parent's actual live native session.
    const caller = controller.credentials.authenticate(controller.credentials.issue('project', parent.id, randomUUID()))!;
    const child = await controller.service.spawn(caller, {
      task: promptFor(backend, 'cezar-done'), baseline: 'HEAD', requestId: randomUUID(),
    });
    await body({ repoRoot, parentRunId: parent.id, runId: child.workerId, store, manager });
  } finally {
    for (const id of store?.listRunIds() ?? []) manager?.cancel(id);
    if (manager && store) await waitFor(() => store!.listRunIds().every(id => !manager!.isActive(id)), 30_000);
    await drainBookkeeping();
    await controller?.close();
    await drainFixtureManagers(repoRoot);
    manager?.dispose();
    store?.close();
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

/** R17 keeps the shipped retry budget, but observes it after the latest native retry. */
export async function driveUnavailableProvider(backend: RunnerId, scenario: ScenarioName | { prompt: string },
  settled: (record: RunRecord | undefined) => boolean, timeoutMs?: number): ReturnType<typeof driveRun> {
  if (backend !== 'codex') return driveRun(backend, scenario, settled, timeoutMs);
  let clock: ReturnType<typeof observationClock> | undefined;
  try {
    return await driveRun(backend, scenario, settled, timeoutMs, undefined, {
      beforeStart: () => {
        clock = observationClock(delay => delay === 60_000 &&
          /\bhandleStreamError\b/.test(new Error().stack ?? ''));
      },
      during: async ({ store, runId }) => {
        // bound: the real native mock must deliver both retry frames before the
        // product's no-progress timer can report its stored latest reason.
        await waitFor(() => store.readEvents(runId).some(event => event.type === 'session.error' &&
          String(event.message).includes('Connection failed: error sending request')));
        if (clock!.captured !== 1) throw new Error(`Expected one stream retry timer, got ${clock!.captured}`);
        await clock!.advance(60_000);
      },
      beforeCleanup: () => { clock?.restore(); clock = undefined; },
    });
  } finally { clock?.restore(); }
}
