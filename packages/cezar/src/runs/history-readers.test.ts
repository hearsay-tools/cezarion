import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { scanHistoryReaders } from '../lint/run-history-reader.ts';
import { compressHistory, historyPaths } from './history-file.ts';
import { RunStore } from './store.ts';

const dirs: string[] = [];
const stores: RunStore[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()!.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function openStore(): { dir: string; store: RunStore } {
  const dir = mkdtempSync(join(tmpdir(), 'cez-history-readers-'));
  dirs.push(dir);
  const store = RunStore.open(dir);
  stores.push(store);
  return { dir, store };
}

describe('history readers', () => {
  it('flags stray transcript path access', () => {
    const violates = (file: string, source: string) => scanHistoryReaders(`packages/cezar/src/${file}`, source).length > 0;
    expect(violates('runs/other.ts', 'createReadStream(this.eventsPath(id))')).toBe(true);
    expect(violates('runs/other.ts', 'statSync(this.eventsPath(id))')).toBe(true);
    expect(violates('runs/store.ts', 'appendFileSync(this.eventsPath(runId), line)')).toBe(false);
    expect(violates('runs/store.ts', 'class Store { private eventsPath(runId: string): string { return ""; } }')).toBe(false);
    expect(violates('runs/store.ts', 'id + ".ndjson"')).toBe(true);
    expect(violates('runs/store.ts', '`${id}.ndjson.br`')).toBe(true);
    expect(violates('runs/history-file.ts', '`${id}.ndjson`')).toBe(false);
    expect(violates('automations/store.ts', "const RECEIPTS = 'automation-receipts.ndjson';")).toBe(false);
  });

  it('store.readEvents reads a compressed transcript', async () => {
    const { dir, store } = openStore();
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.appendEvent(run.id, { type: 'note', message: 'before archive' });
    store.appendEvent(run.id, {
      type: 'ask.requested',
      requestId: 'human-question',
      questions: [{ header: 'Choice', question: 'Which implementation?', options: [{ label: 'First' }, { label: 'Second' }] }],
    });
    const events = store.readEvents(run.id);
    expect(events).toHaveLength(2);
    expect(await compressHistory(dir, run.id, () => true)).toBe('compressed');
    expect(existsSync(historyPaths(dir, run.id).plain)).toBe(false);
    expect(store.readEvents(run.id).map((event) => ({ seq: event.seq, type: event.type }))).toEqual(
      events.map((event) => ({ seq: event.seq, type: event.type })),
    );
  });

  it('appending to a compressed run restores it first', async () => {
    const { dir, store } = openStore();
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    const first = store.appendEvent(run.id, { type: 'note', message: 'old' });
    expect(await compressHistory(dir, run.id, () => true)).toBe('compressed');
    store.close();
    stores.pop();
    const reopened = RunStore.open(dir);
    stores.push(reopened);
    const second = reopened.appendEvent(run.id, { type: 'note', message: 'new' });
    const { plain, compressed } = historyPaths(dir, run.id);
    expect(existsSync(compressed)).toBe(false);
    const lines = readFileSync(plain, 'utf8').split('\n').filter(Boolean);
    expect(lines[0]).toContain('"message":"old"');
    expect(lines[1]).toContain('"message":"new"');
    expect(second.seq).toBe(first.seq + 1);
  });
});
