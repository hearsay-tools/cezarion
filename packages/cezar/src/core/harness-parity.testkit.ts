/**
 * Shared fixtures for the harness parity matrix (`harness-parity.test.ts`,
 * spec `.ai/specs/2026-09-04-harness-parity-matrix.md`, #68).
 *
 * `ui-parity.test.ts` pins one axis: every mapper emits every v2 UI capability.
 * This kit supports the other one — the session, lifecycle and error-path
 * contract in `agent-runner.ts` — by driving each backend's REAL runner class
 * against that backend's own offline mock binary.
 *
 * Two deliberate choices live here rather than in the suite:
 *  - **scenario NAMES are shared, spellings are not.** Every mock is already
 *    driven by `mock:<scenario>` markers found in the prompt text, and those
 *    markers were written alongside the golden fixtures. The adapter maps a
 *    shared name onto whatever a backend already calls it, so the matrix
 *    renames nothing and churns no passing runner test.
 *  - **the transport is an explicit `CEZ_*_BIN`, never `CEZ_DRY_RUN`.** A row's
 *    transport is then visible in the adapter instead of implied by a global,
 *    and a backend with no dry-run short-circuit is driven the same way as one
 *    that has it.
 */
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import type { AgentEvent, AgentRunResult, AgentSession, RunnerId, SessionOptions } from './agent-runner.ts';
import { createRunner } from './runner-factory.ts';
import type { UiEvent } from './ui-events.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { RunManager } from '../workflows/run.ts';
import { planOwnedWorkspace } from '../delegation/workspace.ts';
import type { WorkflowDef } from '../workflows/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The shared scenario catalog. A name, not a marker.
 *
 * | Scenario | The mock must |
 * | --- | --- |
 * | `baseline` | one text, one tool call and result, usage, then its terminal turn signal |
 * | `done` | the same, with a trailing `CEZ:DONE` so the run reaches its review gate |
 * | `hold` | delay the terminal turn signal after the last content event |
 * | `split-text` | stream the reply in pieces, ending with a trailing `CEZ:MONITORING` |
 * | `provider-error` | a runtime provider rejection in its native error shape |
 * | `ask` | an ask — native where the wire has one, a `CEZ:ASK` marker otherwise |
 * | `ask-bad` | a malformed ask, and then still end the turn |
 * | `subagent` | child work and terminal signal, then parent monitoring text followed by late child text |
 */
export const SCENARIOS = [
  'baseline',
  'done',
  'hold',
  'split-text',
  'provider-error',
  'ask',
  'ask-bad',
  'ask-reply-late',
  'subagent',
] as const;
export type ScenarioName = (typeof SCENARIOS)[number];

export interface HarnessAdapter {
  readonly backend: RunnerId;
  /** The env var this backend's runner already reads to locate its binary. */
  readonly binEnv: string;
  /** Absolute path to the offline mock binary. */
  readonly mockBin: string;
  /** Scenario name -> the prompt text this backend's mock answers it with. */
  readonly scenarios: Readonly<Partial<Record<ScenarioName, string>>>;
}

/** Resolved from this file, not the cwd, so the paths hold wherever vitest runs. */
const CLAUDE_MOCK = join(HERE, '..', '..', 'scripts', 'mock-claude.mjs');
const PI_MOCK = join(HERE, '..', '..', 'scripts', 'mock-pi-rpc.mjs');
const CODEX_MOCK = join(HERE, '__fixtures__', 'codex', 'mock-codex-app-server.mjs');
const OPENCODE_MOCK = join(HERE, '__fixtures__', 'opencode', 'mock-opencode-serve.mjs');

/** No marker: every mock's default branch answers this with its scripted turn. */
const BASELINE_PROMPT = 'inspect the working tree';

/** The id cezar pins on every session, mirroring `RunManager`. */
export const PINNED_SESSION_ID = '0e5f1a7c-1c3e-4d2a-9b64-2f7a5c8d1e90';

