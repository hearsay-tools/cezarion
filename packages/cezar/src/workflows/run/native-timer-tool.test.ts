import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../core/agent-runner.ts';
import { nativeTimerDelay } from './turn-markers.ts';

// Give codex Claude's timer tool and take it from Claude, so the test proves the turn reads the
// declared `nativeTimerTool` and not the runner id (hearsay-tools/cezarion#2991).
vi.mock('../../core/runner-facts.ts', async (load) => {
  const actual = await load<typeof import('../../core/runner-facts.ts')>();
  return { ...actual, RUNNER_FACTS: {
    ...actual.RUNNER_FACTS,
    claude: { ...actual.RUNNER_FACTS.claude, nativeTimerTool: null },
    codex: { ...actual.RUNNER_FACTS.codex, nativeTimerTool: 'ScheduleWakeup' },
  } };
});

const call = (input: unknown): AgentEvent => ({ type: 'tool-call', id: 'toolu_1', tool: 'ScheduleWakeup', input });

describe('the native timer tool follows the runner\'s declaration', () => {
  it('reads the delay only on a runner that declares the tool', () => {
    expect(nativeTimerDelay(call({ delaySeconds: 120 }), 'codex')).toBe(120);
    expect(nativeTimerDelay(call({ delaySeconds: 120 }), 'claude')).toBeUndefined();
  });

  it('reports the tool without a usable delay as null', () => {
    expect(nativeTimerDelay(call({ delaySeconds: 'soon' }), 'codex')).toBeNull();
  });

  it('ignores another tool name on the declaring runner', () => {
    expect(nativeTimerDelay({ type: 'tool-call', id: 'toolu_2', tool: 'Bash', input: {} }, 'codex')).toBeUndefined();
  });
});
