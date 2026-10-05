import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KILL_GRACE_MS,
  discoverOmpModels,
  parseOmpModels,
  resolveOmpExecutable,
  spawnOmp,
} from './omp-model-catalog.ts';

// Trimmed from a recorded `omp models --json` (omp/18.4.11): the output is an OBJECT with a
// `models` array, and `thinking` is null or the model's own list of levels.
const RECORDED = JSON.stringify({
  models: [
    {
      provider: 'anthropic',
      kind: 'chat',
      id: 'claude-3-5-sonnet-20240620',
      selector: 'anthropic/claude-3-5-sonnet-20240620',
      name: 'Claude Sonnet 3.5',
      contextWindow: 200000,
      maxTokens: 8192,
      reasoning: false,
      thinking: null,
      input: ['text', 'image'],
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      pricingStatus: 'fixed',
    },
    {
      provider: 'anthropic',
      kind: 'chat',
      id: 'claude-fable-5-1',
      selector: 'anthropic/claude-fable-5-1',
      name: 'Claude Fable 5.1',
      contextWindow: 1000000,
      maxTokens: 128000,
      reasoning: true,
      thinking: ['low', 'medium', 'high', 'xhigh', 'max'],
      input: ['text', 'image'],
      cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
      pricingStatus: 'fixed',
    },
    {
      provider: 'anthropic',
      kind: 'chat',
      id: 'claude-haiku-4-5',
      selector: 'anthropic/claude-haiku-4-5',
      name: 'Claude Haiku 4.5',
      contextWindow: 200000,
      maxTokens: 64000,
      reasoning: true,
      thinking: ['minimal', 'low', 'medium', 'high', 'xhigh'],
      input: ['text', 'image'],
      cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
      pricingStatus: 'fixed',
    },
  ],
});

/** A stand-in for the `omp models --json` child, with Node's real signal semantics. */
function fakeChild() {
  const proc = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const signals: NodeJS.Signals[] = [];
  const exit = (code: number) => {
    Object.assign(proc, { exitCode: code });
    proc.emit('exit', code, null);
  };
  Object.assign(proc, {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    killed: false,
    kill: (signal: NodeJS.Signals = 'SIGTERM') => {
      signals.push(signal);
      Object.assign(proc, { killed: true });
      return true;
    },
    pid: 654,
  });
  return {
    child: proc as unknown as ChildProcessWithoutNullStreams,
    say: (text: string) => stdout.write(text),
    fail: (error: Error) => proc.emit('error', error),
    close(code: number) {
      exit(code);
      stdout.end();
      queueMicrotask(() => proc.emit('close', code));
    },
    signals,
  };
}

function discover(
  script: (fake: ReturnType<typeof fakeChild>) => void,
  options: { timeoutMs?: number } = {},
) {
  const fake = fakeChild();
  const spawn = vi.fn(() => fake.child);
  const promise = discoverOmpModels({ cwd: '/repo', bin: 'omp-test', spawn, ...options });
  queueMicrotask(() => script(fake));
  return { promise, spawn, fake };
}

