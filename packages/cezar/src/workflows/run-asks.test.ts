import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';
import { deriveAttention } from '@open-mercato/cezar-contract/attention';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { runnerHook, run, GIT_ID, FINISHED_RUN_STATUSES, waitForProduct } from './run-fixture.testkit.ts';
describe('cezar_ask parks as waiting and emits ask.requested (#473)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let currentId: string | undefined;
  const savedEnv: Record<string, string | undefined> = {};
  const SINGLE_STEP: WorkflowDef = {
    name: 'quick-task',
    source: 'built-in',
    steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-473-'));
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await run('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await run('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot);
    currentId = undefined;
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    runnerHook.runner = undefined;
    if (currentId) manager.cancel(currentId);
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

  const readEvents = (id: string): Array<Record<string, unknown>> =>
    readFileSync(join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

  it('a cezar_ask turn-end parks the run as waiting (attention) and emits ask.requested', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:cezar-ask which library?', worktree: false });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting');
    const parked = store.getRun(record.id);
    expect(parked?.status).toBe('waiting'); // attention — NOT running/monitoring
    const asks = readEvents(record.id).filter((e) => e.type === 'ask.requested');
    expect(asks).toHaveLength(1);
    expect(typeof asks[0]!.requestId).toBe('string');
    const questions = asks[0]!.questions as Array<{ header: string; options: unknown[] }>;
    expect(questions[0]!.header).toBe('Library');
    expect(questions[0]!.options).toHaveLength(2);
  }, 30_000);

  it('a markerless turn-end raises no ask.requested', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'just do the thing', worktree: false });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting');
    expect(readEvents(record.id).some((e) => e.type === 'ask.requested')).toBe(false);
  }, 30_000);

  it('a mid-turn follow-up does not resume past a cezar_ask park', async () => {
    savedEnv.CEZ_OPENCODE_BIN = process.env.CEZ_OPENCODE_BIN;
    process.env.CEZ_OPENCODE_BIN = join(
      dirname(fileURLToPath(import.meta.url)),
      '../core/__fixtures__/opencode/mock-opencode-serve.mjs',
    );
    delete process.env.CEZ_DRY_RUN;

    const record = manager.startRun(SINGLE_STEP, {
      task: 'mock:hold-cezar-ask choose',
      runner: 'opencode',
      worktree: false,
    });
    currentId = record.id;
    await waitFor(record.id, () => {
      try {
        return readEvents(record.id).some((e) => e.type === 'turn.started');
      } catch {
        return false;
      }
    });
    expect(manager.sendMessage(record.id, [{ type: 'text', text: 'just resolve it' }])).toBe(true);
    await waitFor(record.id, (r) => r?.status === 'waiting');

    const events = readEvents(record.id);
    expect(events.filter((e) => e.type === 'ask.requested')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'turn.started')).toHaveLength(1);
  }, 30_000);

  // `runContinuation`'s turn end must raise the card as `runAgentStep`'s does: AGENTS.md's standing
  // warning that a lifecycle change applied to one of them ships half a fix.
  it('a cezar_ask on a continuation turn raises one card on the continuation step', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'do the first thing', worktree: false });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting');
    expect(manager.finish(record.id)).toBe(true); // continueRun only accepts a terminal run
    await waitFor(record.id, (r) => ['done', 'review'].includes(r?.status ?? ''));
    expect(manager.continueRun(record.id, { text: 'mock:cezar-ask choose' })).toEqual({ ok: true });
    await waitFor(record.id, (r) => r?.status === 'waiting' && readEvents(r.id).some((e) => e.type === 'ask.requested'));

    const asks = readEvents(record.id).filter((e) => e.type === 'ask.requested');
    expect(asks).toHaveLength(1); // the first turn asked nothing
    const questions = asks[0]!.questions as Array<{ header: string; options: unknown[] }>;
    expect(questions[0]!.header).toBe('Library');
    expect(questions[0]!.options).toHaveLength(2);
    expect(String(asks[0]!.stepId)).toMatch(/^continue-/); // the continuation handler, not the step one
    expect(deriveAttention(store.getRun(record.id)!).label).toBe('needs you');
  }, 40_000);
});

describe('native Codex requestUserInput parks and resumes the run (#565)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let runId: string | undefined;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  const savedCodexBin = process.env.CEZ_CODEX_BIN;
  const workflow: WorkflowDef = {
    name: 'quick-task', source: 'built-in', steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-565-'));
    delete process.env.CEZ_DRY_RUN;
    // Resolved from this file, not the cwd: the fixture is a sibling of the source under test,
    // so the path holds wherever vitest is invoked from and survives the tree moving.
    process.env.CEZ_CODEX_BIN = join(import.meta.dirname, '../core/__fixtures__/codex/mock-codex-app-server.mjs');
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
    if (runId) manager.cancel(runId);
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN; else process.env.CEZ_DRY_RUN = savedDryRun;
    if (savedCodexBin === undefined) delete process.env.CEZ_CODEX_BIN; else process.env.CEZ_CODEX_BIN = savedCodexBin;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const waitFor = (predicate: () => boolean, ms = 15_000) => waitForProduct(manager, store, predicate, ms);

  it('persists the ask, parks immediately, then routes the answer to the pending RPC', async () => {
    const record = manager.startRun(workflow, {
      task: 'mock:native-codex-ask choose a library', runner: 'codex', worktree: false,
    });
    runId = record.id;
    await waitFor(() => store.getRun(record.id)?.status === 'waiting');
    const eventsPath = join(repoRoot, '.ai/cezar/runs', `${record.id}.ndjson`);
    expect(readFileSync(eventsPath, 'utf8')).toContain('"type":"ask.requested"');
    expect(manager.sendMessage(record.id, [{ type: 'text', text: 'Library: Vitest' }])).toBe(true);
    // The native turn-end precedes the committed park (hearsay-tools/cezarion#1641).
    // Controlled ordering proof: .ai/specs/2026-10-27-native-codex-park-proof.md.
    await waitFor(() => readFileSync(eventsPath, 'utf8').includes('"type":"turn-end"')
      && store.getRun(record.id)?.status === RUN_STATUS.waiting);
    expect(store.getRun(record.id)?.status).toBe('waiting');
  }, 30_000);
});
