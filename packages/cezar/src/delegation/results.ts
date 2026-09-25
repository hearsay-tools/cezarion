import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkerCollectedResult } from '@open-mercato/cezar-contract';
import type { RunRecord, RunStore } from '../runs/store.ts';
import { isAttachmentFileName, resolveAttachmentPath } from '../workflows/attachment-path.ts';
import { readOwnedDiff, verifyOwnedWorkspace } from './workspace.ts';
import { artifactDirectory, listArtifacts, readArtifact } from '../artifacts/store.ts';

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
  const workspaceRemoved = !!delegation.destroy && !delegation.destroy.remaining.includes('worktree');
  const lastExecutionOutcome = run.status === 'review' ? 'review-ready' : run.status === 'done' ? 'completed'
    : run.status === 'failed' ? 'failed' : run.status === 'cancelled' ? 'cancelled' : 'running';
  const settled = lastExecutionOutcome !== 'running' && store.readWorkerExecution(run.id)?.phase === 'complete';
  const historicalSha = previous?.head && 'sha' in previous.head ? previous.head.sha : undefined;
  let head: WorkerCollectedResult['head'] = { state: workspaceRemoved ? 'deleted' : 'unavailable', reason: 'missing', ...(historicalSha ? { sha: historicalSha } : {}) };
  let diff: WorkerCollectedResult['diff'] = { state: workspaceRemoved ? 'deleted' : 'unavailable', reason: 'missing' };
  let diffSnapshot: string | undefined;
  try {
    const workspace = await verifyOwnedWorkspace(repoRoot, run);
    const sha = await new Promise<string>((resolve, reject) => execFile('git', ['rev-parse', '--verify', 'HEAD^{commit}'],
      { cwd: workspace.path, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) throw Error('invalid HEAD');
    head = { state: 'available', sha };
  } catch { if (!workspaceRemoved) head = { state: 'unavailable', reason: 'unverified', ...(historicalSha ? { sha: historicalSha } : {}) }; }
  try {
    const observation = await readOwnedDiff(repoRoot, run);
    diffSnapshot = observation.diff;
    const snapshotId = randomUUID();
    diff = { state: 'available', snapshotId, path: store.workerResultSnapshotPath(delegation.parentRunId, run.id, snapshotId), truncated: observation.truncated };
  } catch { if (!destroyed) diff = { state: 'unavailable', reason: 'unverified' }; }
  // A retained snapshot guarantees bytes after destroy or retention reclaim (#575).
  // Keep the `previous.diff.state === 'available'` check inline so TypeScript narrows the spread.
  if (diffSnapshot === undefined && previous?.revision === workerRevision(run) && previous.diff.state === 'available'
    && (destroyed || workspaceRemoved || !!run.worktreeReclaimedAt)) {
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
  const published = await listArtifacts(artifactDirectory(dataDir, run.id), run.id);
  const publishedItems = published.slice().reverse().map(item => ({ state: 'available' as const, id: `published:${item.id}`, path: join(artifactDirectory(dataDir, run.id), item.id, 'content') }));
  const items: Extract<WorkerCollectedResult['artifacts'], { state: 'available' }>['items'] = [...publishedItems, ...[...ids].map((id): Extract<WorkerCollectedResult['artifacts'], { state: 'available' }>['items'][number] => {
    const path = join(dataDir, 'runs', `${run.id}-images`, id);
    if (resolveAttachmentPath(dataDir, run.id, id)) return { state: 'available', id, path };
    return existsSync(path) ? { state: 'unavailable', reason: 'unreadable', id, path } : { state: 'deleted', reason: 'missing', id, path };
  })].slice(0, 32);
  return { result: {
    workerId: run.id, parentRunId: delegation.parentRunId, revision: workerRevision(run), observedAt: new Date().toISOString(),
    status: run.status, outcome: destroyed ? 'destroyed' : lastExecutionOutcome, lastExecutionOutcome,
    partial: !settled || run.status === 'failed' || run.status === 'cancelled', settled,
    ...(run.error ? { error: run.error.slice(0, 2000) } : {}),
    ...(run.runner ? { backend: run.runner } : {}), ...(run.model ? { model: run.model } : {}),
    baselineSha: delegation.workspace.baselineSha, workspace: { ...delegation.workspace, state: workspaceRemoved ? 'deleted' : head.state === 'available' ? 'available' : 'unavailable' }, cleanup: delegation.destroy?.phase ?? 'retained',
    summary, head, diff, artifacts: { state: 'available', items, truncated: ids.size + published.length > 32 },
  }, ...(diffSnapshot === undefined ? {} : { diffSnapshot }) };
}

/** History deletion retains observation bytes, not attachment files or live Git refs. */
export async function revalidateRetainedWorkerResult(repoRoot: string, previous: WorkerCollectedResult): Promise<WorkerCollectedResult> {
  const dataDir = join(repoRoot, '.ai/cezar');
  return { ...previous, observedAt: new Date().toISOString(),
    head: previous.head.state === 'available' ? { state: 'unavailable', reason: 'unverified', sha: previous.head.sha } : previous.head,
    diff: previous.diff.state === 'available' ? { ...previous.diff, snapshotId: randomUUID() } : previous.diff,
    artifacts: previous.artifacts.state !== 'available' ? previous.artifacts : { ...previous.artifacts,
      items: await Promise.all(previous.artifacts.items.map(async item => {
        if (item.id.startsWith('published:')) {
          const available = await readArtifact(artifactDirectory(dataDir, previous.workerId), previous.workerId, item.id.slice('published:'.length));
          return available ? { state: 'available' as const, id: item.id, path: item.path }
            : { state: 'deleted' as const, reason: 'missing' as const, id: item.id, path: item.path };
        }
        return resolveAttachmentPath(dataDir, previous.workerId, item.id)
          ? { state: 'available' as const, id: item.id, path: item.path }
          : existsSync(join(dataDir, 'runs', `${previous.workerId}-images`, item.id))
            ? { state: 'unavailable' as const, reason: 'unreadable' as const, id: item.id, path: item.path }
            : { state: 'deleted' as const, reason: 'missing' as const, id: item.id, path: item.path };
      })),
    },
  };
}
