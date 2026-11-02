import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  KILL_GRACE_MS,
  discoverPiModels,
  parsePiEffortLevels,
  parsePiModels,
  spawnPi,
} from './pi-model-catalog.ts';

/**
 * A stand-in for the `pi --list-models` child: write its stdout, then close with a code.
 *
 * Mirrors Node's actual signal semantics — `kill()` records the signal and sets `killed = true`
 * on *delivery*, while the child stays alive until something makes it exit.
 */
function fakeChild(): {
  child: ChildProcessWithoutNullStreams;
  say(text: string): void;
  close(code: number): void;
  exit(code: number): void;
  signals: NodeJS.Signals[];
  killed(): boolean;
  input(): string;
} {
  const process = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const signals: NodeJS.Signals[] = [];
  const exit = (code: number) => {
    Object.assign(process, { exitCode: code });
    process.emit('exit', code, null);
  };
  Object.assign(process, {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    killed: false,
    kill: (signal: NodeJS.Signals = 'SIGTERM') => {
      signals.push(signal);
      Object.assign(process, { killed: true });
      return true;
    },
    pid: 321,
  });
  return {
    child: process as unknown as ChildProcessWithoutNullStreams,
    say: (text: string) => stdout.write(text),
    close(code: number) {
      exit(code);
      stdout.end();
      queueMicrotask(() => process.emit('close', code));
    },
    exit,
    signals,
    killed: () => signals.length > 0,
    input() {
      // Node 26 returns one buffered chunk per read; Node 24 coalesces them.
      // Drain every write so assertions inspect the complete RPC transcript.
      let input = '';
      for (let chunk = stdin.read(); chunk !== null; chunk = stdin.read()) {
        input += chunk.toString();
      }
      return input;
    },
  };
}

/** Run discovery against a scripted child; `script` drives it once stdout is wired up. */
function discover(
  script: (fake: ReturnType<typeof fakeChild>) => void,
  options: { timeoutMs?: number } = {},
): Promise<Array<{ id: string; label: string; description: string }>> {
  const base = fakeChild();
  let calls = 0;
  const promise = discoverPiModels({
    cwd: '/repo',
    spawn: () => {
      calls += 1;
      if (calls === 1) return base.child;
      const rpc = fakeChild();
      queueMicrotask(() => rpc.close(1));
      return rpc.child;
    },
    ...options,
  });
  queueMicrotask(() => script(base));
  return promise;
}

const TABLE = [
  'provider      model                context  max-out  thinking  images',
  'llama-home    qwen3.8-27b-q4_k_m   131.1K   16.4K    yes       no    ',
  'openai-codex  gpt-5.4              272K     128K     yes       yes   ',
  'xai           grok-4.6             500K     500K     yes       yes   ',
].join('\n');

const BASE_MODELS = [
  { id: 'llama-home/qwen3.8-27b-q4_k_m', label: 'qwen3.8-27b-q4_k_m', description: 'via llama-home' },
  { id: 'openai-codex/gpt-5.4', label: 'gpt-5.4', description: 'via openai-codex' },
  { id: 'xai/grok-4.6', label: 'grok-4.6', description: 'via xai' },
];

function discoverWithRpc(
  script: (rpc: ReturnType<typeof fakeChild>) => void,
  timeoutMs = 50,
) {
  const base = fakeChild();
  const rpc = fakeChild();
  let spawns = 0;
  const promise = discoverPiModels({
    cwd: '/repo',
    timeoutMs,
    spawn: () => {
      spawns += 1;
      if (spawns === 2) queueMicrotask(() => script(rpc));
      return spawns === 1 ? base.child : rpc.child;
    },
  });
  queueMicrotask(() => {
    base.say(`${TABLE}\n`);
    base.close(0);
  });
  return { promise, rpc };
}

describe('parsePiModels', () => {
  it('skips the header row and returns provider/model ids from the table', () => {
    expect(parsePiModels(TABLE)).toEqual([
      { id: 'llama-home/qwen3.8-27b-q4_k_m', label: 'qwen3.8-27b-q4_k_m', description: 'via llama-home' },
      { id: 'openai-codex/gpt-5.4', label: 'gpt-5.4', description: 'via openai-codex' },
      { id: 'xai/grok-4.6', label: 'grok-4.6', description: 'via xai' },
    ]);
  });

  it('reads a colorized table', () => {
    expect(
      parsePiModels(
        '\u001B[1mprovider\u001B[0m      \u001B[1mmodel\u001B[0m\n\u001B[32mxai\u001B[0m           \u001B[32mgrok-4.6\u001B[0m\n',
      ),
    ).toEqual([{ id: 'xai/grok-4.6', label: 'grok-4.6', description: 'via xai' }]);
  });

  it('drops duplicate rows, keeping the first', () => {
    expect(
      parsePiModels(
        [
          'provider      model',
          'xai           grok-4.6',
          'openai-codex  gpt-5.4',
          'xai           grok-4.6',
        ].join('\n'),
      ),
    ).toEqual([
      { id: 'xai/grok-4.6', label: 'grok-4.6', description: 'via xai' },
      { id: 'openai-codex/gpt-5.4', label: 'gpt-5.4', description: 'via openai-codex' },
    ]);
  });

  it('refuses a listing with no provider/model header', () => {
    expect(() => parsePiModels('No models configured.\n')).toThrow('unrecognized output');
  });

  it('refuses a listing longer than the size cap', () => {
    const rows = Array.from({ length: 501 }, (_, i) => `openai  gpt-${i}`).join('\n');
    expect(() => parsePiModels(`provider  model\n${rows}`)).toThrow('size limit');
  });
});

