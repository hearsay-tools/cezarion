import fs, { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel, Worker, type MessagePort } from 'node:worker_threads';
import type { FactsLoadResult } from './transcript-facts-load.ts';
import type { FactsJobMessage, FactsJobReply } from './transcript-facts-worker.ts';
import { brotliCompressSync } from 'node:zlib';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TranscriptFactsIndex } from './transcript-facts.ts';
import { REFRESH_FACTS, TranscriptFactsQueue } from './transcript-facts-queue.ts';
import * as factsFold from './transcript-facts-fold.ts';
import { compressHistory, historyPaths } from './history-file.ts';
import { countTranscriptReads, restoreTranscriptReads } from './transcript-reads.testkit.ts';

let dir: string;
let indexes: TranscriptFactsIndex[];
let ports: MessagePort[] = [];
const index = () => { const value = new TranscriptFactsIndex(dir); indexes.push(value); return value; };
const event = (seq: number, projectionId: string) => ({ seq, ts: '2026-10-08T00:00:00Z', type: 'conversation-message', projectionId });
const line = (seq: number, id: string) => JSON.stringify(event(seq, id)) + '\n';
const seed = (id: string) => writeFileSync(historyPaths(dir, id).plain, line(1, id));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cez-facts-queue-')); mkdirSync(join(dir, 'runs')); indexes = []; });
afterEach(() => { for (const value of indexes) value.stop(); for (const port of ports) port.close(); ports = []; vi.useRealTimers(); vi.restoreAllMocks(); restoreTranscriptReads(); rmSync(dir, { recursive: true, force: true }); });

it.each(['plain', 'compressed'])('real source worker shares one %s load and preserves sidecar bytes', async (format) => {
  const paths = historyPaths(dir, 'a');
  const questions = [{ header: 'Pick', question: 'Which?', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }];
  const more = [
    { seq: 8, type: 'ask.requested', requestId: '選択', questions },
    { seq: 9, type: 'worker-question-routed', askSeq: 8, messageId: 'route' },
    { seq: 10, type: 'worker-question-fallback', askSeq: 8 },
    { seq: 11, type: 'worker-outcome', waitId: 'wait', outcome: { workerId: 'worker', revision: 2 } },
  ];
  const text = line(1, 'π') + '{broken\n' + line(7, '尾') + more.map((value) => JSON.stringify(value) + '\n').join('');
  writeFileSync(format === 'plain' ? paths.plain : paths.compressed, format === 'plain' ? text : brotliCompressSync(Buffer.from(text)));
  index().get('a');
  const expected = readFileSync(paths.facts, 'utf8');
  rmSync(paths.facts);
  const dispatch = vi.spyOn(Worker.prototype, 'postMessage');
  const reads = countTranscriptReads();
  const reader = index();
  const warm = reader.warm(['a', 'a']);
  const [a, b] = await Promise.all([reader.ready('a'), reader.ready('a')]);
  await warm;
  expect(a).toBe(b);
  expect(a).toMatchObject({
    lastSeq: 11, projectionIds: ['π', '尾'], workerOutcomeKeys: ['wait:worker:2'],
    pendingAsk: { seq: 8, requestId: '選択', questions, routedMessageId: 'route', fallback: true }, pendingGateSeq: 8,
  });
  expect(readFileSync(paths.facts, 'utf8')).toBe(expected);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(reads.counts.files).toEqual([]);
});

it('peek never folds a stale tail, readiness folds it off loop', async () => {
  seed('a'); index().get('a');
  appendFileSync(historyPaths(dir, 'a').plain, line(2, 'tail'));
  const reads = countTranscriptReads();
  const reader = index();
  expect(reader.peek('a')).toBeUndefined();
  expect((await reader.ready('a'))?.projectionIds).toEqual(['a', 'tail']);
  expect(reads.counts.files).toEqual([]);
});

it('queued synchronous takeover settles warm without dispatching a second fold', async () => {
  seed('a');
  const dispatch = vi.spyOn(Worker.prototype, 'postMessage');
  const reader = index();
  const warm = reader.warm(['a']);
  const facts = reader.get('a');
  await warm;
  expect(await reader.ready('a')).toBe(facts);
  expect(dispatch).not.toHaveBeenCalled();
});

