import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RUNNER_IDS, type RunnerId } from '../core/agent-runner.ts';
import { RUNNER_FACTS } from '../core/runner-facts.ts';
import { HARNESS_ADAPTERS, promptFor, waitFor } from '../core/harness-parity.testkit.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** The UUID Squawk writes on a step before the runner reports its own session id. */
const LAUNCH_SESSION_ID = '0b6f1f8e-6c2a-4f55-9d0e-3c7c1a2b9e41';

/** Two agent steps at different efforts, so the wire shows which step a Continue runs as. */
const CHAIN_DEF: WorkflowDef = {
  name: 'two-step',
  source: 'file',
  steps: [
    { id: 'implement', name: 'Implement', prompt: '{{task}}', effort: 'high' },
    { id: 'review', name: 'Review', prompt: 'review {{task}}', effort: 'low' },
  ],
};

type Row = Record<string, unknown> | unknown[];

function rows(wire: string): Row[] {
  return wire.split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as Row]; } catch { return []; }
  });
}

function record(row: Row): Record<string, unknown> | undefined {
  return Array.isArray(row) ? undefined : row;
}

function argv(row: Row): string[] | undefined {
  return Array.isArray(row) ? row.map(String) : undefined;
}

/** Each value of `flag` across the recorded command lines. */
function flagValues(wire: Row[], flag: string): string[] {
  return wire.flatMap((row) => {
    const args = argv(row);
    const at = args?.indexOf(flag) ?? -1;
    return at >= 0 ? [args![at + 1]!] : [];
  });
}

/** How each native wire shows a resumed session, a fresh one, a started turn and its effort.
 *  Cursor resolves effort through its account's model catalog, which the mock does not serve, so
 *  its chain sets no effort and `cursor-bootstrap-continue.test.ts` checks its continued step. */
const WIRES: Record<RunnerId, {
  resumed(wire: Row[]): string[];
  freshSessions(wire: Row[]): number;
  started(wire: Row[]): boolean;
  effort?(wire: Row[]): string | undefined;
}> = {
  claude: {
    resumed: wire => flagValues(wire, '--resume'),
    freshSessions: wire => flagValues(wire, '--session-id').length,
    started: wire => wire.some(row => argv(row)?.includes('--output-format') === true),
    effort: wire => flagValues(wire, '--effort').at(-1),
  },
  pi: {
    resumed: wire => flagValues(wire, '--session'),
    freshSessions: wire => flagValues(wire, '--session-id').length,
    started: wire => wire.some(row => argv(row)?.includes('--mode') === true),
    effort: wire => flagValues(wire, '--thinking').at(-1),
  },
  omp: {
    resumed: wire => flagValues(wire, '--resume'),
    freshSessions: wire => wire.filter(row => argv(row)?.includes('--mode') === true && !argv(row)!.includes('--resume')).length,
    started: wire => wire.some(row => argv(row)?.includes('--mode') === true),
    effort: wire => flagValues(wire, '--thinking').at(-1),
  },
  cursor: {
    resumed: wire => flagValues(wire, '--resume'),
    freshSessions: wire => wire.filter(row => argv(row)?.includes('-p') === true && !argv(row)!.includes('--resume')).length,
    started: wire => wire.some(row => argv(row)?.includes('-p') === true),
  },
  codex: {
    resumed: wire => wire.flatMap(row => record(row)?.method === 'thread/resume'
      ? [String((record(row)!.params as { threadId?: string }).threadId)] : []),
    freshSessions: wire => wire.filter(row => record(row)?.method === 'thread/start').length,
    started: wire => wire.some(row => record(row)?.method === 'turn/start'),
    effort: wire => wire.flatMap(row => record(row)?.method === 'turn/start'
      ? [(record(row)!.params as { effort?: string }).effort] : []).at(-1),
  },
  opencode: {
    resumed: wire => wire.flatMap((row) => {
      const rec = record(row);
      const match = rec?.method === 'GET' && typeof rec.url === 'string' ? /^\/session\/([^/]+)$/.exec(rec.url) : null;
      return match ? [match[1]!] : [];
    }),
    freshSessions: wire => wire.filter(row => record(row)?.method === 'POST' && record(row)?.url === '/session').length,
    started: wire => wire.some(row => typeof record(row)?.url === 'string' && String(record(row)!.url).includes('prompt_async')),
    effort: wire => wire.flatMap((row) => {
      const rec = record(row);
      return typeof rec?.url === 'string' && rec.url.includes('prompt_async') ? [(rec.body as { variant?: string }).variant] : [];
    }).at(-1),
  },
};

/**
 * Squawk saves a launch UUID on the step before the runner's `session` event. A runner that opens
 * its session under that id (`sessionIdSource: 'launch'`) resumes it after a crash in that
 * window. A runner that mints its own id (`native`) never knew it, so the Continue opens a fresh
 * session. Either way the Continue runs as the step it continues. The real native mocks show the
 * session on the wire (hearsay-tools/cezarion#2991).
 */
