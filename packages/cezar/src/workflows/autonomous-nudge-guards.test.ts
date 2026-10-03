import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';

// Focused policy guards complement workflow-autonomous-parity's actual native
// wires. A refused nudge must never touch either transport or consume its budget.
type State = Parameters<RunManager['tryAutonomousNudge']>[1];
const ask = { questions: [{ header: 'Choice', question: 'Which framework?', options: [{ label: 'Vitest' }, { label: 'Node' }] }] };
const guards = ['disabled', 'cancelled', 'finish', 'disposed', 'stopping', 'input-error', 'native-ask', 'persisted-ask',
  'closed', 'queued-input', 'unread-input', 'input-flight', 'worker-wait', 'ci-wait', 'worker-wake', 'root-finish'] as const;

describe('autonomous nudge priority and lifecycle guards', () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  let id: string;
  let state: State;
  let session: AgentSession;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-autonomous-guards-'));
    store = RunStore.open(join(root, '.ai/cezar'));
    id = store.createRun({ title: 'guard', task: 'work', workflow: 'quick-task', autonomous: true, steps: [{ id: 'task', name: 'Task', kind: 'agent' }] }).id;
    store.updateRun(id, { status: 'running' });
    manager = new RunManager(store, root);
    session = {
      open: true, result: Promise.resolve({ text: '', toolCalls: [], tokensUsed: 0 }),
      sendMessage: vi.fn(() => true), sendAgentMessage: vi.fn(() => Promise.resolve()),
      end: vi.fn(), interrupt: vi.fn(), discardQueuedMessages: vi.fn(),
    };
    state = { cwd: root, cancelled: false, interrupt: () => {}, pendingHumanAsk: false, autonomous: true, autoContinues: 0, session };
  });
  afterEach(() => { manager.dispose(); store.flush(); rmSync(root, { recursive: true, force: true }); });

  for (const portable of [false, true]) it.each(guards)('%s blocks the nudge (portable ASK=' + portable + ')', guard => {
    switch (guard) {
      case 'disabled': state.autonomous = false; break; // includes the memory-limit pause
      case 'cancelled': state.cancelled = true; break;
      case 'finish': state.finishRequested = true; break;
      case 'disposed': manager.dispose(); break;
      case 'stopping': store.updateRun(id, { stopping: true }); break;
      case 'input-error': state.agentInputError = 'transport failed'; break;
      case 'native-ask': state.pendingHumanAsk = true; break;
      case 'persisted-ask': store.appendEvent(id, { type: 'ask.requested', requestId: randomUUID(), ...ask }); break;
      case 'closed': state.session = { ...session, open: false }; break;
      case 'queued-input': store.commitAgentInputs(id, [{ id: randomUUID(), source: 'agent', parentRunId: randomUUID(), text: 'Read this first', createdAt: new Date().toISOString() }]); break;
      case 'unread-input': state.unreadInputIds = new Set([randomUUID()]); break;
      case 'input-flight': state.agentInputFlight = { session, inputIds: [randomUUID()] }; break;
      case 'worker-wait': store.commitDelegation([{ id, delegation: { role: 'root', permissions: ['wait'], receipts: [], wait: {
        id: randomUUID(), workerIds: [randomUUID()], deadline: new Date(Date.now() + 60_000).toISOString(), phase: 'registered', outcomes: [],
      } } }]); break;
      case 'ci-wait': store.commitCiWait(id, {
        id: randomUUID(), prUrl: 'https://github.com/acme/repo/pull/1', repository: 'acme/repo', prNumber: 1, headSha: 'a'.repeat(40),
        generation: 'generation', turnId: 'turn', timeoutSeconds: 60, registeredAt: new Date().toISOString(), deadline: new Date(Date.now() + 60_000).toISOString(), phase: 'registered',
      }); break;
      case 'worker-wake': manager['workerWakeAdmitted'].add(id); break;
      case 'root-finish': store.commitDelegation([{ id, delegation: { role: 'root', permissions: [], receipts: [], finishRequestedAt: new Date().toISOString() } }]); break;
    }
    expect(manager['tryAutonomousNudge'](id, state, 'task', portable ? ask : null)).toBe(false);
    expect(session.sendMessage).not.toHaveBeenCalled();
    expect(session.sendAgentMessage).not.toHaveBeenCalled();
    expect(state.autoContinues).toBe(0);
    expect(store.readEvents(id).some(e => e.type === 'note' && String(e.message).includes('autonomous'))).toBe(false);
  });

  it('a refused portable override leaves the question and budget untouched', () => {
    vi.mocked(session.sendMessage).mockReturnValue(false);
    expect(manager['tryAutonomousNudge'](id, state, 'task', ask)).toBe(false);
    expect(state.autoContinues).toBe(0);
    expect(store.readEvents(id).filter(e => e.type === 'note' || e.type === 'human-input-delivered')).toEqual([]);
  });
});
