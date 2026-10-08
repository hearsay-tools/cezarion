/** Shared cold fixture for the isolated lag, HTTP, and installed-package proofs. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';

export async function seedColdHistories(dataDir, runtime) {
  const { RunDatabase, RUNS_DB_FILE, RUNS_IMPORT_COMPLETE_KEY } = await import(new URL('runs/run-database.' + runtime.ext, runtime.url));
  const { encodeRunRow } = await import(new URL('runs/run-row.' + runtime.ext, runtime.url));
  mkdirSync(join(dataDir, 'runs'), { recursive: true });
  const fixtures = [];
  const rows = [];
  for (let i = 0; i < 700; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    const events = i === 0 ? 100_000 : 8;
    const text = Array.from({ length: events }, (_, n) => JSON.stringify({
      type: 'text', seq: n + 1, ts: '2026-10-08T00:00:00.000Z', text: 'history payload '.repeat(i === 0 ? 24 : 2),
    }) + '\n').join('');
    const archived = i % 2 === 1;
    const bytes = Buffer.byteLength(text);
    const body = archived ? brotliCompressSync(Buffer.from(text), { params: { [constants.BROTLI_PARAM_QUALITY]: 1 } }) : text;
    writeFileSync(join(dataDir, 'runs', `${id}.ndjson${archived ? '.br' : ''}`), body);
    fixtures.push({ id, events, bytes, archived, diskBytes: Buffer.byteLength(body) });
    rows.push(encodeRunRow({ id, title: 'cold history', task: 'fixture', workflow: 'quick-task', status: 'done',
      createdAt: '2026-10-08T00:00:00.000Z', tokensUsed: 0, archived: false, steps: [],
      delegation: { role: 'root', permissions: [], receipts: [], conversation: { messages: [], outcomes: [] } },
    }));
  }
  const db = RunDatabase.open(join(dataDir, RUNS_DB_FILE));
  try { db.transaction({ upserts: rows, deletes: [], meta: { [RUNS_IMPORT_COMPLETE_KEY]: JSON.stringify({ source: 'responsiveness fixture', records: rows.length }) } }); }
  finally { db.close(); }
  assert.equal(readdirSync(join(dataDir, 'runs')).filter(name => name.endsWith('.facts.json')).length, 0);
  return fixtures;
}

export function verifyFacts(dataDir, fixtures, store) {
  for (const fixture of fixtures) {
    const facts = JSON.parse(readFileSync(join(dataDir, 'runs', `${fixture.id}.facts.json`), 'utf8'));
    assert.equal(facts.version, 1);
    assert.equal(facts.bytes, fixture.bytes);
    assert.equal(facts.lastSeq, fixture.events);
    assert.deepEqual(store.transcriptFacts(fixture.id), facts);
    if (fixture.archived) {
      const stat = statSync(join(dataDir, 'runs', `${fixture.id}.ndjson.br`));
      assert.deepEqual(facts.archive, { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino });
    } else assert.equal(facts.archive, undefined);
  }
  assert.equal(readdirSync(join(dataDir, 'runs')).filter(name => name.endsWith('.facts.json')).length, fixtures.length);
  return { histories: fixtures.length, plain: fixtures.filter(f => !f.archived).length,
    brotli: fixtures.filter(f => f.archived).length, events: fixtures.reduce((n, f) => n + f.events, 0),
    decodedBytes: fixtures.reduce((n, f) => n + f.bytes, 0), diskBytes: fixtures.reduce((n, f) => n + f.diskBytes, 0),
    largestEvents: fixtures[0].events, largestBytes: fixtures[0].bytes, coldSidecars: 0, sidecars: fixtures.length };
}
