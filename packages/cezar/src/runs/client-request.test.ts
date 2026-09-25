import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clientRequestHash } from './client-request.ts';
import { RunStore } from './store.ts';

/** Idempotent start (#504): the hash is what decides "same request" vs "stale id". */
describe('clientRequestHash', () => {
  const base = { task: 'a', workflow: 'quick-task' };

  it('is independent of key order and undefined keys', () => {
    expect(clientRequestHash({ task: 'a', workflow: 'quick-task', model: undefined }))
      .toBe(clientRequestHash({ workflow: 'quick-task', task: 'a' }));
  });

  it.each([
    ['task', 'b'], ['workflow', 'review'], ['steps', [{ id: 'x', prompt: '{{task}}' }]], ['runner', 'codex'],
    ['model', 'm'], ['effort', 'high'], ['agentProfile', 'p'], ['autonomous', true], ['worktree', false],
    ['systemPrompt', 's'], ['images', [{ mediaType: 'image/png', data: 'x' }]], ['generateFollowups', false],
  ])('changes with %s', (key, value) => {
    expect(clientRequestHash({ ...base, [key]: value })).not.toBe(clientRequestHash(base));
  });

  it.each([
    ['todoId', 't1'], ['variants', 1], ['clientRequestId', '0b0f9a4e-8c1e-4b8a-9a52-4b3f1d0c9e11'],
    // Mutable after start through POST /runs/:id/notify (#589), so a retry must not conflict on it.
    ['notify', true],
  ])('ignores %s', (key, value) => {
    expect(clientRequestHash({ ...base, [key]: value } as Parameters<typeof clientRequestHash>[0])).toBe(clientRequestHash(base));
  });

  it('canonicalises nested step objects', () => {
    expect(clientRequestHash({ task: 'a', steps: [{ prompt: 'p', id: 'x' }] }))
      .toBe(clientRequestHash({ task: 'a', steps: [{ id: 'x', prompt: 'p' }] }));
  });
});

describe('RunStore client request id', () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'cez-client-request-')); });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  const id = '0b0f9a4e-8c1e-4b8a-9a52-4b3f1d0c9e11';

  it('persists the id and hash across a reopen, and finds archived runs', () => {
    const store = RunStore.open(dataDir);
    const run = store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [], clientRequestId: id, clientRequestHash: 'h' });
    store.setArchived(run.id, true);
    store.flush();
    const reopened = RunStore.open(dataDir);
    const found = reopened.findRunByClientRequestId(id);
    expect(found?.id).toBe(run.id);
    expect(found?.clientRequestHash).toBe('h');
    expect(found?.archived).toBe(true);
  });

  it('answers undefined for an unknown id and leaves ordinary runs without the fields', () => {
    const store = RunStore.open(dataDir);
    const run = store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [] });
    expect(store.findRunByClientRequestId(id)).toBeUndefined();
    expect('clientRequestId' in run).toBe(false);
  });

  it('loads a runs.json written before the fields existed', () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([{ id: 'old', title: 'o', workflow: 'w', task: 't', status: 'done',
      createdAt: '2026-01-01T00:00:00.000Z', tokensUsed: 0, archived: false, steps: [] }]));
    const store = RunStore.open(dataDir);
    expect(store.getRun('old')?.clientRequestId).toBeUndefined();
  });
});
