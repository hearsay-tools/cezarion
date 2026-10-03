import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.js';
import { RunManager } from './run.js';
import type { WorkflowDef } from './types.js';

const workflow: WorkflowDef = {
  name: 'quick-task', source: 'built-in',
  steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
};
const providerError = 'pi: openai-codex/gpt-5.6-sol request failed: WebSocket error';

describe('Pi provider failure survives teardown (#73)', () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-pi-teardown-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'gc.auto', '0'], { cwd: root });
    execFileSync('git', ['config', 'maintenance.auto', 'false'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-qm', 'base'], { cwd: root });
    vi.stubEnv('CEZ_DRY_RUN', '1');
    vi.stubEnv('CEZ_PI_BIN', new URL('../core/__fixtures__/pi/stub-sigterm.mjs', import.meta.url).pathname);
    store = RunStore.open(join(root, '.ai/cezar'));
    manager = new RunManager(store, root);
  });
  afterEach(() => {
    manager.dispose();
    store.flush();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it.each(['143', '1'])('execute and Continue keep the provider error after teardown exit %s', async (code) => {
    const task = `provider-error exit-${code}`;
    const { id } = manager.startRun(workflow, { task, runner: 'pi', worktree: false });
    await vi.waitFor(() => expect(store.getRun(id)?.status).toBe('failed'), { timeout: 15_000 });
    expect.soft(store.getRun(id)?.steps[0]?.error).toBe(providerError);
    await vi.waitFor(() => expect(manager.isActive(id)).toBe(false));
    expect(manager.continueRun(id, { text: task })).toEqual({ ok: true });
    await vi.waitFor(() => expect(store.getRun(id)?.steps.find((step) => step.id === 'continue-1')?.status).toBe('failed'), { timeout: 15_000 });
    expect(store.getRun(id)?.steps.find((step) => step.id === 'continue-1')?.error).toBe(providerError);
    expect(store.getRun(id)?.error).toBe(`continue failed: ${providerError}`);
    await vi.waitFor(() => expect(manager.isActive(id)).toBe(false));
  }, 35_000);
});