export const HARNESS_ADAPTERS: Readonly<Record<RunnerId, HarnessAdapter>> = {
  claude: {
    backend: 'claude',
    binEnv: 'CEZ_CLAUDE_BIN',
    mockBin: CLAUDE_MOCK,
    scenarios: {
      baseline: BASELINE_PROMPT,
      done: 'mock:done',
      hold: 'mock:hold',
      'split-text': 'mock:split-text',
      // Claude's mock has carried an auth-rejection branch since #430.
      'provider-error': 'mock:auth-error',
      ask: 'mock:ask',
      'ask-reply-late': 'mock:ask',
      'ask-bad': 'mock:ask-bad',
      subagent: 'mock:subagents',
    },
  },
  codex: {
    backend: 'codex',
    binEnv: 'CEZ_CODEX_BIN',
    mockBin: CODEX_MOCK,
    scenarios: {
      baseline: BASELINE_PROMPT,
      done: 'mock:done',
      hold: 'mock:hold',
      'split-text': 'mock:split-text',
      // #83: 0.147 reports provider rejection on turn/completed with turn.error.
      'provider-error': 'mock:provider-error',
      ask: 'mock:native-codex-ask',
      'ask-reply-late': 'mock:native-codex-ask',
      'ask-bad': 'mock:ask-bad',
      // #600's repro: a child thread's own turn/completed must not end the parent.
      subagent: 'mock:child-turn',
    },
  },
  opencode: {
    backend: 'opencode',
    binEnv: 'CEZ_OPENCODE_BIN',
    mockBin: OPENCODE_MOCK,
    scenarios: {
      baseline: BASELINE_PROMPT,
      done: 'mock:done',
      hold: 'mock:hold',
      'split-text': 'mock:split-text',
      'provider-error': 'mock:provider-error',
      ask: 'mock:ask',
      'ask-reply-late': 'mock:ask-reply-late',
      'ask-bad': 'mock:ask-bad',
      subagent: 'mock:subagent',
    },
  },
  pi: {
    backend: 'pi',
    binEnv: 'CEZ_PI_BIN',
    mockBin: PI_MOCK,
    scenarios: {
      baseline: BASELINE_PROMPT,
      done: 'mock:done',
      hold: 'mock:hold',
      'split-text': 'mock:split-text',
      'provider-error': 'mock:provider-error',
      ask: 'mock:ask',
      'ask-reply-late': 'mock:ask',
      'ask-bad': 'mock:ask-bad',
      // No `subagent`: see the S9 and R12 entries in PARITY_EXEMPTIONS.
    },
  },
};

/** The prompt text that drives one backend's mock into one shared scenario. */
export function promptFor(backend: RunnerId, scenario: ScenarioName): string {
  const prompt = HARNESS_ADAPTERS[backend].scenarios[scenario];
  if (prompt === undefined) {
    throw new Error(`${backend} declares no prompt for scenario "${scenario}"`);
  }
  return prompt;
}

/**
 * Why a cell is exempt, which decides how the matrix pins it. Both kinds fail
 * the day the backend gains the thing, which is what keeps an exemption from
 * going stale — they just cannot be pinned the same way.
 *
 * - `capability-absent` — the scenario IS constructible on this wire, the
 *   backend simply does not produce the criterion's signal. Pinned by an
 *   INVERTED assertion: the criterion must not hold.
 * - `scenario-unconstructible` — the wire cannot even create the situation, so
 *   there is nothing to invert (an unrelated baseline turn would satisfy some
 *   criteria by accident). Pinned by requiring the adapter to declare NO prompt
 *   for that scenario, so the day a mock answers it the exemption fails and the
 *   row has to go live.
 */
export type ExemptionKind = 'capability-absent' | 'scenario-unconstructible';

export interface ParityExemption {
  /** The criterion's stable id — `S9`, `R3`. */
  readonly criterion: string;
  readonly backend: RunnerId;
  readonly kind: ExemptionKind;
  /** Why this backend's WIRE cannot carry it. Never "not implemented yet". */
  readonly reason: string;
}

