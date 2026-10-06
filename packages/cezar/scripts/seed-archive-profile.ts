/** Repro fixture for #657: 12 archiveable parents, 48 owned workers, 200 review rows.
 * Run only against an empty scratch repository:
 * `tsx packages/cezar/scripts/seed-archive-profile.ts <scratch-repo>`. */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { RunStore } from '../src/runs/store.ts';

const root = process.argv[2];
if (!root) throw new Error('Pass the path to an empty scratch repository');
const store = RunStore.open(join(root, '.ai/cezar'));
if (store.listRunSummaries().runs.length) throw new Error('Scratch repository already contains runs');

for (let p = 0; p < 12; p++) {
  const parent = store.createRun({
    title: `Profile parent ${p + 1}`, task: 'Task '.repeat(300), workflow: 'quick-task',
    steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
  });
  store.updateRun(parent.id, {
    status: 'done', finishedAt: '2026-01-01T00:00:00.000Z',
    delegation: { role: 'root', permissions: ['spawn'], receipts: [] },
  });
  for (let w = 0; w < 4; w++) {
    const workerId = randomUUID();
    const worker = store.createOwnedRun(
      {
        title: `Profile worker ${p + 1}-${w + 1}`, task: 'Worker task '.repeat(150),
        workflow: 'quick-task', runner: 'claude',
        steps: [{ id: 'task', name: 'Task', kind: 'agent' }],
      },
      parent.id,
      randomUUID(),
      {
        role: 'worker', permissions: [], parentRunId: parent.id,
        workspace: {
          ownerRunId: workerId, resourceId: randomUUID(), kind: 'owned-isolated',
          path: `/managed/${workerId}`, branch: `cez/${workerId.slice(0, 8)}`,
          baselineSha: 'a'.repeat(40),
        },
      },
      'a'.repeat(64),
    );
    store.updateRun(worker.id, { status: 'running' });
  }
}
for (let i = 0; i < 200; i++) {
  const extra = store.createRun({
    title: `Background task ${i + 1}`, task: 'Background task '.repeat(100),
    workflow: 'quick-task', steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
  });
  store.updateRun(extra.id, { status: 'review' });
}
console.log(JSON.stringify({ root, runs: store.listRunSummaries().runs.length, finished: 12 }));
store.close();
