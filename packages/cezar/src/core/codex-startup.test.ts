import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentSession } from './agent-runner.ts';
import { CodexAppServerRunner } from './codex-app-server-runner.ts';
import type { UiEvent } from './ui-events.ts';

const spawnHook = vi.hoisted(() => ({ child: undefined as unknown }));
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  spawn: () => spawnHook.child,
}));

// Only the external process is replaced. Real RPC correlation, stdout parsing,
// session state and timers run unchanged. Frames follow mock-codex-app-server.mjs.
function fakeChild() {
  const emitter = new EventEmitter();
  const requests: Array<{ id?: number; method: string; params: Record<string, unknown> }> = [];
  const signals: NodeJS.Signals[] = [];
  const child = Object.assign(emitter, {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    killed: false, pid: 4243,
    kill(signal: NodeJS.Signals) { signals.push(signal); child.killed = true; return true; },
  });
  child.stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().trim().split('\n')) requests.push(JSON.parse(line));
  });
  return {
    child: child as unknown as ChildProcessWithoutNullStreams, requests, signals,
    frame(message: unknown) { if (!child.stdout.destroyed) child.stdout.write(`${JSON.stringify(message)}\n`); },
    respond(method: string, result: unknown) {
      const request = [...requests].reverse().find((message) => message.method === method);
      if (!request?.id) throw new Error(`No pending ${method} request`);
      this.frame({ id: request.id, result });
    },
    exit(code: number | null = 143, signal: NodeJS.Signals | null = null, holdOutput = false) {
      child.exitCode = code; child.signalCode = signal;
      emitter.emit('exit', code, signal);
      if (!holdOutput) { child.stdout.end(); child.stderr.end(); emitter.emit('close', code, signal); }
    },
  };
}

type Phase = 'initialize' | 'thread/start' | 'thread/resume' | 'turn/start' | 'first turn';
let fake: ReturnType<typeof fakeChild>;
let session: AgentSession;
let events: AgentEvent[];
let ui: UiEvent[];
let outcome: 'pending' | 'resolved' | 'rejected';
let failure: unknown;
let readyHints: number;
const flush = () => vi.advanceTimersByTimeAsync(0);

function start(resume = false, timeoutMs = 0) {
  session = new CodexAppServerRunner({ bin: 'fake-only', timeoutMs }).startSession({
    cwd: process.cwd(), userPrompt: 'test', ...(resume ? { resume: true, sessionId: 'thread_1' } : {}),
  }, (event) => events.push(event), { onUiEvent: (event) => ui.push(event), onAgentInputReady: () => { readyHints += 1; } });
  void session.result.then(() => { outcome = 'resolved'; }, (error: unknown) => { failure = error; outcome = 'rejected'; });
}
async function initialize() { fake.respond('initialize', {}); await flush(); }
async function thread(resume = false) {
  fake.respond(resume ? 'thread/resume' : 'thread/start', { thread: { id: 'thread_1' } }); await flush();
}
function started(threadId = 'thread_1') {
  fake.frame({ method: 'turn/started', params: { threadId, turn: { id: 'turn_1', status: 'inProgress', items: [] } } });
}
async function opening() {
  fake.respond('turn/start', { turn: { id: 'turn_1', status: 'inProgress', items: [] } });
  started(); await flush();
}
async function stall(phase: Phase) {
  start(phase === 'thread/resume');
  if (phase === 'initialize') return;
  await initialize();
  if (phase.startsWith('thread/')) return;
  await thread();
  if (phase === 'turn/start') return;
  fake.respond('turn/start', { turn: { id: 'turn_1', status: 'inProgress', items: [] } }); await flush();
}

beforeEach(() => {
  vi.useFakeTimers(); fake = fakeChild(); spawnHook.child = fake.child;
  events = []; ui = []; outcome = 'pending'; failure = undefined; readyHints = 0;
});
afterEach(async () => {
  fake.exit(); await flush(); vi.clearAllTimers(); vi.useRealTimers();
});

