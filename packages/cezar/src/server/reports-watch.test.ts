import { reportsIndex } from '../artifacts/reports-index.ts';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs/promises';
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }));
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReportsFrame } from '@open-mercato/cezar-contract/reports';
import { artifactDirectory, publishArtifact } from '../artifacts/store.ts';
import { RunStore } from '../runs/store.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { reportsPublisher } from './reports-topic.ts';

let root: string, dataDir: string, store: RunStore;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reports-watch-')); dataDir = join(root, '.ai/cezar'); store = RunStore.open(dataDir);
});
afterEach(() => { store.close(); vi.useRealTimers(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
const task = () => store.createRun({ title: 'Source', workflow: 'quick-task', task: 'Report', steps: [] });
async function publish(id: string, name = 'report.html') {
  const source = join(root, name); writeFileSync(source, '<p>Report</p>');
  return publishArtifact(artifactDirectory(dataDir, id), id, source);
}
const barrier = () => reportsIndex(store).backfill();

it('emits only relevant metadata and never scans settled clean history', async () => {
  const run = task(); await publish(run.id); setRunStatus(store, run.id, 'done');
  await reportsIndex(store).list({});
  const frames: ReportsFrame[] = []; reportsIndex(store).onChange(frame => frames.push(frame));
  vi.useFakeTimers(); const release = reportsIndex(store).watch();
  const scans = vi.spyOn(fs, 'opendir');
  store.updateRun(run.id, { title: 'Renamed' }); store.flush();
  expect(frames).toEqual([expect.objectContaining({ type: 'metadata', metadataGeneration: 1, runs: [expect.objectContaining({ taskTitle: 'Renamed' })] })]);
  store.updateRun(run.id, { pinned: true }); store.flush();
  expect(frames).toHaveLength(1);
  store.updateRun(run.id, { titleSummary: 'Search summary', branch: 'new-branch' }); store.flush();
  expect(frames).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(5_000); await barrier();
  expect(scans).not.toHaveBeenCalled();
  release();
});
it('scans live event bursts at most once per second and publishes changed sets and deletion', async () => {
  const run = task(); vi.useFakeTimers(); await reportsIndex(store).list({});
  const frames: ReportsFrame[] = []; reportsIndex(store).onChange(frame => frames.push(frame));
  const release = reportsIndex(store).watch();
  const artifact = await publish(run.id);
  store.updateRun(run.id, { title: 'First' }); store.flush();
  await vi.advanceTimersByTimeAsync(1_000); await barrier();
  expect(frames.some(frame => frame.type === 'content')).toBe(true);
  const scans = vi.spyOn(fs, 'opendir');
  for (let n = 0; n < 10; n++) { store.updateRun(run.id, { title: `Title ${n}` }); store.flush(); }
  await vi.advanceTimersByTimeAsync(999); await barrier();
  expect(scans).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); await barrier();
  expect(scans).toHaveBeenCalledTimes(1);
  const generation = reportsIndex(store).state().generation;
  rmSync(join(artifactDirectory(dataDir, run.id), artifact.id), { recursive: true });
  await vi.advanceTimersByTimeAsync(10_000); await barrier();
  expect(reportsIndex(store).state().generation).toBe(generation + 1);
  await publish(run.id, 'another.html'); await reportsIndex(store).reconcile();
  const beforeDelete = reportsIndex(store).state().generation;
  store.deleteRun(run.id); store.flush();
  expect(reportsIndex(store).state().generation).toBe(beforeDelete + 1);
  release();
});
it('finds quiet publications on the watched tick and stops when the last watcher leaves', async () => {
  const run = task(); await reportsIndex(store).list({});
  vi.useFakeTimers(); const release = reportsIndex(store).watch();
  await publish(run.id); const initial = reportsIndex(store).state().generation;
  await vi.advanceTimersByTimeAsync(5_000); await barrier();
  expect(reportsIndex(store).state().generation).toBe(initial + 1);
  release(); const scans = vi.spyOn(fs, 'opendir');
  await vi.advanceTimersByTimeAsync(10_000); await barrier();
  expect(scans).not.toHaveBeenCalled();
});
it('retains unreadable cached rows and retries on the watched tick after repair', async () => {
  const run = task(); const artifact = await publish(run.id); await reportsIndex(store).list({});
  vi.useFakeTimers(); const release = reportsIndex(store).watch();
  const blocked = vi.spyOn(fs, 'opendir').mockRejectedValue(Object.assign(new Error('permission'), { code: 'EACCES' }));
  const before = reportsIndex(store).state().generation;
  await vi.advanceTimersByTimeAsync(5_000); await barrier();
  expect(reportsIndex(store).state().generation).toBe(before);
  const raw = new DatabaseSync(join(dataDir, 'runs.db'), { readOnly: true });
  try {
    expect(raw.prepare('SELECT id FROM artifacts WHERE id = ?').get(artifact.id)).toBeTruthy();
    expect(raw.prepare('SELECT value FROM meta WHERE key = ?').get(`reports-dirty:${run.id}`)).toBeTruthy();
  } finally { raw.close(); }
  blocked.mockRestore();
  rmSync(join(artifactDirectory(dataDir, run.id), artifact.id), { recursive: true });
  await vi.advanceTimersByTimeAsync(5_000); await barrier();
  expect(reportsIndex(store).state().generation).toBe(before + 1);
  release();
});
it('coalesces topic frames and releases watch demand', async () => {
  const run = task(); await publish(run.id); await reportsIndex(store).list({});
  vi.useFakeTimers();
  const publisher = reportsPublisher(reportsIndex(store)), send = vi.fn();
  const off = publisher.start(send);
  expect(await publisher.snapshot()).toMatchObject({ type: 'snapshot', ...reportsIndex(store).state() });
  store.updateRun(run.id, { title: 'First' }); store.flush();
  store.updateRun(run.id, { title: 'Second' }); store.flush();
  await vi.advanceTimersByTimeAsync(500);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]![0]).toMatchObject({ type: 'metadata', runs: [{ taskTitle: 'Second' }] });
  off();
  store.updateRun(run.id, { title: 'Third' }); store.flush();
  await vi.advanceTimersByTimeAsync(5_000); await barrier();
  expect(send).toHaveBeenCalledTimes(1);
});
it('keeps terminal reconciliation when a shelf closes before its trailing scan', async () => {
  const run = task(); reportsIndex(store).start(); await reportsIndex(store).list({});
  vi.useFakeTimers(); const release = reportsIndex(store).watch();
  await publish(run.id);
  setRunStatus(store, run.id, 'done'); store.flush();
  const before = reportsIndex(store).state().generation;
  release(); await barrier();
  expect(reportsIndex(store).state().generation).toBe(before + 1);
});
it('emits a content change when a selected settled page drops missing content', async () => {
  const run = task(); const artifact = await publish(run.id); setRunStatus(store, run.id, 'done');
  await reportsIndex(store).list({});
  const before = reportsIndex(store).state().generation;
  rmSync(join(artifactDirectory(dataDir, run.id), artifact.id, 'content'));
  const page = await reportsIndex(store).list({});
  expect(page).toMatchObject({ reports: [] });
  expect(reportsIndex(store).state().generation).toBe(before + 1);
});
