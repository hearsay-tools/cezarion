import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HistoryCompressor } from './history-compressor.ts';
import * as historyFile from './history-file.ts';

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cez-history-compressor-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'runs'));
  return dir;
}

describe('HistoryCompressor', () => {
  it('runs jobs one at a time', async () => {
    let inFlight = 0;
    let max = 0;
    const original = historyFile.compressHistory;
    vi.spyOn(historyFile, 'compressHistory').mockImplementation(async (...args) => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 25));
      try {
        return await original(...args);
      } finally {
        inFlight--;
      }
    });
    const dir = dataDir();
    const ids = Array.from({ length: 5 }, () => randomUUID());
    for (const id of ids) writeFileSync(join(dir, 'runs', `${id}.ndjson`), '{"seq":1}\n');
    const compressor = new HistoryCompressor(dir, () => true);
    for (const id of ids) compressor.enqueue(id);
    await compressor.idle();
    expect(max).toBe(1);
    expect(historyFile.compressHistory).toHaveBeenCalledTimes(5);
    compressor.stop();
  });

  it('cancel drops a queued job', async () => {
    const started: string[] = [];
    let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(historyFile, 'compressHistory').mockImplementation(async (_dataDir, id) => {
      started.push(id);
      if (started.length === 1) await first;
      return 'compressed';
    });
    const compressor = new HistoryCompressor(dataDir(), () => true);
    const a = randomUUID();
    const b = randomUUID();
    compressor.enqueue(a);
    compressor.enqueue(b);
    await vi.waitFor(() => expect(started).toEqual([a]));
    compressor.cancel(b);
    release();
    await compressor.idle();
    expect(started).toEqual([a]);
    compressor.stop();
  });

  it('idle resolves after the queue drains', async () => {
    vi.spyOn(historyFile, 'compressHistory').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 'compressed';
    });
    const compressor = new HistoryCompressor(dataDir(), () => true);
    compressor.enqueue(randomUUID());
    compressor.enqueue(randomUUID());
    await compressor.idle();
    await expect(compressor.idle()).resolves.toBeUndefined();
    compressor.stop();
  });

  it('does not start a job inline on enqueue', async () => {
    const spy = vi.spyOn(historyFile, 'compressHistory').mockResolvedValue('skipped');
    const compressor = new HistoryCompressor(dataDir(), () => true);
    compressor.enqueue(randomUUID());
    expect(spy).not.toHaveBeenCalled();
    await compressor.idle();
    expect(spy).toHaveBeenCalledTimes(1);
    compressor.stop();
  });

  it('re-enqueues a changed job at most 3 times', async () => {
    const spy = vi.spyOn(historyFile, 'compressHistory').mockResolvedValue('changed');
    const compressor = new HistoryCompressor(dataDir(), () => true);
    compressor.enqueue(randomUUID());
    await compressor.idle();
    expect(spy).toHaveBeenCalledTimes(4);
    compressor.stop();
  });

  it('does not retry a skipped job', async () => {
    const spy = vi.spyOn(historyFile, 'compressHistory').mockResolvedValue('skipped');
    const compressor = new HistoryCompressor(dataDir(), () => true);
    compressor.enqueue(randomUUID());
    await compressor.idle();
    expect(spy).toHaveBeenCalledTimes(1);
    compressor.stop();
  });
});
