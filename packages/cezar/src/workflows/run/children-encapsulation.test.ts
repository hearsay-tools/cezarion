import { testHome } from '../../home/test-home.testkit.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { AgentSession } from '../../core/agent-runner.ts';
import type { ToolStatus, UiEvent } from '../../core/ui-events.ts';
import { RunStore } from '../../runs/store.ts';
import { WorkspaceSemaphore } from '../../workspace/semaphore.ts';
import { createActiveRun } from '../active-run.ts';
import { SubagentWaits, liveSubagents } from './subagent-waits.ts';
import { TrackedWork } from './tracked-work.ts';
import { noRunners } from '../../core/runners-under-test.testkit.ts';

const unused = (): never => { throw new Error('unused child wait collaborator'); };
let root: string;
let store: RunStore;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cez-child-owner-')); store = RunStore.open(root); });
afterEach(() => { store.flush(); rmSync(root, { recursive: true, force: true }); });
const event = (status: ToolStatus): UiEvent => ({ type: 'item.updated', item: {
  kind: 'tool', id: 'child', name: 'Agent', toolKind: 'task', title: 'research', status, background: true,
} });

it('keeps a live read view, immutable child records and independent owner state', () => {
  const state = createActiveRun({ cwd: root, pendingHumanAsk: false, autonomous: false });
  const other = createActiveRun({ cwd: root, pendingHumanAsk: false, autonomous: false });
  const session: AgentSession = { open: true, result: Promise.resolve({ text: '', toolCalls: [], tokensUsed: 0 }),
    sendMessage: unused, sendAgentMessage: unused, discardQueuedMessages: unused, holdsHumanInput: unused,
    end: unused, interrupt: unused };
  state.liveSession.attachSession(session);
  // This observation-only case calls no wait/line policy. A read of one fails the test.
  const owner = new SubagentWaits({ createRunner: noRunners, home: testHome(), store, repoRoot: root, dataDir: root,
    semaphore: new WorkspaceSemaphore({ home: testHome() }), work: new TrackedWork(), disposed: () => false }, {
    get waitCancellation(): ConstructorParameters<typeof SubagentWaits>[1]['waitCancellation'] { throw new Error('unused wait cancellation'); },
    get waitEngine(): ConstructorParameters<typeof SubagentWaits>[1]['waitEngine'] { return unused(); },
    active: new Map(), isParked: unused, isAdmitted: unused, settleWait: unused,
    armWait: unused, disarmWait: unused, releaseHeldPark: unused,
  });
  const view = state.children.backgroundChildren;
  owner.trackEvent('run', state, event('running'));
  const child = view.get('child')!;
  expect(child.session).toBe(session);
  expect(child.status).toBe('running');
  expect(liveSubagents(state)).toBe(1);
  expect(Object.isFrozen(child)).toBe(true);
  expect(Object.isFrozen(session)).toBe(false);
  const mutate = (target: object) => Object.assign(target, { status: RUN_STATUS.failed });
  expect(() => mutate(child)).toThrow(TypeError);
  expect(() => Map.prototype.set.call(view, 'forged', child)).toThrow(TypeError);
  owner.trackEvent('run', state, event('completed'));
  expect(state.children.backgroundChildren).toBe(view);
  expect(view.get('child')).toEqual({ session, status: 'completed' });
  expect(view.get('child')).not.toBe(child);
  expect(child.status).toBe('running');
  expect(liveSubagents(state)).toBe(0);
  owner.trackEvent('run', state, event('running'));
  expect(view.get('child')!.status).toBe('completed');
  expect(other.children.backgroundChildren.size).toBe(0);
  expect(Object.isFrozen(state.children)).toBe(true);
  expect(Object.isFrozen(Object.getPrototypeOf(state.children))).toBe(true);
  const replace = (target: object, replacement: object) => Object.assign(target, { children: replacement });
  expect(() => replace(state, other.children)).toThrow(TypeError);
  owner.dispose();
});
