import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from './agent-runner.ts';
import { OpencodeServerRunner, SERVE_START_RETRY_DELAY_MS } from './opencode-server-runner.ts';
import { sessionGroupOf } from './session-process.ts';

/** `override` sees the 1-based spawn count; returning undefined spawns for real. */
const spawnHook = vi.hoisted(() => ({ calls: 0, override: null as null | ((call: number) => unknown) }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      spawnHook.calls += 1;
      return spawnHook.override?.(spawnHook.calls) ?? actual.spawn(...args);
    },
  };
});

const mockBin = fileURLToPath(new URL('../../scripts/mock-opencode-serve.mjs', import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  spawnHook.override = null;
  spawnHook.calls = 0;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const waitFor = async (cond: () => boolean, ms = 10_000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, 10));
  }
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const RETRY_NOTE = /^opencode serve exited before listening \(code 1\); retrying once — Error: Unexpected error \(start 1\)$/;

/** Drive the real runner against the bundled mock, whose first `failStarts` starts exit before listening. */
function startAgainstMock(failStarts: number, timeoutMs = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'cez-opencode-serve-retry-'));
  dirs.push(dir);
  const counter = join(dir, 'serve-starts');
  const events: AgentEvent[] = [];
  const pids: number[] = [];
  const session = new OpencodeServerRunner({ bin: mockBin, timeoutMs: 0 }).startSession(
    {
      userPrompt: 'inspect the working tree',
      cwd: dir,
      timeoutMs,
      env: { CEZ_MOCK_OPENCODE_SERVE_FAIL_STARTS: String(failStarts), CEZ_MOCK_OPENCODE_SERVE_FAIL_FILE: counter },
    },
    event => events.push(event),
    { onPidChange: pid => pids.push(pid) },
  );
  const starts = () => (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0);
  return { session, events, pids, starts, firstPid: session.pid };
}

/** A fake `opencode serve` that never prints its URL and dies on any signal. */
function silentChild(): ChildProcessWithoutNullStreams {
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    killed: false,
    pid: 6262,
    kill: () => {
      Object.assign(child, { exitCode: 0, killed: true });
      emitter.emit('exit', 0, null);
      (child.stdout as PassThrough).end();
      (child.stderr as PassThrough).end();
      emitter.emit('close', 0, null);
      return true;
    },
  }) as unknown as ChildProcessWithoutNullStreams;
  return child;
}

/** A fake `opencode serve` that prints the 1.18.33 failure and exits 1 before listening. */
function earlyExitChild(): ChildProcessWithoutNullStreams {
  const child = silentChild();
  Object.assign(child, { pid: 6161 });
  setImmediate(() => {
    (child.stderr as PassThrough).write('Error: Unexpected error\nServeError\n');
    Object.assign(child, { exitCode: 1 });
    child.emit('exit', 1, null);
    (child.stdout as PassThrough).end();
    (child.stderr as PassThrough).end();
    child.emit('close', 1, null);
  });
  return child;
}

