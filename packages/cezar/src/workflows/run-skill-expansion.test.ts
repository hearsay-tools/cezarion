import { run, GIT_ID, waitForProduct } from './run-fixture.testkit.ts';
import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';
describe('registry /skill expansion survives a continuation (#811)', () => {
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
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-811-'));
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
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const eventsOf = (id: string) =>
    readFileSync(join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; text?: string; stepId?: string });

  const waitFor = (predicate: () => boolean, ms = 20_000) => waitForProduct(manager, store, predicate, ms);

  /** A finished run, ready for the cockpit's Reply composer. The dry-run mock ends its
   *  turn with no marker, so the run parks at `waiting` with the session open — closing
   *  it is what a user pressing Finish does, and `continueRun` only accepts a run that
   *  reached a terminal status. */
  const finishedRun = async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'do the first thing', worktree: false });
    runId = record.id;
    await waitFor(() => store.getRun(record.id)?.status === 'waiting');
    expect(manager.finish(record.id)).toBe(true);
    await waitFor(() => ['done', 'review'].includes(store.getRun(record.id)?.status ?? '') && !manager.isActive(record.id));
    return record.id;
  };

  it("expands the continuation's OPENING prompt before it becomes the session userPrompt", async () => {
    const id = await finishedRun();
    expect(manager.continueRun(id, { text: '/demo-review look at the diff' })).toEqual({ ok: true });
    await waitFor(() =>
      eventsOf(id).some((e) => e.stepId === 'continue-1' && e.type === 'text' && e.text?.includes('looking into')),
    );

    const echoed = eventsOf(id).find(
      (e) => e.stepId === 'continue-1' && e.type === 'text' && e.text?.includes('looking into'),
    );
    // The backend saw the expanded skill prompt, NOT a bare slash command it would
    // reject as an unknown skill.
    expect(echoed?.text).toContain('Selected skill: /demo-review');
    expect(echoed?.text).not.toContain('/demo-review look at the diff');

    // Delivery-only: the transcript still shows what the user actually typed.
    const typed = eventsOf(id).find((e) => e.type === 'user-message' && e.stepId === 'continue-1');
    expect(typed?.text).toBe('/demo-review look at the diff');
  }, 40_000);

  it('expands a FOLLOW-UP delivered into the reopened continuation session', async () => {
    const id = await finishedRun();
    expect(manager.continueRun(id, { text: 'keep going' })).toEqual({ ok: true });
    await waitFor(() => store.getRun(id)?.status === 'waiting');

    expect(manager.sendMessage(id, [{ type: 'text', text: '/demo-review now review it' }])).toBe(true);
    await waitFor(() =>
      eventsOf(id).filter((e) => e.type === 'text' && e.text?.includes('Selected skill: /demo-review')).length > 0,
    );
    expect(
      eventsOf(id).some((e) => e.type === 'text' && e.text?.includes('Selected skill: /demo-review')),
    ).toBe(true);
  }, 40_000);

  it('leaves an unknown slash command untouched so backend-native commands still work', async () => {
    const id = await finishedRun();
    expect(manager.continueRun(id, { text: '/compact please' })).toEqual({ ok: true });
    await waitFor(() =>
      eventsOf(id).some((e) => e.stepId === 'continue-1' && e.type === 'text' && e.text?.includes('looking into')),
    );
    const echoed = eventsOf(id).find(
      (e) => e.stepId === 'continue-1' && e.type === 'text' && e.text?.includes('looking into'),
    );
    expect(echoed?.text).toContain('/compact please');
  }, 40_000);
});

describe("registry /skill expansion on a fresh run's opening prompt (#87)", () => {
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
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-87-'));
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
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  // Tolerant of the pre-first-event window: the run's ndjson does not exist until
  // the engine writes its first event, and this describe polls events directly
  // (no store-status gate first), so a missing file is simply "no events yet".
  const eventsOf = (id: string) => {
    let raw: string;
    try {
      raw = readFileSync(join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`), 'utf8').trim();
    } catch {
      return [] as { type: string; text?: string; stepId?: string }[];
    }
    if (!raw) return [] as { type: string; text?: string; stepId?: string }[];
    return raw.split('\n').map((line) => JSON.parse(line) as { type: string; text?: string; stepId?: string });
  };

  const waitFor = (predicate: () => boolean, ms = 20_000) => waitForProduct(manager, store, predicate, ms);

  it('expands the opening prompt before it reaches the backend', async () => {
    const record = manager.startRun(SINGLE_STEP, {
      task: '/demo-review look at the diff',
      worktree: false,
    });
    runId = record.id;
    await waitFor(() =>
      eventsOf(record.id).some(
        (e) => e.stepId === 'task' && e.type === 'text' && e.text?.includes('looking into'),
      ),
    );

    const echoed = eventsOf(record.id).find(
      (e) => e.stepId === 'task' && e.type === 'text' && e.text?.includes('looking into'),
    );
    // The backend saw the expanded skill prompt, NOT the bare slash command it would
    // reject as an unknown command.
    expect(echoed?.text).toContain('Selected skill: /demo-review');
    expect(echoed?.text).not.toContain('/demo-review look at the diff');
    expect(store.getRun(record.id)?.task).toBe('/demo-review look at the diff');
  }, 40_000);

  it.each([
    { task: '/compact please', registry: true },
    { task: '/demo-review look at the diff', registry: false },
  ])('passes through $task with registry=$registry', async ({ task, registry }) => {
    if (!registry) rmSync(join(repoRoot, '.ai/cezar/skills'), { recursive: true });
    const record = manager.startRun(SINGLE_STEP, { task, worktree: false });
    runId = record.id;
    await waitFor(() =>
      eventsOf(record.id).some(
        (e) => e.stepId === 'task' && e.type === 'text' && e.text?.includes('looking into'),
      ),
    );
    const echoed = eventsOf(record.id).find(
      (e) => e.stepId === 'task' && e.type === 'text' && e.text?.includes('looking into'),
    );
    expect(echoed?.text).toBe(`Okay — looking into: ${task}`);
    expect(store.getRun(record.id)?.task).toBe(task);
  }, 40_000);
});
