import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';

interface Frame { type: string; properties?: { info?: { role?: string }; part?: { type?: string }; error?: unknown } }
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function listening(child: ChildProcessWithoutNullStreams): Promise<string> {
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  // bound: mock startup hang guard; its listen announcement is the readiness signal.
  await vi.waitFor(() => expect(output).toMatch(/http:\/\/127\.0\.0\.1:\d+/), { timeout: 10_000 });
  return /http:\/\/127\.0\.0\.1:\d+/.exec(output)![0];
}

async function fixture(persistent = false) {
  const cwd = mkdtempSync(join(tmpdir(), 'opencode-dispatch-'));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('CEZ_') || key === 'OPENCODE_CONFIG_CONTENT') delete env[key];
  // Preserve coverage for the native mock process in the quality measurement.
  env.NODE_V8_COVERAGE = process.env.NODE_V8_COVERAGE;
  if (persistent) {
    const control = join(cwd, 'failure.json');
    writeFileSync(control, JSON.stringify({ mode: 'persistent', opening: 'fail-this', failure: 'provider' }));
    env.CEZ_MOCK_FAILURE_CONTROL = control;
  }
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../scripts/mock-opencode-serve.mjs', import.meta.url))], { cwd, env, stdio: 'pipe' });
  child.stderr.resume();
  const abort = new AbortController();
  cleanups.push(async () => {
    abort.abort();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.stdin.end();
      await exited;
    }
    rmSync(cwd, { recursive: true, force: true });
  });
  const url = await listening(child);
  const session = await (await fetch(`${url}/session`, { method: 'POST', body: '{}' })).json() as { id: string };
  const response = await fetch(`${url}/event`, { signal: abort.signal });
  const frames: Frame[] = [];
  const chunks: string[] = [];
  void consume(response, frames, chunks).catch(error => { if (!abort.signal.aborted) throw error; });
  return {
    frames, chunks, park: join(cwd, 'park'),
    async prompt(text: string) {
      const result = await fetch(`${url}/session/${session.id}/prompt_async`, { method: 'POST', body: JSON.stringify({ parts: [{ type: 'text', text }] }) });
      expect(result.status).toBe(200);
      await result.text();
    },
  };
}

async function consume(response: Response, frames: Frame[], chunks: string[]) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  for (;;) {
    const next = await reader.read();
    if (next.done) return;
    const text = decoder.decode(next.value, { stream: true });
    chunks.push(text);
    pending += text;
    let boundary: number;
    while ((boundary = pending.indexOf('\n\n')) >= 0) {
      const frame = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      if (frame.startsWith('data: ')) frames.push(JSON.parse(frame.slice(6)) as Frame);
    }
  }
}

async function idle(frames: Frame[]) {
  // bound: native session.idle is the completion signal, not the HTTP acknowledgement.
  await vi.waitFor(() => expect(frames.some(frame => frame.type === 'session.idle')).toBe(true), { timeout: 10_000 });
}

it.each([
  ['mock:autonomous mock:provider-error-early', false],
  ['mock:autonomous fail-this', true],
])('keeps native provider failure before the late shared script: %s', async (prompt, persistent) => {
  const f = await fixture(persistent);
  await f.prompt(prompt);
  await idle(f.frames);
  expect(f.frames.some(frame => frame.type === 'session.error')).toBe(true);
});

it('keeps the shared early child script before a persistent provider failure', async () => {
  const f = await fixture(true);
  // The first idle is the parent's park; cleanup ends the mock while its gate stays held.
  await f.prompt(`mock:subagent-after-park fail-this parity-release=${f.park}`);
  await idle(f.frames);
  expect(f.frames.some(frame => frame.properties?.part?.type === 'subtask')).toBe(true);
  expect(f.frames.some(frame => frame.type === 'session.error')).toBe(false);
});

it.each(['mock:approval', 'mock:ask', 'mock:provider-error-early'])(
  'delays the user echo before native dispatch for %s', async native => {
    const f = await fixture();
    const start = performance.now();
    await f.prompt(`mock:deferred-turn-start ${native}`);
    // bound: wait for the native handler's event, after the deferred start and user echo.
    await vi.waitFor(() => expect(f.frames.some(frame => ['permission.asked', 'session.error'].includes(frame.type) || frame.properties?.part?.type === 'tool')).toBe(true), { timeout: 10_000 });
    const user = f.frames.findIndex(frame => frame.properties?.info?.role === 'user');
    expect(user).toBeGreaterThanOrEqual(0);
    const handler = f.frames.findIndex(frame => ['permission.asked', 'session.error'].includes(frame.type) || frame.properties?.part?.type === 'tool');
    expect(user).toBeLessThan(handler);
    // Real time is required: the deferred timer runs in the mock subprocess.
    expect(performance.now() - start).toBeGreaterThanOrEqual(800);
    expect(f.frames[user + 1]?.properties?.part?.type).toBe('text');
  });

it('holds an ack-only silent nudge without publishing a user echo', async () => {
  const f = await fixture();
  await f.prompt('mock:silent-tail-no-reply');
  await idle(f.frames);
  const before = f.frames.length;
  await f.prompt('Your turn ended without a wait or done. Give the final message.');
  // bound: the native heartbeat proves the hold path has run, without a negative-time wait.
  await vi.waitFor(() => expect(f.chunks.join('')).toContain(': heartbeat'), { timeout: 10_000 });
  expect(f.frames.slice(before)).toEqual([]);
});
