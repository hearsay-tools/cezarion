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

const NDJSON_ALLOW_FILES = new Set([
  join('automations', 'store.ts'),
  join('data-gitignore.ts'),
  join('runs', 'history-file.ts'),
]);

const EVENTS_PATH_ALLOW = [
  { file: join('runs', 'store.ts'), text: 'private eventsPath(runId: string)' },
  { file: join('runs', 'store.ts'), text: 'appendFileSync(this.eventsPath(runId)' },
];

function eventsPathViolation(rel: string, line: string): boolean {
  if (!line.includes('eventsPath(')) return false;
  return !EVENTS_PATH_ALLOW.some((allow) => allow.file === rel && line.includes(allow.text));
}

function ndjsonViolation(rel: string, line: string): boolean {
  if (NDJSON_ALLOW_FILES.has(rel)) return false;
  if (/\bfrom\s+['"][^'"]+\.ndjson['"]/.test(line)) return false;
  if (/FIXTURES.*\.ndjson|\.ndjson.*FIXTURES/.test(line)) return false;
  return line.includes('.ndjson');
}

describe('history readers', () => {
  it('flags stray transcript path access', () => {
    expect(eventsPathViolation('runs/other.ts', 'createReadStream(this.eventsPath(id))')).toBe(true);
    expect(eventsPathViolation('runs/other.ts', 'statSync(this.eventsPath(id))')).toBe(true);
    expect(eventsPathViolation(join('runs', 'store.ts'), 'appendFileSync(this.eventsPath(runId), line)')).toBe(false);
    expect(eventsPathViolation(join('runs', 'store.ts'), 'private eventsPath(runId: string): string {')).toBe(false);
    expect(ndjsonViolation('runs/store.ts', 'id + ".ndjson"')).toBe(true);
    expect(ndjsonViolation('runs/store.ts', '`${id}.ndjson.br`')).toBe(true);
    expect(ndjsonViolation(join('runs', 'history-file.ts'), '`${id}.ndjson`')).toBe(false);
    expect(ndjsonViolation(join('automations', 'store.ts'), "const RECEIPTS = 'automation-receipts.ndjson';")).toBe(false);
  });

  it('no module opens a transcript path directly', () => {
    const srcRoot = join(import.meta.dirname, '..');
    const hits: string[] = [];
    for (const file of walkTs(srcRoot)) {
      if (file.endsWith('.test.ts') || file.endsWith('.testkit.ts')) continue;
      const rel = relative(srcRoot, file);
      for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        if (eventsPathViolation(rel, line) || ndjsonViolation(rel, line)) {
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
