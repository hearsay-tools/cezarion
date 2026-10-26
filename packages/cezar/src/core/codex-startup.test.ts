import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentSession } from './agent-runner.ts';
import { CodexAppServerRunner } from './codex-app-server-runner.ts';
import type { UiEvent } from './ui-events.ts';
import { UNSET_TOOL_GRANT } from './tool-grant.testkit.ts';

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

type Phase = 'initialize' | 'configRequirements/read' | 'thread/start' | 'thread/resume' | 'turn/start' | 'first turn';
let fake: ReturnType<typeof fakeChild>;
let session: AgentSession;
let events: AgentEvent[];
let ui: UiEvent[];
let outcome: 'pending' | 'resolved' | 'rejected';
let failure: unknown;
let readyHints: number;
const flush = () => vi.advanceTimersByTimeAsync(0);

function start(resume = false, timeoutMs = 0) {
  session = new CodexAppServerRunner({ bin: 'fake-only', timeoutMs }).startSession({ toolGrant: UNSET_TOOL_GRANT,
    cwd: process.cwd(), userPrompt: 'test', ...(resume ? { resume: true, sessionId: 'thread_1' } : {}),
  }, (event) => events.push(event), { onUiEvent: (event) => ui.push(event), onAgentInputReady: () => { readyHints += 1; } });
  void session.result.then(() => { outcome = 'resolved'; }, (error: unknown) => { failure = error; outcome = 'rejected'; });
}
async function initialize() {
  fake.respond('initialize', {}); await flush();
  fake.respond('configRequirements/read', { requirements: null }); await flush();
}
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
  if (phase === 'configRequirements/read') { fake.respond('initialize', {}); await flush(); return; }
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
  it.each<Phase>(['initialize', 'configRequirements/read', 'thread/start', 'thread/resume', 'turn/start', 'first turn'])(
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

  it('retains stderr diagnostics when malformed RPC precedes an early process failure', async () => {
    start();
    (fake.child.stdout as PassThrough).write('{"method":"item/commandExecution/outputDelta","params":\n');
    const stderr = "Error: write EPIPE\n    at write (file.js:1:2) {\n  code: 'EPIPE'\n}\n\nNode.js v24.20.0\n";
    (fake.child.stderr as PassThrough).write(stderr);
    fake.exit(1);
    await flush();
    expect(outcome).toBe('rejected');
    expect(String(failure)).toContain('initialize');
    expect(events.filter(e => e.type === 'note')).toContainEqual({
      type: 'note', message: `codex app-server stderr:\n${stderr}`,
    });
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

  it.each<Phase>(['initialize', 'configRequirements/read', 'thread/start', 'thread/resume', 'turn/start', 'first turn'])(
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
    session = new CodexAppServerRunner({ bin: 'fake-only', timeoutMs: 0 }).startSession({ toolGrant: UNSET_TOOL_GRANT, cwd: process.cwd(), userPrompt: 'test' }, () => {
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


describe('Codex stream retry deadline (#550)', () => {
  async function running() { start(); await initialize(); await thread(); await opening(); }
  function retry(message = 'Reconnecting... waiting for network', extra = {}) {
    fake.frame({ method: 'error', params: {
      threadId: 'thread_1', turnId: 'turn_1', willRetry: true,
      error: { message, additionalDetails: 'Connection failed: error sending request' }, ...extra,
    } });
  }
  function progress(extra = {}) {
    fake.frame({ method: 'item/agentMessage/delta', params: {
      threadId: 'thread_1', turnId: 'turn_1', itemId: 'message_1', delta: 'Recovered', ...extra,
    } });
  }

  it('shows retry details immediately without failing, then fails at 60s with the last error', async () => {
    await running(); retry('Reconnecting... 2/5'); await flush();
    expect(events).toContainEqual({ type: 'note', message: 'Reconnecting... 2/5 — Connection failed: error sending request' });
    expect(ui).toContainEqual({ type: 'session.error', fatal: false, message: 'Reconnecting... 2/5 — Connection failed: error sending request' });
    expect(events.some(e => e.type === 'error')).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000); retry(); await flush();
    await vi.advanceTimersByTimeAsync(29_999); expect(fake.signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(1); expect(fake.signals).toEqual(['SIGTERM']);
    expect(outcome).toBe('pending'); // wait for actual process exit
    fake.exit(); await flush();
    expect(outcome).toBe('rejected');
    expect(String(failure)).toContain('Reconnecting... waiting for network — Connection failed: error sending request');
    expect(ui).toContainEqual(expect.objectContaining({ type: 'turn.completed', stopReason: 'error' }));
  });

  it('keeps the original deadline through warnings, stale/child progress and user input', async () => {
    await running(); retry(); await flush(); await vi.advanceTimersByTimeAsync(30_000);
    fake.frame({ method: 'warning', params: { message: 'Falling back to HTTPS' } });
    progress({ threadId: 'child' }); progress({ turnId: 'old-turn' }); progress({ delta: '' });
    fake.frame({ method: 'item/started', params: { threadId: 'thread_1', turnId: 'turn_1', item: { id: 'user', type: 'userMessage' } } });
    await flush(); await vi.advanceTimersByTimeAsync(30_000);
    expect(fake.signals).toEqual(['SIGTERM']);
  });

  it('clears a retry episode on real progress and gives a later episode its own budget', async () => {
    await running(); retry(); await flush(); await vi.advanceTimersByTimeAsync(40_000);
    progress(); await flush(); await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.signals).toEqual([]);
    retry('second episode'); await flush(); await vi.advanceTimersByTimeAsync(59_999);
    expect(fake.signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(1); expect(fake.signals).toEqual(['SIGTERM']);
  });

  it.each(['complete', 'interrupt', 'end'] as const)('clears retry state on %s', async action => {
    await running(); retry(); await flush();
    if (action === 'complete') fake.frame({ method: 'turn/completed', params: { threadId: 'thread_1', turn: { id: 'turn_1', status: 'completed' } } });
    else session[action]();
    await flush();
    if (action !== 'complete') { fake.exit(0); await flush(); }
    await vi.advanceTimersByTimeAsync(70_000);
    expect(failure).toBeUndefined();
    expect(events.some(e => e.type === 'error')).toBe(false);
    if (action === 'complete') { expect(fake.signals).toEqual([]); session.end(); fake.exit(0); await flush(); }
    expect(outcome).toBe('resolved');
  });

  it('fails promptly when the server stops retrying', async () => {
    await running(); retry('provider unavailable', { willRetry: false }); await flush();
    expect(fake.signals).toEqual(['SIGTERM']); fake.exit(); await flush();
    expect(outcome).toBe('rejected'); expect(String(failure)).toContain('provider unavailable');
    expect(ui).toContainEqual(expect.objectContaining({ type: 'session.error', fatal: true }));
  });

  it('classifies a timed-out interrupted stream as an error, not user cancellation', async () => {
    await running(); retry('stream interrupted before completion'); await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ui).toContainEqual(expect.objectContaining({ type: 'turn.completed', stopReason: 'error' }));
  });

  it('ignores malformed and foreign/stale retry errors', async () => {
    await running();
    retry('child', { threadId: 'child' }); retry('old', { turnId: 'old-turn' });
    retry('bad', { error: null });
    await flush(); await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.signals).toEqual([]);
    expect(events.filter(e => e.type === 'note' && /child|old|bad/.test(e.message))).toEqual([]);
  });
});

describe('Codex native approvals (hearsay-tools/cezarion#1049)', () => {
  const command = 'item/commandExecution/requestApproval';
  const file = 'item/fileChange/requestApproval';
  const permissions = 'item/permissions/requestApproval';
  const base = { threadId: 'thread_1', turnId: 'turn_1', itemId: 'tool_1', startedAtMs: 1,
    command: 'printf "exact scope"', cwd: '/repo', reason: 'Requires access' };
  async function running() { start(); await initialize(); await thread(); await opening(); }
  const requested = () => ui.filter((e) => e.type === 'permission.requested');
  const responses = () => fake.requests.filter((e) => !e.method) as unknown as Array<{ id: string | number; result?: unknown; error?: { code: number } }>;
  function respond(requestId: string, optionId: string) {
    return (session as AgentSession & { respondPermission?: (requestId: string, optionId: string) => boolean }).respondPermission?.(requestId, optionId);
  }
  async function request(method = command, params: unknown = base, id: string | number = 'approval_1') {
    fake.frame({ id, method, params }); await flush();
  }

  it('keeps approval pending until a dedicated human response, refusing ordinary and agent input', async () => {
    await running(); await request();
    const event = requested()[0]; expect(event).toBeDefined();
    expect(event!.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(event!.requestId).not.toBe('approval_1');
    expect(event!.itemId).toBe('tool_1');
    expect(JSON.parse(event!.details!)).toMatchObject({ command: base.command });
    expect(event!.details).toContain('/repo');
    expect(responses()).toEqual([]);
    const count = fake.requests.length;
    expect(session.sendMessage([{ type: 'text', text: 'accept' }])).toBe(false);
    expect(session.sendAgentMessage([{ type: 'text', text: 'allow' }])).toBe(false);
    await flush(); expect(fake.requests).toHaveLength(count);
    expect(respond(event!.requestId, 'accept')).toBe(false);
    expect(respond('stale', event!.options[0]!.id)).toBe(false);
    expect(responses()).toEqual([]);
    expect(respond(event!.requestId, event!.options[0]!.id)).toBe(true);
    expect(responses()).toEqual([{ id: 'approval_1', result: { decision: 'accept' } }]);
    expect(ui).toContainEqual({ type: 'permission.resolved', requestId: event!.requestId, optionId: event!.options[0]!.id });
    expect(respond(event!.requestId, event!.options[0]!.id)).toBe(false);
    expect(outcome).toBe('pending');
  });

  it.each([command, file])('offers documented fallback native choices for %s', async (method) => {
    await running(); await request(method);
    const event = requested()[0]; expect(event).toBeDefined();
    expect(event!.options.map(o => o.kind)).toEqual(['allow_once', 'allow_always', 'reject_once', 'reject_once']);
    expect(respond(event!.requestId, event!.options[1]!.id)).toBe(true);
    expect(responses()).toEqual([{ id: 'approval_1', result: { decision: 'acceptForSession' } }]);
  });

  it('offers fallback native command choices when availableDecisions is null', async () => {
    // Codex 0.160.1's generated CommandExecutionRequestApprovalParams declares
    // availableDecisions as array | null; null carries the same meaning as absent.
    await running(); await request(command, { ...base, availableDecisions: null });
    const event = requested()[0]; expect(event).toBeDefined();
    expect(event!.options.map(option => option.kind)).toEqual(['allow_once', 'allow_always', 'reject_once', 'reject_once']);
    expect(respond(event!.requestId, event!.options[2]!.id)).toBe(true);
    expect(responses()).toEqual([{ id: 'approval_1', result: { decision: 'decline' } }]);
  });

  it.each(['decline', 'cancel'])('returns %s unchanged and permits a later continuation', async (decision) => {
    await running(); await request(command, { ...base, availableDecisions: [decision] });
    const event = requested()[0]; expect(event).toBeDefined();
    expect(event!.options).toHaveLength(1);
    expect(respond(event!.requestId, event!.options[0]!.id)).toBe(true);
    expect(responses()).toEqual([{ id: 'approval_1', result: { decision } }]);
    fake.frame({ method: 'turn/completed', params: { threadId: 'thread_1', turn: { id: 'turn_1', status: decision === 'cancel' ? 'interrupted' : 'completed' } } }); await flush();
    expect(session.sendMessage([{ type: 'text', text: 'Continue safely' }])).toBe(true);
    await flush(); expect(fake.requests.at(-1)?.method).toBe('turn/start');
  });

  it.each([
    { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', '-C', '/exact scope', 'push'] } },
    { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.test:8443', action: 'allow' } } },
    { applyNetworkPolicyAmendment: { network_policy_amendment: { host: '*.example.test', action: 'deny' } } },
  ])('preserves the exact structured native decision and displays its whole scope: %j', async (decision) => {
    await running(); await request(command, { ...base, availableDecisions: [decision] });
    const event = requested()[0]; expect(event).toBeDefined(); expect(event!.options).toHaveLength(1);
    expect(JSON.parse(event!.details!)).toMatchObject({ availableDecisions: [decision] });
    expect(event!.options[0]!.kind).toBe(decision.applyNetworkPolicyAmendment?.network_policy_amendment.action === 'deny' ? 'reject_always' : 'allow_always');
    expect(respond(event!.requestId, event!.options[0]!.id)).toBe(true);
    expect(responses()).toEqual([{ id: 'approval_1', result: { decision } }]);
  });

  it.each(['turn', 'session', 'decline'])('answers a permissions request with a %s grant, never a decision enum', async (choice) => {
    await running(); const grant = { network: { enabled: true }, fileSystem: { write: ['/exact/path'] } };
    await request(permissions, { ...base, permissions: grant });
    const event = requested()[0]; expect(event).toBeDefined(); expect(event!.options).toHaveLength(3);
    const option = event!.options[choice === 'turn' ? 0 : choice === 'session' ? 1 : 2]!;
    expect(respond(event!.requestId, option.id)).toBe(true);
    expect(responses()).toEqual([{ id: 'approval_1', result: { permissions: choice === 'decline' ? {} : grant, scope: choice === 'session' ? 'session' : 'turn' } }]);
  });

  it('retains concurrent requests and keeps input blocked until both are answered', async () => {
    await running(); await request(); await request(file, { ...base, grantRoot: '/other' }, 0);
    const [a, b] = requested(); expect(a).toBeDefined(); expect(b).toBeDefined(); expect(a!.requestId).not.toBe(b!.requestId);
    expect(respond(b!.requestId, b!.options[2]!.id)).toBe(true);
    expect(session.sendAgentMessage([{ type: 'text', text: 'worker' }])).toBe(false);
    expect(respond(a!.requestId, a!.options[2]!.id)).toBe(true);
    expect(responses()).toEqual([{ id: 0, result: { decision: 'decline' } }, { id: 'approval_1', result: { decision: 'decline' } }]);
    const delivery = session.sendAgentMessage([{ type: 'text', text: 'worker' }]);
    expect(delivery).not.toBe(false);
    fake.respond('turn/steer', {}); await delivery;
  });

  it.each(['turn/completed', 'turn/failed', 'serverRequest/resolved', 'interrupt', 'end', 'exit', 'pipe'])('expires pending approvals on %s', async (action) => {
    await running(); await request(); const event = requested()[0]; expect(event).toBeDefined();
    if (action === 'interrupt' || action === 'end') session[action]();
    else if (action === 'exit') fake.exit(0);
    else if (action === 'pipe') fake.child.stdin.destroy(new Error('EPIPE'));
    else fake.frame({ method: action, params: action === 'serverRequest/resolved'
      ? { threadId: 'thread_1', requestId: 'approval_1' }
      : { threadId: 'thread_1', turn: { id: 'turn_1', status: action === 'turn/failed' ? 'failed' : 'completed' } } });
    await flush();
    expect(ui).toContainEqual(expect.objectContaining({ type: 'permission.resolved', requestId: event!.requestId, reason: expect.any(String) }));
    expect(respond(event!.requestId, event!.options[0]!.id)).toBe(false);
    if (action === 'interrupt' || action === 'end') expect(responses()).toContainEqual({ id: 'approval_1', error: { code: -32000, message: expect.any(String) } });
    if (action === 'serverRequest/resolved') expect(responses()).toEqual([]);
  });

  it.each(['foreign', 'stale', 'no-turn'])('refuses %s approvals without creating a UI capability', async (state) => {
    await running();
    if (state === 'no-turn') { fake.frame({ method: 'turn/completed', params: { threadId: 'thread_1', turn: { id: 'turn_1', status: 'completed' } } }); await flush(); }
    await request(command, { ...base, ...(state === 'foreign' ? { threadId: 'other' } : state === 'stale' ? { turnId: 'old' } : {}) });
    expect(requested()).toEqual([]); expect(responses()).toEqual([{ id: 'approval_1', error: { code: -32602, message: expect.any(String) } }]);
  });

  it.each([
    null, [], {}, { ...base, cwd: 123 }, { ...base, itemId: '' },
    { ...base, availableDecisions: [] }, { ...base, availableDecisions: ['unknown'] },
    { ...base, availableDecisions: [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: [123] } }] },
  ])('rejects malformed command approval %j with -32602', async params => {
    await running(); await request(command, params);
    expect(requested()).toEqual([]); expect(responses()).toEqual([{ id: 'approval_1', error: { code: -32602, message: expect.any(String) } }]);
  });

  it.each(['execCommandApproval', 'applyPatchApproval', 'item/unknown/requestApproval', 'turn/completed'])('answers unsupported request %s with -32601 rather than notifying', async method => {
    await running(); await request(method, base, 0);
    expect(responses()).toEqual([{ id: 0, error: { code: -32601, message: expect.any(String) } }]);
    expect(events.some(e => e.type === 'turn-end')).toBe(false);
  });

  it('keeps notifications distinct and ignores a foreign resolution or stale turn completion', async () => {
    await running(); fake.frame({ method: command, params: base }); await flush(); expect(requested()).toEqual([]);
    await request(); const event = requested()[0]; expect(event).toBeDefined();
    fake.frame({ method: 'serverRequest/resolved', params: { threadId: 'other', requestId: 'approval_1' } });
    fake.frame({ method: 'turn/completed', params: { threadId: 'thread_1', turn: { id: 'old', status: 'completed' } } }); await flush();
    expect(ui.some(event => event.type === 'turn.completed')).toBe(false);
    expect(respond(event!.requestId, event!.options[0]!.id)).toBe(true);
    expect(responses()).toEqual([{ id: 'approval_1', result: { decision: 'accept' } }]);
  });

  it('rejects the server request if its UI sink throws, then keeps reading transport', async () => {
    start(); await initialize(); await thread(); await opening();
    ui.push = ((event: UiEvent) => { if (event.type.startsWith('permission.')) throw new Error('sink failed'); return Array.prototype.push.call(ui, event); }) as typeof ui.push;
    await request();
    expect(responses()).toEqual([{ id: 'approval_1', error: { code: -32000, message: expect.any(String) } }]);
    await request('unknown', {}, 'unknown');
    expect(responses()).toContainEqual({ id: 'unknown', error: { code: -32601, message: expect.any(String) } });
    expect(session.open).toBe(true);
  });

  it('correlates numeric and string ids independently even when an id collides with a client RPC', async () => {
    await running();
    await request(command, base, 0); await request(command, base, '0');
    const [a, b] = requested(); expect(a).toBeDefined(); expect(b).toBeDefined();
    expect(respond(b!.requestId, b!.options[0]!.id)).toBe(true);
    expect(respond(a!.requestId, a!.options[2]!.id)).toBe(true);
    expect(responses()).toEqual([{ id: '0', result: { decision: 'accept' } }, { id: 0, result: { decision: 'decline' } }]);
    expect(session.sendMessage([{ type: 'text', text: 'ordinary input' }])).toBe(true); await flush();
    const rpcId = fake.requests.at(-1)!.id!;
    fake.frame({ id: rpcId, method: 'unknown', result: {} }); await flush();
    expect(responses().at(-1)).toEqual({ id: rpcId, error: { code: -32601, message: expect.any(String) } });
    expect(session.holdsHumanInput()).toBe(true);
  });

  it('invalidates an ambiguous duplicate native id rather than permitting a second answer', async () => {
    await running(); await request(); const event = requested()[0]; expect(event).toBeDefined();
    await request(file);
    expect(responses()).toEqual([{ id: 'approval_1', error: { code: -32602, message: expect.any(String) } }]);
    expect(requested()).toHaveLength(1);
    expect(ui).toContainEqual(expect.objectContaining({ type: 'permission.resolved', requestId: event!.requestId, reason: expect.any(String) }));
    expect(respond(event!.requestId, event!.options[0]!.id)).toBe(false);
  });

  it.each([
    [file, { ...base, grantRoot: 123 }], [file, { ...base, availableDecisions: [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git'] } }] }],
    [permissions, { ...base, permissions: { network: { enabled: 'true' } } }],
    [permissions, { ...base, permissions: { fileSystem: { write: [123] } } }],
    [permissions, { ...base, permissions: { fileSystem: { entries: [{ access: 'allow', path: { type: 'path', path: '/scope' } }] } } }],
    [permissions, { ...base, permissions: { unknownPrivilege: true } }],
  ])('rejects malformed %s payload %j', async (method, params) => {
    await running(); await request(method, params);
    expect(requested()).toEqual([]);
    expect(responses()).toEqual([{ id: 'approval_1', error: { code: -32602, message: expect.any(String) } }]);
  });

  it('does not publish worker readiness when startup completes during a pending approval', async () => {
    start(); expect(session.sendAgentMessage([{ type: 'text', text: 'worker' }])).toBe(false);
    await initialize(); await thread(); started(); await request();
    fake.respond('turn/start', { turn: { id: 'turn_1', status: 'inProgress', items: [] } }); await flush();
    expect(requested()).toHaveLength(1); expect(readyHints).toBe(0);
    expect(session.sendAgentMessage([{ type: 'text', text: 'worker' }])).toBe(false);
  });
});
