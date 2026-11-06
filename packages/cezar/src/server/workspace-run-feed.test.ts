import { EventEmitter } from 'node:events';
import { workspaceReadyEventSchema, workspaceRunDeletedEventSchema, workspaceRunSummaryEventSchema } from '@open-mercato/cezar-contract/workspace-events';
import { toRunSummary, type ProcessUsage, type RunSummary } from '@open-mercato/cezar-contract/runs';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../runs/store.ts';
import type { ProjectContext } from './project-context.ts';
import { createWorkspaceRunFeed, relationshipsDigest, type WorkspaceRunFeedDeps } from './workspace-run-feed.ts';

class FakeStore extends EventEmitter {
  readonly runs = new Map<string, RunRecord>();
  getRun(id: string): RunRecord | undefined { return this.runs.get(id); }
  put(run: RunRecord): void { this.runs.set(run.id, run); this.emit('run', run); }
  remove(id: string): void { this.runs.delete(id); this.emit('deleted', id); }
}

const record = (id: string, over: Partial<RunRecord> = {}): RunRecord => ({
  id, title: id, workflow: 'quick-task', task: 't', status: RUN_STATUS.running, createdAt: '2026-11-06T10:00:00.000Z',
  tokensUsed: 0, archived: false, steps: [], ...over,
} as RunRecord);

const SAMPLE: ProcessUsage = { cpuPct: 5, rssBytes: 1024, procCount: 1 };

function harness() {
  const boot = new FakeStore();
  const built = new Map<string, FakeStore>();
  const builtListeners = new Set<(ctx: ProjectContext) => void>();
  const busListeners = new Set<(event: string, data: unknown) => void>();
  const usageListeners = new Set<(usage: Record<string, ProcessUsage>) => void>();
  let sampled: Record<string, ProcessUsage> = {};
  const deps: WorkspaceRunFeedDeps = {
    bootStore: boot,
    contexts: {
      ids: () => [...built.keys()],
      peek: (id) => (built.has(id) ? { id, store: built.get(id) } as unknown as ProjectContext : undefined),
      onContextBuilt: (listener) => { builtListeners.add(listener); return () => builtListeners.delete(listener); },
    },
    onWorkspaceEvent: (listener) => { busListeners.add(listener); return () => busListeners.delete(listener); },
    onUsage: (listener) => { usageListeners.add(listener); return () => usageListeners.delete(listener); },
    allUsage: () => sampled,
    withLiveUsage: (summary: RunSummary) => (sampled[summary.id] ? { ...summary, usage: sampled[summary.id] } : summary),
  };
  const feed = createWorkspaceRunFeed(deps);
  const open = (mode: 'full' | 'summary', bootProject = 'boot') => {
    const frames: Array<{ event: string; data: string }> = [];
    const detach = feed.connect(bootProject, mode, (event, data) => frames.push({ event, data }));
    return { frames, detach, ready: feed.seq() };
  };
  return {
    feed, boot, open, usageListeners,
    build(id: string): FakeStore {
      const store = new FakeStore();
      built.set(id, store);
      for (const listener of builtListeners) listener({ id, store } as unknown as ProjectContext);
      return store;
    },
    remove(id: string): void { for (const listener of busListeners) listener('project-removed', { id }); },
    tick(usage: Record<string, ProcessUsage>): void {
      sampled = usage;
      for (const listener of usageListeners) listener(usage);
    },
    stopSampling(): void { sampled = {}; },
  };
}

