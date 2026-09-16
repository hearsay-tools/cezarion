import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverCursorModels, parseCursorModels, resolveCursorExecutable, spawnCursor } from './cursor-model-catalog.ts';

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
    const result = discoverCursorModels({ cwd: '/repo', bin: '/cursor-agent', spawn });
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

  it('does not probe the host in dry-run mode without an explicit binary', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    vi.stubEnv('CEZ_CURSOR_BIN', undefined);
    const spawn = vi.fn();
    await expect(discoverCursorModels({ cwd: '/repo', spawn })).resolves.toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('uses the environment binary even in dry-run mode', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    vi.stubEnv('CEZ_CURSOR_BIN', '/custom-agent');
    const fake = fakeChild();
    const spawn = vi.fn(() => fake.child);
    const result = discoverCursorModels({ cwd: '/repo', spawn });
    fake.stdout.write(LIST);
    fake.close();
    await expect(result).resolves.toEqual(MODELS);
    expect(spawn).toHaveBeenCalledExactlyOnceWith('/custom-agent', ['--list-models'], '/repo');
  });

  it.each(['exit', 'error', 'stdin'])('rejects %s failure without including private output', async (kind) => {
    const fake = fakeChild();
    const result = discoverCursorModels({ cwd: '/repo', spawn: () => fake.child });
    fake.stderr.write('private output');
    if (kind === 'exit') fake.close(1);
    else if (kind === 'error') fake.child.emit('error', new Error('private output'));
    else fake.child.stdin.emit('error', new Error('private output'));
    await expect(result).rejects.toThrow(/^Cursor model discovery (child|stdin)/);
  });

  it('limits stdout and escalates a child that ignores SIGTERM', async () => {
    vi.useFakeTimers();
    const fake = fakeChild();
    const result = discoverCursorModels({ cwd: '/repo', spawn: () => fake.child });
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
    const result = discoverCursorModels({ cwd: '/repo', timeoutMs: 10, spawn: () => fake.child });
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