it('active synchronous join shares completion then appends each new fact once', async () => {
  seed('a');
  const dispatch = vi.spyOn(Worker.prototype, 'postMessage');
  const reader = index();
  const pending = reader.ready('a');
  await tick();
  expect(dispatch).toHaveBeenCalledTimes(1);
  const reads = countTranscriptReads();
  const facts = reader.get('a');
  expect(reads.counts.files).toEqual([]);
  expect(await pending).toBe(facts);
  appendFileSync(historyPaths(dir, 'a').plain, line(2, 'new'));
  reader.append('a', event(2, 'new'), Buffer.byteLength(line(2, 'new')));
  expect(reader.get('a')).toMatchObject({ lastSeq: 2, projectionIds: ['a', 'new'] });
  expect(dispatch).toHaveBeenCalledTimes(1);
});

it('promotes demanded pending work ahead of cold history', async () => {
  for (const id of ['active', 'cold', 'live']) seed(id);
  const dispatch = vi.spyOn(Worker.prototype, 'postMessage');
  const reader = index();
  const warm = reader.warm(['active', 'cold', 'live']);
  await tick();
  await reader.ready('live');
  await warm;
  expect(dispatch.mock.calls.map(([message]) => message.runId)).toEqual(['active', 'live', 'cold']);
});

it('exact valid sidecars avoid starting a worker on readiness', async () => {
  seed('a'); index().get('a');
  const dispatch = vi.spyOn(Worker.prototype, 'postMessage');
  expect((await index().ready('a'))?.projectionIds).toEqual(['a']);
  expect(dispatch).not.toHaveBeenCalled();
});

it.each(['forget', 'stop'] as const)('%s revokes queued work and settles all consumers', async (action) => {
  seed('a');
  const reader = index();
  const warm = reader.warm(['a']);
  const ready = reader.ready('a');
  const outcomes = Promise.allSettled([warm, ready]);
  if (action === 'forget') reader.forget('a'); else reader.stop();
  expect((await outcomes).map((result) => result.status)).toEqual(['rejected', 'rejected']);
  await tick();
  expect(existsSync(historyPaths(dir, 'a').facts)).toBe(false);
});

it.each(['error', 'exit', 'startup'] as const)('worker %s failure rejects all waiters without an inline fallback', async (failure) => {
  seed('a'); seed('b');
  const original = Worker.prototype.postMessage;
  vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, ...args) {
    if (failure === 'startup') throw new Error('startup failed');
    original.apply(this, args);
    if (failure === 'exit') void this.terminate();
    else this.emit('error', new Error('worker failed'));
  });
  const reads = countTranscriptReads();
  const reader = index();
  const results = await Promise.allSettled([reader.ready('a'), reader.ready('b')]);
  expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
  expect(reads.counts.files).toEqual([]);
  expect(existsSync(historyPaths(dir, 'a').facts)).toBe(false);
});

it('bounded synchronous join failure rejects its async waiter without refolding', async () => {
  seed('a');
  const reader = index();
  const pending = reader.ready('a');
  const outcome = Promise.allSettled([pending]);
  await tick();
  const reads = countTranscriptReads();
  vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
  expect(() => reader.get('a')).toThrow(/timed out/);
  expect((await outcome)[0]?.status).toBe('rejected');
  expect(reads.counts.files).toEqual([]);
  expect(existsSync(historyPaths(dir, 'a').facts)).toBe(false);
});


/** Hold the first real worker publication, not a fabricated load result. */
function holdFirstResult() {
  let release!: () => void;
  let received!: () => void;
  const loaded = new Promise<void>((resolve) => { received = resolve; });
  const original = Worker.prototype.postMessage;
  const dispatch = vi.spyOn(Worker.prototype, 'postMessage');
  dispatch.mockImplementationOnce(function (this: Worker, message: FactsJobMessage) {
    const { port1, port2 } = new MessageChannel();
    ports.push(port1, message.port);
    port1.once('message', (reply: FactsJobReply) => {
      release = () => {
        message.port.postMessage(reply);
        Atomics.store(new Int32Array(message.signal), 0, 1);
        Atomics.notify(new Int32Array(message.signal), 0);
        message.port.close();
        port1.close();
      };
      received();
    });
    original.call(this, { ...message, port: port2, signal: new SharedArrayBuffer(4) }, [port2]);
  });
  return { loaded, release: () => release(), dispatch };
}

