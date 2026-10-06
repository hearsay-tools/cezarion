import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewServeRequest, PreviewServeResult } from '@open-mercato/cezar-contract';
import { CiToolController } from '../ci-wait/controller.ts';
import type { PreviewHostLike } from '../preview/registration.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** Each session stays open until the test releases it, so the run is `running` while it registers. */
const sessions = vi.hoisted(() => ({ release: [] as Array<() => void> }));
vi.mock('../core/runner-factory.ts', () => ({
  createRunner: () => ({
    backend: 'claude' as const,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: () => {
      let release!: () => void;
      const result = new Promise<{ text: string; toolCalls: never[]; tokensUsed: number }>(done => { release = () => done({ text: 'ok', toolCalls: [], tokensUsed: 0 }); });
      sessions.release.push(release);
      return { result, sendMessage: () => false, discardQueuedMessages: () => {}, holdsHumanInput: () => false, end: () => {}, interrupt: () => {}, open: true };
    },
    interrupt: async () => {},
  }),
}));

type PreviewCallback = (request: PreviewServeRequest, signal?: AbortSignal) => Promise<PreviewServeResult>;

/**
 * The preview capability rides the CI tool session, so every start, Continue and recovered launch
 * must hand the controller the same callback (#811's class: `ActiveRun` has two construction sites).
 */
