import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { refreshHumanAskSummary } from './human-ask-summary.ts';
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

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walkTs(path, acc);
    else if (name.endsWith('.ts')) acc.push(path);
  }
  return acc;
}

describe('history readers', () => {
  it('no module opens a transcript path directly', () => {
    const srcRoot = join(import.meta.dirname, '..');
    const ndjsonTemplate = /\$\{[^}]*\}\.ndjson`/;
    const allowed = 'appendFileSync(this.eventsPath(runId)';
    const hits: string[] = [];
    for (const file of walkTs(srcRoot)) {
      if (file.endsWith('.test.ts') || file.endsWith('.testkit.ts')) continue;
      if (file.endsWith(`${join('runs', 'history-file.ts')}`)) continue;
      const rel = relative(srcRoot, file);
      for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        if (line.includes(allowed)) continue;
        if (ndjsonTemplate.test(line) || line.includes('appendFileSync(this.eventsPath') || line.includes('readFileSync(this.eventsPath')) {
          hits.push(`${rel}:${index + 1}:${line.trim()}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('store.readEvents and refreshHumanAskSummary read a compressed transcript', async () => {
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
    const summary = { id: run.id, hasPendingHumanAsk: false };
    expect(refreshHumanAskSummary(summary, dir)).toBe(true);
    expect(summary.hasPendingHumanAsk).toBe(true);
  });

  it('appending to a compressed run restores it first', async () => {
    const { dir, store } = openStore();
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    const first = store.appendEvent(run.id, { type: 'note', message: 'old' });
    expect(await compressHistory(dir, run.id, () => true)).toBe('compressed');
    const second = store.appendEvent(run.id, { type: 'note', message: 'new' });
    const { plain, compressed } = historyPaths(dir, run.id);
    expect(existsSync(compressed)).toBe(false);
    const text = readFileSync(plain, 'utf8');
    expect(text).toContain('"message":"old"');
    expect(text).toContain('"message":"new"');
    expect(second.seq).toBe(first.seq + 1);
  });
});