it('rejects a stale real result and refreshes changed history off loop', async () => {
  seed('a');
  const held = holdFirstResult();
  const reader = index();
  const pending = reader.ready('a');
  await held.loaded;
  expect(existsSync(historyPaths(dir, 'a').facts)).toBe(false);
  appendFileSync(historyPaths(dir, 'a').plain, line(2, 'external'));
  const reads = countTranscriptReads();
  held.release();
  expect(await pending).toMatchObject({ lastSeq: 2, projectionIds: ['a', 'external'] });
  expect(held.dispatch).toHaveBeenCalledTimes(2);
  expect(reads.counts.files).toEqual([]);
  expect(JSON.parse(readFileSync(historyPaths(dir, 'a').facts, 'utf8')).lastSeq).toBe(2);
});

it('append while a completed worker result awaits acceptance joins and refreshes once', async () => {
  seed('a');
  const held = holdFirstResult();
  const reader = index();
  const pending = reader.ready('a');
  await held.loaded;
  appendFileSync(historyPaths(dir, 'a').plain, line(2, 'append'));
  held.release();
  const reads = countTranscriptReads();
  reader.append('a', event(2, 'append'), Buffer.byteLength(line(2, 'append')));
  expect(await pending).toBe(reader.get('a'));
  expect(reader.get('a')).toMatchObject({ lastSeq: 2, projectionIds: ['a', 'append'] });
  expect(reads.counts.files).toEqual([]);
  expect(held.dispatch).toHaveBeenCalledTimes(2);
});

it('archive adoption refreshes an active worker without a parent full fold', async () => {
  seed('a');
  const held = holdFirstResult();
  const reader = index();
  const pending = reader.ready('a');
  void pending.catch(() => undefined);
  await held.loaded;
  const paths = historyPaths(dir, 'a');
  appendFileSync(paths.plain, line(2, 'adopted'));
  const parentFold = vi.spyOn(factsFold, 'foldText');
  expect(await compressHistory(dir, 'a', () => true, (plain, archive) => {
    reader.adoptArchive('a', plain, factsFold.stampOf(archive));
  })).toBe('compressed');
  held.release();
  expect(parentFold).not.toHaveBeenCalled();
  const adopted = await pending;
  expect(adopted).toBe(reader.peek('a'));
  expect(adopted).toMatchObject({ lastSeq: 2, projectionIds: ['a', 'adopted'], archive: expect.any(Object) });
  expect(JSON.parse(readFileSync(paths.facts, 'utf8'))).toEqual(adopted);
  expect(held.dispatch).toHaveBeenCalledTimes(2);
  expect(parentFold).not.toHaveBeenCalled();
});

it.each(['absent', 'stale'] as const)('archive adoption queues an unowned %s entry without a parent full fold', async (state) => {
  seed('a');
  const reader = index();
  if (state === 'stale') reader.get('a');
  const paths = historyPaths(dir, 'a');
  appendFileSync(paths.plain, line(2, 'adopted'));
  const parentFold = vi.spyOn(factsFold, 'foldText');
  expect(await compressHistory(dir, 'a', () => true, (plain, archive) => {
    reader.adoptArchive('a', plain, factsFold.stampOf(archive));
  })).toBe('compressed');
  expect(parentFold).not.toHaveBeenCalled();
  const adopted = await reader.ready('a');
  expect(adopted).toMatchObject({ lastSeq: 2, projectionIds: ['a', 'adopted'], archive: expect.any(Object) });
  expect(JSON.parse(readFileSync(paths.facts, 'utf8'))).toEqual(adopted);
  expect(parentFold).not.toHaveBeenCalled();
});

it.each(['forget', 'stop'] as const)('%s revokes a held real result and prevents late sidecars', async (action) => {
  seed('a');
  const held = holdFirstResult();
  const reader = index();
  const pending = reader.ready('a');
  const outcome = Promise.allSettled([pending]);
  await held.loaded;
  if (action === 'forget') { reader.forget('a'); rmSync(historyPaths(dir, 'a').plain); }
  else reader.stop();
  held.release();
  expect((await outcome)[0]?.status).toBe('rejected');
  await tick();
  expect(existsSync(historyPaths(dir, 'a').facts)).toBe(false);
});

