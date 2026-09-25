import { describe, expect, it } from 'vitest';
import { createRunner } from './runner-factory.ts';
import type { RunnerId } from './agent-runner.ts';

describe('Cursor ACP runner', () => {
  it('constructs the Cursor backend instead of silently falling back to Claude', () => {
    expect(createRunner('cursor' as RunnerId).backend).toBe('cursor');
  });
});

import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import { parseUsageLimit } from './usage-limit.ts';
import { waitFor, withOwnedInputRun } from './harness-parity.testkit.ts';
import type { AgentEvent, AgentRunner, AgentSession } from './agent-runner.ts';
import type { UiEvent } from './ui-events.ts';
const mock = fileURLToPath(new URL('../../scripts/mock-cursor-acp.mjs', import.meta.url));

/** Retry tuning for #443 scenarios: real caps, instant waits included, negligible sleeps.
 *  `CursorAcpRunner` arrives from the file's grouped import block further down — ES imports
 *  hoist, so using it here in test callbacks is fine. */
const fastRetry = () => new CursorAcpRunner({ providerRetry: { backoffMs: 10 } });

async function withSession(prompt: string, body: (session: AgentSession, v1: AgentEvent[], v2: UiEvent[]) => Promise<void>, runner: AgentRunner = createRunner('cursor' as RunnerId)) {
  vi.stubEnv('CEZ_CURSOR_BIN', mock);
  const v1: AgentEvent[] = []; const v2: UiEvent[] = [];
  const session = runner.startSession({ cwd: process.cwd(), userPrompt: prompt, timeoutMs: 5000 }, e => v1.push(e), { onUiEvent: e => v2.push(e) });
  try { await body(session, v1, v2); } finally { session.interrupt(); await session.result.catch(() => {}); vi.unstubAllEnvs(); }
}
it('streams tools and complete v1 text, then accepts another turn on the same process', async () => {
  await withSession('inspect', async (session, v1) => {
    await waitFor(() => v1.some(e => e.type === 'turn-end'));
    const pid = session.pid;
    expect(v1.some(e => e.type === 'tool-call')).toBe(true);
    expect(v1.some(e => e.type === 'tool-result')).toBe(true);
    expect(session.sendMessage([{ type: 'text', text: 'next' }])).toBe(true);
    await waitFor(() => v1.filter(e => e.type === 'turn-end').length === 2);
    expect(session.pid).toBe(pid);
  });
});
it('surfaces Cursor transport-error prose followed by end_turn as failure', async () => {
  await withSession('mock:provider-error', async (session, v1, v2) => {
    await session.result.catch(() => {});
    expect(v1.some(e => e.type === 'error')).toBe(true);
    expect(v1.some(e => e.type === 'error' && e.message.includes('run agent login'))).toBe(true);
    expect(v2.some(e => e.type === 'session.error')).toBe(true);
    expect(v2.some(e => e.type === 'turn.completed' && e.stopReason === 'end_turn')).toBe(false);
    // Authentication is never retried: no transient note may precede the fatal error.
    expect(v2.some(e => e.type === 'session.error' && !e.fatal)).toBe(false);
  });
});
it('recovers a bare transient provider failure with one bounded inline retry', async () => {
  await withSession('mock:provider-error-transient', async (session, v1, v2) => {
    await waitFor(() => v1.some(e => e.type === 'turn-end'));
    expect(v1.some(e => e.type === 'error')).toBe(false);
    const notes = v2.filter((e): e is Extract<UiEvent, { type: 'session.error' }> => e.type === 'session.error' && !e.fatal);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.message).toContain('502 bad gateway');
    expect(notes[0]?.message).toContain('retrying (1/2)');
    expect(v1.some(e => e.type === 'text' && e.text.includes('Cursor inspected the workspace.'))).toBe(true);
  }, fastRetry());
});
it('completes the failed attempt as an error turn before the retry opens its own', async () => {
  // The v2 stream must never carry a started-but-never-completed turn across a retry:
  // usage accounting and complete-turn projections pair every turn.started with a turn.completed.
  await withSession('mock:provider-error-transient', async (_session, v1, v2) => {
    await waitFor(() => v1.some(e => e.type === 'turn-end'));
    const completions = v2.filter((e): e is Extract<UiEvent, { type: 'turn.completed' }> => e.type === 'turn.completed');
    expect(completions.map(e => e.stopReason)).toEqual(['error', 'end_turn']);
  }, fastRetry());
});
it('recovers a RetriableError protocol failure on the same session without a premature handoff', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cursor-protocol-retry-'));
  const file = join(dir, 'wire.ndjson');
  vi.stubEnv('CEZ_MOCK_STDIN_FILE', file);
  try {
    await withSession('mock:provider-error-protocol', async (session, v1, v2) => {
      await waitFor(() => v1.some(e => e.type === 'turn-end' || e.type === 'error'));
      expect(v1.filter(e => e.type === 'error')).toEqual([]);
      expect(v1.filter(e => e.type === 'turn-end')).toHaveLength(1);
      expect(v1.some(e => e.type === 'text' && e.text.includes('Cursor inspected the workspace.'))).toBe(true);
      expect(session.open).toBe(true);
      expect(v2.some(e => e.type === 'ask.requested' || e.type === 'session.ended')).toBe(false);
      const notes = v2.filter((e): e is Extract<UiEvent, { type: 'session.error' }> => e.type === 'session.error');
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ fatal: false });
      expect(notes[0]?.message).toContain('missing EndStreamResponse; retrying (1/2)');
      const completions = v2.filter((e): e is Extract<UiEvent, { type: 'turn.completed' }> => e.type === 'turn.completed');
      expect(completions.map(e => e.stopReason)).toEqual(['error', 'end_turn']);
      const rows = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(rows.filter(row => row.method === 'session/new')).toHaveLength(1);
      const prompts = rows.filter(row => row.method === 'session/prompt');
      expect(prompts).toHaveLength(2);
      expect(prompts[1].params).toEqual(prompts[0].params);
    }, fastRetry());
  } finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
});
it('exhausts protocol retries with the provider detail and total attempt count', async () => {
  await withSession('mock:provider-error-protocol-exhaust', async (session, v1, v2) => {
    await session.result.catch(() => {});
    const notes = v2.filter((e): e is Extract<UiEvent, { type: 'session.error' }> => e.type === 'session.error' && !e.fatal);
    expect(notes.map(e => e.message.match(/retrying \(\d\/2\)/)?.[0])).toEqual(['retrying (1/2)', 'retrying (2/2)']);
    expect(v1.find(e => e.type === 'error')).toMatchObject({
      message: 'Cursor provider request failed after 3 attempts: RetriableError: [invalid_argument] protocol error: missing EndStreamResponse',
    });
    expect(v2.filter(e => e.type === 'turn.started')).toHaveLength(3);
    expect(v2.filter(e => e.type === 'turn.completed' && e.stopReason === 'error')).toHaveLength(3);
    expect(v2.some(e => e.type === 'session.error' && e.fatal)).toBe(true);
    expect(v1.some(e => e.type === 'turn-end')).toBe(false);
  }, fastRetry());
});
it('recovers an SSL record-layer failure on the same session without a premature handoff', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cursor-ssl-retry-'));
  const file = join(dir, 'wire.ndjson');
  vi.stubEnv('CEZ_MOCK_STDIN_FILE', file);
  try {
    await withSession('mock:provider-error-ssl', async (session, v1, v2) => {
      await waitFor(() => v1.some(e => e.type === 'turn-end' || e.type === 'error'));
      expect(v1.filter(e => e.type === 'error')).toEqual([]);
      expect(v1.filter(e => e.type === 'turn-end')).toHaveLength(1);
      expect(v1.some(e => e.type === 'text' && e.text.includes('Cursor inspected the workspace.'))).toBe(true);
      expect(session.open).toBe(true);
      expect(v2.some(e => e.type === 'ask.requested' || e.type === 'session.ended')).toBe(false);
      const notes = v2.filter((e): e is Extract<UiEvent, { type: 'session.error' }> => e.type === 'session.error');
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ fatal: false });
      expect(notes[0]?.message).toContain('tls_get_more_records');
      expect(notes[0]?.message).toContain('retrying (1/2)');
      const completions = v2.filter((e): e is Extract<UiEvent, { type: 'turn.completed' }> => e.type === 'turn.completed');
      expect(completions.map(e => e.stopReason)).toEqual(['error', 'end_turn']);
      const rows = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(rows.filter(row => row.method === 'session/new')).toHaveLength(1);
      const prompts = rows.filter(row => row.method === 'session/prompt');
      expect(prompts).toHaveLength(2);
      expect(prompts[1].params).toEqual(prompts[0].params);
    }, fastRetry());
  } finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
});
it('exhausts SSL record-layer retries with the provider detail and total attempt count', async () => {
  await withSession('mock:provider-error-ssl-exhaust', async (session, v1, v2) => {
    await session.result.catch(() => {});
    const notes = v2.filter((e): e is Extract<UiEvent, { type: 'session.error' }> => e.type === 'session.error' && !e.fatal);
    expect(notes.map(e => e.message.match(/retrying \(\d\/2\)/)?.[0])).toEqual(['retrying (1/2)', 'retrying (2/2)']);
    expect(v1.find(e => e.type === 'error')).toMatchObject({
      message: 'Cursor provider request failed after 3 attempts: RetriableError: [internal] C0AC9346CC7B0000:error:0A000119:SSL routines:tls_get_more_records:decryption failed or bad record mac:../deps/openssl/openssl/ssl/record/methods/tls_common.c:869:',
    });
    expect(v2.filter(e => e.type === 'turn.started')).toHaveLength(3);
    expect(v2.filter(e => e.type === 'turn.completed' && e.stopReason === 'error')).toHaveLength(3);
    expect(v2.some(e => e.type === 'session.error' && e.fatal)).toBe(true);
    expect(v1.some(e => e.type === 'turn-end')).toBe(false);
  }, fastRetry());
});
it('recovers a resource_exhausted failure on the same session without a premature handoff', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cursor-resource-exhausted-retry-'));
  const file = join(dir, 'wire.ndjson');
  vi.stubEnv('CEZ_MOCK_STDIN_FILE', file);
  try {
    await withSession('mock:provider-error-resource-exhausted', async (session, v1, v2) => {
      await waitFor(() => v1.some(e => e.type === 'turn-end' || e.type === 'error'));
      expect(v1.filter(e => e.type === 'error')).toEqual([]);
      expect(v1.filter(e => e.type === 'turn-end')).toHaveLength(1);
      expect(v1.some(e => e.type === 'text' && e.text.includes('Cursor inspected the workspace.'))).toBe(true);
      expect(session.open).toBe(true);
      expect(v2.some(e => e.type === 'ask.requested' || e.type === 'session.ended')).toBe(false);
      const notes = v2.filter((e): e is Extract<UiEvent, { type: 'session.error' }> => e.type === 'session.error');
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ fatal: false });
      expect(notes[0]?.message).toContain('[resource_exhausted] Error; retrying (1/2)');
      const completions = v2.filter((e): e is Extract<UiEvent, { type: 'turn.completed' }> => e.type === 'turn.completed');
      expect(completions.map(e => e.stopReason)).toEqual(['error', 'end_turn']);
      const rows = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(rows.filter(row => row.method === 'session/new')).toHaveLength(1);
      const prompts = rows.filter(row => row.method === 'session/prompt');
      expect(prompts).toHaveLength(2);
      expect(prompts[1].params).toEqual(prompts[0].params);
    }, fastRetry());
  } finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
});
it('exhausts resource_exhausted retries with the provider detail and total attempt count', async () => {
  await withSession('mock:provider-error-resource-exhausted-exhaust', async (session, v1, v2) => {
    await session.result.catch(() => {});
    const notes = v2.filter((e): e is Extract<UiEvent, { type: 'session.error' }> => e.type === 'session.error' && !e.fatal);
    expect(notes.map(e => e.message.match(/retrying \(\d\/2\)/)?.[0])).toEqual(['retrying (1/2)', 'retrying (2/2)']);
    expect(v1.find(e => e.type === 'error')).toMatchObject({
      message: 'Cursor provider request failed after 3 attempts: RetriableError: [resource_exhausted] Error',
    });
    expect(v2.filter(e => e.type === 'turn.started')).toHaveLength(3);
    expect(v2.filter(e => e.type === 'turn.completed' && e.stopReason === 'error')).toHaveLength(3);
    expect(v2.some(e => e.type === 'session.error' && e.fatal)).toBe(true);
    expect(v1.some(e => e.type === 'turn-end')).toBe(false);
  }, fastRetry());
});
it('fails unknown non-retriable protocol errors without retrying', async () => {
  await withSession('mock:provider-error-unknown-protocol', async (session, v1, v2) => {
    await session.result.catch(() => {});
    expect(v1.find(e => e.type === 'error')).toMatchObject({
      message: 'Cursor provider request failed: [invalid_argument] protocol error: unknown frame',
    });
    expect(v2.some(e => e.type === 'session.error' && !e.fatal)).toBe(false);
    expect(v2.filter(e => e.type === 'turn.started')).toHaveLength(1);
    expect(v1.some(e => e.type === 'turn-end')).toBe(false);
  }, fastRetry());
});
it('retries with the answer continuation after a transient failure post-answer', async () => {
  // #446 round 5: answering a native ask writes the response and sets answeredNativeAsk;
  // a provider error in the resumed work must retry the answer continuation, not the
  // original prompt, or the run loses the answer's thread and stops without processing it.
  const dir = mkdtempSync(join(tmpdir(), 'cursor-ask-retry-'));
  const file = join(dir, 'wire.ndjson');
  try {
    vi.stubEnv('CEZ_CURSOR_BIN', mock);
    const v1: AgentEvent[] = []; const v2: UiEvent[] = [];
    const session = fastRetry().startSession({ cwd: process.cwd(), userPrompt: 'mock:ask-error', timeoutMs: 15000, env: { CEZ_MOCK_STDIN_FILE: file } }, e => v1.push(e), { onUiEvent: e => v2.push(e) });
    try {
      await waitFor(() => v2.some(e => e.type === 'ask.requested'));
      expect(session.sendMessage([{ type: 'text', text: 'Vitest' }])).toBe(true);
      await waitFor(() => v1.some(e => e.type === 'turn-end'));
      expect(v1.some(e => e.type === 'error')).toBe(false);
      expect(v2.some(e => e.type === 'session.error' && !e.fatal && e.message.includes('retrying (1/2)'))).toBe(true);
      const rows = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const prompts = rows.filter((row: { method: string }) => row.method === 'session/prompt');
      expect(prompts).toHaveLength(2);
      const retried = prompts[1]!.params.prompt.filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('\n');
      expect(retried).toContain('Continue using the answer just supplied');
      expect(retried).not.toContain('mock:ask-error');
    } finally { session.interrupt(); await session.result.catch(() => {}); vi.unstubAllEnvs(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('retries the queued free-text answer before the continuation prompt', async () => {
  // #446 round 6: a free-text native answer is queued content (the option-less answer is
  // skipped natively and unshifted). The post-answer retry must consume queued input first,
  // exactly like the successful answered-ask path — the continuation must not jump the queue.
  const dir = mkdtempSync(join(tmpdir(), 'cursor-ask-queued-'));
  const file = join(dir, 'wire.ndjson');
  try {
    vi.stubEnv('CEZ_CURSOR_BIN', mock);
    const v1: AgentEvent[] = []; const v2: UiEvent[] = [];
    const session = fastRetry().startSession({ cwd: process.cwd(), userPrompt: 'mock:ask-error', timeoutMs: 15000, env: { CEZ_MOCK_STDIN_FILE: file } }, e => v1.push(e), { onUiEvent: e => v2.push(e) });
    try {
      await waitFor(() => v2.some(e => e.type === 'ask.requested'));
      expect(session.sendMessage([{ type: 'text', text: 'Use playwright, not vitest' }])).toBe(true);
      await waitFor(() => v1.some(e => e.type === 'turn-end'));
      expect(v1.some(e => e.type === 'error')).toBe(false);
      const rows = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const prompts = rows.filter((row: { method: string }) => row.method === 'session/prompt');
      expect(prompts).toHaveLength(2);
      const retried = prompts[1]!.params.prompt.filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('\n');
      expect(retried).toBe('Use playwright, not vitest');
    } finally { session.interrupt(); await session.result.catch(() => {}); vi.unstubAllEnvs(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('honors the injected retry options instead of silently using the defaults', async () => {
  // Pins the withSession runner seam: a scenario tuning maxRetries must see exactly that
  // cap on the transcript, not the production constants.
  await withSession('mock:provider-error-bare', async (_session, v1, v2) => {
    await waitFor(() => v1.some(e => e.type === 'error'));
    const notes = v2.filter((e): e is Extract<UiEvent, { type: 'session.error' }> => e.type === 'session.error' && !e.fatal);
    expect(notes.map(e => e.message.match(/retrying \(\d\/\d\)/)?.[0])).toEqual(['retrying (1/1)']);
    const error = v1.find((e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error');
    expect(error?.message).toContain('after 2 attempts');
  }, new CursorAcpRunner({ providerRetry: { maxRetries: 1, backoffMs: 10 } }));
});
it('waits out a near reset instant and retries on the same session', async () => {
  await withSession('mock:provider-error-instant-near', async (_session, v1, v2) => {
    await waitFor(() => v1.some(e => e.type === 'turn-end'));
    expect(v1.some(e => e.type === 'error')).toBe(false);
    expect(v2.some(e => e.type === 'session.error' && !e.fatal && e.message.includes('429 rate limited'))).toBe(true);
    expect(v1.some(e => e.type === 'text' && e.text.includes('Cursor inspected the workspace.'))).toBe(true);
  }, fastRetry());
});
it('gives up after the stated retry cap when the provider keeps failing without an instant', async () => {
  await withSession('mock:provider-error-bare', async (_session, v1, v2) => {
    await waitFor(() => v1.some(e => e.type === 'error'));
    const notes = v2.filter((e): e is Extract<UiEvent, { type: 'session.error' }> => e.type === 'session.error' && !e.fatal);
    expect(notes.map(e => e.message.match(/retrying \(\d\/2\)/)?.[0])).toEqual(['retrying (1/2)', 'retrying (2/2)']);
    const error = v1.find((e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error');
    expect(error?.message).toContain('after 3 attempts');
    expect(error?.message).toContain('502 bad gateway');
    expect(v2.some(e => e.type === 'turn.completed' && e.stopReason === 'end_turn')).toBe(false);
  }, fastRetry());
});
it('fails fatally with the preserved reset instant when the wait is too long to retry inline', async () => {
  await withSession('mock:provider-error-instant-far', async (session, v1, v2) => {
    await session.result.catch(() => {});
    const error = v1.find((e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error');
    expect(error?.message).toContain('usage limit reached');
    expect(error?.message).not.toContain('check the Cursor CLI connection');
    // The preserved text must keep feeding the auto-resume scheduler (spec 2026-08-03).
    expect(parseUsageLimit(error?.message)?.resetAt).toBeTruthy();
    expect(v2.some(e => e.type === 'session.error' && !e.fatal)).toBe(false);
  }, fastRetry());
});
it('keeps the reset instant recoverable when a verbose envelope truncates the detail', async () => {
  // The detail cap is display-only: the fatal message must still carry the instant, or the
  // auto-resume scheduler reading run.error can never fire on a verbose provider message.
  await withSession('mock:provider-error-verbose', async (session, v1, v2) => {
    await session.result.catch(() => {});
    const error = v1.find((e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error');
    expect(error?.message).not.toContain('check the Cursor CLI connection');
    expect(parseUsageLimit(error?.message)?.resetAt).toBeTruthy();
    expect(v2.some(e => e.type === 'session.error' && !e.fatal)).toBe(false);
  }, fastRetry());
});
it('native questions refuse agent input and resume only after a human answer', async () => {
  await withSession('mock:ask', async (session, v1, v2) => {
    await waitFor(() => v2.some(e => e.type === 'ask.requested'));
    expect(session.sendAgentMessage([{ type: 'text', text: 'Vitest' }])).toBe(false);
    expect(session.sendMessage([{ type: 'text', text: 'Vitest' }])).toBe(true);
    await waitFor(() => v1.some(e => e.type === 'turn-end'));
    expect(v1.some(e => e.type === 'text' && e.text.includes('vitest'))).toBe(true);
  });
});

it('rejects malformed native asks without parking an invisible question', async () => {
  await withSession('mock:ask-bad', async (_session, v1, v2) => {
    await waitFor(() => v1.some(e => e.type === 'turn-end'));
    expect(v2.some(e => e.type === 'ask.requested')).toBe(false);
    expect(v1.some(e => e.type === 'error')).toBe(false);
  });
});
it('preserves a free-text native answer as the next prompt instead of inventing option IDs', async () => {
  await withSession('mock:ask', async (session, v1, v2) => {
    await waitFor(() => v2.some(e => e.type === 'ask.requested'));
    expect(session.sendMessage([{ type: 'text', text: 'mock:agent-echo use a custom runner' }])).toBe(true);
    await waitFor(() => v1.some(e => e.type === 'turn-end'));
    expect(v2.filter(e => e.type === 'turn.started')).toHaveLength(2);
    expect(v1.filter(e => e.type === 'turn-end')).toHaveLength(1);
    expect(v1.some(e => e.type === 'text' && e.text.includes('use a custom runner'))).toBe(true);
  });
});
it('does not report provider request errors as successful turns', async () => {
  await withSession('mock:rpc-error', async (session, v1, v2) => {
    await session.result;
    expect(v1.filter(e => e.type === 'error')).toHaveLength(1);
    expect(v1.at(-1)?.type).toBe('done');
    expect(v2.some(e => e.type === 'turn.completed' && e.stopReason === 'end_turn')).toBe(false);
  });
});

it('keeps multiple native questions independently addressable under a shared title', async () => {
  await withSession('mock:multi-ask', async (session, v1, v2) => {
    await waitFor(() => v2.some(e => e.type === 'ask.requested'));
    const ask = v2.find(e => e.type === 'ask.requested');
    if (ask?.type !== 'ask.requested') throw new Error('missing ask');
    expect(new Set(ask.questions.map(q => q.header)).size).toBe(2);
    session.sendMessage([{ type: 'text', text: `${ask.questions[0]!.header}: Vitest\n${ask.questions[1]!.header}: Vite` }]);
    await waitFor(() => v1.some(e => e.type === 'turn-end'));
    expect(v1.some(e => e.type === 'text' && e.text.includes('"selectedOptionIds":["vite"]'))).toBe(true);
  });
});

it('accepts native plans using the cockpit header-prefixed answer', async () => {
  await withSession('mock:plan', async (session, v1, v2) => {
    await waitFor(() => v2.some(e => e.type === 'ask.requested'));
    expect(session.sendAgentMessage([{ type: 'text', text: 'Plan: Approve' }])).toBe(false);
    session.sendMessage([{ type: 'text', text: 'Plan: Approve' }]);
    await waitFor(() => v1.some(e => e.type === 'turn-end'));
    expect(v1.some(e => e.type === 'text' && e.text.includes('"outcome":"accepted"'))).toBe(true);
  });
});

it.each([['mock:plan', 'Plan: Approve'], ['mock:ask', 'Tests: Vitest']])('resumes %s after its native answer without exposing an idle park', async (prompt, answer) => {
  await withSession(prompt, async (session, v1, v2) => {
    await waitFor(() => v2.some(e => e.type === 'ask.requested'));
    session.sendMessage([{ type: 'text', text: answer }]);
    await waitFor(() => v1.some(e => e.type === 'turn-end'));
    expect(v2.filter(e => e.type === 'turn.started')).toHaveLength(2);
    expect(v1.filter(e => e.type === 'turn-end')).toHaveLength(1);
    expect(v1.some(e => e.type === 'text' && e.text.includes('Cursor inspected'))).toBe(true);
  });
});

it.each(['done', 'monitoring', 'ask', 'cancelled'])('does not auto-resume across an answer-%s boundary', async kind => {
  await withSession(`mock:plan mock:answer-${kind}`, async (session, v1, v2) => {
    await waitFor(() => v2.some(e => e.type === 'ask.requested'));
    session.sendMessage([{ type: 'text', text: 'Plan: Approve' }]);
    await waitFor(() => v1.some(e => e.type === 'turn-end'));
    expect(v2.filter(e => e.type === 'turn.started')).toHaveLength(1);
    if (kind === 'ask') expect(session.sendAgentMessage([{ type: 'text', text: 'do not answer' }])).toBe(false);
  });
});

it.each([['mock:plan', 'Plan: Approve'], ['mock:ask', 'Tests: Vitest'], ['mock:ask', 'Use a custom runner']])('takes %s from cockpit answer to completed work without another needs-you park', async (prompt, answer) => {
  await withOwnedInputRun('cursor', 'ask', async ({ store, manager, runId }) => {
    store.updateRun(runId, { task: `${prompt} mock:resume-done` });
    manager.enqueueOwnedRun(runId);
    await waitFor(() => store.readEvents(runId).some(e => e.type === 'ask.requested'));
    expect(store.getRun(runId)?.status).toBe('waiting');
    const statuses: string[] = [];
    store.on('run', run => { if (run.id === runId) statuses.push(run.status); });
    expect(manager.sendMessage(runId, [{ type: 'text', text: answer }])).toBe(true);
    // The synchronous delivery checkpoint is written before sendMessage unparks.
    expect(store.getRun(runId)?.status).toBe('running');
    statuses.length = 0;
    await waitFor(() => !manager.isActive(runId));
    expect(store.getRun(runId)?.status).toBe('done');
    expect(store.getRun(runId)?.steps[0]?.status).toBe('done');
    expect(statuses).not.toContain('waiting');
    const events = store.readEvents(runId);
    expect(events.filter(e => e.type === 'user-message')).toHaveLength(1);
    expect(events.filter(e => e.type === 'human-input-delivered')).toHaveLength(1);
    expect(events.filter(e => e.type === 'turn.started')).toHaveLength(2);
    expect(events.filter(e => e.type === 'turn-end')).toHaveLength(1);
  });
}, 30_000);

it('preserves rejection and uses queued human input instead of an extra automatic prompt', async () => {
  await withSession('mock:plan', async (session, v1, v2) => {
    await waitFor(() => v2.some(e => e.type === 'ask.requested'));
    session.sendMessage([{ type: 'text', text: 'Plan: Reject' }]);
    session.sendMessage([{ type: 'text', text: 'mock:agent-echo Revise the plan' }]);
    await waitFor(() => v1.some(e => e.type === 'turn-end'));
    expect(v1.some(e => e.type === 'text' && e.text.includes('"outcome":"rejected"'))).toBe(true);
    expect(v1.some(e => e.type === 'text' && e.text.includes('Revise the plan'))).toBe(true);
    expect(v2.filter(e => e.type === 'turn.started')).toHaveLength(2);
    expect(v1.filter(e => e.type === 'turn-end')).toHaveLength(1);
  });
});

it('keeps queued human input ahead of reentrant worker input at turn end', async () => {
  vi.stubEnv('CEZ_CURSOR_BIN', mock);
  let session: AgentSession;
  let admitted: false | Promise<void> | undefined;
  let turns = 0;
  session = createRunner('cursor').startSession({ cwd: process.cwd(), userPrompt: 'mock:hold' }, e => {
    if (e.type === 'turn-end' && ++turns === 1) admitted = session.sendAgentMessage([{ type: 'text', text: 'mock:agent-echo WORKER' }]);
  });
  try {
    session.sendMessage([{ type: 'text', text: 'mock:agent-echo HUMAN' }]);
    await waitFor(() => turns >= 2);
    expect(admitted).toBe(false);
  } finally { session.interrupt(); await session.result; vi.unstubAllEnvs(); }
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CursorAcpRunner } from './cursor-acp-runner.ts';
it.each([['sonnet-test', 'effort'], ['gpt-test', 'reasoning']])('applies advertised effort for %s before the first prompt', async (model, configId) => {
  const dir = mkdtempSync(join(tmpdir(), 'cursor-config-'));
  const file = join(dir, 'wire.ndjson');
  try {
    const result = await new CursorAcpRunner({ bin: mock }).run({ cwd: dir, userPrompt: 'mock:done', model, effort: 'high', env: { CEZ_MOCK_STDIN_FILE: file }, timeoutMs: 5000 });
    expect(result.text).toContain('Done.');
    const rows = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows.find(row => row.method === 'initialize').params.clientCapabilities._meta.parameterizedModelPicker).toBe(true);
    const setting = rows.findIndex(row => row.method === 'session/set_config_option' && row.params.configId === configId && row.params.value === 'high');
    expect(setting).toBeGreaterThan(0);
    expect(setting).toBeLessThan(rows.findIndex(row => row.method === 'session/prompt'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('fails before inference when the selected model does not advertise the requested effort', async () => {
  const errors: AgentEvent[] = [];
  const result = await new CursorAcpRunner({ bin: mock }).run({ cwd: process.cwd(), userPrompt: 'mock:done', effort: 'impossible', timeoutMs: 5000 }, event => errors.push(event));
  expect(result.text).toBe('');
  expect(errors.some(event => event.type === 'error' && event.message.includes('does not advertise'))).toBe(true);
});

it('refreshes model-dependent effort options after setting the advertised model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cursor-config-model-'));
  const file = join(dir, 'wire.ndjson');
  try {
    const result = await new CursorAcpRunner({ bin: mock }).run({ cwd: dir, userPrompt: 'mock:done', model: 'sonnet-test', effort: 'high', env: { CEZ_MOCK_STDIN_FILE: file, CEZ_MOCK_CURSOR_INITIAL_MODEL: 'gpt-test' }, timeoutMs: 5000 });
    expect(result.text).toContain('Done.');
    const rows = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const settings = rows.filter(row => row.method === 'session/set_config_option').map(row => [row.params.configId, row.params.value]);
    expect(settings).toEqual([['model', 'sonnet-test'], ['effort', 'high']]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('keeps legacy model control when config options are absent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cursor-config-legacy-'));
  const file = join(dir, 'wire.ndjson');
  try {
    const model = 'model[effort=high]';
    const result = await new CursorAcpRunner({ bin: mock }).run({ cwd: dir, userPrompt: 'mock:done', model, env: { CEZ_MOCK_STDIN_FILE: file, CEZ_MOCK_CURSOR_LEGACY: '1' }, timeoutMs: 5000 });
    expect(result.text).toContain('Done.');
    const rows = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows.find(row => row.method === 'session/set_model')?.params.modelId).toBe(model);
    expect(rows.some(row => row.method === 'session/set_config_option')).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('refuses a config acknowledgement that does not confirm the requested value', async () => {
  const errors: AgentEvent[] = [];
  const result = await new CursorAcpRunner({ bin: mock }).run({ cwd: process.cwd(), userPrompt: 'mock:done', effort: 'high', env: { CEZ_MOCK_CURSOR_STALE_CONFIG: '1' }, timeoutMs: 5000 }, event => errors.push(event));
  expect(result.text).toBe('');
  expect(errors.some(event => event.type === 'error' && event.message.includes('did not confirm'))).toBe(true);
});

describe('Cursor input delivery (#505)', () => {
  it('declares boundary delivery: a second session/prompt would cancel the running turn', () => {
    expect(new CursorAcpRunner().inputDelivery).toEqual({ mode: 'boundary', consumption: 'unobservable', via: expect.stringContaining('session/prompt') });
  });
});

describe('Cursor ACP spawn retry (#529)', () => {
  const crashRunner = () => new CursorAcpRunner({ bin: mock, providerRetry: { backoffMs: 10 } });

  async function driveCrash(opts: {
    remaining: number;
    resume?: boolean;
    sessionId?: string;
    stderr?: string;
    prompt?: string;
  }, body: (session: AgentSession, v1: AgentEvent[], v2: UiEvent[], wire: string) => Promise<void>) {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-spawn-retry-'));
    const crash = join(dir, 'crash-remaining');
    const wire = join(dir, 'wire.ndjson');
    writeFileSync(crash, String(opts.remaining));
    const v1: AgentEvent[] = [];
    const v2: UiEvent[] = [];
    const session = crashRunner().startSession({
      cwd: dir,
      userPrompt: opts.prompt ?? 'mock:done',
      timeoutMs: 8000,
      ...(opts.resume ? { resume: true, sessionId: opts.sessionId ?? 'sess-529' } : {}),
      env: {
        CEZ_MOCK_CURSOR_CRASH_ON_LOAD: crash,
        CEZ_MOCK_STDIN_FILE: wire,
        ...(opts.stderr ? { CEZ_MOCK_CURSOR_CRASH_STDERR: opts.stderr } : {}),
      },
    }, e => v1.push(e), { onUiEvent: e => v2.push(e) });
    try { await body(session, v1, v2, wire); }
    finally { session.interrupt(); await session.result.catch(() => {}); rmSync(dir, { recursive: true, force: true }); }
  }

  it('respawns and session/loads after an unexpected resume exit', async () => {
    await driveCrash({ remaining: 1, resume: true, sessionId: 'sess-529' }, async (session, v1, v2, wire) => {
      await waitFor(() => v1.some(e => e.type === 'turn-end') || v1.some(e => e.type === 'error'));
      expect(v1.filter(e => e.type === 'error')).toEqual([]);
      expect(v2.some(e => e.type === 'session.started' && e.sessionId === 'sess-529')).toBe(true);
      expect(v1.some(e => e.type === 'text' && e.text.includes('Done.'))).toBe(true);
      const rows = readFileSync(wire, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(rows.filter(row => row.method === 'session/load')).toHaveLength(2);
      expect(rows.filter(row => row.method === 'session/new')).toHaveLength(0);
      expect(session.open).toBe(true);
    });
  });

  it('includes capped stderr when an unexpected bootstrap exit exhausts retries', async () => {
    const stderr = `${'x'.repeat(2000)} boom`;
    await driveCrash({ remaining: 10, resume: true, stderr }, async (session, v1) => {
      await session.result.catch(() => {});
      const error = v1.find((e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error');
      expect(error?.message).toMatch(/exited unexpectedly \(1\)/);
      expect(error?.message).toMatch(/after 3 attempts/);
      expect(error?.message).toContain('boom');
      expect(error?.message).not.toMatch(/x{501}/);
      const detail = error?.message.split(': ').slice(1).join(': ') ?? '';
      expect(detail.length).toBeLessThanOrEqual(500);
    });
  });

  it('does not hang when stdin dies during bootstrap while the child stays up', async () => {
    const hang = fileURLToPath(new URL('../../scripts/mock-cursor-hang-stdin.mjs', import.meta.url));
    const v1: AgentEvent[] = [];
    const started = Date.now();
    const session = new CursorAcpRunner({ bin: hang }).startSession({ cwd: process.cwd(), userPrompt: 'hang', timeoutMs: 8000 }, e => v1.push(e));
    try {
      // Tight 3s/5s bounds flake under a full shard: spawn shares the machine with
      // hundreds of files, then `finally` still awaits `session.result`.
      await waitFor(() => v1.some(e => e.type === 'error'), 5_000);
      expect(v1.some(e => e.type === 'error')).toBe(true);
      expect(Date.now() - started).toBeLessThan(6_000);
    } finally { session.interrupt(); await session.result.catch(() => {}); }
  }, 15_000);

  it('does not retry a clean session close after end_turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-clean-close-'));
    const wire = join(dir, 'wire.ndjson');
    try {
      const v1: AgentEvent[] = [];
      const result = await crashRunner().run({
        cwd: dir, userPrompt: 'mock:done', timeoutMs: 5000, env: { CEZ_MOCK_STDIN_FILE: wire },
      }, e => v1.push(e));
      expect(v1.some(e => e.type === 'error')).toBe(false);
      expect(result.text).toContain('Done.');
      const rows = readFileSync(wire, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(rows.filter(row => row.method === 'initialize')).toHaveLength(1);
      expect(rows.filter(row => row.method === 'session/new')).toHaveLength(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
