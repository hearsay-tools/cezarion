import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  REFERENCED_RUN_RULE, RETENTION_RUN_RULE, SWEEPABLE_RUN_RULE, UNREAD_RUN_RULE,
} from '@open-mercato/cezar-contract/run-predicates';
import { automationIdOf, runRecordSchema, type RunRecord } from '@open-mercato/cezar-contract/runs';
import { makeRunRecord, RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { RUNS_DB_FILE, RunDatabase } from './run-database.ts';
import { encodeRunRow } from './run-row.ts';

const BEFORE = '2026-10-25T00:00:00.000Z';
const FINISH = '2026-10-26T00:00:00.000Z';
const AFTER = '2026-10-27T00:00:00.000Z';
const UUID = '00000000-0000-4000-8000-000000000001';
const delegations: RunRecord['delegation'][] = [
  undefined,
  { role: 'invalid' },
  { role: 'root', permissions: [], receipts: [] },
  {
    role: 'worker', parentRunId: UUID, permissions: [],
    workspace: { ownerRunId: UUID, resourceId: UUID, kind: 'owned-isolated', path: '/tmp/worker', branch: 'worker', baselineSha: 'a'.repeat(40) },
  },
];

/** Cross each independent branch without relying on host settings or a seeded catalog. */
function variants(runs: RunRecord[], overrides: Partial<RunRecord>[]): RunRecord[] {
  return runs.flatMap((run) => overrides.map((over) => ({ ...run, ...over })));
}

function rows(): RunRecord[] {
  let runs = Object.values(RUN_STATUS).map((status) => makeRunRecord({ status }));
  runs = variants(runs, [{ archived: false }, { archived: true }]);
  runs = variants(runs, [{ finishedAt: undefined }, { finishedAt: FINISH }]);
  runs = variants(runs, [undefined, BEFORE, FINISH, AFTER].map((seenAt) => ({ seenAt })));
  runs = variants(runs, [{ autoResumeAt: undefined }, { autoResumeAt: AFTER }]);
  runs = variants(runs, [undefined, false, true].map((pinned) => ({ pinned })));
  runs = variants(runs, delegations.map((delegation) => ({ delegation })));
  runs = variants(runs, [{ automation: undefined }, { automation: { automationId: 'automation', automationRevision: 1, receiptId: 'receipt', event: 'issue', githubUrl: 'https://github.com/o/r/issues/1' } }]);
  // Reference presence includes empty strings: SQL tests nullness, not truthiness.
  runs = variants(runs, [
    {}, { referencedPullRequestUrl: '' }, { referencedIssueUrl: '' },
    { referencedPullRequestUrl: 'https://github.com/o/r/pull/1' },
    { referencedIssueUrl: 'https://github.com/o/r/issues/2' },
    { referencedPullRequestUrl: 'https://github.com/o/r/pull/1', referencedIssueUrl: 'https://github.com/o/r/issues/2' },
  ]);
  return runs.map((run, index) => ({ ...run, id: `row-${index}` }));
}

let dir: string;
let db: RunDatabase;
let runs: RunRecord[];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cez-run-predicates-'));
  db = RunDatabase.open(join(dir, RUNS_DB_FILE));
  runs = rows();
  db.transaction({ upserts: runs.map((run) => encodeRunRow(run)), deletes: [] });
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Real SQL must retain every accepted row; decoding and rechecking must recover the exact set. */
function parity(sql: string, matches: (run: RunRecord) => boolean, params: string[] = []): void {
  const expected = runs.filter(matches).map((run) => run.id).sort();
  expect(expected.length).toBeGreaterThan(0);
  expect(expected.length).toBeLessThan(runs.length);
  const candidates = db.listWhere(sql, params);
  const kept = new Set(candidates.map((row) => row.id));
  expect(expected.filter((id) => !kept.has(id))).toEqual([]);
  const rechecked = candidates.map((row) => runRecordSchema.parse(JSON.parse(row.data)))
    .filter(matches).map((run) => run.id).sort();
  expect(rechecked).toEqual(expected);
}

describe('run predicate SQL prefilters', () => {
  it('unread retains and rechecks every record branch', () => {
    parity(UNREAD_RUN_RULE.sql, UNREAD_RUN_RULE.matches);
  });

  it('sweepable retains and rechecks every scope and automation tab', () => {
    for (const scope of [undefined, 'pinned', 'unpinned'] as const) {
      for (const automation of [undefined, true, false]) {
        parity(SWEEPABLE_RUN_RULE.sql, (run) => SWEEPABLE_RUN_RULE.matches({ ...run, automationId: automationIdOf(run) }, scope, automation));
      }
    }
  });

  it('retention retains and rechecks every record branch within the given ids', () => {
    parity(RETENTION_RUN_RULE.sql, RETENTION_RUN_RULE.matches, [JSON.stringify(runs.map((run) => run.id))]);
    expect(db.listWhere(RETENTION_RUN_RULE.sql, ['[]'])).toEqual([]);
  });

  it('referenced retains and rechecks each reference presence combination', () => {
    parity(REFERENCED_RUN_RULE.sql, REFERENCED_RUN_RULE.matches);
  });
});