it('idle worker exits and a later cold demand lazily creates another', async () => {
  seed('a'); seed('b');
  const original = Worker.prototype.postMessage;
  const exits: Promise<number>[] = [];
  vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, ...args) {
    exits.push(new Promise((resolve) => this.once('exit', resolve)));
    original.apply(this, args);
  });
  const reader = index();
  await reader.ready('a');
  await exits[0];
  expect((await reader.ready('b'))?.projectionIds).toEqual(['b']);
  await exits[1];
  expect(exits).toHaveLength(2);
});

it('a stalled startup is bounded and a later demand can retry', async () => {
  seed('a');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(Worker.prototype, 'postMessage').mockImplementationOnce((message: FactsJobMessage) => { message.port.close(); });
  const reader = index();
  const outcomes = Promise.allSettled([reader.ready('a')]);
  await tick();
  await vi.advanceTimersByTimeAsync(30_000);
  expect((await outcomes)[0]).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('timed out') }) });
  vi.useRealTimers();
  expect((await reader.ready('a'))?.projectionIds).toEqual(['a']);
});

it('warming already-ready sidecars yields without starting a worker', async () => {
  seed('a'); seed('b'); index().get('a'); index().get('b');
  const dispatch = vi.spyOn(Worker.prototype, 'postMessage');
  const reader = index();
  await reader.warm(['a', 'b']);
  expect(reader.peek('a')?.projectionIds).toEqual(['a']);
  expect(reader.peek('b')?.projectionIds).toEqual(['b']);
  expect(dispatch).not.toHaveBeenCalled();
});

it('a queued sync refresh consumes the active owner before dispatching another job', async () => {
  seed('a'); seed('b');
  const accepted: string[] = [];
  const queue = new TranscriptFactsQueue<FactsLoadResult | undefined>(dir, (id, result): FactsLoadResult | undefined | typeof REFRESH_FACTS => {
    accepted.push(id);
    if (id === 'b' && accepted.length === 1) return REFRESH_FACTS;
    return result;
  });
  try {
    const pending = queue.request('a');
    await tick();
    expect(queue.join('b')?.facts.projectionIds).toEqual(['b']);
    // One active owner: a must settle before b's worker refresh is dispatched.
    expect(accepted).toEqual(['b', 'a', 'b']);
    expect((await pending)?.facts.projectionIds).toEqual(['a']);
  } finally { queue.stop(); }
});


it('bounds repeated refreshes instead of autonomously retrying forever', async () => {
  seed('a');
  const dispatch = vi.spyOn(Worker.prototype, 'postMessage');
  const queue = new TranscriptFactsQueue(dir, () => REFRESH_FACTS);
  try {
    await expect(queue.request('a')).rejects.toThrow(/keeps changing/);
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(existsSync(historyPaths(dir, 'a').facts)).toBe(false);
  } finally { queue.stop(); }
});

it('unreadable history remains uncached and can be retried', async () => {
  const paths = historyPaths(dir, 'a');
  mkdirSync(paths.plain);
  const reader = index();
  expect(await reader.ready('a')).toBeUndefined();
  expect(existsSync(paths.facts)).toBe(false);
  rmSync(paths.plain, { recursive: true });
  seed('a');
  expect((await reader.ready('a'))?.projectionIds).toEqual(['a']);
});


it('keeps per-run sidecar cleanup failures conservative for synchronous callers', () => {
  seed('a');
  const originalWrite = fs.writeFileSync;
  const originalRemove = fs.rmSync;
  const denied = Object.assign(new Error('read-only facts directory'), { code: 'EACCES' });
  vi.spyOn(fs, 'writeFileSync').mockImplementation((path, ...args) => {
    if (String(path).endsWith('.tmp')) throw denied;
    return originalWrite(path, ...args);
  });
  vi.spyOn(fs, 'rmSync').mockImplementation((path, ...args) => {
    if (String(path).endsWith('.tmp')) throw denied;
    return originalRemove(path, ...args);
  });
  syncBuiltinESMExports();
  expect(index().get('a')).toBeUndefined();
  expect(existsSync(historyPaths(dir, 'a').facts)).toBe(false);
});
