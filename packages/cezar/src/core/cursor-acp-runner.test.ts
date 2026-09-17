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
import { waitFor, withOwnedInputRun } from './harness-parity.testkit.ts';
import type { AgentEvent, AgentSession } from './agent-runner.ts';
import type { UiEvent } from './ui-events.ts';
const mock = fileURLToPath(new URL('../../scripts/mock-cursor-acp.mjs', import.meta.url));

async function withSession(prompt: string, body: (session: AgentSession, v1: AgentEvent[], v2: UiEvent[]) => Promise<void>) {
  vi.stubEnv('CEZ_CURSOR_BIN', mock);
  const v1: AgentEvent[] = []; const v2: UiEvent[] = [];
  const session = createRunner('cursor' as RunnerId).startSession({ cwd: process.cwd(), userPrompt: prompt, timeoutMs: 5000 }, e => v1.push(e), { onUiEvent: e => v2.push(e) });
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
    expect(v2.some(e => e.type === 'session.error')).toBe(true);
    expect(v2.some(e => e.type === 'turn.completed' && e.stopReason === 'end_turn')).toBe(false);
  });
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

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