/**
 * Cells a backend's upstream protocol genuinely cannot carry.
 *
 * An entry here is not a waiver — see `ExemptionKind` for how each is pinned.
 * "Not implemented yet" is never a reason: that is a failing row, and the fix
 * is the runner, not this table.
 */
export const PARITY_EXEMPTIONS: readonly ParityExemption[] = [
  {
    criterion: 'R12',
    backend: 'pi',
    kind: 'scenario-unconstructible',
    reason:
      "pi's RPC has no child session or child transcript: task tools run on the parent " +
      'session (see `__fixtures__/pi/rpc-lifecycle.expected.json`), so no child message can ' +
      'arrive between the parent monitoring marker and turn-end.',
  },
  {
    criterion: 'S9',
    backend: 'pi',
    kind: 'scenario-unconstructible',
    reason:
      "pi's RPC has no child session: a `task` tool is a plain tool call on the parent " +
      'session (see `__fixtures__/pi/rpc-lifecycle.expected.json` — the task item carries no ' +
      'parentItemId and no child transcript), so there is no child terminal signal that could ' +
      'end the parent turn.',
  },
];

export function exemptionFor(criterion: string, backend: RunnerId): ParityExemption | undefined {
  return PARITY_EXEMPTIONS.find((e) => e.criterion === criterion && e.backend === backend);
}

/** Poll a condition. Generous on purpose: under a full suite run these share the
 *  machine with hundreds of files, and a tight bound is a flake, not a check. */
export async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** `Array.prototype.findLastIndex` is ES2023; this package's lib is ES2022. */
export function lastIndexWhere<T>(items: readonly T[], match: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (match(items[i] as T)) return i;
  }
  return -1;
}

/** Every v1 `text` event of a run, folded the way the orchestrator folds a turn. */
export function textEvents(v1: readonly AgentEvent[]): string[] {
  return v1
    .filter((e): e is Extract<AgentEvent, { type: 'text' }> => e.type === 'text')
    .map((e) => e.text);
}

export interface SeamObservation {
  readonly v1: readonly AgentEvent[];
  readonly v2: readonly UiEvent[];
  readonly result: AgentRunResult;
  /** The spawned backend process pid, as the seam reported it while open. */
  readonly pid: number | undefined;
}

export interface DriveSeamOptions {
  readonly sessionOptions?: SessionOptions;
  /** Extra work while the session is live — a follow-up message, an interrupt.
   *  When absent, `driveSeam` waits for the first turn-end or error. */
  readonly whileOpen?: (
    session: AgentSession,
    observed: { v1: readonly AgentEvent[]; v2: readonly UiEvent[] },
  ) => Promise<void>;
  readonly timeoutMs?: number;
}

/**
 * Drive one backend's real runner class against its own offline mock and collect
 * both event streams plus the settled result.
 *
 * The bin env var is set and restored around the call the same way
 * `pi-runner.test.ts` and `workflows/run.test.ts` already do it, and
 * `CEZ_DRY_RUN` is cleared so the mock named by the adapter is the only
 * transport in play.
 */