describe('Codex startup and Stop (#493)', () => {
  // Removing early RPC shutdown would leave result pending after actual child exit.
  it.each<Phase>(['initialize', 'thread/start', 'thread/resume', 'turn/start', 'first turn'])(
    'Stop settles normally while waiting for %s, without a provider error', async (phase) => {
      await stall(phase);
      session.interrupt(); await flush();
      expect(outcome).toBe('pending'); // RPC rejection is NOT process termination.
      fake.exit(); await flush();
      expect(outcome).toBe('resolved');
      expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
      expect(events.some((event) => event.type === 'error')).toBe(false);
      expect(session.sendMessage([{ type: 'text', text: 'too late' }])).toBe(false);
    },
  );

  it('escalates an ignored TERM once, without restarting its grace on repeated Stop', async () => {
    start(); session.interrupt();
    await vi.advanceTimersByTimeAsync(9_999);
    session.interrupt(); session.end();
    expect(fake.signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(outcome).toBe('pending');
    fake.exit(null, 'SIGKILL'); await flush();
    expect(outcome).toBe('resolved');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('stops escalation on real exit even if descendants hold stdout open', async () => {
    start(); session.interrupt(); fake.exit(null, 'SIGTERM', true);
    // Bounded pipe drainage is allowed after real exit, never before it.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(outcome).toBe('resolved');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.signals).toEqual(['SIGTERM']);
  });

  it('does not start work when an initialize response and queued follow-up arrive after Stop', async () => {
    start(); expect(session.sendMessage([{ type: 'text', text: 'Keep going' }])).toBe(true);
    session.interrupt();
    fake.respond('initialize', {}); await flush();
    expect(fake.requests.map((request) => request.method)).toEqual(['initialize']);
    fake.exit(); await flush(); expect(outcome).toBe('resolved');
  });

  it.each([false, true])('surfaces early child exit with a phase diagnostic (held stdout=%s)', async (holdOutput) => {
    start(); fake.exit(7, null, holdOutput); await vi.advanceTimersByTimeAsync(1_000);
    expect(outcome).toBe('rejected');
    expect(String(failure)).toMatch(/initialize.*(?:exit|7)|(?:exit|7).*initialize/i);
  });

  it('settles a failed spawn without waiting for a nonexistent process', async () => {
    Object.assign(fake.child, { pid: undefined });
    start(); fake.child.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' }));
    await flush(); expect(outcome).toBe('rejected'); expect(String(failure)).toContain('not found');
    expect(fake.signals).toEqual([]);
  });

  it('treats early EOF as a transport failure, but still waits for process exit', async () => {
    start(); (fake.child.stdout as PassThrough).end(); await flush();
    expect(outcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.signals).toContain('SIGKILL');
    fake.exit(); await flush();
    expect(outcome).toBe('rejected'); expect(String(failure)).toMatch(/initialize.*(?:closed|EOF)|(?:closed|EOF).*initialize/i);
  });

  // Independent literal budget: phase transitions must NOT reset the clock.
  it('uses one total 60s startup deadline despite timeoutMs=0 and phase progress', async () => {
    start(); await vi.advanceTimersByTimeAsync(20_000); await initialize();
    await vi.advanceTimersByTimeAsync(20_000); await thread();
    await vi.advanceTimersByTimeAsync(19_999); expect(fake.signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.signals).toEqual(['SIGTERM']); expect(outcome).toBe('pending');
    expect(events).toContainEqual(expect.objectContaining({ type: 'note', message: expect.stringContaining('initialize') }));
    fake.exit(); await flush();
    expect(outcome).toBe('rejected'); expect(String(failure)).toMatch(/60s.*turn\/start/);
  });

  it.each<Phase>(['initialize', 'thread/start', 'thread/resume', 'turn/start', 'first turn'])(
    'bounds startup while waiting for %s', async (phase) => {
      await stall(phase); await vi.advanceTimersByTimeAsync(60_000);
      expect(fake.signals).toEqual(['SIGTERM']); fake.exit(); await flush();
      expect(outcome).toBe('rejected'); expect(String(failure)).toMatch(/startup.*timed out/i);
    },
  );

  it('does not clear startup deadline when turn/started overtakes its ACK', async () => {
    start(); await initialize(); await thread(); started(); await flush();
    await vi.advanceTimersByTimeAsync(60_000); expect(fake.signals).toEqual(['SIGTERM']);
    fake.exit(); await flush(); expect(outcome).toBe('rejected');
  });

  it('does not mistake a child thread start for main-thread startup', async () => {
    await stall('first turn'); started('child_thread'); await flush();
    await vi.advanceTimersByTimeAsync(60_000); expect(fake.signals).toEqual(['SIGTERM']);
    fake.exit(); await flush(); expect(outcome).toBe('rejected');
  });

  it('does not treat a malformed turn/started notification as startup evidence', async () => {
    await stall('first turn');
    fake.frame({ method: 'turn/started', params: { threadId: 'thread_1', turn: {} } }); await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.signals).toEqual(['SIGTERM']); fake.exit(); await flush();
    expect(outcome).toBe('rejected');
  });

  it.each(['ack first', 'lifecycle first'])('leaves healthy long turns and native questions unbounded: %s', async (order) => {
    start(); await initialize(); await thread();
    if (order === 'lifecycle first') { started(); await flush(); }
    fake.respond('turn/start', { turn: { id: 'turn_1', status: 'inProgress', items: [] } });
    if (order === 'ack first') started();
    await flush();
    fake.frame({ id: 'ask_1', method: 'item/tool/requestUserInput', params: { questions: [{
      id: 'choice', header: 'Choice', question: 'Choose?', options: [{ label: 'A' }, { label: 'B' }],
    }] } });
    await flush(); expect(ui.some((event) => event.type === 'ask.requested')).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000); expect(fake.signals).toEqual([]);
    session.interrupt(); fake.exit(); await flush(); expect(outcome).toBe('resolved');
  });

  it('rejects a pending nonhuman delivery receipt on Stop rather than acknowledging it', async () => {
    start(); await initialize(); await thread(); await opening();
    fake.frame({ method: 'turn/completed', params: { threadId: 'thread_1', turn: { id: 'turn_1', status: 'completed', items: [] } } });
    await flush();
    const receipt = session.sendAgentMessage([{ type: 'text', text: 'worker result' }]);
    expect(receipt).not.toBe(false);
    let delivery = 'pending';
    if (receipt) void receipt.then(() => { delivery = 'ack'; }, () => { delivery = 'rejected'; });
    session.interrupt(); await flush(); expect(delivery).toBe('rejected');
    fake.respond('turn/start', { turn: { id: 'late_turn', status: 'inProgress', items: [] } });
    fake.exit(); await flush(); expect(outcome).toBe('resolved');
    expect(delivery).toBe('rejected'); expect(events.some((event) => event.type === 'error')).toBe(false);
  });

  it.each(['end', 'interrupt'] as const)('preserves passive buffered output after %s without reopening control', async (close) => {
    start(); await initialize(); await thread(); await opening();
    const turnsBefore = ui.filter((event) => event.type.startsWith('turn.')).length;
    fake.frame({ method: 'item/agentMessage/delta', params: { threadId: 'thread_1', itemId: 'partial', delta: 'Buffered partial text.' } });
    fake.frame({ method: 'item/completed', params: { threadId: 'thread_1', item: { type: 'agentMessage', id: 'final', text: 'Buffered final answer.' } } });
    fake.frame({ method: 'item/started', params: { threadId: 'thread_1', item: { type: 'commandExecution', id: 'tool_1', command: ['pwd'], status: 'inProgress' } } });
    fake.frame({ method: 'item/completed', params: { threadId: 'thread_1', item: { type: 'commandExecution', id: 'tool_1', command: ['pwd'], status: 'completed', aggregatedOutput: '/repo', exitCode: 0 } } });
    fake.frame({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread_1', tokenUsage: { total: { totalTokens: 42, inputTokens: 30, outputTokens: 12 } } } });
    session[close]();
    const methodsAfterClose = fake.requests.map((request) => request.method);
    // These are control frames, not passive output. Neither channel may reopen.
    fake.respond('turn/start', { turn: { id: 'late', status: 'inProgress', items: [] } });
    started();
    fake.frame({ method: 'turn/completed', params: { threadId: 'thread_1', turn: { id: 'turn_1', status: 'failed', error: { message: 'late cancellation noise' }, items: [] } } });
    fake.frame({ id: 'late_ask', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'late', header: 'Late', question: 'Choose?', options: [{ label: 'A' }, { label: 'B' }] }] } });
    fake.exit(close === 'end' ? 0 : 143); await flush();
    const result = await session.result;
    expect(result.text).toContain('Buffered final answer.');
    expect(result.text).toContain('Buffered partial text.');
    expect(result.tokensUsed).toBe(42);
    expect(result.toolCalls).toContainEqual(expect.objectContaining({ id: 'tool_1' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool-result', toolCallId: 'tool_1' }));
    expect(ui).toContainEqual(expect.objectContaining({ type: 'item.completed', item: expect.objectContaining({ id: 'final', text: 'Buffered final answer.' }) }));
    expect(ui.filter((event) => event.type.startsWith('turn.'))).toHaveLength(turnsBefore);
    expect(ui.some((event) => event.type === 'ask.requested')).toBe(false);
    expect(events.some((event) => event.type === 'turn-end' || event.type === 'error')).toBe(false);
    expect(readyHints).toBe(0);
    expect(session.open).toBe(false);
    expect(session.sendAgentMessage([{ type: 'text', text: 'late worker' }])).toBe(false);
    expect(fake.requests.map((request) => request.method)).toEqual(methodsAfterClose);
  });

  it.each([
    ['idle', 'error'], ['native ask', 'error'], ['idle', 'close'], ['native ask', 'close'],
    ['idle', 'finish'], ['native ask', 'finish'],
  ])('fails an established %s session on unexpected stdin %s, awaiting real exit', async (state, fault) => {
    start(); await initialize(); await thread(); await opening();
    if (state === 'idle') {
      fake.frame({ method: 'turn/completed', params: { threadId: 'thread_1', turn: { id: 'turn_1', status: 'completed', items: [] } } });
    } else {
      fake.frame({ id: 'ask_1', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'choice', header: 'Choice', question: 'Choose?', options: [{ label: 'A' }, { label: 'B' }] }] } });
    }
    await flush();
    const methodsBefore = fake.requests.map((request) => request.method);
    if (fault === 'finish') fake.child.stdin.end();
    else fake.child.stdin.destroy(fault === 'error' ? new Error('EPIPE') : undefined);
    await flush();
    expect(session.open).toBe(false);
    expect(session.sendMessage([{ type: 'text', text: 'A' }])).toBe(false);
    expect(session.sendAgentMessage([{ type: 'text', text: 'worker result' }])).toBe(false);
    expect(fake.signals).toEqual(['SIGTERM']);
    expect(outcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(outcome).toBe('pending');
    fake.exit(null, 'SIGKILL'); await flush();
    expect(outcome).toBe('rejected');
    expect(String(failure)).toMatch(/stdin.*(?:failed|closed)/);
    expect(fake.requests.map((request) => request.method)).toEqual(methodsBefore);
    expect(readyHints).toBe(0);
  });

  it('does not claim a native answer was accepted when its write fails synchronously', async () => {
    start(); await initialize(); await thread(); await opening();
    fake.frame({ id: 'ask_1', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'choice', header: 'Choice', question: 'Choose?', options: [{ label: 'A' }, { label: 'B' }] }] } });
    await flush();
    const write = vi.spyOn(fake.child.stdin, 'write').mockImplementation(() => { throw new Error('EPIPE'); });
    try {
      expect(session.sendMessage([{ type: 'text', text: 'A' }])).toBe(false);
      expect(session.open).toBe(false);
      expect(fake.signals).toEqual(['SIGTERM']);
      expect(outcome).toBe('pending');
    } finally { write.mockRestore(); }
    fake.exit(); await flush();
    expect(outcome).toBe('rejected'); expect(String(failure)).toMatch(/stdin.*write failed/);
  });

  it('does not reinterpret an expected pipe error during Stop as a provider failure', async () => {
    start(); await initialize(); await thread(); await opening();
    session.interrupt(); fake.child.stdin.destroy(new Error('EPIPE')); await flush();
    fake.exit(); await flush();
    expect(outcome).toBe('resolved'); expect(failure).toBeUndefined();
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });

  it.each([
    ['turn/completed', 'failed', 'error'],
    ['turn/failed', 'failed', 'error'],
    ['turn/completed', 'completed', 'end_turn'],
  ])('preserves final %s (%s) classification after natural exit without reviving control', async (method, status, stopReason) => {
    start(); await initialize(); await thread(); await opening();
    const methodsBefore = fake.requests.map((request) => request.method);
    fake.frame({ method, params: { threadId: 'thread_1', turn: {
      id: 'turn_1', status, items: [], ...(status === 'failed' ? { error: { message: 'model unavailable' } } : {}),
    } } });
    // Process termination overtakes the reader; it is NOT a Finish/Stop request.
    fake.exit(0, null, true);
    fake.respond('turn/start', { turn: { id: 'late', status: 'inProgress', items: [] } });
    started();
    fake.frame({ id: 'late_ask', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'late', header: 'Late', question: 'Choose?', options: [{ label: 'A' }, { label: 'B' }] }] } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(outcome).toBe('resolved'); // Existing runner contract surfaces turn failure through events.
    expect(events.filter((event) => event.type === 'error')).toEqual(status === 'failed' ? [{ type: 'error', message: 'model unavailable' }] : []);
    expect(ui).toContainEqual({ type: 'turn.completed', turnId: 'turn_1', stopReason });
    expect(events.filter((event) => event.type === 'turn-end')).toHaveLength(1);
    expect(ui.filter((event) => event.type === 'turn.started')).toHaveLength(1);
    expect(ui.some((event) => event.type === 'ask.requested')).toBe(false);
    expect(readyHints).toBe(0);
    expect(session.open).toBe(false);
    expect(session.sendMessage([{ type: 'text', text: 'late human' }])).toBe(false);
    expect(session.sendAgentMessage([{ type: 'text', text: 'late worker' }])).toBe(false);
    expect(fake.requests.map((request) => request.method)).toEqual(methodsBefore);
    expect(fake.signals).toEqual([]);
  });

  it('drains final output after real exit without hanging on an inherited stdout pipe', async () => {
    start(); await initialize(); await thread(); await opening();
    fake.frame({ method: 'item/completed', params: { threadId: 'thread_1', item: { type: 'agentMessage', id: 'last', text: 'Final buffered text.' } } });
    fake.exit(0, null, true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(outcome).toBe('resolved');
    await expect(session.result).resolves.toMatchObject({ text: 'Final buffered text.' });
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
    expect(fake.signals).toEqual([]);
  });

  it('releases inherited stderr and input handles only after actual process exit', async () => {
    start(); session.interrupt(); await flush();
    expect(fake.child.stderr.destroyed).toBe(false);
    fake.exit(null, 'SIGTERM', true); await vi.advanceTimersByTimeAsync(1_000);
    expect(outcome).toBe('resolved');
    expect(fake.child.stdout.destroyed).toBe(true);
    expect(fake.child.stderr.destroyed).toBe(true);
    expect(fake.child.stdin.destroyed).toBe(true);
  });

  it('closes message admission on actual exit before the inherited output pipe drains', async () => {
    start(); await initialize(); await thread(); await opening();
    fake.exit(0, null, true);
    expect(session.open).toBe(false);
    expect(session.sendMessage([{ type: 'text', text: 'too late' }])).toBe(false);
    expect(session.sendAgentMessage([{ type: 'text', text: 'worker result' }])).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
  });

  it('replaces an earlier graceful-close watchdog when Stop is pressed', async () => {
    start(); session.end(); session.interrupt();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    fake.exit(); await flush(); expect(outcome).toBe('resolved');
  });

  it('keeps startup notes bounded and stage-only when an RPC error contains raw vendor detail', async () => {
    start();
    const detail = `vendor diagnostic ${'private-detail '.repeat(300)}`;
    fake.frame({ id: 1, error: { code: -32603, message: detail } }); await flush();
    const notes = events.filter((event) => event.type === 'note').map((event) => event.message);
    expect(notes.every((message) => message.length < 200 && !message.includes('private-detail'))).toBe(true);
    expect(notes.some((message) => message.includes('initialize'))).toBe(true);
    fake.exit(); await flush();
    expect(String(failure)).toContain('vendor diagnostic'); // Preserve the initiating error.
  });

  it('still owns process termination when a startup diagnostic consumer throws', async () => {
    session = new CodexAppServerRunner({ bin: 'fake-only', timeoutMs: 0 }).startSession({ cwd: process.cwd(), userPrompt: 'test' }, () => {
      throw new Error('journal unavailable');
    });
    void session.result.then(() => { outcome = 'resolved'; }, (error: unknown) => { outcome = 'rejected'; failure = error; });
    await flush();
    expect(outcome).toBe('pending');
    expect(fake.signals).toEqual(['SIGTERM']);
    fake.exit(); await flush();
    expect(outcome).toBe('rejected'); expect(String(failure)).toContain('journal unavailable');
  });

  it('preserves a genuine bootstrap rejection while shutting down its process', async () => {
    start(); fake.frame({ id: 1, error: { code: -32603, message: 'initialization rejected' } }); await flush();
    fake.exit(); await flush(); expect(outcome).toBe('rejected'); expect(String(failure)).toContain('initialization rejected');
  });
});
