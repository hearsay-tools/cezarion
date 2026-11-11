import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AutomationStore } from './store.ts';
import { retryAutomationLogReceipt, type AutomationLogRetryInput } from '../server/automation-log-retry.ts';

const input = { name: 'Review', enabled: false, events: ['pull_request.opened'] as const,
  intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'Review {{github.url}}' } };

describe('project automation sources', () => {
  let repo: string;
  beforeEach(() => { repo = mkdtempSync(join(tmpdir(), 'project-automations-')); });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));
  const root = (name: string) => join(repo, '.ai', name);
  const open = () => AutomationStore.open(root('cezar'));
  function seed(name: string, ids: string[]) {
    // Build valid fixture definitions outside either project directory.
    const fixture = AutomationStore.open(join(repo, `fixture-${name}`));
    const definitions = ids.map(id => fixture.create({ ...input, name: `${name} ${id}` }, id));
    mkdirSync(root(name), { recursive: true });
    writeFileSync(join(root(name), 'automations.json'), JSON.stringify({ version: 1, future: name, automations: definitions }));
  }

  it('reads absent state without creating either directory', () => {
    expect(open().list()).toEqual([]);
    expect(existsSync(join(repo, '.ai'))).toBe(false);
  });

  it.each(['cezar', 'squawk'])('reads %s alone and writes only the legacy counterpart', name => {
    seed(name, ['one']);
    const source = readFileSync(join(root(name), 'automations.json'));
    const store = open();
    expect(store.get('one')?.name).toBe(`${name} one`);
    if (name === 'squawk') expect(existsSync(root('cezar'))).toBe(false);
    store.update('one', 1, { ...input, name: 'changed' });
    expect(open().get('one')?.name).toBe('changed');
    expect(JSON.parse(readFileSync(join(root('cezar'), 'automations.json'), 'utf8')).future).toBe(name);
    if (name === 'squawk') expect(readFileSync(join(root(name), 'automations.json'))).toEqual(source);
    else expect(existsSync(root('squawk'))).toBe(false);
  });

  it('unions disjoint IDs, keeps legacy duplicates, and refuses either fallback delete', () => {
    seed('cezar', ['duplicate', 'old']);
    seed('squawk', ['duplicate', 'fallback']);
    const source = readFileSync(join(root('squawk'), 'automations.json'));
    const store = open();
    expect(store.list().map(row => row.id).sort()).toEqual(['duplicate', 'fallback', 'old']);
    expect(store.get('duplicate')?.name).toBe('cezar duplicate');
    for (const id of ['duplicate', 'fallback']) expect(() => store.delete(id)).toThrow(/\.ai\/squawk.*binary that migrated/);
    expect(store.delete('old')).toBe(true);
    expect(open().get('old')).toBeUndefined();
    expect(readFileSync(join(root('squawk'), 'automations.json'))).toEqual(source);
  });

  it('keeps positive cursors stable across legacy appends and compacts legacy rows only', async () => {
    seed('cezar', ['legacy']); seed('squawk', ['fallback']);
    const log = (automationId: string) => Array.from({ length: 100 }, (_, index) => JSON.stringify({
      automationId, revision: 1, seq: index + 1, ts: new Date().toISOString(), result: 'skipped', reason: `${automationId}-${index + 1}`,
    })).join('\n') + '\n';
    const fallbackBytes = log('fallback');
    writeFileSync(join(root('cezar'), 'automation-log.ndjson'), log('legacy'));
    writeFileSync(join(root('squawk'), 'automation-log.ndjson'), fallbackBytes);
    const receipt = { receiptKey: 'fallback:event', receiptId: 'source-receipt', automationId: 'fallback', eventId: 'event', revision: 1, status: 'reserved', observedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    writeFileSync(join(root('squawk'), 'automation-receipts.ndjson'), JSON.stringify(receipt) + '\n');
    const store = open();
    const first = store.logs({ limit: 100 });
    expect(first.every(row => Number.isInteger(row.seq) && row.seq > 0)).toBe(true);
    await store.appendLog({ automationId: 'legacy', revision: 1, result: 'skipped', reason: 'new entry' });
    const second = store.logs({ cursor: first.at(-1)!.seq, limit: 100 });
    const all = [...first, ...second];
    expect(new Set(all.map(row => row.seq)).size).toBe(200);
    expect(new Set(all.map(row => row.reason)).size).toBe(200);
    expect(all.some(row => row.reason === 'new entry')).toBe(false);
    expect(store.logs({ cursor: second.at(-1)!.seq })).toEqual([]);
    writeFileSync(join(root('squawk'), 'automation-log.ndjson'), fallbackBytes + log('legacy'));
    expect(store.logs({ cursor: first.at(-1)!.seq, limit: 100 })).toEqual(second);
    writeFileSync(join(root('squawk'), 'automation-log.ndjson'), fallbackBytes);
    await store.compact();
    expect(open().logs({ cursor: first.at(-1)!.seq, limit: 100 })).toEqual(second);
    const persisted = readFileSync(join(root('cezar'), 'automation-log.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(persisted).toHaveLength(101);
    expect(readFileSync(join(root('cezar'), 'automation-receipts.ndjson'), 'utf8')).toBe('');
    expect(open().receipts().map(row => row.receiptId)).toEqual(['source-receipt']);
    expect(persisted.every(row => row.automationId === 'legacy' && Number.isInteger(row.seq) && row.seq > 0)).toBe(true);
    expect(readFileSync(join(root('squawk'), 'automation-log.ndjson'), 'utf8')).toBe(fallbackBytes);
  });

  it('skips compaction when only fallback files exist', async () => {
    seed('squawk', ['fallback']);
    const bytes = JSON.stringify({ automationId: 'fallback', revision: 1, seq: 1, ts: new Date().toISOString(), result: 'skipped' }) + '\n';
    writeFileSync(join(root('squawk'), 'automation-log.ndjson'), bytes);
    await open().compact();
    expect(existsSync(root('cezar'))).toBe(false);
    expect(open().logs()).toHaveLength(1);
    expect(readFileSync(join(root('squawk'), 'automation-log.ndjson'), 'utf8')).toBe(bytes);
  });

  it('preserves fallback runtime state and receipt transitions when writing legacy files', () => {
    seed('squawk', ['one']);
    writeFileSync(join(root('squawk'), 'automation-state.json'), JSON.stringify({ version: 1, states: { one: { revision: 1 }, untouched: { revision: 4 } } }));
    const receipt = { receiptKey: 'one:event', receiptId: 'receipt', automationId: 'one', eventId: 'event', revision: 1,
      status: 'reserved' as const, observedAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' };
    const bytes = `${JSON.stringify(receipt)}\n`;
    writeFileSync(join(root('squawk'), 'automation-receipts.ndjson'), bytes);
    const store = open();
    store.setState('one', current => ({ ...current, nextRunAt: '2026-11-10T00:00:00Z' }));
    store.appendReceipt({ ...receipt, status: 'launched', runId: 'run', updatedAt: '2026-11-02T00:00:00Z' });
    expect(open().state('untouched')).toMatchObject({ revision: 4 });
    expect(open().receipts().map(row => row.status)).toEqual(['reserved', 'launched']);
    expect(open().latestReceipts().get('one:event')?.status).toBe('launched');
    expect(readFileSync(join(root('squawk'), 'automation-receipts.ndjson'), 'utf8')).toBe(bytes);
  });

  it('takes the newest receipt transition across directories, so a launched fallback receipt is not retried', async () => {
    seed('cezar', ['one']);
    const receipt = { receiptKey: 'one:event', receiptId: 'receipt', automationId: 'one', eventId: 'event', revision: 1, observedAt: '2026-11-01T00:00:00Z' };
    writeFileSync(join(root('cezar'), 'automation-receipts.ndjson'), JSON.stringify({ ...receipt, status: 'launch-error', error: 'boom', updatedAt: '2026-11-01T00:00:00Z' }) + '\n');
    mkdirSync(root('squawk'), { recursive: true });
    writeFileSync(join(root('squawk'), 'automation-receipts.ndjson'), JSON.stringify({ ...receipt, status: 'launched', runId: 'already-launched', updatedAt: '2026-11-02T00:00:00Z' }) + '\n');
    const store = open();
    expect(store.latestReceipts().get('one:event')).toMatchObject({ status: 'launched', runId: 'already-launched' });
    const retried = await retryAutomationLogReceipt({ project: { automationStore: store }, receiptId: 'receipt' } as unknown as AutomationLogRetryInput);
    expect(retried).toEqual({ status: 409, body: { error: 'receipt is not retryable' } });
    expect(store.receipts()).toHaveLength(2);
  });

  it('pages merged log rows newest first in recorded time across directories', () => {
    seed('cezar', ['legacy']); seed('squawk', ['fallback']);
    const row = (automationId: string, seq: number, day: number) => JSON.stringify({ automationId, revision: 1, seq, ts: `2026-11-0${day}T00:00:00.000Z`, result: 'skipped', reason: `${automationId}-${day}` });
    writeFileSync(join(root('cezar'), 'automation-log.ndjson'), [row('legacy', 1, 1), row('legacy', 2, 3)].join('\n') + '\n');
    writeFileSync(join(root('squawk'), 'automation-log.ndjson'), row('fallback', 1, 2) + '\n');
    const store = open();
    expect(store.logs().map(entry => entry.reason)).toEqual(['legacy-3', 'fallback-2', 'legacy-1']);
    const pages: string[] = [];
    let cursor: number | undefined;
    for (let page = store.logs({ limit: 1 }); page.length; page = store.logs({ cursor, limit: 1 })) { pages.push(page[0]!.reason!); cursor = page[0]!.seq; }
    expect(pages).toEqual(['legacy-3', 'fallback-2', 'legacy-1']);
  });

  it('never skips a merged log row when legacy compaction drops the oldest rows between pages', async () => {
    seed('cezar', ['legacy']); seed('squawk', ['fallback']);
    const row = (automationId: string, seq: number, minute: number) => JSON.stringify({ automationId, revision: 1, seq,
      ts: new Date(Date.parse('2026-10-01T00:00:00.000Z') + minute * 60_000).toISOString(), result: 'skipped', reason: `${automationId}-${seq}` });
    // Scale down retention, not the boundary: compaction still drops the five oldest rows.
    const openCompactingStore = () => AutomationStore.open(root('cezar'), { logRetentionCount: 20 });
    writeFileSync(join(root('cezar'), 'automation-log.ndjson'), Array.from({ length: 25 }, (_, index) => row('legacy', index + 1, index * 2)).join('\n') + '\n');
    writeFileSync(join(root('squawk'), 'automation-log.ndjson'), Array.from({ length: 10 }, (_, index) => row('fallback', index + 1, index * 2 + 1)).join('\n') + '\n');
    const store = openCompactingStore();
    const first = store.logs({ limit: 10 });
    await store.compact();
    const reopened = openCompactingStore();
    // Keep paging from page 1's cursor after compaction: rows may repeat, none may be missing.
    const later: Array<{ ts: string; reason?: string | undefined }> = [];
    for (let page = reopened.logs({ cursor: first.at(-1)!.seq, limit: 10 }); page.length; page = reopened.logs({ cursor: page.at(-1)!.seq, limit: 10 })) later.push(...page);
    const all: Array<{ ts: string; reason?: string | undefined }> = [];
    for (let page = reopened.logs({ limit: 10 }); page.length; page = reopened.logs({ cursor: page.at(-1)!.seq, limit: 10 })) all.push(...page);
    expect(first).toHaveLength(10);
    expect(all).toHaveLength(30);
    const seen = new Set([...first, ...later].map(entry => entry.reason));
    expect(all.map(entry => entry.reason).filter(reason => !seen.has(reason))).toEqual([]);
    expect(readFileSync(join(root('cezar'), 'automation-log.ndjson'), 'utf8').trim().split('\n')).toHaveLength(20);
  });
});
