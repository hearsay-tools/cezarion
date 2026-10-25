import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunner, AgentRunResult, AgentSession, SessionOptions } from './agent-runner.ts';
import { startManagedSession } from './managed-session.ts';
import { DEFAULT_NO_PROGRESS_TIMEOUT_MS as LIMIT } from './runner-runtime.ts';
import { UNSET_TOOL_GRANT } from './tool-grant.testkit.ts';

function fixture(respondPermission?: (requestId: string, optionId: string) => boolean) {
  vi.useFakeTimers();
  let emit!: (event: AgentEvent) => void;
  let options!: SessionOptions;
  let settle!: (result: AgentRunResult) => void;
  const result = new Promise<AgentRunResult>(resolve => { settle = resolve; });
  const live: AgentSession = {
    result, open: true, sendMessage: () => true, sendAgentMessage: () => false,
    ...(respondPermission ? { respondPermission } : {}),
    discardQueuedMessages() {}, holdsHumanInput() { return false; }, end: vi.fn(), interrupt: vi.fn(),
  };
  const runner: Pick<AgentRunner, 'startSession'> = {
    startSession(_spec, onEvent, opts) { emit = onEvent!; options = opts!; return live; },
  };
  const events: AgentEvent[] = [];
  const session = startManagedSession(runner, { toolGrant: UNSET_TOOL_GRANT, userPrompt: 'work', cwd: '.', timeoutMs: 0 }, e => events.push(e), {});
  return { session, live, emit, options, events, settle: () => settle({ text: '', toolCalls: [], tokensUsed: 0 }) };
}
afterEach(() => vi.useRealTimers());
describe('managed open-turn watchdog', () => {
  it('defaults to 30 minutes, resets on activity, and retains the slot until actual exit', async () => {
    expect(LIMIT).toBe(30 * 60_000);
    const f = fixture();
    await vi.advanceTimersByTimeAsync(LIMIT - 1);
    f.options.onActivity!();
    await vi.advanceTimersByTimeAsync(LIMIT - 1);
    expect(f.live.interrupt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.live.interrupt).toHaveBeenCalledOnce();
    expect(f.events).toEqual([{ type: 'error', message: expect.stringContaining('no progress for 30 minutes') }]);
    let settled = false;
    void f.session.result.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(LIMIT);
    expect(settled).toBe(false);
    expect(f.events).toHaveLength(1);
    f.settle(); await f.session.result;
    expect(settled).toBe(true);
  });
  it('ignores background heartbeats while parked and rearms on a new turn', async () => {
    const f = fixture(); f.emit({ type: 'turn-end' });
    f.options.onActivity!();
    await vi.advanceTimersByTimeAsync(LIMIT * 2);
    expect(f.events).toHaveLength(1);
    f.options.onUiEvent!({ type: 'turn.started', turnId: 'next' });
    await vi.advanceTimersByTimeAsync(LIMIT);
    expect(f.live.interrupt).toHaveBeenCalledOnce();
  });
  it('pauses native human questions and rearms on an accepted answer in the same turn', async () => {
    const f = fixture();
    f.options.onUiEvent!({ type: 'ask.requested', requestId: 'q', questions: [{ header: 'Test', question: 'Choose?', options: [{ label: 'A' }, { label: 'B' }] }] });
    f.options.onActivity!();
    await vi.advanceTimersByTimeAsync(LIMIT * 2);
    expect(f.live.interrupt).not.toHaveBeenCalled();
    f.session.sendMessage([{ type: 'text', text: 'A' }]);
    await vi.advanceTimersByTimeAsync(LIMIT);
    expect(f.live.interrupt).toHaveBeenCalledOnce();
  });
  it('arms admitted agent input before an ACK with no turn-start notification', async () => {
    const f = fixture(); f.emit({ type: 'turn-end' });
    f.live.sendAgentMessage = () => Promise.resolve();
    await f.session.sendAgentMessage([{ type: 'text', text: 'continue' }]);
    await vi.advanceTimersByTimeAsync(LIMIT);
    expect(f.live.interrupt).toHaveBeenCalledOnce();
  });
  for (const outcome of ['refused', 'rejected', 'turn-ended', 'question'] as const) {
    it(`does not leave agent admission armed after ${outcome}`, async () => {
      const f = fixture(); f.emit({ type: 'turn-end' });
      f.live.sendAgentMessage = () => {
        if (outcome === 'refused') return false;
        if (outcome === 'rejected') return Promise.reject(new Error('not admitted'));
        if (outcome === 'turn-ended') f.emit({ type: 'turn-end' });
        else f.options.onUiEvent!({ type: 'ask.requested', requestId: 'q', questions: [] });
        return Promise.resolve();
      };
      const result = f.session.sendAgentMessage([{ type: 'text', text: 'continue' }]);
      if (outcome === 'rejected') await expect(result).rejects.toThrow('not admitted');
      else await result;
      await vi.advanceTimersByTimeAsync(LIMIT * 2);
      expect(f.live.interrupt).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });
  }
  for (const action of ['end', 'interrupt', 'result', 'provider-error'] as const) {
    it(`disposes the guard on ${action}`, async () => {
      const f = fixture();
      if (action === 'result') { f.settle(); await f.session.result; }
      else if (action === 'provider-error') f.emit({ type: 'error', message: 'provider failed' });
      else f.session[action]();
      f.options.onActivity!();
      f.options.onUiEvent!({ type: 'turn.started', turnId: 'late' });
      await vi.advanceTimersByTimeAsync(LIMIT * 2);
      expect(f.events.some(e => e.type === 'error' && e.message.includes('no progress'))).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });
  }
});

describe('managed permission lifecycle (hearsay-tools/cezarion#1049)', () => {
  const permission = (requestId: string) => ({ type: 'permission.requested' as const, requestId, title: 'Run command?', options: [{ id: 'allow', label: 'Allow once', kind: 'allow_once' as const }] });
  it('parks the no-progress timer while a human approval is pending', async () => {
    const f = fixture();
    f.options.onUiEvent!(permission('one'));
    f.options.onActivity!();
    await vi.advanceTimersByTimeAsync(LIMIT * 2);
    expect(f.live.interrupt).not.toHaveBeenCalled();
    expect(f.session.sendMessage([{ type: 'text', text: 'accept' }])).toBe(false);
    expect(f.session.sendAgentMessage([{ type: 'text', text: 'accept' }])).toBe(false);
  });
  it('forwards an explicit decision and waits for all concurrent approvals before rearming', async () => {
    const reply = vi.fn((requestId: string, optionId: string) => {
      if (optionId !== 'allow') return false;
      f.options.onUiEvent!({ type: 'permission.resolved', requestId, optionId });
      return true;
    });
    const f = fixture(reply);
    f.options.onUiEvent!(permission('one')); f.options.onUiEvent!(permission('two'));
    expect(f.session.respondPermission?.('one', 'invalid')).toBe(false);
    expect(f.session.respondPermission?.('one', 'allow')).toBe(true);
    await vi.advanceTimersByTimeAsync(LIMIT * 2);
    expect(f.live.interrupt).not.toHaveBeenCalled();
    expect(f.session.respondPermission?.('two', 'allow')).toBe(true);
    expect(reply).toHaveBeenLastCalledWith('two', 'allow');
    await vi.advanceTimersByTimeAsync(LIMIT);
    expect(f.live.interrupt).toHaveBeenCalledOnce();
  });
});
