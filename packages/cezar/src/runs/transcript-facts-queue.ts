import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from 'node:worker_threads';
import { loadTranscriptFacts, type FactsLoadResult } from './transcript-facts-load.ts';
import type { FactsJobMessage, FactsJobReply } from './transcript-facts-worker.ts';

export const REFRESH_FACTS = Symbol('transcript changed');
const JOB_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
interface Job<T> {
  runId: string;
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  attempts: number;
  value?: T;
  error?: Error;
  port?: MessagePort;
  signal?: Int32Array;
  timer?: NodeJS.Timeout;
}

/** One owner per run, one active worker load. Both receive paths settle the same job. */
export class TranscriptFactsQueue<T> {
  private readonly jobs = new Map<string, Job<T>>();
  private pending: Job<T>[] = [];
  private active?: Job<T>;
  private worker?: Worker;
  private dispatch?: NodeJS.Immediate;
  private stopped = false;

  constructor(
    private readonly dataDir: string,
    private readonly accept: (runId: string, loaded: FactsLoadResult | undefined, serialized?: string) => T | typeof REFRESH_FACTS,
    private readonly cached?: (runId: string) => T | undefined,
  ) {}

  has(runId: string): boolean { return this.jobs.has(runId); }

  request(runId: string, demand = true): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('Transcript facts queue stopped'));
    let job = this.jobs.get(runId);
    if (!job) {
      let resolve!: (value: T) => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
      job = { runId, promise, resolve, reject, attempts: 0 };
      // Synchronous callers may take ownership without ever observing this promise.
      void promise.catch(() => undefined);
      this.jobs.set(runId, job);
      this.pending.push(job);
    }
    if (demand && job !== this.active) {
      this.pending = [job, ...this.pending.filter((item) => item !== job)];
    }
    this.schedule();
    return job.promise;
  }

  /** Exceptional compatibility path: take a queued job, but NEVER refold an active one. */
  join(runId: string): T {
    if (this.stopped) throw new Error('Transcript facts queue stopped');
    void this.request(runId);
    const job = this.jobs.get(runId)!;
    if (job !== this.active) {
      this.pending = this.pending.filter((item) => item !== job);
      this.complete(job, { result: loadTranscriptFacts(this.dataDir, runId) });
    }
    const deadline = Date.now() + JOB_TIMEOUT_MS;
    while (this.jobs.get(runId) === job) {
      if (!this.active) this.start(job);
      if (this.jobs.get(runId) !== job) break;
      const active = this.active!;
      const remaining = deadline - Date.now();
      if (remaining <= 0 || Atomics.wait(active.signal!, 0, 0, remaining) === 'timed-out') {
        this.fail(new Error(`Transcript facts worker timed out for ${runId}`));
        break;
      }
      const received = receiveMessageOnPort(active.port!);
      if (!received) {
        this.fail(new Error(`Transcript facts worker published no result for ${runId}`));
        break;
      }
      this.complete(active, received.message as FactsJobReply);
    }
    if (job.error) throw job.error;
    return job.value as T;
  }

  forget(runId: string): void {
    const job = this.jobs.get(runId);
    if (!job) return;
    if (job === this.active) this.disposeWorker();
    this.settle(job, new Error(`Transcript facts cancelled for ${runId}`));
  }

  stop(): void {
    this.stopped = true;
    this.fail(new Error('Transcript facts queue stopped'));
  }

  private schedule(): void {
    if (this.stopped || this.dispatch) return;
    // Yield even for cached sidecars, and let synchronous callers take pending ownership.
    this.dispatch = setImmediate(() => {
      this.dispatch = undefined;
      if (this.active) return;
      const next = this.pending[0];
      if (next) this.start(next);
      else this.disposeWorker();
    });
  }

  private createWorker(): Worker {
    const source = import.meta.url.endsWith('.ts');
    const entry = new URL(`./transcript-facts-worker.${source ? 'ts' : 'js'}`, import.meta.url);
    // --import tsx inherited from the parent does not register TS inside a Worker reliably.
    // Register in the worker itself; never inherit Vitest/debugger flags.
    const url = source ? new URL(`data:text/javascript,${encodeURIComponent(
      `import { register } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}; register(); await import(${JSON.stringify(entry.href)});`,
    )}`) : entry;
    const worker = new Worker(url, { execArgv: [] });
    worker.on('error', (error) => { if (this.worker === worker) this.fail(error); });
    worker.on('exit', (code) => {
      if (this.worker === worker) this.fail(new Error(`Transcript facts worker exited (${code})`));
    });
    return worker;
  }

  private start(job: Job<T>): void {
    this.pending = this.pending.filter((item) => item !== job);
    this.active = job;
    job.attempts++;
    try {
      const cached = this.cached?.(job.runId);
      if (cached !== undefined) { this.settle(job, undefined, cached); return; }
      this.worker ??= this.createWorker();
      const { port1, port2 } = new MessageChannel();
      job.port = port1;
      job.signal = new Int32Array(new SharedArrayBuffer(4));
      port1.once('message', (reply: FactsJobReply) => this.complete(job, reply));
      job.timer = setTimeout(() => this.fail(new Error(`Transcript facts worker timed out for ${job.runId}`)), JOB_TIMEOUT_MS);
      const message: FactsJobMessage = { dataDir: this.dataDir, runId: job.runId, port: port2, signal: job.signal.buffer as SharedArrayBuffer };
      try { this.worker.postMessage(message, [port2]); } catch (error) { port2.close(); throw error; }
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }

  private complete(job: Job<T>, reply: FactsJobReply): void {
    if (this.jobs.get(job.runId) !== job) return;
    if ('error' in reply) { this.fail(new Error(reply.error)); return; }
    try {
      const value = this.accept(job.runId, reply.result, reply.serialized);
      if (value === REFRESH_FACTS) {
        this.release(job);
        if (job.attempts >= MAX_ATTEMPTS) {
          this.settle(job, new Error(`Transcript keeps changing for ${job.runId}`));
        } else {
          this.pending.unshift(job);
          this.schedule();
        }
      } else this.settle(job, undefined, value);
    } catch (error) { this.settle(job, error instanceof Error ? error : new Error(String(error))); }
  }

  private release(job: Job<T>): void {
    clearTimeout(job.timer);
    job.port?.close();
    job.port = undefined;
    job.signal = undefined;
    if (this.active === job) this.active = undefined;
  }

  private settle(job: Job<T>, error?: Error, value?: T): void {
    this.release(job);
    this.jobs.delete(job.runId);
    this.pending = this.pending.filter((item) => item !== job);
    job.error = error;
    job.value = value;
    if (error) job.reject(error); else job.resolve(value as T);
    this.schedule();
  }

  private disposeWorker(): void {
    const worker = this.worker;
    this.worker = undefined;
    if (worker) void worker.terminate().catch(() => undefined);
  }

  private fail(error: Error): void {
    this.disposeWorker();
    if (this.dispatch) clearImmediate(this.dispatch);
    this.dispatch = undefined;
    for (const job of this.jobs.values()) this.settle(job, error);
  }
}
