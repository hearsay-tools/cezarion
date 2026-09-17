import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverCursorModels, discoverCursorVariantModels, parseCursorModels, resolveCursorExecutable, spawnCursor } from './cursor-model-catalog.ts';

// Shape observed from the installed `agent --list-models`, including its footer.
const LIST = '\u001B[1mAvailable models\u001B[0m\n\nauto - Auto (default)\ncomposer-2.5 - Composer 2.5\nclaude-opus-5-thinking-high - Claude Opus 5 1M Thinking\n\nTip: use --model <id> (or /model <id> in interactive mode) to switch.\n';
const MODELS = [
  { id: 'auto', label: 'Auto', description: 'Default model' },
  { id: 'composer-2.5', label: 'Composer 2.5', description: '' },
  { id: 'claude-opus-5-thinking-high', label: 'Claude Opus 5 1M Thinking', description: '' },
];

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null as number | null, signalCode: null, killed: false,
    kill: vi.fn((_signal: NodeJS.Signals) => { child.killed = true; return true; }),
  });
  return {
    child: child as unknown as ChildProcessWithoutNullStreams,
    kill: child.kill,
    stdout: child.stdout,
    stderr: child.stderr,
    close(code = 0) {
      child.exitCode = code;
      child.emit('exit', code, null);
      child.emit('close', code, null);
    },
  };
}

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('Cursor model listing', () => {
  it('preserves exact IDs, display labels and order without guessing effort metadata', () => {
    expect(parseCursorModels(LIST)).toEqual(MODELS);
  });

  it('keeps the first duplicate and meaningful parenthesized label text', () => {
    expect(parseCursorModels('Available models\nx - Model (NO ZDR)\nx - Duplicate\n')).toEqual([
      { id: 'x', label: 'Model (NO ZDR)', description: '' },
    ]);
  });

  it.each(['', 'Login required', 'Available models\nUnexpected output', 'Available models\nx - '])(
    'rejects unrecognized output %j', (output) => {
      expect(() => parseCursorModels(output)).toThrow('unrecognized output');
    },
  );

  it('allows a recognized empty list', () => {
    expect(parseCursorModels('Available models\n\n')).toEqual([]);
  });

  it('caps the number of distinct models', () => {
    const rows = Array.from({ length: 501 }, (_, i) => `model-${i} - Model ${i}`);
    expect(() => parseCursorModels(`Available models\n${rows.join('\n')}`)).toThrow('size limit');
  });
});