export async function driveSeam(
  backend: RunnerId,
  scenario: ScenarioName,
  opts: DriveSeamOptions = {},
): Promise<SeamObservation> {
  const adapter = HARNESS_ADAPTERS[backend];
  const savedBin = process.env[adapter.binEnv];
  const savedDry = process.env.CEZ_DRY_RUN;
  process.env[adapter.binEnv] = adapter.mockBin;
  delete process.env.CEZ_DRY_RUN;
  const cwd = mkdtempSync(join(tmpdir(), `cez-parity-${backend}-`));
  const v1: AgentEvent[] = [];
  const v2: UiEvent[] = [];
  let session: AgentSession | undefined;
  try {
    session = createRunner(backend).startSession(
      {
        userPrompt: promptFor(backend, scenario),
        cwd,
        timeoutMs: opts.timeoutMs ?? 30_000,
        // RunManager always pins one (`workflows/run.ts:2909`), and claude
        // resumes off exactly this value, so a row that omitted it would test
        // a shape no real run ever uses.
        sessionId: PINNED_SESSION_ID,
        // The claude mock writes to these when set; empty keeps a row from
        // touching a handoff file it does not own.
        env: { CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '', CEZ_MOCK_ARGS_FILE: '' },
      },
      (event) => v1.push(event),
      { ...opts.sessionOptions, onUiEvent: (event) => v2.push(event) },
    );
    const pid = session.pid;
    if (opts.whileOpen) await opts.whileOpen(session, { v1, v2 });
    else await waitFor(() => v1.some((e) => e.type === 'turn-end' || e.type === 'error'));
    session.end();
    const result = await session.result.catch(
      (): AgentRunResult => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    );
    return { v1, v2, result, pid };
  } finally {
    session?.interrupt();
    if (savedBin === undefined) delete process.env[adapter.binEnv];
    else process.env[adapter.binEnv] = savedBin;
    if (savedDry !== undefined) process.env.CEZ_DRY_RUN = savedDry;
    rmSync(cwd, { force: true, recursive: true });
  }
}

// ---- the run tier ---------------------------------------------------------

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

/**
 * Drive one backend through a real `RunManager` run against its offline mock.
 *
 * The run tier exists because three of the failure-mode groups are only uniform
 * ABOVE the seam: `ask.requested` comes from the runner for codex and opencode
 * and from `workflows/run.ts` for claude and pi, and whether a provider failure
 * fails the run or parks it is decided in the orchestrator either way.
 *
 * Modelled on the #565 suite in `workflows/run.test.ts`: a temp git repo, a
 * store, a manager, and the built-in single-step workflow with `worktree: false`.
 */
