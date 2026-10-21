import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import type { AgentEvent, AgentSession } from './agent-runner.ts';
import type { UiEvent } from './ui-events.ts';

const bin = fileURLToPath(new URL('../../scripts/mock-claude.mjs', import.meta.url));
const refusal = "There's an issue with the selected model (claude-test-model). It may not exist or you may not have access to it. Run --model to pick a different model.";
const isRetry = (event: AgentEvent) => event.type === 'note' && /retrying.*\/2/.test(event.message);
async function until(predicate: () => boolean) {
  const deadline = performance.now() + 5000;
  while (!predicate() && performance.now() < deadline) await sleep(10);
  expect(predicate()).toBe(true);
}
afterEach(() => vi.useRealTimers());

async function fixture(check: (ctx: {
  session: AgentSession; events: AgentEvent[]; ui: UiEvent[]; consumed: string[];
  send: (mode: string) => void; turns: () => number; inputs: () => { userText: string; imageCount: number }[];
}) => Promise<void>, options: { seed?: boolean; timeoutMs?: number; autoEnd?: boolean } = {}) {
  const { seed = true, timeoutMs = 0, autoEnd = false } = options;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const cwd = mkdtempSync(join(tmpdir(), 'cez-refusal-'));
  const events: AgentEvent[] = [], ui: UiEvent[] = [], consumed: string[] = [];
  const trace = join(cwd, 'stdin.jsonl');
  const session = new ClaudeCliRunner({ bin }).startSession({
    userPrompt: `mock:model-refusal:${seed ? 'seed' : 'always'}`, cwd, timeoutMs, sessionId: 'model-refusal-session', resume: !seed,
    env: { CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '', CEZ_MOCK_STDIN_FILE: trace },
  }, e => events.push(e), { autoEndAfterFirstTurn: autoEnd, onUiEvent: e => ui.push(e), onAgentInputConsumed: ids => consumed.push(...ids) });
  const settled = session.result.catch(() => undefined);
  const turns = () => events.filter(e => e.type === 'turn-end').length;
  try {
    await until(() => turns() === 1);
    await check({ session, events, ui, consumed, turns,
      send: mode => { expect(session.sendMessage([{ type: 'text', text: `mock:model-refusal:${mode}` }])).toBe(true); },
      inputs: () => readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line)),
    });
  } finally {
    vi.useRealTimers();
    session.end();
    await settled;
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('Claude model refusal retry (hearsay-tools/cezarion#1351)', () => {
  it('retries after 5s with the exact input, retains delivery IDs and defers later input', async () => {
    await fixture(async ({ session, events, ui, consumed, turns, inputs }) => {
      const content = [{ type: 'text' as const, text: 'mock:model-refusal:once' },
        { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'aGVsbG8=' } }];
      const accepted = session.sendAgentMessage(content, ['wake-1']);
      expect(accepted).not.toBe(false);
      await accepted;
      await until(() => events.some(isRetry) || events.some(e => e.type === 'error'));
      expect(events.filter(e => e.type === 'error')).toEqual([]);
      expect(turns()).toBe(1);
      expect(consumed).toEqual([]);
      expect(ui.filter(e => e.type === 'turn.completed')).toHaveLength(2);
      expect(session.sendAgentMessage([{ type: 'text', text: 'another worker' }], ['wake-2'])).toBe(false);
      expect(session.sendMessage([{ type: 'text', text: 'mock:model-refusal:later' }])).toBe(true);
      expect(session.holdsHumanInput()).toBe(true);
      expect(inputs()).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(4999);
      expect(inputs()).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      await until(() => turns() === 3);
      expect(inputs()).toEqual([
        { userText: 'mock:model-refusal:seed', imageCount: 0 },
        { userText: 'mock:model-refusal:once', imageCount: 1 },
        { userText: 'mock:model-refusal:once', imageCount: 1 },
        { userText: 'mock:model-refusal:later', imageCount: 0 },
      ]);
      expect(consumed).toEqual(['wake-1']);
      expect(session.holdsHumanInput()).toBe(false);
      expect(ui.filter(e => e.type === 'turn.started')).toHaveLength(4);
      expect(ui.filter(e => e.type === 'turn.completed')).toHaveLength(4);
      expect(events.filter(e => e.type === 'token-usage')).toEqual([
        { type: 'token-usage', tokensUsed: 15 }, { type: 'token-usage', tokensUsed: 30 }, { type: 'token-usage', tokensUsed: 45 },
      ]);
    });
  });

  it('retries a refused queued turn without inheriting the previous turn work', async () => {
    await fixture(async ({ events, ui, send, turns, inputs }) => {
      send('queued-seed');
      await until(() => events.some(e => e.type === 'text' && e.text === 'Completed mock:model-refusal:queued-seed'));
      expect(turns()).toBe(1);
      send('once:queued');
      await until(() => turns() === 3 || events.some(isRetry));
      expect(events.filter(e => e.type === 'error')).toEqual([]);
      expect(events.filter(isRetry)).toHaveLength(1);
      expect(turns()).toBe(2);
      await vi.advanceTimersByTimeAsync(5000);
      await until(() => turns() === 3);
      expect(inputs().map(input => input.userText)).toEqual([
        'mock:model-refusal:seed', 'mock:model-refusal:queued-seed',
        'mock:model-refusal:once:queued', 'mock:model-refusal:once:queued',
      ]);
      expect(ui.filter(e => e.type === 'turn.started')).toHaveLength(4);
      expect(ui.filter(e => e.type === 'turn.completed')).toHaveLength(4);
    });
  });

  it('retains background work observed in a queued turn', async () => {
    await fixture(async ({ events, send, turns, inputs }) => {
      send('queued-seed');
      await until(() => events.some(e => e.type === 'text' && e.text === 'Completed mock:model-refusal:queued-seed'));
      expect(turns()).toBe(1);
      send('system-task-started');
      await until(() => turns() === 3);
      expect(events.some(e => e.type === 'error')).toBe(true);
      expect(events.filter(isRetry)).toEqual([]);
      await vi.advanceTimersByTimeAsync(20000);
      expect(inputs()).toHaveLength(3);
    });
  });

  it('bounds exhaustion at 5s then 15s and preserves the first refusal', async () => {
    await fixture(async ({ events, send, turns, inputs }) => {
      send('always');
      await until(() => events.some(isRetry) || turns() === 2);
      expect(events.filter(isRetry)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5000);
      await until(() => events.filter(isRetry).length === 2);
      await vi.advanceTimersByTimeAsync(14999);
      expect(inputs()).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1);
      await until(() => turns() === 2);
      expect(inputs()).toHaveLength(4);
      expect(events.filter(e => e.type === 'error')).toEqual([{ type: 'error', message: refusal }]);
      await vi.advanceTimersByTimeAsync(60000);
      expect(inputs()).toHaveLength(4);
    });
  });

  it.each(['changed', 'missing-session', 'empty-session', 'changed-session', 'missing-model', 'empty-model', 'wrong-model', 'missing-usage', 'missing-count', 'invalid-count', 'used', 'cached', 'paid', 'work', 'prose', 'assistant-usage', 'model-tokens', 'model-cost', 'model-invalid', 'system-task-started', 'system-task-progress', 'system-task-notification', 'system-hook-started', 'tool-progress', 'auth', 'limit'])('fails immediately when %s makes replay unsafe or unproven', async mode => {
    await fixture(async ({ events, send, turns, inputs }) => {
      send(mode);
      await until(() => turns() === 2 || events.some(isRetry));
      expect(events.some(e => e.type === 'error')).toBe(true);
      expect(events.filter(isRetry)).toEqual([]);
      await vi.advanceTimersByTimeAsync(60000);
      expect(inputs()).toHaveLength(2);
    });
  });

  it('does not infer model success from a resumed session ID', async () => {
    await fixture(async ({ events, inputs }) => {
      expect(events.filter(e => e.type === 'error')).toEqual([{ type: 'error', message: refusal }]);
      expect(events.filter(isRetry)).toEqual([]);
      await vi.advanceTimersByTimeAsync(60000);
      expect(inputs()).toHaveLength(1);
    }, { seed: false });
  });

  it('discards human input held behind a retry without discarding the retry', async () => {
    await fixture(async ({ session, events, send, turns, inputs }) => {
      send('once');
      await until(() => events.some(isRetry));
      send('later');
      expect(session.holdsHumanInput()).toBe(true);
      session.discardQueuedMessages();
      expect(session.holdsHumanInput()).toBe(true); // the refused human input is still owed
      await vi.advanceTimersByTimeAsync(5000);
      await until(() => turns() === 2);
      expect(inputs()).toHaveLength(3);
      expect(session.holdsHumanInput()).toBe(false);
    });
  });

  it('refuses replay when multiple native inputs are outstanding', async () => {
    await fixture(async ({ events, send, turns, inputs }) => {
      send('always');
      send('later');
      await until(() => turns() === 3);
      expect(events.some(e => e.type === 'error')).toBe(true);
      expect(events.filter(isRetry)).toEqual([]);
      await vi.advanceTimersByTimeAsync(20000);
      expect(inputs()).toHaveLength(3);
    });
  });

  it('keeps the original error when the child exits during backoff', async () => {
    await fixture(async ({ session, events, send, inputs }) => {
      send('always');
      await until(() => events.some(isRetry));
      process.kill(session.pid!, 'SIGTERM');
      await until(() => events.some(e => e.type === 'error' && e.message === refusal));
      await vi.advanceTimersByTimeAsync(20000);
      expect(inputs()).toHaveLength(2);
    });
  });

  it('cancels backoff at the authored timeout', async () => {
    await fixture(async ({ session, events, send, inputs }) => {
      send('always');
      await until(() => events.some(isRetry));
      await vi.advanceTimersByTimeAsync(1000);
      expect(session.open).toBe(false);
      await vi.advanceTimersByTimeAsync(20000);
      expect(inputs()).toHaveLength(2);
    }, { timeoutMs: 1000 });
  });

  it('prevents auto-end during backoff and closes after recovery', async () => {
    await fixture(async ({ session, events, send, turns }) => {
      send('once');
      await until(() => events.some(isRetry));
      await vi.advanceTimersByTimeAsync(4999);
      expect(session.open).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      await until(() => turns() === 2);
      await vi.advanceTimersByTimeAsync(250);
      expect(session.open).toBe(false);
    }, { autoEnd: true });
  });

  it('grants a fresh retry budget to a later logical turn', async () => {
    await fixture(async ({ events, send, turns }) => {
      for (const [index, mode] of ['once:first', 'once:second'].entries()) {
        send(mode);
        await until(() => events.filter(isRetry).length === index + 1);
        await vi.advanceTimersByTimeAsync(5000);
        await until(() => turns() === index + 2);
      }
      expect(events.filter(e => e.type === 'error')).toEqual([]);
    });
  });

  it.each(['end', 'interrupt'] as const)('cancels backoff on %s', async action => {
    await fixture(async ({ session, events, send, inputs }) => {
      send('always');
      await until(() => events.some(isRetry) || events.some(e => e.type === 'error'));
      expect(events.some(isRetry)).toBe(true);
      session[action]();
      await vi.advanceTimersByTimeAsync(20000);
      expect(inputs()).toHaveLength(2);
    });
  });
});