describe('parseOmpModels', () => {
  it('parses the recorded omp models --json into provider/id options', () => {
    expect(parseOmpModels(RECORDED)).toEqual([
      { id: 'anthropic/claude-3-5-sonnet-20240620', label: 'Claude Sonnet 3.5', description: 'anthropic' },
      {
        id: 'anthropic/claude-fable-5-1',
        label: 'Claude Fable 5.1',
        description: 'anthropic',
        effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      {
        // `minimal` is OMP's own level, not a cezar EffortLevel: it is dropped, never remapped.
        id: 'anthropic/claude-haiku-4-5',
        label: 'Claude Haiku 4.5',
        description: 'anthropic',
        effortLevels: ['low', 'medium', 'high', 'xhigh'],
      },
    ]);
  });

  it('accepts a bare array too, and labels a nameless entry by its id', () => {
    expect(parseOmpModels(JSON.stringify([{ provider: 'xai', id: 'grok-4.6' }]))).toEqual([
      { id: 'xai/grok-4.6', label: 'grok-4.6', description: 'xai' },
    ]);
  });

  it('skips non-chat kinds, unreadable entries and duplicates', () => {
    const entries = [
      { provider: 'a', kind: 'embedding', id: 'embed-1' },
      { provider: 'a', kind: 'chat', id: 'one' },
      { provider: 'a', kind: 'chat', id: 'one' },
      { provider: 'a', id: 'two' },
      { provider: 'a' },
      null,
      'nope',
    ];
    expect(parseOmpModels(JSON.stringify({ models: entries })).map((m) => m.id)).toEqual(['a/one', 'a/two']);
  });

  it('omits effortLevels when the thinking list holds nothing cezar can pin', () => {
    const [model] = parseOmpModels(JSON.stringify({ models: [{ provider: 'a', id: 'x', thinking: ['minimal'] }] }));
    expect(model).toEqual({ id: 'a/x', label: 'x', description: 'a' });
  });

  // Ruling R19 (final review #2): OpenRouter alone lists 561 chat models on v18.4.11, so a cap
  // that throws made one common key turn the whole catalog `unavailable`. Volume never throws:
  // the first 2000 in OMP's own order are kept and the cut is logged once.
  it('keeps the first 2000 models in OMP order and logs the cut once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const models = Array.from({ length: 2_101 }, (_, i) => ({ provider: 'p', kind: 'chat', id: `m${i}` }));
      const parsed = parseOmpModels(JSON.stringify({ models }));
      expect(parsed).toHaveLength(2_000);
      expect(parsed[0]!.id).toBe('p/m0');
      expect(parsed.at(-1)!.id).toBe('p/m1999');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain('2000');
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps a 561-model OpenRouter-sized catalog whole, without a log line', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const models = Array.from({ length: 561 }, (_, i) => ({ provider: 'openrouter', kind: 'chat', id: `v/m${i}` }));
      expect(parseOmpModels(JSON.stringify({ models }))).toHaveLength(561);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    ['garbage', 'OMP model discovery returned malformed output'],
    ['', 'OMP model discovery returned malformed output'],
    ['{"models":"nope"}', 'OMP model discovery returned malformed output'],
    ['{"other":[]}', 'OMP model discovery returned malformed output'],
    ['42', 'OMP model discovery returned malformed output'],
    ['[]', 'OMP reported no models (run omp login)'],
    ['{"models":[]}', 'OMP reported no models (run omp login)'],
    ['{"models":[{"provider":"a","kind":"embedding","id":"e"}]}', 'OMP reported no models (run omp login)'],
  ])('%j throws %s', (stdout, message) => {
    expect(() => parseOmpModels(stdout)).toThrow(message);
  });
});

