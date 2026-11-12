import { afterEach, expect, it, vi } from 'vitest';
import { runnerHook } from './run-fixture.testkit.ts';
import { runnersUnderTest } from '../core/runners-under-test.testkit.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import { UNSET_TOOL_GRANT } from '../core/tool-grant.testkit.ts';
import type { AgentRunner, AgentSession } from '../core/agent-runner.ts';

afterEach(() => { runnerHook.runner = undefined; });

it('calls the original session start when two factory calls reuse one runner', () => {
  const session: AgentSession = {
    result: Promise.resolve({ text: '', toolCalls: [], tokensUsed: 0 }), open: false,
    sendMessage: () => false, sendAgentMessage: () => false, discardQueuedMessages() {},
    holdsHumanInput: () => false, end() {}, interrupt() {},
  };
  const start = vi.fn<AgentRunner['startSession']>(() => session);
  const runner: AgentRunner = {
    backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
    startSession: (...args) => start(...args), run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: async () => {},
  };
  runnerHook.runner = runner;
  const spec = { userPrompt: 'hello', cwd: '/tmp', toolGrant: UNSET_TOOL_GRANT };
  const firstUi = vi.fn();
  const secondUi = vi.fn();
  expect(runnersUnderTest()('claude').startSession(spec, undefined, { onUiEvent: firstUi })).toBe(session);
  runnerHook.uiEvent({ type: 'session.started', sessionId: 'first', backend: 'claude' });
  expect(runnersUnderTest()('claude').startSession(spec, undefined, { onUiEvent: secondUi })).toBe(session);
  runnerHook.uiEvent({ type: 'session.started', sessionId: 'second', backend: 'claude' });
  expect(start).toHaveBeenCalledTimes(2);
  expect(firstUi).toHaveBeenCalledExactlyOnceWith({ type: 'session.started', sessionId: 'first', backend: 'claude' });
  expect(secondUi).toHaveBeenCalledExactlyOnceWith({ type: 'session.started', sessionId: 'second', backend: 'claude' });
  runnerHook.runner = undefined;
  expect(() => runnerHook.uiEvent({ type: 'session.started', sessionId: 'stale', backend: 'claude' }))
    .toThrow('No runner UI channel observed');
  expect(secondUi).toHaveBeenCalledTimes(1);
});
