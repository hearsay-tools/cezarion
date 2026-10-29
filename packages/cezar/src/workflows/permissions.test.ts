import { runInternals } from './run-internals.testkit.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '../core/agent-runner.ts';
import type { UiEvent } from '../core/ui-events.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';

type State = Parameters<RunManager['tryAutonomousNudge']>[1];
describe('human permission lifecycle', () => {
  let root: string, store: RunStore, manager: RunManager, id: string, state: State, session: AgentSession;
  const emit = (event: UiEvent) => manager['handleRunnerUiEvent'](id, state, manager['makeUiSink'](id, 'task'), event);
  const request = (requestId: string) => emit({ type: 'permission.requested', requestId, title: 'Run command', options: [{ id: 'deny', label: 'Decline', kind: 'reject_once' }] });
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cez-permission-'));
    store = RunStore.open(join(root, '.ai/cezar'));
    id = store.createRun({ title: 'Permission', task: 'work', workflow: 'quick-task', steps: [{ id: 'task', name: 'Task', kind: 'agent' }] }).id;
    await store.factsWarmIdle();
    store.updateRun(id, { status: 'running' });
    manager = new RunManager(store, root);
    session = { open: true, result: new Promise(() => {}), sendMessage: vi.fn(() => true), sendAgentMessage: vi.fn(() => Promise.resolve()),
      respondPermission: vi.fn((requestId, optionId) => {
        if (optionId !== 'deny') return false;
        emit({ type: 'permission.resolved', requestId, optionId }); return true;
      }), end: vi.fn(), interrupt: vi.fn(), discardQueuedMessages: vi.fn(), holdsHumanInput: () => false };
    state = { cwd: root, cancelled: false, interrupt: () => {}, pendingHumanAsk: false, autonomous: true, session, currentStepId: 'task' };
    manager['activate'](id, state);
  });
  afterEach(() => { manager.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); });

  it('parks concurrent requests until their exact IDs resolve and blocks all ordinary input', () => {
    request('a'); request('b');
    expect(store.getRun(id)).toMatchObject({ status: 'waiting', hasPendingPermission: true });
    expect(runInternals(manager).line.busySlots()).toBe(0);
    expect(manager.sendMessage(id, [{ type: 'text', text: 'accept' }])).toBe(false);
    expect(manager['tryAutonomousNudge'](id, state, 'task', null)).toBe(false);
    expect(session.sendMessage).not.toHaveBeenCalled();
    expect(session.sendAgentMessage).not.toHaveBeenCalled();
    expect(store.readEvents(id).some(event => event.type === 'user-message')).toBe(false);
    expect(manager.respondPermission(id, 'a', 'invalid')).toBe(false);
    expect(manager.respondPermission(id, 'unknown', 'deny')).toBe(false);
    expect(manager.respondPermission(id, 'a', 'deny')).toBe(true);
    expect(store.getRun(id)).toMatchObject({ status: 'waiting', hasPendingPermission: true });
    expect(manager.respondPermission(id, 'a', 'deny')).toBe(false);
    expect(manager.respondPermission(id, 'b', 'deny')).toBe(true);
    expect(store.getRun(id)).toMatchObject({ status: 'running', hasPendingPermission: false });
    expect(runInternals(manager).line.busySlots()).toBe(1);
  });

  it.each(['cancelled', 'stopping', 'closed'] as const)('%s refuses decisions and teardown clears attention', reason => {
    request('a');
    if (reason === 'cancelled') state.cancelled = true;
    if (reason === 'stopping') store.updateRun(id, { stopping: true });
    if (reason === 'closed') state.session = { ...session, open: false };
    expect(manager.respondPermission(id, 'a', 'deny')).toBe(false);
    expect(session.respondPermission).not.toHaveBeenCalled();
    manager['dropActive'](id);
    expect(store.getRun(id)?.hasPendingPermission).toBe(false);
    expect(manager.respondPermission(id, 'a', 'deny')).toBe(false);
  });
});
