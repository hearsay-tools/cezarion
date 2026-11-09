import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RUN_STATUS, makeRunRecord } from '@open-mercato/cezar-contract/test-factories.testkit';
import { openClaimSession, closeClaimSession } from './run-claims.ts';
import { RUNS_IMPORT_COMPLETE_KEY, RunDatabase } from './run-database.ts';
import { encodeRunRow } from './run-row.ts';

describe('project database projection', () => {
  let repo: string;
  const handles: RunDatabase[] = [];
  beforeEach(() => { repo = mkdtempSync(join(tmpdir(), 'project-projection-')); });
  afterEach(() => { handles.reverse().forEach(db => db.close()); handles.length = 0; rmSync(repo, { recursive: true, force: true }); });
  function open(name: string) {
    mkdirSync(join(repo, name), { recursive: true });
    const db = RunDatabase.open(join(repo, name, 'runs.db'));
    handles.push(db);
    return db;
  }
  const record = (id: string, parentRunId?: string) => makeRunRecord({ id, title: 'runs', task: 'runs',
    workflow: 'quick-task', status: RUN_STATUS.done, createdAt: '2026-11-01T00:00:00Z', steps: [],
    branch: 'shared', worktreePath: '/checkout', ...(parentRunId ? { delegation: { role: 'worker', parentRunId, permissions: [], workspace: { ownerRunId: id, resourceId: randomUUID(), kind: 'owned-isolated', path: '/checkout', branch: 'shared', baselineSha: 'a'.repeat(40) } } } : {}), clientRequestId: id,
    completionAction: { id: randomUUID(), phase: 'pending' },
    pullRequestUrl: 'https://github.com/hearsay-tools/cezarion/pull/1' });

  it('persists writes when disk appears after the initial in-memory connection was selected', () => {
    const initial = RunDatabase.open(':memory:');
    const source = open('squawk');
    const disk = open('cezar');
    disk.close(); handles.pop();
    const target = join(repo, 'cezar', 'runs.db');
    const db = RunDatabase.withProjectSource(initial, target, join(repo, 'squawk', 'runs.db'));
    const run = record(randomUUID());
    db.transaction({ upserts: [encodeRunRow(run)], deletes: [] });
    db.close();
    const reopened = open('cezar');
    expect(reopened.get(run.id)?.data).toContain(run.id);
    expect(source.listIds()).toEqual([]);
  });

  it('projects every run query and claim read, preserving legacy rows, literals, and aliases', () => {
    const primary = open('cezar'), source = open('squawk');
    const rootId = randomUUID(), workerId = randomUUID(), legacyId = randomUUID();
    const fallback = record(rootId), worker = record(workerId, rootId), legacy = record(legacyId);
    primary.transaction({ upserts: [encodeRunRow({ ...fallback, title: 'legacy wins' }), encodeRunRow(legacy)], deletes: [], meta: { [RUNS_IMPORT_COMPLETE_KEY]: 'fixture', runs: 'runs' } });
    source.transaction({ upserts: [encodeRunRow(fallback), encodeRunRow(worker)], deletes: [] });
    const owner = openClaimSession();
    source.takeClaims(owner, [{ family: rootId, expect: null }]);
    handles.splice(handles.indexOf(primary), 1);
    const db = RunDatabase.withProjectSource(primary, join(repo, 'cezar', 'runs.db'), join(repo, 'squawk', 'runs.db'));
    handles.push(db);
    const ids = [rootId, workerId, legacyId].sort();
    const roots = [rootId, legacyId].sort();
    const readIds = (rows: readonly { id: string }[]) => rows.map(row => row.id).sort();
    try {
      expect(db.get(rootId)?.data).toContain('legacy wins');
      expect(readIds(db.getMany(ids))).toEqual(ids);
      expect(readIds(db.listAll())).toEqual(ids);
      expect(readIds(db.listSummaries())).toEqual(ids);
      expect(readIds(db.getSummaries(ids))).toEqual(ids);
      expect(readIds(db.listWindowSummaries(10))).toEqual(ids);
      expect(readIds(db.listWindowSummaries(10, { roots: true }))).toEqual(roots);
      expect(readIds(db.listPeerSummaries({ all: true, excluded: [], offset: 0, limit: 10 }))).toEqual(roots);
      expect(readIds(db.searchRootSummaries(['runs']))).toEqual([legacyId]);
      expect(readIds(db.listWhere("runs.id = ? AND 'JOIN runs' <> ''", [workerId]))).toEqual([workerId]);
      expect(db.isFallback(workerId)).toBe(true);
      expect(db.isFallback(rootId)).toBe(false);
      expect(db.hasFallback(rootId)).toBe(true);
      const visited: string[] = [];
      db.visitRootSummaries([], row => { visited.push(row.id); return true; });
      expect(visited.sort()).toEqual(roots);
      expect(db.listLive()).toEqual([]);
      expect(readIds(db.listByParent(rootId))).toEqual([workerId]);
      expect(db.listIdsByParent(rootId)).toEqual([workerId]);
      expect(db.listWorkerIds()).toEqual([workerId]);
      expect(db.findByClientRequestId(workerId)?.id).toBe(workerId);
      expect(readIds(db.listWithWorktree())).toEqual(ids);
      expect(readIds(db.listBranchOwners())).toEqual(ids);
      expect(db.findResourceHolders({ branch: 'shared', worktreePath: '/checkout' }).sort()).toEqual(ids);
      expect(db.listIds().sort()).toEqual(ids);
      expect(db.has(workerId)).toBe(true);
      expect(db.revisionOf(workerId)).toBe(source.revisionOf(workerId));
      expect(readIds(db.listRevisions())).toEqual(ids);
      expect(readIds(db.listWhere("json_extract(data, '$.title') = 'runs'"))).toEqual([legacyId, workerId].sort());
      expect(readIds(db.listKeysWhere('1'))).toEqual(ids);
      expect(readIds(db.listArchiveOnMergeCandidates(-Number.MAX_SAFE_INTEGER, 64))).toEqual(roots);
      expect(readIds(db.listCompletionCandidates(-Number.MAX_SAFE_INTEGER, 64))).toEqual(ids);
      expect(db.archiveFamilyHasPullRequests(rootId)).toBe(true);
      expect(db.familyOf(workerId)).toBe(rootId);
      expect(db.familyHasLive(rootId)).toBe(false);
      expect(db.getClaim(rootId)?.session).toBe(owner.session);
      expect(db.getClaims([rootId]).get(rootId)?.session).toBe(owner.session);
      expect(db.listClaims().map(claim => claim.family)).toEqual([rootId]);
      expect(readIds(db.listForeignClaimedIds('another'))).toEqual([rootId, workerId].sort());
      expect(db.listConflicts()).toEqual([]);
      expect(db.getMeta('runs')).toBe('runs');
      db.reports.replace(workerId, [{ id: 'report', runId: workerId, name: 'runs', createdAt: fallback.createdAt, size: 1 }]);
      expect(db.reports.count()).toBe(1);
      expect(db.reports.page(undefined, 10)[0]?.summary).toContain(workerId);
      expect(db.reports.page(['9999', ''], 10)).toHaveLength(1);
      expect([...db.reports.summaries()]).toHaveLength(1);
      expect(db.reports.forRun(workerId)).toHaveLength(1);
      expect(db.listArtifacts()).toHaveLength(1);
      db.reports.markDirty(workerId, true, 1);
      expect(db.reports.dirty()).toEqual([workerId]);
    } finally { closeClaimSession(owner.session); }
  });
});
