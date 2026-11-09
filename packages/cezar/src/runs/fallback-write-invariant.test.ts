import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { requestOutcomeSchema } from '@open-mercato/cezar-contract/conversations';
import { createRunner } from '../core/runner-factory.ts';
import { pruneOrphans } from '../git-worktree.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { ArchiveOnMergeCoordinator } from '../server/archive-on-merge.ts';
import { CompletionActionCoordinator } from '../server/completion-actions.ts';
import { seedSettledFamily } from '../workflows/delegation-reconcile.testkit.ts';
import { RunManager } from '../workflows/run.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { ProjectRunConnection } from './project-run-connection.ts';
import { reclaimWorktrees } from './retention.ts';
import { RUNS_DB_FILE, RunDatabase } from './run-database.ts';
import { readPersistedRuns, seedRuns, setRunStatus } from './run-store.testkit.ts';
import { RunStore } from './store.ts';

/**
 * The invariant, without naming the paths that could break it: boot, recovery, every reconciler
 * and background sweep run over a project that mixes legacy and fallback families. No fallback
 * row may reach `.ai/cezar/runs.db`, no `.ai/squawk/` byte may change (SQLite's -wal/-shm
 * coordination files aside), and the database guard must never have to refuse a write.
 */
let root: string, primary: string, fallback: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fallback-invariant-'));
  primary = join(root, '.ai/cezar');
  fallback = join(root, '.ai/squawk');
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

const pr = (n: number) => `https://github.com/acme/app/pull/${n}`;

/** One store builds every family under `.ai/cezar/`; the split then moves some rows away. */
function buildFixture() {
  const store = RunStore.open(primary, { keepLive: true });
  const family = (live: boolean) => {
    const f = seedSettledFamily(store, root);
    if (live) { setRunStatus(store, f.parentId, RUN_STATUS.running); setRunStatus(store, f.workerId, RUN_STATUS.running); }
    return f;
  };
  /** A worker question its parent settled without a reply: recovery retires it (B1 class). */
  const routedQuestion = (f: ReturnType<typeof family>) => {
    const questions = [{ header: 'Pick', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }];
    const ask = store.appendEvent(f.workerId, { type: 'ask.requested', requestId: 'q', questions });
    const messageId = randomUUID();
    const parent = store.getRun(f.parentId)!;
    const conversation = parent.delegation?.role === 'root' ? parent.delegation.conversation ?? { messages: [], outcomes: [] } : { messages: [], outcomes: [] };
    store.commitConversation(f.parentId, { messages: [...conversation.messages, { id: messageId, senderRunId: f.workerId, recipientRunId: f.parentId,
      kind: 'request', question: { questions }, text: 'Which?', createdAt: new Date().toISOString(), requestHash: 'c'.repeat(64), state: 'accepted' }],
    outcomes: [...conversation.outcomes, { requestId: messageId, status: requestOutcomeSchema.shape.status.enum.cancelled, observedAt: new Date().toISOString() }] });
    store.appendEvent(f.workerId, { type: 'worker-question-routed', askSeq: ask.seq, messageId, parentRunId: f.parentId });
  };
  /** A merged PR on the root (archive on merge) and a pending archive-when-done action. */
  const finishing = (f: ReturnType<typeof family>, n: number) => {
    // A settled worker execution, so archive collection reaches the whole family.
    writeFileSync(join(primary, 'runs', `${f.workerId}.execution.json`), JSON.stringify({ generation: randomUUID(), phase: 'complete' }));
    store.recordCreatedPr(f.parentId, pr(n));
    store.updateRun(f.parentId, { archiveWhenDone: true, completionAction: { id: randomUUID(), phase: 'pending' } });
  };
  const legacy = family(false); routedQuestion(legacy); finishing(legacy, 1);
  const mixed = family(false); routedQuestion(mixed); finishing(mixed, 2);
  const mixedLive = family(true);
  const fallbackSettled = family(false); routedQuestion(fallbackSettled); finishing(fallbackSettled, 3);
  const fallbackLive = family(true);
  const archived = store.createRun({ title: 'archived fallback', task: 'a', workflow: 'quick-task', steps: [] });
  setRunStatus(store, archived.id, RUN_STATUS.done);
  store.appendEvent(archived.id, { type: 'text', text: 'archived history' });
  store.setArchived(archived.id, true);
  const worktreeRun = store.createRun({ title: 'fallback worktree', task: 'w', workflow: 'quick-task', steps: [] });
  const worktreePath = join(fallback, 'worktrees', worktreeRun.id);
  setRunStatus(store, worktreeRun.id, RUN_STATUS.done, { worktreePath, branch: `cez/${worktreeRun.id.slice(0, 8)}` });
  store.flush(); store.close();
  const fallbackIds = new Set([mixed.workerId, mixedLive.workerId, fallbackSettled.parentId, fallbackSettled.workerId,
    fallbackLive.parentId, fallbackLive.workerId, archived.id, worktreeRun.id]);
  return { legacy, mixed, mixedLive, fallbackSettled, fallbackLive, fallbackIds, worktreePath };
}

/** Move whole records and every run file of `ids` under `.ai/squawk/`. */
function split(ids: ReadonlySet<string>, worktreePath: string) {
  const records = readPersistedRuns(primary);
  seedRuns(primary, records.filter(run => !ids.has(run.id)));
  seedRuns(fallback, records.filter(run => ids.has(run.id)));
  mkdirSync(join(fallback, 'runs'), { recursive: true });
  for (const name of readdirSync(join(primary, 'runs'))) {
    if ([...ids].some(id => name.startsWith(`${id}.`) || name.startsWith(`${id}-`))) renameSync(join(primary, 'runs', name), join(fallback, 'runs', name));
  }
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(join(worktreePath, 'file.txt'), 'checkout bytes');
}