describe('discoverOmpModels', () => {
  const saved = { dry: process.env.CEZ_DRY_RUN, bin: process.env.CEZ_OMP_BIN };
  afterEach(() => {
    vi.useRealTimers();
    for (const [key, value] of [['CEZ_DRY_RUN', saved.dry], ['CEZ_OMP_BIN', saved.bin]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('runs `omp models --json` in the repo and returns the parsed options', async () => {
    const { promise, spawn } = discover((fake) => {
      fake.say(RECORDED);
      fake.close(0);
    });
    await expect(promise).resolves.toHaveLength(3);
    expect(spawn).toHaveBeenCalledWith('omp-test', ['models', '--json'], '/repo');
  });

  it('reports a missing binary as not installed', async () => {
    const { promise } = discover((fake) => fake.fail(Object.assign(new Error('spawn omp ENOENT'), { code: 'ENOENT' })));
    await expect(promise).rejects.toThrow('OMP CLI not installed');
  });

  it('reports a hung child as timed out and kills it', async () => {
    vi.useFakeTimers();
    const { promise, fake } = discover(() => undefined, { timeoutMs: 100 });
    const settled = expect(promise).rejects.toThrow('OMP model discovery timed out');
    await vi.advanceTimersByTimeAsync(100);
    await settled;
    expect(fake.signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
    expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('reports non-JSON output as malformed', async () => {
    const { promise } = discover((fake) => {
      fake.say('garbage');
      fake.close(0);
    });
    await expect(promise).rejects.toThrow('OMP model discovery returned malformed output');
  });

  it('reports an empty catalog as logged out', async () => {
    const { promise } = discover((fake) => {
      fake.say('{"models":[]}');
      fake.close(0);
    });
    await expect(promise).rejects.toThrow('OMP reported no models (run omp login)');
  });

  it('reports a failing exit and oversized output without echoing the child', async () => {
    await expect(
      discover((fake) => {
        fake.say('secret-looking stderr-free stdout');
        fake.close(3);
      }).promise,
    ).rejects.toThrow('OMP model discovery failed (exit 3)');
    const big = discover((fake) => fake.say('x'.repeat(2 * 1024 * 1024 + 1)));
    await expect(big.promise).rejects.toThrow('OMP model discovery returned malformed output');
    expect(big.fake.signals).toEqual(['SIGTERM']);
  });

  // Ruling R19: ~350 bytes per model on v18.4.11, so 1,500 models already pass the old 512 KiB
  // stdout cap. The 2 MiB cap admits the 2000-model cut with room to spare.
  it('reads a listing larger than 512 KiB', async () => {
    const models = Array.from({ length: 1_500 }, (_, i) => ({ provider: 'openrouter', kind: 'chat', id: `v/m${i}`, name: 'n'.repeat(380) }));
    const stdout = JSON.stringify({ models });
    expect(stdout.length).toBeGreaterThan(512 * 1024);
    const { promise } = discover((fake) => {
      fake.say(stdout);
      fake.close(0);
    });
    await expect(promise).resolves.toHaveLength(1_500);
  });

  it('returns [] under CEZ_DRY_RUN=1 without spawning', async () => {
    process.env.CEZ_DRY_RUN = '1';
    delete process.env.CEZ_OMP_BIN;
    const spawn = vi.fn();
    await expect(discoverOmpModels({ cwd: '/repo', spawn })).resolves.toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('still discovers under CEZ_DRY_RUN=1 when a binary is named explicitly', async () => {
    process.env.CEZ_DRY_RUN = '1';
    const { promise } = discover((fake) => {
      fake.say(RECORDED);
      fake.close(0);
    });
    await expect(promise).resolves.toHaveLength(3);
  });
});

describe('resolveOmpExecutable', () => {
  const saved = process.env.CEZ_OMP_BIN;
  afterEach(() => {
    if (saved === undefined) delete process.env.CEZ_OMP_BIN;
    else process.env.CEZ_OMP_BIN = saved;
  });

  it('prefers the argument, then CEZ_OMP_BIN, then omp on PATH', () => {
    process.env.CEZ_OMP_BIN = '/opt/omp';
    expect(resolveOmpExecutable('/x/omp')).toBe('/x/omp');
    expect(resolveOmpExecutable()).toBe('/opt/omp');
    delete process.env.CEZ_OMP_BIN;
    expect(resolveOmpExecutable()).toBe('omp');
  });
});

describe('spawnOmp', () => {
  it('spawns with the omp child env, never the full process env', () => {
    const spawnImpl = vi.fn(() => ({}) as ChildProcessWithoutNullStreams);
    spawnOmp('omp', ['models', '--json'], '/repo', spawnImpl);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [bin, args, options] = spawnImpl.mock.calls[0] as unknown as [
      string,
      string[],
      { cwd: string; env: NodeJS.ProcessEnv },
    ];
    expect([bin, args, options.cwd]).toEqual(['omp', ['models', '--json'], '/repo']);
    expect(options.env).not.toBe(process.env);
  });
});
