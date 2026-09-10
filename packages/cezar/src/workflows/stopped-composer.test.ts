import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunSpec } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { mergeWriteAgentAccounts } from '../workspace/agent-accounts.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';

const captured = vi.hoisted(() => ({ specs: [] as AgentRunSpec[], release: undefined as (() => void) | undefined }));
vi.mock('../core/runner-factory.ts', () => ({ createRunner: () => ({
  backend: 'claude', interrupt: async () => {},
  startSession: (spec: AgentRunSpec) => {
    captured.specs.push(spec);
    return { result: new Promise(resolve => { captured.release = () => resolve({ text: 'ok', toolCalls: [], tokensUsed: 0 }); }),
      sendMessage: () => true, discardQueuedMessages: () => {}, end: () => {}, interrupt: () => {}, open: true };
  },
}) }));
const workflow = { name: 'original', source: 'built-in' as const, steps: [{ id: 'work', prompt: '{{task}}', allowedTools: ['Read'] }] };
const roots: string[] = [];
const managers: RunManager[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cez-stopped-')); roots.push(root);
  const data = join(root, '.ai/cezar');
  const store = RunStore.open(data);
  const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 0 } });
  const manager = new RunManager(store, root, { semaphore }); managers.push(manager);
  return { root, data, store, manager };
}
afterEach(async () => {
  captured.release?.(); captured.release = undefined;
  for (const manager of managers.splice(0)) manager.dispose();
  await new Promise(resolve => setTimeout(resolve, 30));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  captured.specs.length = 0;
});
describe('stopped composer engine', () => {
  it('requeues the same untouched workflow durably, preserving prompt, attachments and execution inputs across restart', async () => {
    const { root, data, store, manager } = fixture();
    const accountDir = join(root, 'selected-account');
    mkdirSync(accountDir); writeFileSync(join(accountDir, 'settings.json'), '{}');
    await mergeWriteAgentAccounts(accounts => { accounts.accounts.push({ id: 'stopped-composer-selected', provider: 'claude', configDir: accountDir, label: 'Selected', addedAt: '' }); });
    const run = manager.startRun(workflow, { task: 'original task', systemPrompt: 'private instruction', worktree: false,
      autonomous: true, runner: 'claude', model: 'opus', agentProfile: 'default',
      images: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }] });
    expect(manager.cancel(run.id)).toBe(true);
    const accepted = manager.continueRun(run.id, { text: 'new request', model: 'sonnet', effort: 'high', agentProfile: 'stopped-composer-selected', images: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'd29ybGQ=' } }] });
    expect(accepted).toEqual({ ok: true });
    expect(manager.continueRun(run.id)).toMatchObject({ ok: false });
    expect(store.getRun(run.id)).toMatchObject({ id: run.id, status: 'queued', task: 'original task', model: 'sonnet', effort: 'high', systemPrompt: 'private instruction', worktree: false, autonomous: true });
    expect(store.getRun(run.id)?.steps.map(step => step.id)).toEqual(['work']);
    expect(store.getRun(run.id)?.queuedMessages).toHaveLength(1);
    expect(captured.specs).toHaveLength(0);
    manager.dispose();
    const reopened = RunStore.open(data, { keepLive: true });
    const next = new RunManager(reopened, root); managers.push(next);
    await next.recover();
    await vi.waitFor(() => expect(captured.specs).toHaveLength(1));
    expect(captured.specs[0]).toMatchObject({ model: 'sonnet', effort: 'high', allowedTools: ['Read'], env: { CLAUDE_CONFIG_DIR: accountDir } });
    expect(JSON.stringify(captured.specs[0])).toContain('original task');
    expect(JSON.stringify(captured.specs[0])).toContain('new request');
    expect(JSON.stringify(captured.specs[0])).toContain('private instruction');
    expect(reopened.getRun(run.id)?.taskImages).toHaveLength(1);
    expect(reopened.getRun(run.id)?.queuedMessages?.[0]?.images).toHaveLength(1);
  });
  it('rejects replay when even one command step has already executed', () => {
    const { store, manager } = fixture();
    const run = manager.startRun(workflow, { task: 'task' }); manager.cancel(run.id);
    store.updateStep(run.id, 'work', { status: 'done' });
    expect(manager.continueRun(run.id)).toMatchObject({ ok: false });
  });
  it('exposes stopping until the process result settles and rejects Continue in that interval', async () => {
    const { root, store, manager } = fixture(); manager.dispose();
    const live = new RunManager(store, root); managers.push(live);
    const run = live.startRun(workflow, { task: 'task' });
    await vi.waitFor(() => expect(captured.specs).toHaveLength(1));
    expect(live.cancel(run.id)).toBe(true);
    expect(store.getRun(run.id)).toHaveProperty('stopping', true);
    expect(live.continueRun(run.id)).toMatchObject({ ok: false });
    captured.release?.();
    await vi.waitFor(() => expect(store.getRun(run.id)?.status).toBe('cancelled'));
    expect(store.getRun(run.id)?.stopping).not.toBe(true);
  });
  it('honors Stop during continuation startup and refuses buffered Send or a duplicate Continue', async () => {
    const { store, manager } = fixture();
    const run = store.createRun({ title: 'task', task: 'task', workflow: 'original', steps: [{ id: 'work', name: 'Work', kind: 'agent' }] });
    store.updateStep(run.id, 'work', { status: 'done', sessionId: 'old-session' });
    store.updateRun(run.id, { status: 'done' });
    expect(manager.continueRun(run.id)).toEqual({ ok: true });
    expect(manager.continueRun(run.id)).toMatchObject({ ok: false });
    expect(manager.cancel(run.id)).toBe(true);
    expect(manager.deferMessage(run.id, [{ type: 'text', text: 'must remain draft' }])).toBe(false);
    await vi.waitFor(() => expect(store.getRun(run.id)?.status).toBe('cancelled'));
    expect(captured.specs).toHaveLength(0);
    expect(store.getRun(run.id)?.stopping).not.toBe(true);
  });
  it('preserves old queued messages when an empty Continue requeues without inventing a new prompt', () => {
    const { manager, store } = fixture();
    const run = manager.startRun(workflow, { task: 'original' });
    manager.enqueueMessage(run.id, [{ type: 'text', text: 'earlier note' }]);
    manager.cancel(run.id);
    expect(manager.continueRun(run.id)).toEqual({ ok: true });
    expect(store.getRun(run.id)?.queuedMessages?.map(message => message.text)).toEqual(['earlier note']);
  });
  it('persists a queued Stop before acknowledging it', () => {
    const { manager, store, data } = fixture();
    const run = manager.startRun(workflow, { task: 'original' }); store.flush();
    expect(manager.cancel(run.id)).toBe(true);
    expect(RunStore.open(data, { keepLive: true }).getRun(run.id)?.status).toBe('cancelled');
  });
  it('does not resume an accepted stop after a restart', () => {
    const { store, data } = fixture();
    const run = store.createRun({ title: 'task', task: 'task', workflow: 'original', steps: [] });
    store.updateRun(run.id, { status: 'running', stopping: true }); store.flush();
    expect(RunStore.open(data, { keepLive: true }).getRun(run.id)).toMatchObject({ status: 'cancelled' });
  });
});
