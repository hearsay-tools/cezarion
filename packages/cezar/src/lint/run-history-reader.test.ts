import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { blankOnce } from './source-rule.ts';
import { historyAccesses, historyReadersFile, readHistoryReaders, runHistoryReader, scanHistoryReaders } from './run-history-reader.ts';
import { staleHistoryReaders } from './run.ts';

const other = 'packages/cezar/src/runs/other.ts';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('run history ownership', () => {
  it.each([
    'readFileSync(historyPaths(dir, id).plain)',
    'statSync(owner.historyPaths \n (dir, id).plain)',
    'createReadStream(this.eventsPath(id))',
    'statSync(this.eventsPath \n (id))',
    'const path = `${id}.ndjson`;',
    'const path = `${id}.ndjson.br`;',
    'const path = `${format({ id })}.ndjson`;',
    'const path = `${`${id}`}.ndjson`;',
    'const path = id + ".ndjson";',
    'const path = id + "prefix" + ".ndjson.br";',
  ])('refuses raw access: %s', (source) => {
    expect(scanHistoryReaders(other, source)).toHaveLength(1);
  });

  it.each([
    '// readFileSync(historyPaths(dir, id).plain); `${id}.ndjson`',
    '/* id + ".ndjson" */',
    'const name = "automation-receipts.ndjson";',
    'const example = "historyPaths(dir, id)";',
    'const name = "fixed" + ".ndjson";',
    'const name = `fixed.ndjson`;',
    'import data from "./fixture.ndjson";',
    'const text = readHistoryText(dir, id);',
    'const path = `${id}.json`;',
  ])('passes non-path code: %s', (source) => {
    expect(scanHistoryReaders(other, source)).toEqual([]);
  });

  it('preserves source offsets when blanking literals and comments', () => {
    const source = '// comment\nconst name = `${id}.ndjson`;';
    const code = blankOnce(source);
    expect(code).toHaveLength(source.length);
    expect(code.indexOf('${')).toBe(source.indexOf('${'));
    expect(historyAccesses(source)).toEqual([{ kind: 'dynamic-path', offset: source.indexOf('`') }]);
  });

  it('passes each reasoned exception and refuses it in another file', () => {
    const samples = {
      historyPaths: 'historyPaths(dir, id)',
      'eventsPath-declaration': 'private eventsPath(runId: string): string {',
      'eventsPath-append': 'appendFileSync(this.eventsPath(runId), line)',
      'dynamic-path': 'const path = `${id}.ndjson`;',
      eventsPath: 'this.eventsPath(id)',
    };
    for (const entry of readHistoryReaders()) {
      expect(entry.reason.trim()).not.toBe('');
      expect(scanHistoryReaders(entry.file, samples[entry.kind])).toEqual([]);
      expect(scanHistoryReaders(other, samples[entry.kind])).toHaveLength(1);
    }
    expect(scanHistoryReaders('packages/cezar/src/runs/store.ts', 'readFileSync(this.eventsPath(id))')).toHaveLength(1);
  });

  it.each([
    ['packages/cezar/src/other.ts', true],
    ['packages/cezar/src/other.test.ts', false],
    ['packages/cezar/src/other.testkit.ts', false],
    ['packages/web/src/other.ts', false],
  ])('scopes %s', (file, expected) => {
    expect(runHistoryReader.applies(file)).toBe(expected);
  });

  it('checks each stale entry against its own helper use', () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-history-list-'));
    roots.push(root);
    const list = join(root, historyReadersFile);
    mkdirSync(dirname(list), { recursive: true });
    mkdirSync(dirname(join(root, other)), { recursive: true });
    writeFileSync(join(root, other), 'historyPaths(dir, id)');
    writeFileSync(list, JSON.stringify({ entries: [
      { file: other, kind: 'historyPaths', reason: 'present' },
      { file: other, kind: 'dynamic-path', reason: 'removed' },
      { file: 'packages/cezar/src/gone.ts', kind: 'historyPaths', reason: 'deleted' },
    ] }));
    expect(staleHistoryReaders(root)).toEqual([
      `${historyReadersFile} cez/run-history-reader: ${other} no longer has dynamic-path; remove its exemption`,
      `${historyReadersFile} cez/run-history-reader: packages/cezar/src/gone.ts no longer has historyPaths; remove its exemption`,
    ]);
  });
});
