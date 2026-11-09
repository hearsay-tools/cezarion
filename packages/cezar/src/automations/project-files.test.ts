import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AutomationStore } from './store.ts';

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
});