describe('Cursor discovery child', () => {
  it('runs only --list-models, closes stdin and collects the listing', async () => {
    const fake = fakeChild();
    const spawn = vi.fn(() => fake.child);
    const result = discoverCursorVariantModels({ cwd: '/repo', bin: '/cursor-agent', spawn });
    fake.stdout.write(LIST);
    fake.close();
    await expect(result).resolves.toEqual(MODELS);
    expect(spawn).toHaveBeenCalledExactlyOnceWith('/cursor-agent', ['--list-models'], '/repo');
    expect(fake.child.stdin.writableEnded).toBe(true);
    expect(fake.kill).not.toHaveBeenCalled();
  });

  it('honors binary overrides and the default agent executable', () => {
    vi.stubEnv('CEZ_CURSOR_BIN', undefined);
    expect(resolveCursorExecutable()).toBe('agent');
    vi.stubEnv('CEZ_CURSOR_BIN', '/custom-agent');
    expect(resolveCursorExecutable()).toBe('/custom-agent');
    expect(resolveCursorExecutable('/explicit')).toBe('/explicit');
  });

  it.each([discoverCursorModels, discoverCursorVariantModels])('does not probe the host in dry-run mode without an explicit binary (%s)', async discover => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    vi.stubEnv('CEZ_CURSOR_BIN', undefined);
    const spawn = vi.fn();
    await expect(discover({ cwd: '/repo', spawn })).resolves.toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('uses the environment binary even in dry-run mode', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    vi.stubEnv('CEZ_CURSOR_BIN', '/custom-agent');
    const fake = fakeChild();
    const spawn = vi.fn(() => fake.child);
    const result = discoverCursorVariantModels({ cwd: '/repo', spawn });
    fake.stdout.write(LIST);
    fake.close();
    await expect(result).resolves.toEqual(MODELS);
    expect(spawn).toHaveBeenCalledExactlyOnceWith('/custom-agent', ['--list-models'], '/repo');
  });

  it.each(['exit', 'error', 'stdin'])('rejects %s failure without including private output', async (kind) => {
    const fake = fakeChild();
    const result = discoverCursorVariantModels({ cwd: '/repo', spawn: () => fake.child });
    fake.stderr.write('private output');
    if (kind === 'exit') fake.close(1);
    else if (kind === 'error') fake.child.emit('error', new Error('private output'));
    else fake.child.stdin.emit('error', new Error('private output'));
    await expect(result).rejects.toThrow(/^Cursor model discovery (child|stdin)/);
  });

  it('limits stdout and escalates a child that ignores SIGTERM', async () => {
    vi.useFakeTimers();
    const fake = fakeChild();
    const result = discoverCursorVariantModels({ cwd: '/repo', spawn: () => fake.child });
    const rejection = expect(result).rejects.toThrow('output limit');
    fake.stdout.write('x'.repeat(512 * 1024 + 1));
    await rejection;
    expect(fake.kill.mock.calls).toEqual([['SIGTERM']]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fake.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
  });

  it('times out and stops escalation when the child exits during grace', async () => {
    vi.useFakeTimers();
    const fake = fakeChild();
    const result = discoverCursorVariantModels({ cwd: '/repo', timeoutMs: 10, spawn: () => fake.child });
    const rejection = expect(result).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10);
    await rejection;
    expect(fake.kill.mock.calls).toEqual([['SIGTERM']]);
    fake.close(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fake.kill.mock.calls).toEqual([['SIGTERM']]);
  });

  it('builds a filtered child environment for the cursor backend', () => {
    // Synthetic values only; never inspect the real host credentials.
    vi.stubEnv('CURSOR_API_KEY', 'test-cursor');
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-other');
    vi.stubEnv('CEZ_AGENT_ENV_FULL', undefined);
    vi.stubEnv('CEZ_ENV_PASSTHROUGH', undefined);
    const fake = fakeChild();
    const spawn = vi.fn((_bin: string, _args: string[], _opts: { cwd: string; env: NodeJS.ProcessEnv }) => fake.child);
    spawnCursor('agent', ['--list-models'], '/repo', spawn);
    const opts = spawn.mock.calls[0]?.[2] as { cwd: string; env: NodeJS.ProcessEnv } | undefined;
    expect(opts?.cwd).toBe('/repo');
    expect(opts?.env.CURSOR_API_KEY).toBe('test-cursor');
    expect(opts?.env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

function rpcReply(fake: ReturnType<typeof fakeChild>, id: number, result: unknown) {
  fake.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function startProbe() {
  const fake = fakeChild();
  const requests: { method: string; id: number; params: unknown }[] = [];
  fake.child.stdin.on('data', (chunk: Buffer) => requests.push(JSON.parse(chunk.toString())));
  const spawn = vi.fn(() => fake.child);
  const result = discoverCursorModels({ cwd: '/repo', bin: '/cursor', timeoutMs: 10, spawn });
  return { fake, requests, spawn, result };
}

describe('Cursor parameterized discovery', () => {
  it('negotiates the picker and reads advertised base IDs and exact effort values without sessions', async () => {
    const { fake, requests, spawn, result } = startProbe();
    rpcReply(fake, 1, { protocolVersion: 1, agentCapabilities: {} });
    rpcReply(fake, 2, { models: [
      { value: 'opaque[context=1m]', name: 'Opaque', configOptions: [
        { id: 'effort', type: 'select', options: ['low', 'medium', 'high', 'xhigh', 'max', 'minimal', 'extra-high', 'low'].map(value => ({ value, name: value })) },
      ] },
      { value: 'reasoner', name: 'Reasoner', configOptions: [
        { id: 'reasoning', type: 'select', options: [{ value: 'high', name: 'High' }] },
      ] },
      { value: 'gemini', name: 'Gemini', configOptions: [
        { id: 'reasoning_effort', type: 'select', options: [{ value: 'low', name: 'Low' }] },
      ] },
      { value: 'thinking-only', name: 'Thinking', configOptions: [
        { id: 'thinking', type: 'select', options: [{ value: 'high', name: 'High' }] },
      ] },
      { value: 'absent', name: 'Absent' },
    ] });
    await expect(result).resolves.toEqual([
      { id: 'opaque[context=1m]', label: 'Opaque', description: '', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'reasoner', label: 'Reasoner', description: '', effortLevels: ['high'] },
      { id: 'gemini', label: 'Gemini', description: '', effortLevels: ['low'] },
      { id: 'thinking-only', label: 'Thinking', description: '', effortLevels: [] },
      { id: 'absent', label: 'Absent', description: '', effortLevels: [] },
    ]);
    expect(spawn).toHaveBeenCalledExactlyOnceWith('/cursor', ['acp'], '/repo');
    expect(requests).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: { _meta: { parameterizedModelPicker: true } } } },
      { jsonrpc: '2.0', id: 2, method: 'cursor/list_available_models', params: {} },
    ]);
    expect(fake.child.stdin.writableEnded).toBe(true);
    expect(fake.kill).toHaveBeenCalledWith('SIGTERM');
    fake.close();
  });

  it('assembles split responses, ignores notifications and accepts an empty catalog without fallback', async () => {
    const { fake, spawn, result } = startProbe();
    fake.stdout.write('{"jsonrpc":"2.0","method":"status","params":{}}\n');
    fake.stdout.write('{"jsonrpc":"2.0","id":1,"result":');
    fake.stdout.write('{"protocolVersion":1}}\n');
    rpcReply(fake, 99, { unrelated: true });
    rpcReply(fake, 2, { models: [] });
    await expect(result).resolves.toEqual([]);
    expect(spawn).toHaveBeenCalledTimes(1);
    fake.close();
  });

  it.each([
    { models: [{ value: 'x', name: 'X', configOptions: 'invalid' }] },
    { models: Array.from({ length: 501 }, (_, i) => ({ value: String(i), name: String(i) })) },
    { models: [{ value: '', name: 'Empty' }] },
  ])('rejects malformed or oversized catalogs without inventing metadata', async catalog => {
    const { fake, result, spawn } = startProbe();
    rpcReply(fake, 1, { protocolVersion: 1 });
    rpcReply(fake, 2, catalog);
    await expect(result).rejects.toThrow('unrecognized models');
    expect(spawn).toHaveBeenCalledTimes(1);
    fake.close();
  });

  it('falls back to the variant list only when the extension is unsupported', async () => {
    const first = fakeChild();
    const legacy = fakeChild();
    const spawn = vi.fn().mockReturnValueOnce(first.child).mockReturnValueOnce(legacy.child);
    const result = discoverCursorModels({ cwd: '/repo', bin: '/cursor', spawn });
    rpcReply(first, 1, { protocolVersion: 1 });
    first.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'private diagnostics' } }) + '\n');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    legacy.stdout.write(LIST);
    legacy.close();
    first.close();
    await expect(result).resolves.toEqual(MODELS);
    expect(spawn.mock.calls[1]).toEqual(['/cursor', ['--list-models'], '/repo']);
  });

  it.each(['timeout', 'cap', 'close', 'malformed', 'error', 'stdin', 'rpc'])('bounds %s failures without fallback or raw diagnostics', async kind => {
    vi.useFakeTimers();
    const { fake, result, spawn } = startProbe();
    const rejected = expect(result).rejects.toThrow(/^Cursor model discovery /);
    if (kind === 'timeout') await vi.advanceTimersByTimeAsync(10);
    if (kind === 'cap') fake.stdout.write('x'.repeat(512 * 1024 + 1));
    if (kind === 'close') fake.close();
    if (kind === 'malformed') fake.stdout.write('private diagnostics\n');
    if (kind === 'error') fake.child.emit('error', new Error('private diagnostics'));
    if (kind === 'stdin') fake.child.stdin.emit('error', new Error('private diagnostics'));
    if (kind === 'rpc') fake.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'private diagnostics' } }) + '\n');
    await rejected;
    await expect(result).rejects.not.toThrow('private diagnostics');
    expect(spawn).toHaveBeenCalledTimes(1);
    if (kind !== 'close') {
      expect(fake.kill).toHaveBeenCalledWith('SIGTERM');
      await vi.advanceTimersByTimeAsync(2000);
      expect(fake.kill).toHaveBeenCalledWith('SIGKILL');
    }
    fake.close();
  });
});
