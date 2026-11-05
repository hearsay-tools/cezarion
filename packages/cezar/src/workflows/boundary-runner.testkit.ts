import { beforeEach } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentSession } from '../core/agent-runner.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import type { UiEvent } from '../core/ui-events.ts';
import { runnerHook } from './run-fixture.testkit.ts';

/** A fixture-owned runner sends callbacks through the normal session wiring. No provider starts. */
export function useBoundaryRunner(log: string[] = []) {
  const sessions: AgentSession[] = [];
  let emitUi: (event: UiEvent) => void = () => { throw new Error('No live runner'); };
  let emitAgent: (event: AgentEvent) => void = () => { throw new Error('No live runner'); };
  beforeEach(() => {
    sessions.length = 0;
    runnerHook.runner = {
      backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
      run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: async () => {},
      startSession(_spec, onEvent, options) {
        log.push('launch');
        let open = true;
        let finish!: (result: AgentRunResult) => void;
        const result = new Promise<AgentRunResult>(resolve => { finish = resolve; });
        const close = () => { log.push('close'); open = false; finish({ text: 'Complete', toolCalls: [], tokensUsed: 0 }); };
        emitUi = event => options?.onUiEvent?.(event);
        emitAgent = event => onEvent?.(event);
        const session: AgentSession = { get open() { return open; }, result, end: close, interrupt: close,
          sendMessage: () => true, sendAgentMessage: async () => {}, discardQueuedMessages() {}, holdsHumanInput: () => false };
        sessions.push(session);
        queueMicrotask(() => onEvent?.({ type: 'session', sessionId: `boundary-order-${sessions.length}` }));
        return session;
      },
    };
  });
  return { sessions, emitUi: (event: UiEvent) => emitUi(event), emitAgent: (event: AgentEvent) => emitAgent(event) };
}
