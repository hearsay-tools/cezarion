import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import * as agentProfiles from '../workspace/agent-profiles.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

// Route-level guard cases for the extracted handlers. Inject launchers so this suite never
// opens a GUI or a real coding-agent session, and own all account and provider state.
describe('run open-in target dispatch and refusals', () => {
  let root: string;
  let store: RunStore;
  let runId: string;
  const openApp = vi.fn(async () => true);
  const openTerminal = vi.fn(async () => true);
  const openFile = vi.fn(async () => true);

  beforeEach(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), 'cez-open-targets-'));
    vi.stubEnv('CEZ_HOME', join(root, 'home'));
    vi.stubEnv('CEZ_REMOTE', '0');
    vi.stubEnv('CEZ_AGENT_MODELS_LOCKED', '1');
    store = RunStore.open(join(root, '.ai/cezar'));
    runId = store.createRun({ title: 't', task: 't', workflow: 'quick-task', steps: [] }).id;
    vi.clearAllMocks();
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const post = (target: string, path?: string) => apiRequest(
    createApp({ repoRoot: root, store, manager: {} as RunManager, version: 'test', openApp, openTerminal, openFile }),
    `/api/v1/runs/${runId}/open-in`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target, path }) },
  );

  it.each(['vscode', 'finder', 'terminal'])('opens %s in the existing worktree', async (target) => {
    const worktree = join(root, 'worktree');
    mkdirSync(worktree);
    store.updateRun(runId, { worktreePath: worktree });
    const res = await post(target);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ opened: true, path: worktree });
    expect(openApp).toHaveBeenCalledWith(target, worktree);
    expect(openTerminal).not.toHaveBeenCalled();
  });

  it('falls back to the repo root when the recorded worktree is gone', async () => {
    store.updateRun(runId, { worktreePath: join(root, 'gone') });
    const res = await post('finder');
    expect(await res.json()).toEqual({ opened: true, path: root });
    expect(openApp).toHaveBeenCalledWith('finder', root);
  });

  it('preserves the target and path when an app cannot open', async () => {
    openApp.mockResolvedValueOnce(false);
    const res = await post('vscode');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'could not open vscode', path: root });
  });

  it.each([undefined, 'gone'])('refuses default-app opening without a live worktree (%s)', async (path) => {
    if (path) store.updateRun(runId, { worktreePath: join(root, path) });
    const res = await post('default', 'image.png');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'no worktree — this task ran directly in the repo working tree' });
    expect(openFile).not.toHaveBeenCalled();
  });

  it('returns the copy-paste fallback when no terminal can open', async () => {
    openTerminal.mockResolvedValueOnce(false);
    const res = await post('cli:claude');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'no terminal emulator found', command: `cd '${root}' && claude` });
  });

  it.each([
    ['CEZ_CURSOR_BIN', 'cursor', 'Cursor'],
    ['CEZ_OMP_BIN', 'omp', 'OMP'],
  ])('refuses an unsafe %s executable before launching', async (key, runner, label) => {
    vi.stubEnv(key, '/unsafe\nexecutable');
    const res = await post(`cli:${runner}`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: `the configured ${label} executable cannot be used in a terminal command` });
    expect(openTerminal).not.toHaveBeenCalled();
  });

  it('refuses account paths that cannot be carried in the terminal command', async () => {
    // Persisted accounts already reject control characters. Inject the resolved environment
    // at this boundary to exercise the terminal's independent fail-closed safeguard.
    vi.spyOn(agentProfiles, 'resolveProfileEnvForRoot').mockResolvedValueOnce({
      profile: agentProfiles.defaultAgentProfile('claude'),
      env: { CLAUDE_CONFIG_DIR: '/account\nfolder' },
    });
    const res = await post('cli:claude');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "this account's folder cannot be used in a terminal command" });
    expect(openTerminal).not.toHaveBeenCalled();
  });
});