export async function driveRun(
  backend: RunnerId,
  scenario: ScenarioName | { prompt: string },
  settled: (record: RunRecord | undefined) => boolean,
  timeoutMs = 30_000,
): Promise<RunObservation> {
  const adapter = HARNESS_ADAPTERS[backend];
  const savedBin = process.env[adapter.binEnv];
  const savedDry = process.env.CEZ_DRY_RUN;
  process.env[adapter.binEnv] = adapter.mockBin;
  delete process.env.CEZ_DRY_RUN;
  const repoRoot = mkdtempSync(join(tmpdir(), `cez-parity-run-${backend}-`));
  let store: RunStore | undefined;
  let manager: RunManager | undefined;
  let runId: string | undefined;
  try {
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await execFileAsync('git', ['add', '-A'], { cwd: repoRoot });
    await execFileAsync('git', [...GIT_IDENTITY, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
    const started = manager.startRun(SINGLE_STEP, {
      task: typeof scenario === 'string' ? promptFor(backend, scenario) : scenario.prompt,
      runner: backend,
      worktree: false,
    });
    runId = started.id;
    const statuses: string[] = [];
    const record = () => store?.getRun(started.id);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
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
    store.flush();
    return { statuses, record: record(), events: readRunEvents(repoRoot, started.id) };
  } finally {
    if (runId && manager) manager.cancel(runId);
    store?.flush();
    if (savedBin === undefined) delete process.env[adapter.binEnv];
    else process.env[adapter.binEnv] = savedBin;
    if (savedDry !== undefined) process.env.CEZ_DRY_RUN = savedDry;
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
  const pending = new Set<Promise<void>>();
  const record = manager.recordTurnEnd.bind(manager);
  manager.recordTurnEnd = (runId, text) => {
    const result = record(runId, text);
    pending.add(result);
    void result.finally(() => pending.delete(result));
    return result;
  };
  return async () => { while (pending.size) await Promise.all(pending); };
}

/** An owned worker, using real disk/Git state and the same four wire mocks. */
export async function withOwnedInputRun(
  backend: RunnerId,
  scenario: ScenarioName,
  body: (fixture: {
    repoRoot: string; runId: string; parentRunId: string;
    store: RunStore; manager: RunManager;
    restart: () => Promise<{ store: RunStore; manager: RunManager }>;
  }) => Promise<void>,
): Promise<void> {
  const adapter = HARNESS_ADAPTERS[backend];
  const savedBin = process.env[adapter.binEnv];
  const savedDry = process.env.CEZ_DRY_RUN;
  const savedAutoName = process.env.CEZ_AUTONAME;
  // Naming is a separate auxiliary invocation, not part of input delivery.
  process.env.CEZ_AUTONAME = '0';
  process.env[adapter.binEnv] = adapter.mockBin;
  delete process.env.CEZ_DRY_RUN;
  const repoRoot = mkdtempSync(join(tmpdir(), `cez-owned-input-${backend}-`));
  let store: RunStore | undefined;
  let manager: RunManager | undefined;
  let runId: string | undefined;
  let drainBookkeeping = async () => {};
  try {
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.name', 'test'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.email', 'test@local'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await execFileAsync('git', ['add', '-A'], { cwd: repoRoot });
    await execFileAsync('git', ['commit', '-q', '-m', 'base'], { cwd: repoRoot });
    const sha = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim();
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    const parent = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [] });
    // A live root with its own unanswered question survives recovery without
    // launching a parent process. A terminal root correctly cancels its workers.
    store.updateRun(parent.id, { status: 'waiting' });
    store.commitDelegation([{ id: parent.id, delegation: { role: 'root', permissions: ['spawn'], receipts: [] } }]);
    store.appendEvent(parent.id, { type: 'ask.requested', requestId: randomUUID(), questions: [{
      header: 'Parent', question: 'Which parent task should follow?',
      options: [{ label: 'First task' }, { label: 'Second task' }],
    }] });
    runId = randomUUID();
    const workspace = await planOwnedWorkspace(repoRoot, runId, sha);
    store.createOwnedRun({ title: 'worker', task: promptFor(backend, scenario), workflow: 'quick-task', runner: backend,
      steps: [{ id: 'task', name: 'Task', kind: 'agent' }] }, parent.id, randomUUID(), {
      role: 'worker', parentRunId: parent.id, permissions: [], workspace,
    }, 'a'.repeat(64));
    manager = new RunManager(store, repoRoot);
    drainBookkeeping = trackTurnBookkeeping(manager);
    const restart = async () => {
      store!.flush();
      const index = readFileSync(join(repoRoot, '.ai/cezar/runs.json'), 'utf8');
      // Stop only test-owned processes, then restore the precise pre-crash disk
      // checkpoint. No fake manager/session: recovery opens a new real store.
      manager!.cancel(runId!);
      await waitFor(() => !manager!.isActive(runId!));
      await drainBookkeeping();
      manager!.dispose();
      store!.flush();
      writeFileSync(join(repoRoot, '.ai/cezar/runs.json'), index);
      store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
      manager = new RunManager(store, repoRoot);
      drainBookkeeping = trackTurnBookkeeping(manager);
      await manager.recover();
      return { store, manager };
    };
    await body({ repoRoot, runId, parentRunId: parent.id, store, manager, restart });
  } finally {
    if (runId && manager) {
      manager.cancel(runId);
      await waitFor(() => !manager!.isActive(runId!));
    }
    await drainBookkeeping();
    manager?.dispose();
    store?.flush();
    if (savedBin === undefined) delete process.env[adapter.binEnv];
    else process.env[adapter.binEnv] = savedBin;
    if (savedDry !== undefined) process.env.CEZ_DRY_RUN = savedDry;
    if (savedAutoName === undefined) delete process.env.CEZ_AUTONAME;
    else process.env.CEZ_AUTONAME = savedAutoName;
    rmSync(repoRoot, { recursive: true, force: true });
  }
}
