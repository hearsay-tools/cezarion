import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunSpec } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
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

const roots: string[] = [];
const managers: RunManager[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cez-unarchive-')); roots.push(root);
  const store = RunStore.open(join(root, '.ai/cezar'));
  const manager = new RunManager(store, root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }) });
  managers.push(manager);
  return { store, manager };
}

function archivedFinished(store: RunStore) {
  const run = store.createRun({
    title: 'task', task: 'task', workflow: 'original',
    steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
  });
  store.updateStep(run.id, 'work', { status: 'done', sessionId: 'old-session' });
  store.updateRun(run.id, { status: 'done' });
  store.setArchived(run.id, true);
  return run;
}

afterEach(async () => {
  captured.release?.(); captured.release = undefined;
  for (const manager of managers.splice(0)) manager.dispose();
  await new Promise(resolve => setTimeout(resolve, 30));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  captured.specs.length = 0;
});

describe('continueRun unarchives', () => {
  it.each([
    { name: 'human Continue', defer: false, status: 'running' as const },
    { name: 'deferred restart recovery', defer: true, status: 'queued' as const },
  ])('$name on an archived run clears archived and archivedAt', ({ defer, status }) => {
    const { store, manager } = fixture();
    const run = archivedFinished(store);
    expect(store.getRun(run.id)).toMatchObject({ archived: true });
    expect(store.getRun(run.id)?.archivedAt).toBeDefined();

    expect(manager.continueRun(run.id, { text: 'keep going' }, defer)).toEqual({ ok: true });

    const after = store.getRun(run.id);
    expect(after?.archived).toBe(false);
    expect(after?.archivedAt).toBeUndefined();
    expect(after?.status).toBe(status);
    expect(after?.pinned).toBeUndefined();
  });

  it('a refused Continue leaves the run archived', () => {
    const { store, manager } = fixture();
    const run = store.createRun({
      title: 'task', task: 'task', workflow: 'original',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });
    store.updateStep(run.id, 'work', { status: 'done' });
    store.updateRun(run.id, { status: 'done' });
    store.setArchived(run.id, true);

    expect(manager.continueRun(run.id, { text: 'keep going' })).toMatchObject({ ok: false });
    expect(store.getRun(run.id)?.archived).toBe(true);
    expect(store.getRun(run.id)?.archivedAt).toBeDefined();
  });
});