describe('RunManager.registerPreviewServer (#781)', { timeout: 30_000 }, () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  let preview: PreviewHostLike;

  beforeEach(async () => {
    vi.stubEnv('CEZ_PREVIEW', '1');
    sessions.release.length = 0;
    preview = { stopPreview: vi.fn(async () => ({ ok: true, code: 'stopped' as const, message: 'Stopped', hint: 'Continue.' })), portOwner: () => undefined, probe: async () => false, release: async () => undefined, replaced: vi.fn(async () => undefined) };
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-preview-reg-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot, { preview, cezarPort: () => 4321 });
  });

  afterEach(async () => {
    for (const release of sessions.release) release();
    manager?.dispose();
    manager = undefined;
    store.flush();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const callbackAt = async (provision: { mock: { calls: unknown[][] } }, index: number): Promise<PreviewCallback> => {
    await expect.poll(() => provision.mock.calls.length, { timeout: 15_000 }).toBeGreaterThan(index);
    const callback = provision.mock.calls[index]![1];
    expect(callback).toBeTypeOf('function');
    return callback as PreviewCallback;
  };

  it('a running run registers, and Continue hands the next session a callback that still registers', async () => {
    const provision = vi.spyOn(CiToolController.prototype, 'provision');
    const record = manager!.startRun(QUICK_TASK_WORKFLOW, { task: 'build the members page' });
    const first = await callbackAt(provision, 0);
    expect(store.getRun(record.id)?.status).toBe('running');

    const registered = await first({ command: 'npm run dev -- --port 5173 --strictPort', port: 5173, label: 'vite' });
    expect(registered).toMatchObject({ ok: true, code: 'registered' });
    expect(store.getRun(record.id)?.previewServers?.[0]).toMatchObject({ port: 5173, label: 'vite', answeredAtRegistration: false });
    expect(store.readEvents(record.id).at(-1)).toMatchObject({ type: 'preview.server-registered', server: { port: 5173 } });

    sessions.release[0]!();
    await expect.poll(() => store.getRun(record.id)?.status, { timeout: 15_000 }).toSatisfy(status => ['done', 'review'].includes(String(status)));
    expect(manager!.continueRun(record.id, { text: 'add the storybook too' })).toEqual({ ok: true });
    const second = await callbackAt(provision, 1);

    const added = await second({ command: 'npm run storybook', port: 6006 });
    expect(added).toMatchObject({ ok: true, code: 'registered' });
    const replaced = await second({ command: 'npm run dev -- --port 5173 --strictPort --host', port: 5173 });
    expect(replaced).toMatchObject({ ok: true, code: 'replaced' });
    expect(store.getRun(record.id)?.previewServers?.map(server => [server.port, server.command])).toEqual([
      [5173, 'npm run dev -- --port 5173 --strictPort --host'],
      [6006, 'npm run storybook'],
    ]);
    expect(store.readEvents(record.id).at(-1)).toMatchObject({ type: 'preview.server-registered', server: { port: 5173, label: 'npm' } });
    // A changed command must not leave the old one running behind the new registration.
    expect(preview.replaced).toHaveBeenCalledTimes(1);
    expect(preview.replaced).toHaveBeenCalledWith(record.id, 5173);
    // The same registration again changes nothing the running server depends on.
    await second({ command: 'npm run dev -- --port 5173 --strictPort --host', port: 5173 });
    expect(preview.replaced).toHaveBeenCalledTimes(1);
  });

  it('provisions stop for fresh and continued sessions with trusted run identity and lifetime', async () => {
    const provision = vi.spyOn(CiToolController.prototype, 'provision');
    const record = manager!.startRun(QUICK_TASK_WORKFLOW, { task: 'build the app' });
    await (await callbackAt(provision, 0))({ command: 'npm run dev', port: 5173 });
    const first = provision.mock.calls[0]![2]!;
    expect(first).toBeTypeOf('function');
    const signal = new AbortController().signal;
    expect(await first({ port: 5173, restart: true }, signal)).toMatchObject({ ok: true });
    expect(preview.stopPreview).toHaveBeenCalledWith(record.id, { port: 5173, restart: true }, signal);
    const revoked = new AbortController(); revoked.abort();
    expect(await first({ port: 5173 }, revoked.signal)).toMatchObject({ code: 'unavailable' });
    expect(await first({ port: 6000 }, signal)).toMatchObject({ code: 'not_registered' });
    expect(preview.stopPreview).toHaveBeenCalledTimes(1);
    sessions.release[0]!();
    await expect.poll(() => store.getRun(record.id)?.status, { timeout: 15_000 }).toSatisfy(status => ['done', 'review'].includes(String(status)));
    expect(manager!.continueRun(record.id, { text: 'restart preview' })).toEqual({ ok: true });
    await callbackAt(provision, 1);
    const next = provision.mock.calls[1]![2]!;
    expect(await next({ port: 5173 }, signal)).toMatchObject({ ok: true });
    expect(preview.stopPreview).toHaveBeenLastCalledWith(record.id, { port: 5173 }, signal);
  });

  it('recovery provisions the stop capability through the continuation construction path', async () => {
    const provision = vi.spyOn(CiToolController.prototype, 'provision');
    const record = store.createRun({ title: 'recover preview', workflow: 'quick-task', task: 'continue', runner: 'claude', steps: [{ id: 'work', name: 'Work', kind: 'agent' }] });
    store.updateStep(record.id, 'work', { status: 'running', iterations: 1, sessionId: 'saved-session', backend: 'claude' });
    store.updateRun(record.id, { status: 'running', currentStepId: 'work', worktreePath: repoRoot, previewServers: [{ port: 5173, command: 'npm run dev', label: 'web', registeredAt: new Date().toISOString(), answeredAtRegistration: false }] });
    await manager!.recover();
    await callbackAt(provision, 0);
    const stop = provision.mock.calls[0]![2]!;
    const signal = new AbortController().signal;
    expect(await stop({ port: 5173, restart: true }, signal)).toMatchObject({ ok: true });
    expect(preview.stopPreview).toHaveBeenCalledWith(record.id, { port: 5173, restart: true }, signal);
  });

  it('a capability revoked while the port probe is pending records nothing', async () => {
    const provision = vi.spyOn(CiToolController.prototype, 'provision');
    const record = manager!.startRun(QUICK_TASK_WORKFLOW, { task: 'build the members page' });
    const register = await callbackAt(provision, 0);
    const lifetime = new AbortController();
    // The run is cancelled while the probe is in flight.
    preview.probe = async () => { lifetime.abort(); return false; };
    await expect(register({ command: 'npm run dev', port: 5173 }, lifetime.signal)).rejects.toThrow();
    expect(store.getRun(record.id)?.previewServers ?? []).toEqual([]);
    expect(store.readEvents(record.id).some(event => event.type === 'preview.server-registered')).toBe(false);
  });

  it('records a port that answers at registration and refuses one held by another task', async () => {
    const provision = vi.spyOn(CiToolController.prototype, 'provision');
    preview.probe = async port => port === 5173;
    preview.portOwner = port => port === 3000 ? { runId: 'other-run', title: 'Member management' } : undefined;
    const record = manager!.startRun(QUICK_TASK_WORKFLOW, { task: 'build the members page' });
    const register = await callbackAt(provision, 0);

    await register({ command: 'npm run dev', port: 5173 });
    expect(store.getRun(record.id)?.previewServers?.[0]?.answeredAtRegistration).toBe(true);
    const held = await register({ command: 'npm run dev', port: 3000 });
    expect(held).toMatchObject({ ok: false, code: 'port_held' });
    expect(held.hint).toContain('Member management');
    const own = await register({ command: 'npm run dev', port: 4321 });
    expect(own).toMatchObject({ ok: false, code: 'cezar_port' });
    expect(store.getRun(record.id)?.previewServers).toHaveLength(1);
  });

  it('answers unavailable until the cockpit knows its own port, so cezar_port cannot be skipped', async () => {
    // Recovered runs launch before `startServer` binds: `cezarPort()` is undefined in that window.
    let boundPort: number | undefined;
    manager!.dispose();
    manager = new RunManager(store, repoRoot, { preview, cezarPort: () => boundPort });
    const provision = vi.spyOn(CiToolController.prototype, 'provision');
    const record = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'build the members page' });
    const register = await callbackAt(provision, 0);

    const early = await register({ command: 'npm run dev', port: 4321 });
    expect(early).toMatchObject({ ok: false, code: 'unavailable' });
    expect(store.getRun(record.id)?.previewServers ?? []).toHaveLength(0);

    boundPort = 4321;
    expect(await register({ command: 'npm run dev', port: 4321 })).toMatchObject({ ok: false, code: 'cezar_port' });
    expect(await register({ command: 'npm run dev', port: 5173 })).toMatchObject({ ok: true, code: 'registered' });
  });

  it('answers headless without a preview host', async () => {
    manager!.dispose();
    manager = new RunManager(store, repoRoot);
    const provision = vi.spyOn(CiToolController.prototype, 'provision');
    const record = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'build the members page' });
    const register = await callbackAt(provision, 0);
    expect(await register({ command: 'npm run dev', port: 5173 })).toMatchObject({ ok: false, code: 'headless' });
    expect(store.getRun(record.id)?.previewServers).toBeUndefined();
  });

  it('tells a run that never had a worktree that preview is unavailable for it, not that it was removed', async () => {
    const provision = vi.spyOn(CiToolController.prototype, 'provision');
    const record = manager!.startRun(QUICK_TASK_WORKFLOW, { task: 'build the members page', worktree: false });
    const register = await callbackAt(provision, 0);
    expect(store.getRun(record.id)?.worktreePath).toBeUndefined();
    expect(await register({ command: 'npm run dev', port: 5173 })).toEqual({
      ok: false,
      code: 'worktree_missing',
      message: 'This task runs without its own worktree, so live preview is not available.',
      hint: 'Do not retry. Report the command and port in your final message.',
    });
    expect(store.getRun(record.id)?.previewServers).toBeUndefined();
  });

  it('tells a run whose worktree was removed that it no longer exists', async () => {
    const provision = vi.spyOn(CiToolController.prototype, 'provision');
    const record = manager!.startRun(QUICK_TASK_WORKFLOW, { task: 'build the members page' });
    const register = await callbackAt(provision, 0);
    const worktreePath = store.getRun(record.id)?.worktreePath;
    expect(worktreePath).toBeTruthy();
    rmSync(worktreePath!, { recursive: true, force: true });
    expect(await register({ command: 'npm run dev', port: 5173 })).toEqual({
      ok: false,
      code: 'worktree_missing',
      message: 'This task\'s worktree no longer exists.',
      hint: 'Do not retry.',
    });
    expect(store.getRun(record.id)?.previewServers).toBeUndefined();
  });
});