/** Every `.ai/squawk/` file and its bytes, SQLite coordination files aside. */
function fallbackBytes(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (!/-(?:wal|shm)$/.test(name)) out.set(relative(fallback, path), createHash('sha256').update(readFileSync(path)).digest('hex'));
    }
  };
  walk(fallback);
  return out;
}

function primaryIds(): string[] {
  const db = RunDatabase.openReadOnly(join(primary, RUNS_DB_FILE));
  if (!db) return [];
  try { return db.listRevisions().map(row => row.id); } finally { db.close(); }
}

it('boot, recovery, reconcilers and background sweeps never copy or change a fallback family', async () => {
  const fixture = buildFixture();
  split(fixture.fallbackIds, fixture.worktreePath);
  const before = fallbackBytes();
  // Any refusal by the database guard is a store-layer bypass: the test fails on it.
  const writable = vi.spyOn(ProjectRunConnection.prototype, 'assertWritable');
  const claimable = vi.spyOn(ProjectRunConnection.prototype, 'assertClaimable');
  const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

  const store = RunStore.open(primary, { keepLive: true });
  const manager = new RunManager(store, root, { createRunner, home: testHome(),
    semaphore: new WorkspaceSemaphore({ home: testHome(), initial: { maxParallel: 0 } }) });
  vi.spyOn(manager, 'continueRun').mockReturnValue({ ok: false, error: 'fixture launches no agent' });
  const project = { id: 'p', root };
  try {
    await manager.recover();
    manager.reconcileWorkerWaits();
    for (const f of [fixture.legacy, fixture.mixed, fixture.mixedLive, fixture.fallbackSettled, fixture.fallbackLive]) manager.reconcileWorkerWaits(f.parentId);
    store.setRepoHandle({ owner: 'acme', name: 'app' });
    const merged = new ArchiveOnMergeCoordinator({
      projects: async () => [project], enabled: async () => true, repository: async () => 'acme/app',
      withStore: async (_project, work) => work(store, id => manager.isActive(id), () => true),
      lookup: async (_root, identities) => identities.map(identity => ({ ...identity, mergedAt: '2026-11-01T00:00:00.000Z' })),
    });
    await merged.tick(); await merged.tick();
    const completions = new CompletionActionCoordinator({
      projects: async () => [project], withStore: async (_project, work) => work(store, () => true),
      forge: async () => undefined, head: async () => undefined,
    });
    await completions.tick();
    store.compressArchivedHistory();
    await store.historyIdle();
    await reclaimWorktrees(root, store, 0);
    await pruneOrphans(root, new Set(store.listRunIds()));
    store.archiveFinished(undefined, true);
    store.createRun({ title: 'triggers count retention', task: 'r', workflow: 'quick-task', steps: [] });
    store.flush();

    // Positive control: the same sweeps did act on the legacy-only family.
    expect(store.readEvents(fixture.legacy.workerId).some(event => event.type === 'human-ask-closed')).toBe(true);
    expect(store.getRun(fixture.legacy.parentId)?.archived).toBe(true);
    // Fallback and mixed families stay visible with their stored status.
    expect(store.getRun(fixture.fallbackLive.parentId)?.status).toBe(RUN_STATUS.running);
    expect(store.getRun(fixture.mixedLive.parentId)?.status).toBe(RUN_STATUS.running);
    expect(store.getRun(fixture.mixed.parentId)?.archived).toBe(false);
    expect(store.runOwnership(fixture.mixed.parentId)).toBe('fallback');
  } finally { manager.dispose(); store.close(); }

  expect(primaryIds().filter(id => fixture.fallbackIds.has(id))).toEqual([]);
  expect(fallbackBytes()).toEqual(before);
  expect(existsSync(fixture.worktreePath)).toBe(true);
  expect([...writable.mock.results, ...claimable.mock.results].filter(result => result.type === 'throw')).toEqual([]);
  expect(info.mock.calls.flat().join('\n')).not.toMatch(/Refused an automatic write/);
});

it('the database guard refuses an unauthorized fallback write loudly and allows only the adoption intent', () => {
  const fixture = buildFixture();
  split(fixture.fallbackIds, fixture.worktreePath);
  const before = fallbackBytes();
  const store = RunStore.open(primary, { keepLive: true });
  try {
    const db = (store as unknown as { db: RunDatabase }).db;
    const row = db.get(fixture.mixed.workerId)!;
    const upsert = { ...row, data: row.data.replace('historical worker', 'bypass') };
    expect(() => db.transaction({ upserts: [upsert], deletes: [] })).toThrow(/Refused an automatic write/);
    expect(() => db.transaction({ upserts: [], deletes: [fixture.fallbackSettled.parentId] })).toThrow(/Refused an automatic write/);
    const legacyRoot = db.get(fixture.mixed.parentId)!;
    expect(() => db.transaction({ upserts: [legacyRoot], deletes: [] })).toThrow(/Refused an automatic write/);
    expect(() => db.takeClaims({ session: 's', pid: process.pid, startToken: null }, [{ family: fixture.fallbackLive.parentId, expect: null }]))
      .toThrow(/Refused an automatic write/);
    expect(primaryIds().filter(id => fixture.fallbackIds.has(id))).toEqual([]);
    // The adoption intent copies the whole family first, so the same write then commits.
    db.transaction({ upserts: [upsert], deletes: [], adoptFallback: [fixture.mixed.parentId] });
    expect(primaryIds()).toEqual(expect.arrayContaining([fixture.mixed.parentId, fixture.mixed.workerId]));
    expect(store.isFallbackRun(fixture.mixed.workerId)).toBe(false);
  } finally { store.close(); }
  expect(fallbackBytes()).toEqual(before);
});