describe('Continue after a crash before the native session event', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  let argsFile: string;
  const saved = new Map<string, string | undefined>();

  function setEnv(name: string, value: string): void {
    if (!saved.has(name)) saved.set(name, process.env[name]);
    process.env[name] = value;
  }

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-native-continue-'));
    argsFile = join(repoRoot, 'wire.args.ndjson');
    setEnv('CEZ_AUTONAME', '0');
    setEnv('CEZ_MOCK_ARGS_FILE', argsFile);
    setEnv('CEZ_MOCK_STDIN_FILE', join(repoRoot, 'wire.stdin.ndjson'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await run('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await run('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot);
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    manager?.dispose();
    manager = undefined;
    store.flush();
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    saved.clear();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** A failed run whose first step holds `sessionId`. `launched` writes the step-start event a
   *  real launch writes before the runner starts; without it the run has no event history. */
  function failedRun(backend: RunnerId, sessionId: string, options: { launched: boolean }): string {
    setEnv(HARNESS_ADAPTERS[backend].binEnv, HARNESS_ADAPTERS[backend].mockBin);
    const workflowDef = WIRES[backend].effort ? CHAIN_DEF
      : { ...CHAIN_DEF, steps: CHAIN_DEF.steps.map(({ effort: _effort, ...step }) => step) };
    const created = store.createRun({
      title: 't', workflow: workflowDef.name, task: promptFor(backend, 'baseline'), runner: backend,
      steps: workflowDef.steps.map(step => ({ id: step.id, name: step.name ?? step.id, kind: STEP_KIND.agent })),
    });
    setRunStatus(store, created.id, RUN_STATUS.failed, {
      finishedAt: new Date().toISOString(), workflowDef, worktree: false, error: 'boom',
    });
    if (options.launched) {
      store.appendEvent(created.id, { type: 'step-start', stepId: 'implement', name: 'Implement', kind: STEP_KIND.agent, iteration: 1 });
    }
    store.updateStep(created.id, 'implement', { status: STEP_STATUS.failed, iterations: 1, sessionId, backend, error: 'boom' });
    return created.id;
  }

  async function continueWire(runId: string, backend: RunnerId): Promise<Row[]> {
    expect(manager!.continueRun(runId, { text: promptFor(backend, 'baseline') })).toEqual({ ok: true });
    const read = () => rows(existsSync(argsFile) ? readFileSync(argsFile, 'utf8') : '');
    // bound: hang guard; the turn's first request on the wire is the product signal.
    await waitFor(() => WIRES[backend].started(read()) || store.getRun(runId)?.status === 'failed', 30_000);
    expect(store.getRun(runId)?.error).toBeUndefined();
    return read();
  }

  for (const backend of RUNNER_IDS) {
    const source = RUNNER_FACTS[backend].sessionIdSource;
    it(`${backend} ${source === 'launch' ? 'resumes' : 'never resumes'} the launch UUID and runs as the continued step`, async () => {
      const id = failedRun(backend, LAUNCH_SESSION_ID, { launched: true });
      const wire = await continueWire(id, backend);
      if (source === 'launch') {
        expect(WIRES[backend].resumed(wire)).toEqual([LAUNCH_SESSION_ID]);
        expect(WIRES[backend].freshSessions(wire)).toBe(0);
      } else {
        expect(WIRES[backend].resumed(wire)).toEqual([]);
        expect(WIRES[backend].freshSessions(wire)).toBeGreaterThan(0);
      }
      // The Continue runs as `implement`, the step whose session it continues.
      if (WIRES[backend].effort) expect(WIRES[backend].effort!(wire)).toBe('high');
      if (source === 'native') {
        // bound: hang guard; the runner reports its own id, which the Continue step records.
        await waitFor(() => store.readEvents(id).some(event => event.type === 'session' && event.stepId === 'continue-1'), 15_000);
        expect(store.getRun(id)?.steps.find(step => step.id === 'continue-1')?.sessionId).not.toBe(LAUNCH_SESSION_ID);
      }
    }, 60_000);
  }

  it('resumes a saved native id when the run has no event history', async () => {
    // Older or salvaged run data can keep the step record without its event history. Nothing
    // then shows that the runner never reported the id, so the Continue keeps the conversation.
    const id = failedRun('codex', 'thread-from-salvaged-run', { launched: false });
    const wire = await continueWire(id, 'codex');
    expect(WIRES.codex.resumed(wire)).toEqual(['thread-from-salvaged-run']);
    expect(WIRES.codex.freshSessions(wire)).toBe(0);
    expect(WIRES.codex.effort!(wire)).toBe('high');
  }, 60_000);
});
