import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkerCollectedResult } from '@open-mercato/cezar-contract';
import type { RunRecord, RunStore } from '../runs/store.ts';
import { isAttachmentFileName, resolveAttachmentPath } from '../workflows/attachment-path.ts';
import { readOwnedDiff, verifyOwnedWorkspace } from './workspace.ts';

export const workerRevision = (run: RunRecord): number => run.delegation?.role === 'worker' ? run.delegation.executionRevision ?? 0 : 0;

/** Snapshot collection is deliberately read-only until the service rechecks lifecycle identity. */
export async function collectWorkerEvidence(repoRoot: string, store: RunStore, run: RunRecord): Promise<{ result: WorkerCollectedResult; diffSnapshot?: string }> {
  if (run.delegation?.role !== 'worker') throw Error('missing worker ownership');
  const delegation = run.delegation;
  const previous = store.readWorkerResult(delegation.parentRunId, run.id);
  const events = store.readEvents(run.id).filter(event => event.seq > (delegation.executionStartSeq ?? -1));
  let summary: WorkerCollectedResult['summary'] = { state: 'unavailable', reason: 'no-assistant-output' };
  for (const event of events) {
    const item = event.item as { kind?: string; role?: string; text?: string; parentItemId?: string } | undefined;
    const text = event.type === 'text' && !event.parentItemId ? event.text
      : event.type === 'item.completed' && item?.kind === 'message' && item.role === 'assistant' && item.parentItemId === undefined ? item.text : undefined;
    if (typeof text === 'string' && text.trim()) summary = { state: 'available', text: text.slice(0, 4000), source: 'assistant', seq: event.seq, truncated: text.length > 4000 };
  }
  const destroyed = delegation.destroy?.phase === 'complete';
  const lastExecutionOutcome = run.status === 'review' ? 'review-ready' : run.status === 'done' ? 'completed'
    : run.status === 'failed' ? 'failed' : run.status === 'cancelled' ? 'cancelled' : 'running';
  const settled = lastExecutionOutcome !== 'running' && store.readWorkerExecution(run.id)?.phase === 'complete';
  const historicalSha = previous?.head && 'sha' in previous.head ? previous.head.sha : undefined;
  let head: WorkerCollectedResult['head'] = { state: destroyed ? 'deleted' : 'unavailable', reason: 'missing', ...(historicalSha ? { sha: historicalSha } : {}) };
  let diff: WorkerCollectedResult['diff'] = { state: destroyed ? 'deleted' : 'unavailable', reason: 'missing' };
  let diffSnapshot: string | undefined;
  try {
    const workspace = await verifyOwnedWorkspace(repoRoot, run);
    const sha = await new Promise<string>((resolve, reject) => execFile('git', ['rev-parse', '--verify', 'HEAD^{commit}'],
      { cwd: workspace.path, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) throw Error('invalid HEAD');
    head = { state: 'available', sha };
  } catch { if (!destroyed) head = { state: 'unavailable', reason: 'unverified', ...(historicalSha ? { sha: historicalSha } : {}) }; }
  try {
    const observation = await readOwnedDiff(repoRoot, run);
    diffSnapshot = observation.diff;
    const snapshotId = randomUUID();
    diff = { state: 'available', snapshotId, path: store.workerResultSnapshotPath(delegation.parentRunId, run.id, snapshotId), truncated: observation.truncated };
  } catch { if (!destroyed) diff = { state: 'unavailable', reason: 'unverified' }; }
  // A retained snapshot guarantees bytes even after cleanup; live availability is represented by cleanup/workspace and HEAD.
  if (destroyed && previous?.diff.state === 'available') {
    const retained = store.readWorkerResultDiff(delegation.parentRunId, run.id);
    if (retained !== undefined) { diffSnapshot = retained; diff = { ...previous.diff, snapshotId: randomUUID() }; }
  }
  const dataDir = join(repoRoot, '.ai/cezar');
  const ids = new Set<string>();
  for (const event of store.readEvents(run.id)) {
    if (event.type !== 'image' || typeof event.url !== 'string') continue;
    const match = event.url.match(new RegExp(`^/api/(?:v1/)?runs/${run.id}/images/([^/]+)$`));
    if (match && isAttachmentFileName(match[1]!) && match[1]!.length <= 255) ids.add(match[1]!);
  }
  for (const input of delegation.context?.inputs ?? []) if (input.source.kind === 'parent-attachment') {
    const name = input.path.split('/').at(-1)!; if (isAttachmentFileName(name)) ids.add(name);
  }
  const items: Extract<WorkerCollectedResult['artifacts'], { state: 'available' }>['items'] = [...ids].slice(0, 32).map(id => {
    const path = join(dataDir, 'runs', `${run.id}-images`, id);
    if (resolveAttachmentPath(dataDir, run.id, id)) return { state: 'available', id, path };
    return existsSync(path) ? { state: 'unavailable', reason: 'unreadable', id, path } : { state: 'deleted', reason: 'missing', id, path };
  });
  return { result: {
    workerId: run.id, parentRunId: delegation.parentRunId, revision: workerRevision(run), observedAt: new Date().toISOString(),
    status: run.status, outcome: destroyed ? 'destroyed' : lastExecutionOutcome, lastExecutionOutcome,
    partial: !settled || run.status === 'failed' || run.status === 'cancelled', settled,
    ...(run.error ? { error: run.error.slice(0, 2000) } : {}),
    ...(run.runner ? { backend: run.runner } : {}), ...(run.model ? { model: run.model } : {}),
    baselineSha: delegation.workspace.baselineSha, workspace: delegation.workspace, cleanup: delegation.destroy?.phase ?? 'retained',
    summary, head, diff, artifacts: { state: 'available', items, truncated: ids.size > 32 },
  }, ...(diffSnapshot === undefined ? {} : { diffSnapshot }) };
}

/** History deletion retains observation bytes, not attachment files or live Git refs. */
export function revalidateRetainedWorkerResult(repoRoot: string, previous: WorkerCollectedResult): WorkerCollectedResult {
  const dataDir = join(repoRoot, '.ai/cezar');
  return { ...previous, observedAt: new Date().toISOString(),
    head: previous.head.state === 'available' ? { state: 'unavailable', reason: 'unverified', sha: previous.head.sha } : previous.head,
    diff: previous.diff.state === 'available' ? { ...previous.diff, snapshotId: randomUUID() } : previous.diff,
    artifacts: previous.artifacts.state !== 'available' ? previous.artifacts : { ...previous.artifacts,
      items: previous.artifacts.items.map(item => resolveAttachmentPath(dataDir, previous.workerId, item.id)
        ? { state: 'available', id: item.id, path: item.path }
        : existsSync(join(dataDir, 'runs', `${previous.workerId}-images`, item.id))
          ? { state: 'unavailable', reason: 'unreadable', id: item.id, path: item.path }
          : { state: 'deleted', reason: 'missing', id: item.id, path: item.path }),
    },
  };
}
