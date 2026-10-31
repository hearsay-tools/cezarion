/**
 * Family reconcile benchmark (hearsay-tools/cezarion#2378): what one reconcile pass over a settled
 * conversation root costs as its message count grows, with a fixed member count.
 *
 *   npm run bench:family-reconcile -w @wjarka/cezarion
 *   node --import tsx packages/cezar/scripts/benchmark-family-reconcile.ts --messages 50,300,1000 --baseline
 *
 * Flags: --messages (50,300,1000) --workers (2) --pad-kb (64, bytes added to each record's task so
 * a decode costs what a real record does) --samples (5) --baseline (run every pass without
 * `withReadCache`, as before #2378).
 *
 * Method:
 * - One process per run. For each size it seeds, through the public store API, a settled root
 *   with --workers settled workers and a conversation of that many progress messages between the
 *   root and its workers, then reopens the store so every member is a cold row.
 * - It runs one pass first: that pass writes the projections a settled family still lacks. Each
 *   sample then flushes (the written members leave memory) and times `reconcileWorkerWaits(root)`,
 *   the pass recovery runs for each conversation root, with `performance.now()`.
 * - "decodes" counts `JSON.parse` calls on a string longer than the pad, which only a record
 *   decode makes here, during the last timed pass.
 * - Linear in members means decodes stay at members + 0 as messages grow, and the pass time grows
 *   with the bytes of the root's ledger only.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import type { ConversationMessage } from '@open-mercato/cezar-contract';

process.env.CEZ_DRY_RUN = '1';
process.env.CEZ_DELEGATION = '1';
process.env.CEZ_AUTONAME = '0';
process.env.CEZ_PROJECT_WARMUP = '0';
const ownHome = process.env.CEZ_HOME ? undefined : mkdtempSync(join(tmpdir(), 'cez-bench-home-'));
if (ownHome) process.env.CEZ_HOME = ownHome;

const { values } = parseArgs({ options: {
  messages: { type: 'string', default: '50,300,1000' },
  workers: { type: 'string', default: '2' },
  'pad-kb': { type: 'string', default: '64' },
  samples: { type: 'string', default: '5' },
  baseline: { type: 'boolean', default: false },
} });
const sizes = values.messages.split(',').map(Number);
const workerCount = Number(values.workers), padBytes = Number(values['pad-kb']) * 1024, samples = Number(values.samples);
if (sizes.some(size => !Number.isInteger(size) || size < 1) || !Number.isInteger(workerCount) || workerCount < 1 || !(samples > 0)) {
  throw new Error('--messages takes whole numbers >= 1, --workers a whole number >= 1, --samples > 0');
}

const { RunStore } = await import('../src/runs/store.ts');
const { RunManager } = await import('../src/workflows/run.ts');

const pad = 'x'.repeat(padBytes);
let decodes = 0;
const parse = JSON.parse;
JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
  if (typeof text === 'string' && text.length > padBytes) decodes++;
  return parse(text, reviver);
}) as typeof JSON.parse;

function seed(dataDir: string, root: string, messageCount: number) {
  const store = RunStore.open(dataDir);
  const parent = store.createRun({ title: 'root', task: pad, workflow: 'quick-task', steps: [] });
  store.updateRun(parent.id, { delegation: { role: 'root', permissions: [], receipts: [] } });
  const workers = Array.from({ length: workerCount }, () => {
    const id = randomUUID();
    const worker = store.createOwnedRun({ title: 'worker', task: pad, workflow: 'quick-task', steps: [] }, parent.id, randomUUID(), {
      role: 'worker', parentRunId: parent.id, permissions: [], workspace: {
        ownerRunId: id, resourceId: randomUUID(), kind: 'owned-isolated',
        path: join(root, 'workers', id), branch: `cez/${id.slice(0, 8)}`, baselineSha: '0'.repeat(40),
      },
    }, 'a'.repeat(64));
    store.updateRun(worker.id, { status: 'done' });
    return worker.id;
  });
  store.updateRun(parent.id, { status: 'done' });
  const messages: ConversationMessage[] = Array.from({ length: messageCount }, (_, i) => {
    const worker = workers[i % workers.length]!;
    const [senderRunId, recipientRunId] = i % 2 ? [worker, parent.id] : [parent.id, worker];
    return { id: randomUUID(), senderRunId, recipientRunId, kind: 'progress', text: `progress ${i}`,
      createdAt: new Date(Date.UTC(2026, 9, 1) + i).toISOString(), requestHash: 'b'.repeat(64), state: 'accepted' };
  });
  store.commitConversation(parent.id, { messages, outcomes: [] });
  store.close();
  return parent.id;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const rows: string[] = [];
for (const size of sizes) {
  const root = mkdtempSync(join(tmpdir(), 'cez-bench-reconcile-'));
  try {
    const dataDir = join(root, '.ai/cezar');
    const rootId = seed(dataDir, root, size);
    const store = RunStore.open(dataDir, { keepLive: true });
    if (values.baseline) store.withReadCache = <T>(fn: () => T): T => fn();
    const manager = new RunManager(store, root);
    manager.reconcileWorkerWaits(rootId); // writes the missing projections once
    const times: number[] = [];
    for (let i = 0; i < samples; i++) {
      store.flush();
      decodes = 0;
      const start = performance.now();
      manager.reconcileWorkerWaits(rootId);
      times.push(performance.now() - start);
    }
    rows.push(`| ${size} | ${workerCount + 1} | ${decodes} | ${median(times).toFixed(1)} |`);
    manager.dispose();
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
}
JSON.parse = parse;
if (ownHome) rmSync(ownHome, { recursive: true, force: true });
console.log(`Family reconcile pass, ${values.baseline ? 'baseline (no read cache)' : 'withReadCache'}, ${values['pad-kb']} KB pad per record, median of ${samples}\n`);
console.log('| Messages per root | Members | Decodes | Pass ms |\n|---|---|---|---|');
for (const row of rows) console.log(row);