describe('workspace run feed (hearsay-tools/cezarion#2730)', () => {
  it('numbers run and delete frames contiguously across projects, from the ready seq on', () => {
    const h = harness();
    const early = h.build('early');
    const first = h.open('summary');
    expect(first.ready).toBe(0);
    const late = h.build('late');
    h.boot.put(record('a'));
    early.put(record('b'));
    late.put(record('c'));
    late.remove('c');

    const second = h.open('summary');
    expect(second.ready).toBe(4);
    h.boot.put(record('a', { status: RUN_STATUS.done }));

    const seqs = first.frames.map((frame) => (JSON.parse(frame.data) as { seq: number }).seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
    expect(first.frames.map((frame) => (JSON.parse(frame.data) as { project: string }).project)).toEqual(['boot', 'early', 'late', 'late', 'boot']);
    expect(second.frames.map((frame) => (JSON.parse(frame.data) as { seq: number }).seq)).toEqual([5]);
    expect(workspaceRunDeletedEventSchema.parse(JSON.parse(first.frames[3]!.data))).toEqual({ project: 'late', seq: 4, id: 'c' });
  });

  it('sends exactly the index row: the live usage sample laid over toRunSummary, validated by the contract', () => {
    const h = harness();
    const connection = h.open('summary');
    h.tick({ a: SAMPLE });
    const run = record('a', { delegation: undefined, title: 'With usage' });
    h.boot.put(run);
    const frame = connection.frames.find((entry) => entry.event === 'run-summary');
    const payload = workspaceRunSummaryEventSchema.parse(JSON.parse(frame!.data));
    expect(payload).toEqual({ project: 'boot', seq: 1, run: { ...toRunSummary(run), usage: SAMPLE }, relationships: relationshipsDigest(run) });
    expect(frame!.data).not.toContain('"task"');
  });

  it('builds each frame once per mode and keeps the legacy frames unchanged', () => {
    const h = harness();
    const full = h.open('full');
    const summary = h.open('summary');
    const other = h.open('summary');
    const run = record('a');
    h.boot.put(run);
    h.boot.remove('a');
    expect(full.frames).toEqual([
      { event: 'run', data: JSON.stringify({ ...run, project: 'boot' }) },
      { event: 'run-deleted', data: JSON.stringify({ id: 'a', project: 'boot' }) },
    ]);
    expect(summary.frames.map((frame) => frame.event)).toEqual(['run-summary', 'run-deleted']);
    expect(other.frames[0]!.data).toBe(summary.frames[0]!.data);
  });

  it('clears a stopped project once in summary mode and never in legacy mode', () => {
    const h = harness();
    const full = h.open('full');
    const summary = h.open('summary');
    h.boot.runs.set('a', record('a'));
    h.tick({ a: SAMPLE });
    h.tick({});
    h.tick({});
    expect(full.frames).toEqual([{ event: 'usage', data: JSON.stringify({ project: 'boot', usage: { a: SAMPLE } }) }]);
    expect(summary.frames).toEqual([
      { event: 'usage', data: JSON.stringify({ project: 'boot', usage: { a: SAMPLE } }) },
      { event: 'usage', data: JSON.stringify({ project: 'boot', usage: {} }) },
    ]);
  });

  it('clears usage on the run event when the sampler stopped with the last run, without waiting for a tick', () => {
    const h = harness();
    const summary = h.open('summary');
    h.boot.runs.set('a', record('a'));
    h.tick({ a: SAMPLE });
    // The last process ended: the sampler stops ticking, and the run's record update follows.
    h.stopSampling();
    h.boot.put(record('a', { status: RUN_STATUS.done }));
    expect(summary.frames.map((frame) => [frame.event, JSON.parse(frame.data).usage])).toEqual([
      ['usage', { a: SAMPLE }], ['run-summary', undefined], ['usage', {}],
    ]);
  });

  it('holds the module-global usage subscription only while a connection is open', () => {
    const h = harness();
    expect(h.usageListeners.size).toBe(0);
    const a = h.open('summary');
    const b = h.open('full');
    expect(h.usageListeners.size).toBe(1);
    a.detach();
    expect(h.usageListeners.size).toBe(1);
    b.detach();
    expect(h.usageListeners.size).toBe(0);
  });

  it('detaches a removed project and attaches its rebuilt store under the same id', () => {
    const h = harness();
    const old = h.build('other');
    const connection = h.open('summary');
    h.remove('other');
    old.put(record('stale'));
    const rebuilt = h.build('other');
    rebuilt.put(record('fresh'));
    expect(connection.frames.map((frame) => JSON.parse(frame.data).run.id)).toEqual(['fresh']);
  });

  it('keeps the boot store under one id when a later connection resolves its registered id', () => {
    const h = harness();
    const first = h.open('full', 'boot-slug');
    h.open('full', 'boot');
    h.boot.put(record('a'));
    expect(first.frames.map((frame) => JSON.parse(frame.data).project)).toEqual(['boot']);
  });

  it('digests only what the relationships route renders', () => {
    const worker = record('w', {
      delegation: {
        role: 'worker', parentRunId: '0f1cbcbf-84b2-4978-8381-c9dfbe9339b5', permissions: [],
        workspace: {
          ownerRunId: '0f1cbcbf-84b2-4978-8381-c9dfbe9339b5', resourceId: 'a45eb6fd-be26-4ebc-9b96-8f1c4b7607cb',
          kind: 'owned-isolated', path: '/tmp/w', branch: 'cez/w', baselineSha: 'a'.repeat(40),
        },
      },
    } as Partial<RunRecord>);
    const digest = relationshipsDigest(worker);
    expect(relationshipsDigest({ ...worker, tokensUsed: 99, title: 'renamed' })).toBe(digest);
    expect(relationshipsDigest({ ...worker, status: RUN_STATUS.done })).not.toBe(digest);
    expect(relationshipsDigest({ ...worker, currentStepId: 'review' })).not.toBe(digest);
    expect(relationshipsDigest({ ...worker, destroyRetry: { attempts: 1, nextAt: '2026-11-06T10:00:00.000Z' } })).not.toBe(digest);
    expect(workspaceReadyEventSchema.safeParse({ generation: 'g', seq: 0 }).success).toBe(true);
  });
});
