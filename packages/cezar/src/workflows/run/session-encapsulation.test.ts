import { expect, it, vi } from 'vitest';
import type { AgentSession } from '../../core/agent-runner.ts';
import { delegationExecutionSettings } from '../../delegation/execution-settings.ts';
import { createActiveRun } from '../active-run.ts';
import { createSessionGroup } from './live-session-state.ts';

const unused = (): never => { throw new Error('unused session capability'); };
function session(): AgentSession {
  return { open: true, result: Promise.resolve({ text: '', toolCalls: [], tokensUsed: 0 }),
    sendMessage: unused, sendAgentMessage: unused, discardQueuedMessages: unused,
    holdsHumanInput: unused, end: unused, interrupt: vi.fn() };
}
const define = (target: object, key: string, value: unknown) => Reflect.defineProperty(target, key, { value });
const set = (target: object, key: string, value: unknown) => Reflect.set(target, key, value);
const setPrototype = (target: object, prototype: object | null) => Reflect.setPrototypeOf(target, prototype);
const replace = (target: object, key: string, value: unknown) => Object.assign(target, { [key]: value });

it('locks the session slot and group while commands retain the same runner capability', () => {
  const state = createActiveRun({ cwd: '/task', pendingHumanAsk: false, autonomous: false });
  const group = state.liveSession;
  const wire = session();
  expect(Object.getOwnPropertyDescriptor(state, 'liveSession')).toMatchObject({ writable: false, configurable: false });
  expect(Object.isFrozen(group)).toBe(true);
  expect(Object.isFrozen(Object.getPrototypeOf(group))).toBe(true);
  expect(() => replace(state, 'liveSession', createSessionGroup('/other'))).toThrow(TypeError);
  expect(() => replace(group, 'session', wire)).toThrow(TypeError);
  expect(define(group, 'cwd', '/other')).toBe(false);
  expect(set(group, 'cancelled', true)).toBe(false);
  expect(setPrototype(group, null)).toBe(false);
  group.attachSession(wire);
  expect(group.session).toBe(wire);
  expect(Object.isFrozen(wire)).toBe(false);
  group.markSessionOpened();
  group.selectStep('work');
  group.installInterrupt(wire.interrupt);
  group.interrupt();
  expect(wire.interrupt).toHaveBeenCalledOnce();
  group.retireSession();
  group.clearStep();
  expect(group.session).toBeUndefined();
  expect(group.currentStepId).toBeUndefined();
  expect(group.sessionEverOpened).toBe(true);
  expect(state.liveSession).toBe(group);
});

it('keeps stable live permission views, insertion order and independent generations', () => {
  const group = createSessionGroup('/task');
  const other = createSessionGroup('/other');
  const view = group.pendingPermissions;
  const iterator = view.values();
  group.requestPermission('one');
  group.requestPermission('two');
  expect(iterator.next()).toEqual({ value: 'one', done: false });
  expect([...view]).toEqual(['one', 'two']);
  expect(group.pendingPermissions).toBe(view);
  view.forEach((_value, _key, received) => { expect(received).toBe(view); });
  expect(Object.isFrozen(view)).toBe(true);
  expect(() => Set.prototype.add.call(view, 'forged')).toThrow(TypeError);
  expect(() => replace(view, 'size', 99)).toThrow(TypeError);
  expect(group.resolvePermission('one')).toBe(true);
  expect(group.resolvePermission('missing')).toBe(false);
  expect([...view]).toEqual(['two']);
  expect(other.pendingPermissions.size).toBe(0);
  group.clearPermissions();
  expect(view.size).toBe(0);
  group.requestPermission('old');
  group.resetPermissions();
  expect([...view]).toEqual(['old']);
  expect(group.pendingPermissions).not.toBe(view);
  expect(group.pendingPermissions.size).toBe(0);
});

it('owns frozen cloneable settings without freezing shared launch inputs', () => {
  const state = createActiveRun({ cwd: '/task', pendingHumanAsk: false, autonomous: false });
  const source = { cwd: '/task', runner: 'claude' as const, agentProfile: 'default', allowedTools: ['Read'],
    bashAllowlist: ['pwd'], accountBinding: { provider: 'claude' as const, profileId: 'default',
      claudeLayout: { kind: 'native' as const, statePath: '/state' } } };
  state.liveSession.captureDelegationSettings(source);
  state.liveSession.attachSession(session());
  const value = state.liveSession.delegationSettings!;
  expect(value).toEqual(source);
  expect(state.liveSession.delegationSettings).toBe(value);
  expect(value).not.toBe(source);
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  for (const owned of [value, value.allowedTools, value.bashAllowlist, value.accountBinding, value.accountBinding!.claudeLayout]) {
    expect(Object.isFrozen(owned)).toBe(true);
  }
  expect(Object.isFrozen(source)).toBe(false);
  expect(Object.isFrozen(source.accountBinding)).toBe(false);
  source.allowedTools.push('Write');
  source.accountBinding.claudeLayout.statePath = '/changed';
  expect(value.allowedTools).toEqual(['Read']);
  expect(value.accountBinding!.claudeLayout).toEqual({ kind: 'native', statePath: '/state' });
  expect(() => replace(value.accountBinding!, 'profileId', 'forged')).toThrow(TypeError);
  const clone = delegationExecutionSettings(state);
  expect(clone).toEqual(value);
  expect(clone).not.toBe(value);
  expect(Object.isFrozen(clone)).toBe(false);
  replace(clone, 'cwd', '/independent');
  expect(value.cwd).toBe('/task');
});

it('starts with the old defaults and changes only the requested handles', () => {
  const group = createSessionGroup('/task');
  expect(group.cancelled).toBe(false);
  for (const value of [group.delegationSettings, group.revokeDelegation, group.revokeCiTools, group.ciGeneration,
    group.finishRequested, group.session, group.agentSessionError, group.currentStepId,
    group.sessionEverOpened, group.releaseRepoRoot]) expect(value).toBeUndefined();
  expect(group.interrupt()).toBeUndefined();
  const revoke = vi.fn();
  group.installDelegationRevoker(revoke);
  group.installCiRevoker(revoke);
  group.retainRepoRootRelease(revoke);
  group.beginCiGeneration('generation');
  group.recordSessionError('failure');
  group.changeWorkingDirectory('/worktree');
  group.requestFinish();
  group.cancel();
  expect(group.revokeDelegation).toBe(revoke);
  expect(group.revokeCiTools).toBe(revoke);
  expect(group.releaseRepoRoot).toBe(revoke);
  expect(group.ciGeneration).toBe('generation');
  expect(group.agentSessionError).toBe('failure');
  expect(group.cwd).toBe('/worktree');
  expect(group.finishRequested).toBe(true);
  expect(group.cancelled).toBe(true);
  group.clearDelegationRevoker();
  group.clearCiRevoker();
  group.clearRepoRootRelease();
  expect(revoke).not.toHaveBeenCalled();
  expect(group.revokeDelegation).toBeUndefined();
  expect(group.revokeCiTools).toBeUndefined();
  expect(group.releaseRepoRoot).toBeUndefined();
});
