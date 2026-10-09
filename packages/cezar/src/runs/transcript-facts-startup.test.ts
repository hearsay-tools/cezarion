import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { WorkerOptions } from 'node:worker_threads';
import { afterEach, expect, it, vi } from 'vitest';
import { historyPaths } from './history-file.ts';
import { TranscriptFactsIndex } from './transcript-facts.ts';

const startup = vi.hoisted(() => ({
  gate: undefined as Int32Array | undefined,
  entered: undefined as (() => void) | undefined,
  exited: undefined as ((code: number) => void) | undefined,
}));

// Hold a native worker before executing the unchanged production bootstrap.
// Immediate terminate() would kill it before imports can complete (phase 2).
vi.mock('node:worker_threads', async (importOriginal) => {
  const native = await importOriginal<typeof import('node:worker_threads')>();
  return { ...native, Worker: class extends native.Worker {
    constructor(url: string | URL, options?: WorkerOptions) {
      const gate = startup.gate;
      if (!gate) { super(url, options); return; }
      const bootstrap = decodeURIComponent(String(url).split('data:text/javascript,')[1]!);
      super(new URL(`data:text/javascript,${encodeURIComponent(`
        import { parentPort as controlPort, workerData as controlData } from 'node:worker_threads';
        const phase = new Int32Array(controlData.testStartup);
        Atomics.store(phase, 0, 1);
        controlPort.postMessage('test:initializing');
        Atomics.wait(phase, 1, 0);
        ${bootstrap}
        Atomics.store(phase, 0, 2);
      `)}`), { ...options, workerData: { ...options?.workerData, testStartup: gate.buffer } });
      const entered = startup.entered;
      const exited = startup.exited;
      this.on('message', (message) => { if (message === 'test:initializing') entered?.(); });
      this.once('exit', (code) => exited?.(code));
    }
  } };
});

afterEach(() => { startup.gate = undefined; vi.useRealTimers(); });

it.each(['stop', 'forget', 'timeout'] as const)('%s settles startup consumers without interrupting native imports', async (action) => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-facts-startup-'));
  mkdirSync(join(dir, 'runs'));
  for (const id of ['a', 'b']) writeFileSync(historyPaths(dir, id).plain, JSON.stringify({ seq: 1, type: 'conversation-message', projectionId: id }) + '\n');
  const gate = startup.gate = new Int32Array(new SharedArrayBuffer(8));
  const entered = new Promise<void>((resolve) => { startup.entered = resolve; });
  const exited = new Promise<number>((resolve) => { startup.exited = resolve; });
  const reader = new TranscriptFactsIndex(dir);
  if (action === 'timeout') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const consumers = Promise.allSettled([reader.ready('a'), reader.ready('a')]);
    await entered;
    expect(Atomics.load(gate, 0)).toBe(1);
    if (action === 'stop') reader.stop();
    else if (action === 'forget') reader.forget('a');
    else await vi.advanceTimersByTimeAsync(30_000);
    expect((await consumers).map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(existsSync(historyPaths(dir, 'a').facts)).toBe(false);
    vi.useRealTimers();
    startup.gate = undefined;
    Atomics.store(gate, 1, 1);
    Atomics.notify(gate, 1);
    await exited;
    expect(Atomics.load(gate, 0)).toBe(2);
    expect(existsSync(historyPaths(dir, 'a').facts)).toBe(false);
    expect(reader.peek('a')).toBeUndefined();
    if (action !== 'stop') expect((await reader.ready('b'))?.projectionIds).toEqual(['b']);
  } finally {
    Atomics.store(gate, 1, 1); Atomics.notify(gate, 1);
    reader.stop();
    await exited;
    rmSync(dir, { recursive: true, force: true });
  }
});

it('bounds cleanup of a cancelled initializer that never becomes ready', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-facts-startup-stalled-'));
  mkdirSync(join(dir, 'runs'));
  writeFileSync(historyPaths(dir, 'a').plain, JSON.stringify({ seq: 1, type: 'conversation-message', projectionId: 'a' }) + '\n');
  const gate = startup.gate = new Int32Array(new SharedArrayBuffer(8));
  const entered = new Promise<void>((resolve) => { startup.entered = resolve; });
  const exited = new Promise<number>((resolve) => { startup.exited = resolve; });
  const reader = new TranscriptFactsIndex(dir);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const consumers = Promise.allSettled([reader.ready('a')]);
    await entered;
    reader.stop();
    expect((await consumers)[0]?.status).toBe('rejected');
    await vi.advanceTimersByTimeAsync(30_000);
    // Deliberately never release the native startup barrier: the failsafe
    // must reap this worker rather than requiring initialization to finish.
    expect(await exited).toBe(1);
    expect(Atomics.load(gate, 0)).toBe(1);
    expect(existsSync(historyPaths(dir, 'a').facts)).toBe(false);
  } finally {
    vi.useRealTimers();
    Atomics.store(gate, 1, 1); Atomics.notify(gate, 1);
    reader.stop();
    await exited;
    rmSync(dir, { recursive: true, force: true });
  }
});

it('drains cancelled native startup before the parent process exits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-facts-startup-exit-'));
  mkdirSync(join(dir, 'runs'));
  const marker = join(dir, 'initialized');
  const script = join(dir, 'exit.mjs');
  const queueEntry = new URL('./transcript-facts-queue.ts', import.meta.url).href;
  const workerEntry = new URL('./transcript-facts-worker.ts', import.meta.url).href;
  const tsx = import.meta.resolve('tsx/esm/api');
  writeFileSync(script, `
    import { Worker } from 'node:worker_threads';
    import { register } from ${JSON.stringify(tsx)};
    register();
    const { TranscriptFactsQueue } = await import(${JSON.stringify(queueEntry)});
    const queue = new TranscriptFactsQueue(${JSON.stringify(dir)}, () => { throw new Error('cancelled job accepted'); });
    queue.createWorker = () => {
      const lifecycle = new Int32Array(new SharedArrayBuffer(8));
      queue.workerLifecycle = lifecycle;
      const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(${JSON.stringify(`
        import { parentPort } from 'node:worker_threads';
        import { writeFileSync } from 'node:fs';
        parentPort.postMessage('initializing');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        const { register } = await import(${JSON.stringify(tsx)});
        register();
        await import(${JSON.stringify(workerEntry)});
        writeFileSync(${JSON.stringify(marker)}, 'initialized');
      `)})), { execArgv: [], workerData: { lifecycle: lifecycle.buffer } });
      worker.on('error', error => { throw error; });
      worker.once('message', () => queue.stop());
      return worker;
    };
    const outcomes = await Promise.allSettled([queue.request('a')]);
    if (outcomes[0].status !== 'rejected') throw new Error('consumer did not reject');
    // No parent-side timer or keepalive: queue shutdown must drain its worker.
  `);
  try {
    await promisify(execFile)(process.execPath, [script], { timeout: 5000 });
    expect(existsSync(marker)).toBe(true);
    expect(existsSync(historyPaths(dir, 'a').facts)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