describe('parsePiEffortLevels', () => {
  it('keeps recognized levels only after the matching model switch succeeds', () => {
    const output = [
      { id: 'set:0', type: 'response', command: 'set_model', success: true, data: {} },
      {
        id: 'levels:0',
        type: 'response',
        command: 'get_available_thinking_levels',
        success: true,
        data: { levels: ['off', 'minimal', 'low', 'high', 'max', 'future', 'high'] },
      },
      { id: 'set:1', type: 'response', command: 'set_model', success: false, error: 'missing' },
      {
        id: 'levels:1',
        type: 'response',
        command: 'get_available_thinking_levels',
        success: true,
        data: { levels: ['low', 'medium'] },
      },
      { id: 'set:2', type: 'response', command: 'set_model', success: true, data: {} },
      { id: 'levels:2', type: 'response', command: 'get_available_thinking_levels', success: true, data: { levels: [] } },
      'not-json',
    ].map((record) => typeof record === 'string' ? record : JSON.stringify(record)).join('\n');

    expect([...parsePiEffortLevels(output, 3)]).toEqual([[0, ['low', 'high', 'max']]]);
  });
});

describe('discoverPiModels', () => {
  it('leaves stdin open for the caller that owns list or RPC input', () => {
    const fake = fakeChild();
    spawnPi('pi', ['--mode', 'rpc'], '/repo', () => fake.child);
    expect(fake.child.stdin.writableEnded).toBe(false);
  });

  it('enriches each listed model through one RPC child without changing model order', async () => {
    const base = fakeChild();
    const rpc = fakeChild();
    const spawned: Array<{ args: readonly string[]; child: ReturnType<typeof fakeChild> }> = [];
    const promise = discoverPiModels({
      cwd: '/repo',
      spawn: (_bin, args) => {
        const child = spawned.length === 0 ? base : rpc;
        spawned.push({ args, child });
        if (spawned.length === 2) {
          queueMicrotask(() => {
            rpc.say([
              JSON.stringify({ id: 'set:0', type: 'response', command: 'set_model', success: true, data: {} }),
              JSON.stringify({ id: 'levels:0', type: 'response', command: 'get_available_thinking_levels', success: true, data: { levels: ['low', 'medium', 'high', 'xhigh'] } }),
              JSON.stringify({ id: 'set:1', type: 'response', command: 'set_model', success: false, error: 'missing' }),
              JSON.stringify({ id: 'levels:1', type: 'response', command: 'get_available_thinking_levels', success: true, data: { levels: ['max'] } }),
              JSON.stringify({ id: 'set:2', type: 'response', command: 'set_model', success: true, data: {} }),
              JSON.stringify({ id: 'levels:2', type: 'response', command: 'get_available_thinking_levels', success: true, data: { levels: ['low', 'high', 'max'] } }),
            ].join('\n'));
            rpc.close(0);
          });
        }
        return child.child;
      },
    });
    queueMicrotask(() => {
      base.say(`${TABLE}\n`);
      base.close(0);
    });

    await expect(promise).resolves.toEqual([
      {
        id: 'llama-home/qwen3.8-27b-q4_k_m',
        label: 'qwen3.8-27b-q4_k_m',
        description: 'via llama-home',
        effortLevels: ['low', 'medium', 'high', 'xhigh'],
      },
      { id: 'openai-codex/gpt-5.4', label: 'gpt-5.4', description: 'via openai-codex' },
      {
        id: 'xai/grok-4.6',
        label: 'grok-4.6',
        description: 'via xai',
        effortLevels: ['low', 'high', 'max'],
      },
    ]);
    expect(spawned.map(({ args }) => args)).toEqual([
      ['--list-models'],
      ['--mode', 'rpc', '--no-session', '--no-tools', '--no-skills', '--no-prompt-templates'],
    ]);
    const commands = rpc.input().trim().split('\n').map((line: string) => JSON.parse(line));
    expect(commands).toEqual([
      { id: 'set:0', type: 'set_model', provider: 'llama-home', modelId: 'qwen3.8-27b-q4_k_m' },
      { id: 'levels:0', type: 'get_available_thinking_levels' },
      { id: 'set:1', type: 'set_model', provider: 'openai-codex', modelId: 'gpt-5.4' },
      { id: 'levels:1', type: 'get_available_thinking_levels' },
      { id: 'set:2', type: 'set_model', provider: 'xai', modelId: 'grok-4.6' },
      { id: 'levels:2', type: 'get_available_thinking_levels' },
    ]);
  });

  it('degrades an asynchronous RPC stdin error to the intact base list', async () => {
    const { promise, rpc } = discoverWithRpc((child) => {
      child.child.stdin.emit('error', new Error('EPIPE'));
    });
    await expect(promise).resolves.toEqual(BASE_MODELS);
    expect(rpc.killed()).toBe(true);
  });

  it('bounds a stalled RPC child and escalates teardown without losing base models', async () => {
    vi.useFakeTimers();
    try {
      const { promise, rpc } = discoverWithRpc(() => {}, 5);
      await vi.advanceTimersByTimeAsync(5);
      await expect(promise).resolves.toEqual(BASE_MODELS);
      expect(rpc.signals).toEqual(['SIGTERM']);
      await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
      expect(rpc.signals).toEqual(['SIGTERM', 'SIGKILL']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds RPC stdout without losing base models', async () => {
    const { promise, rpc } = discoverWithRpc((child) => {
      child.say('x'.repeat(512 * 1_024 + 1));
    });
    await expect(promise).resolves.toEqual(BASE_MODELS);
    expect(rpc.killed()).toBe(true);
  });

  it('lists what the host CLI printed when RPC enrichment fails', async () => {
    await expect(
      discover((fake) => {
        fake.say(`${TABLE}\n`);
        fake.close(0);
      }),
    ).resolves.toEqual([
      { id: 'llama-home/qwen3.8-27b-q4_k_m', label: 'qwen3.8-27b-q4_k_m', description: 'via llama-home' },
      { id: 'openai-codex/gpt-5.4', label: 'gpt-5.4', description: 'via openai-codex' },
      { id: 'xai/grok-4.6', label: 'grok-4.6', description: 'via xai' },
    ]);
  });

  it('uses the runner binary override for the table and RPC probes', async () => {
    const base = fakeChild();
    const rpc = fakeChild();
    const spawned: Array<{ bin: string; args: readonly string[]; cwd: string }> = [];
    const promise = discoverPiModels({
      cwd: '/repo',
      bin: '/opt/pi',
      spawn: (bin, args, cwd) => {
        spawned.push({ bin, args, cwd });
        if (spawned.length === 2) queueMicrotask(() => rpc.close(1));
        return spawned.length === 1 ? base.child : rpc.child;
      },
    });
    queueMicrotask(() => {
      base.say(`${TABLE}\n`);
      base.close(0);
    });
    await promise;
    expect(spawned).toEqual([
      { bin: '/opt/pi', args: ['--list-models'], cwd: '/repo' },
      {
        bin: '/opt/pi',
        args: ['--mode', 'rpc', '--no-session', '--no-tools', '--no-skills', '--no-prompt-templates'],
        cwd: '/repo',
      },
    ]);
  });

  it('does not spawn the host CLI under CEZ_DRY_RUN=1', async () => {
    const savedDry = process.env.CEZ_DRY_RUN;
    const savedBin = process.env.CEZ_PI_BIN;
    process.env.CEZ_DRY_RUN = '1';
    delete process.env.CEZ_PI_BIN;
    try {
      const spawn = vi.fn();
      await expect(discoverPiModels({ cwd: '/repo', spawn })).resolves.toEqual([]);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      if (savedDry === undefined) delete process.env.CEZ_DRY_RUN;
      else process.env.CEZ_DRY_RUN = savedDry;
      if (savedBin === undefined) delete process.env.CEZ_PI_BIN;
      else process.env.CEZ_PI_BIN = savedBin;
    }
  });

  it('fails when the CLI exits non-zero', async () => {
    await expect(
      discover((fake) => {
        fake.close(1);
      }),
    ).rejects.toThrow('exited (1)');
  });

  it('fails and kills the child when discovery outruns its deadline', async () => {
    const fake = fakeChild();
    const promise = discoverPiModels({ cwd: '/repo', timeoutMs: 5, spawn: () => fake.child });
    await expect(promise).rejects.toThrow('timed out');
    expect(fake.killed()).toBe(true);
  });

  it('escalates to SIGKILL when the probe survives the teardown SIGTERM', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeChild();
      const rejected = expect(
        discoverPiModels({ cwd: '/repo', timeoutMs: 5, spawn: () => fake.child }),
      ).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(5);
      await rejected;

      expect(fake.signals).toEqual(['SIGTERM']);
      expect(fake.child.killed).toBe(true);
      expect(fake.child.exitCode).toBeNull();

      await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails when the child floods stdout', async () => {
    await expect(
      discover((fake) => {
        fake.say(`${'xai  grok-4.6\n'.repeat(60_000)}`);
      }),
    ).rejects.toThrow('output limit');
  });
});
