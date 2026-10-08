import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CursorRunner } from '../core/cursor-runner.ts';
import { unregisterRunProcess } from '../core/process-usage.ts';
import { RunStore } from '../runs/store.ts';
import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import type { RunManager } from './run.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';

vi.mock('../core/runner-factory.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/runner-factory.ts')>();
  return { createRunner: (backend: Parameters<typeof actual.createRunner>[0], options: Parameters<typeof actual.createRunner>[1]) =>
    backend === 'cursor' ? new CursorRunner({ sessionTransport: options?.sessionTransport ?? 'cursor-print' }) : actual.createRunner(backend, options) };
});

const git = promisify(execFile);
const savedDryRun = process.env.CEZ_DRY_RUN;
const savedMode = process.env.CEZ_MOCK_CURSOR_PRINT_MODE;
const savedLog = process.env.CEZ_MOCK_CURSOR_PRINT_LOG;
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

describe('Cursor print workflow transport', () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  let log: string;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cez-print-workflow-'));
    await git('git', ['init', '-q', '-b', 'main'], { cwd: root });
    await git('git', ['config', 'gc.auto', '0'], { cwd: root });
    await git('git', ['config', 'maintenance.auto', 'false'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'one\n');
    await git('git', ['add', '-A'], { cwd: root });
    await git('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: root });
    log = join(root, 'print-log.jsonl');
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_MOCK_CURSOR_PRINT_LOG = log;
    delete process.env.CEZ_MOCK_CURSOR_PRINT_MODE;
    store = RunStore.open(join(root, '.ai/cezar'));
    manager = createFixtureManager(store, root);
  });
  afterEach(async () => {
    await drainFixtureManagers(root);
    store.flush();
    rmSync(root, { recursive: true, force: true });
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN; else process.env.CEZ_DRY_RUN = savedDryRun;
    if (savedMode === undefined) delete process.env.CEZ_MOCK_CURSOR_PRINT_MODE; else process.env.CEZ_MOCK_CURSOR_PRINT_MODE = savedMode;
    if (savedLog === undefined) delete process.env.CEZ_MOCK_CURSOR_PRINT_LOG; else process.env.CEZ_MOCK_CURSOR_PRINT_LOG = savedLog;
  });

  it('persists print transport and resumes the same native ID', async () => {
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'first turn', runner: 'cursor', worktree: false });
    await expect.poll(() => store.getRun(run.id)?.steps[0]?.sessionTransport, { timeout: 15_000 }).toBe('cursor-print');
    const first = store.getRun(run.id)!.steps[0]!;
    expect(first.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    await expect.poll(() => store.getRun(run.id)?.status, { timeout: 15_000 }).toBe('waiting');
    expect(manager.finish(run.id)).toBe(true);
    await expect.poll(() => manager.isActive(run.id), { timeout: 15_000 }).toBe(false);
    expect(manager.continueRun(run.id, { text: 'second turn' })).toEqual({ ok: true });
    await expect.poll(() => store.getRun(run.id)?.steps.at(-1)?.sessionTransport, { timeout: 15_000 }).toBe('cursor-print');
    await expect.poll(() => readFileSync(log, 'utf8').trim().split('\n').length, { timeout: 15_000 }).toBe(2);
    const lines = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { resumeId?: string });
    expect(lines).toHaveLength(2);
    expect(lines[1]?.resumeId).toBe(first.sessionId);
    const last = store.getRun(run.id)!.steps.at(-1)!;
    expect(last.sessionId).toBe(first.sessionId);
    expect(last.profileId).toBe(first.profileId);
    await expect.poll(() => store.getRun(run.id)?.status, { timeout: 15_000 }).toBe('waiting');
    expect(manager.finish(run.id)).toBe(true);
    await expect.poll(() => manager.isActive(run.id), { timeout: 15_000 }).toBe(false);
    expect(manager.continueRun(run.id, { text: 'third turn' })).toEqual({ ok: true });
    await expect.poll(() => readFileSync(log, 'utf8').trim().split('\n').length, { timeout: 15_000 }).toBe(3);
  }, 20_000);

  it('leaves a portable ASK pending until an explicit human reply', async () => {
    process.env.CEZ_MOCK_CURSOR_PRINT_MODE = 'portable-ask';
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'ask', runner: 'cursor', worktree: false });
    await expect.poll(() => store.getRun(run.id)?.hasPendingHumanAsk, { timeout: 15_000 }).toBe(true);
    const before = readFileSync(log, 'utf8').trim().split('\n').length;
    expect(before).toBe(1);
    expect(store.getRun(run.id)?.status).toBe('waiting');
    expect(manager.continueRun(run.id)).toEqual({ ok: false, error: 'run is still active' });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(before);
    expect(store.getRun(run.id)?.hasPendingHumanAsk).toBe(true);
    const nativeId = store.getRun(run.id)!.steps[0]!.sessionId;
    expect(manager.sendMessage(run.id, [{ type: 'text', text: 'Library: Vitest' }])).toBe(true);
    await expect.poll(() => readFileSync(log, 'utf8').trim().split('\n').length, { timeout: 15_000 }).toBe(2);
    await expect.poll(() => store.getRun(run.id)?.hasPendingHumanAsk, { timeout: 15_000 }).toBe(false);
    const reply = JSON.parse(readFileSync(log, 'utf8').trim().split('\n')[1]!) as { resumeId: string };
    expect(reply.resumeId).toBe(nativeId);
  }, 20_000);

  it('recovers a pending portable ASK without admitting an automatic print turn', async () => {
    process.env.CEZ_MOCK_CURSOR_PRINT_MODE = 'portable-ask';
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'ask', runner: 'cursor', worktree: false });
    await expect.poll(() => store.getRun(run.id)?.hasPendingHumanAsk, { timeout: 15_000 }).toBe(true);
    const nativeId = store.getRun(run.id)!.steps[0]!.sessionId;
    manager.dispose();
    unregisterRunProcess(run.id); // A real controller restart begins with an empty process registry.
    manager = createFixtureManager(store, root);
    await manager.recover();
    expect(store.getRun(run.id)?.hasPendingHumanAsk).toBe(true);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(manager.continueRun(run.id, { text: 'Library: Vitest' })).toEqual({ ok: true });
    await expect.poll(() => readFileSync(log, 'utf8').trim().split('\n').length, { timeout: 15_000 }).toBe(2);
    const reply = JSON.parse(readFileSync(log, 'utf8').trim().split('\n')[1]!) as { resumeId: string };
    expect(reply.resumeId).toBe(nativeId);
  }, 20_000);
});