/** #872 — one retry for an `opencode serve` start that exits before listening. */
describe('opencode serve start retry (#872)', { timeout: 20_000 }, () => {
  it('retries a server that exited before listening once, on a new process, and completes the turn', async () => {
    const { session, events, pids, starts, firstPid } = startAgainstMock(1);
    await waitFor(() => events.some(e => e.type === 'turn-end' || e.type === 'error'));

    expect(starts()).toBe(2);
    expect(events.filter(e => e.type === 'error')).toEqual([]);
    const notes = events.filter((e): e is Extract<AgentEvent, { type: 'note' }> => e.type === 'note');
    expect(notes.filter(n => /retrying once/.test(n.message))).toHaveLength(1);
    expect(notes.find(n => /retrying once/.test(n.message))!.message).toMatch(RETRY_NOTE);
    // The caller that registered the first pid hears about the replacement.
    expect(pids).toHaveLength(1);
    expect(pids[0]).not.toBe(firstPid);
    expect(session.pid).toBe(pids[0]);
    // hearsay-tools/cezarion#890: the replacement leads its own process group too.
    if (process.platform !== 'win32') expect(sessionGroupOf(session.pid!)).toBe(session.pid);
    expect(events.filter(e => e.type === 'turn-end')).toHaveLength(1);
    expect(events.some(e => e.type === 'text')).toBe(true);

    session.end();
    const result = await session.result;
    expect(result.text).not.toBe('');
    expect(events.filter(e => e.type === 'error')).toEqual([]);
    expect(events.filter(e => e.type === 'done')).toHaveLength(1);
  });

  it('fails with one error naming both attempts when the retry also exits before listening', async () => {
    const { session, events, pids, starts } = startAgainstMock(2);
    await session.result;

    expect(starts()).toBe(2);
    expect(pids).toHaveLength(1);
    const errors = events.filter(e => e.type === 'error');
    expect(errors).toEqual([{
      type: 'error',
      message: 'opencode serve exited before listening on both attempts — '
        + 'attempt 1: code 1 — Error: Unexpected error (start 1); '
        + 'attempt 2: code 1 — Error: Unexpected error (start 2)',
    }]);
    const stderrNote = events.find(e => e.type === 'note' && e.message.startsWith('opencode serve stderr'));
    expect(stderrNote).toEqual({
      type: 'note',
      message: 'opencode serve stderr (attempt 1):\nError: Unexpected error (start 1)\nServeError\n'
        + '\nopencode serve stderr (attempt 2):\nError: Unexpected error (start 2)\nServeError\n',
    });
    expect(events.some(e => e.type === 'turn-end' || e.type === 'text')).toBe(false);
    // The error is the last word before done: no second error rides behind it.
    expect(events.map(e => e.type).slice(-2)).toEqual(['error', 'done']);
  });

  it('does not retry a server that never prints its URL; the start timeout keeps its port fallback', async () => {
    spawnHook.override = () => silentChild();
    const events: AgentEvent[] = [];
    const pids: number[] = [];
    const session = new OpencodeServerRunner({ bin: 'opencode', timeoutMs: 0, serverStartTimeoutMs: 50 }).startSession(
      { userPrompt: 'go', cwd: process.cwd() },
      event => events.push(event),
      { onPidChange: pid => pids.push(pid) },
    );
    await session.result.catch(() => undefined);
    // Past the point a retry would have spawned.
    await sleep(SERVE_START_RETRY_DELAY_MS + 200);

    expect(spawnHook.calls).toBe(1);
    expect(pids).toEqual([]);
    expect(events.some(e => e.type === 'note' && /retrying once/.test(e.message))).toBe(false);
    expect(events.some(e => e.type === 'error' && /before (it started )?listening/.test(e.message))).toBe(false);
  });

  it('does not blame both attempts when the retry hangs instead of exiting early', async () => {
    // Start 1 exits early; start 2 never prints a URL, so the 50 ms start timeout
    // falls back to a port nothing listens on.
    spawnHook.override = call => (call === 1 ? earlyExitChild() : silentChild());
    const events: AgentEvent[] = [];
    const pids: number[] = [];
    const session = new OpencodeServerRunner({ bin: 'opencode', timeoutMs: 0, serverStartTimeoutMs: 50 }).startSession(
      { userPrompt: 'go', cwd: process.cwd() },
      event => events.push(event),
      { onPidChange: pid => pids.push(pid) },
    );
    await session.result;

    expect(spawnHook.calls).toBe(2);
    expect(pids).toEqual([6262]);
    const errors = events.filter((e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error');
    expect(errors).toHaveLength(1);
    // The fallback port answered nothing: that is the reported failure, not a second early exit.
    expect(errors[0]!.message).toMatch(/^opencode: /);
    expect(errors[0]!.message).not.toMatch(/both attempts/);
  });

  it('names the retry spawn failure instead of only the first early exit when the retry cannot start', async () => {
    // EAGAIN/EMFILE-style: `spawn` throws synchronously, so no second process exists.
    spawnHook.override = call => {
      if (call === 1) return earlyExitChild();
      throw Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' });
    };
    const events: AgentEvent[] = [];
    const pids: number[] = [];
    const session = new OpencodeServerRunner({ bin: 'opencode', timeoutMs: 0 }).startSession(
      { userPrompt: 'go', cwd: process.cwd() },
      event => events.push(event),
      { onPidChange: pid => pids.push(pid) },
    );
    await session.result;

    expect(spawnHook.calls).toBe(2);
    expect(pids).toEqual([]);
    const errors = events.filter((e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/^opencode serve exited before listening \(code 1 — Error: Unexpected error\) and its retry could not start: /);
    expect(errors[0]!.message).toMatch(/EAGAIN/);
  });

  it('spawns no second server when the session is interrupted during the retry pause', async () => {
    const { session, events, pids, starts } = startAgainstMock(1);
    await waitFor(() => events.some(e => e.type === 'note' && /retrying once/.test(e.message)));
    session.interrupt();
    await session.result;
    await sleep(SERVE_START_RETRY_DELAY_MS + 300);

    expect(starts()).toBe(1);
    expect(pids).toEqual([]);
    // The first start's failure stays the one reported error, as before #872.
    expect(events.filter(e => e.type === 'error')).toEqual([
      { type: 'error', message: 'opencode serve exited with code 1 — Error: Unexpected error (start 1)' },
    ]);
    expect(events.some(e => e.type === 'turn-end')).toBe(false);
  });

  it('spawns no second server when the session is ended during the retry pause', async () => {
    const { session, events, pids, starts } = startAgainstMock(1);
    await waitFor(() => events.some(e => e.type === 'note' && /retrying once/.test(e.message)));
    session.end();
    await session.result;
    await sleep(SERVE_START_RETRY_DELAY_MS + 300);

    expect(starts()).toBe(1);
    expect(pids).toEqual([]);
    expect(events.filter(e => e.type === 'error')).toHaveLength(1);
  });

  it('spawns no second server once the run deadline fired, and reports only the timeout', async () => {
    // Lands inside the pause on a normal machine; on a loaded one the deadline's
    // interrupt stops the first start instead, possibly before it counted itself.
    // Either way nothing may spawn after it.
    const { session, events, pids, starts } = startAgainstMock(1, 700);
    await session.result;
    await sleep(SERVE_START_RETRY_DELAY_MS + 300);

    expect(spawnHook.calls).toBe(1);
    expect(starts()).toBeLessThanOrEqual(1);
    expect(pids).toEqual([]);
    expect(events.filter(e => e.type === 'error')).toEqual([
      { type: 'error', message: expect.stringMatching(/^opencode timed out after /) },
    ]);
  });
});
