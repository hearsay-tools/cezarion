const test = require('node:test');
const assert = require('node:assert/strict');

const timing = import('../../packages/cezar/scripts/transcript-facts-timing.mjs');

test('separates CPU, run-queue wait and residual blocked time', async () => {
  const { timingDelta } = await timing;
  assert.deepEqual(timingDelta({ at: 0, cpuMs: 10, queueAfterMs: 5 }, { at: 100, cpuMs: 12, queueBeforeMs: 35 }),
    { elapsedMs: 100, mainThreadCpuMs: 2, queueWaitMs: 30, blockedMs: 68 });
});

test('does not invent scheduler evidence when procfs is absent', async () => {
  const { timingDelta } = await timing;
  assert.deepEqual(timingDelta({ at: 0, cpuMs: 10, queueAfterMs: null }, { at: 100, cpuMs: 12, queueBeforeMs: null }),
    { elapsedMs: 100, mainThreadCpuMs: 2, queueWaitMs: null, blockedMs: null });
});

test('clamps residual skew from independently sampled clocks', async () => {
  const { timingDelta } = await timing;
  assert.equal(timingDelta({ at: 0, cpuMs: 0, queueAfterMs: 0 }, { at: 1, cpuMs: 1, queueBeforeMs: 1 }).blockedMs, 0);
});

test('takes a finite current-thread CPU snapshot and optional scheduler snapshot', async () => {
  const { timingSnapshot } = await timing;
  const sample = timingSnapshot();
  assert.ok(Number.isFinite(sample.at));
  assert.ok(Number.isFinite(sample.cpuMs));
  assert.ok(sample.queueBeforeMs === null || Number.isFinite(sample.queueBeforeMs));
});

test('excludes run-queue delay but keeps synchronous blocking and CPU', async () => {
  const { blockingBudget } = await timing;
  assert.deepEqual(blockingBudget({ elapsedMs: 120, mainThreadCpuMs: 2, queueWaitMs: 100 }, 20),
    { mode: 'scheduler-adjusted', blockingMs: 2 });
  assert.equal(blockingBudget({ elapsedMs: 120, mainThreadCpuMs: 2, queueWaitMs: 0 }, 20).blockingMs, 100);
  assert.equal(blockingBudget({ elapsedMs: 120, mainThreadCpuMs: 110, queueWaitMs: 0 }, 20).blockingMs, 110);
  assert.equal(blockingBudget({ elapsedMs: 120, mainThreadCpuMs: 2, queueWaitMs: 100 }).blockingMs, 20);
  assert.equal(blockingBudget({ elapsedMs: 120, mainThreadCpuMs: 2, queueWaitMs: 0 }).blockingMs, 120);
  assert.equal(blockingBudget({ elapsedMs: 1, mainThreadCpuMs: 0, queueWaitMs: 2 }).blockingMs, 0);
  assert.deepEqual(blockingBudget({ elapsedMs: 120, mainThreadCpuMs: 2, queueWaitMs: null }),
    { mode: 'cpu-only', blockingMs: 2 });
});

test('does not credit queue wait before the measured interval (B1)', async () => {
  const { timingSnapshot, timingDelta, blockingBudget } = await timing;
  let wall = 0;
  let queue = 0;
  let reads = 0;
  const readQueue = () => {
    const value = queue;
    if (reads++ === 0) { wall += 80; queue += 80; }
    return value;
  };
  const sources = { now: () => wall, readQueue, readCpu: () => ({ user: 0, system: 0 }) };
  const start = timingSnapshot(sources);
  wall += 60; // Synchronous off-CPU blocking inside the measured interval.
  const end = timingSnapshot(sources);
  const sample = timingDelta(start, end);
  assert.equal(sample.elapsedMs, 60);
  assert.equal(sample.queueWaitMs, 0);
  assert.equal(blockingBudget(sample).blockingMs, 60);
});

test('malformed schedstat data selects CPU-only mode through the real reader', async () => {
  const { readQueueWaitMs, timingSnapshot, timingDelta, blockingBudget } = await timing;
  for (const content of ['', '1', '1 nope 3', '1 Infinity 3', '1 -1 3']) {
    const readQueue = () => readQueueWaitMs({ read: () => content, platform: 'linux' });
    assert.equal(readQueue(), null, JSON.stringify(content));
    const start = timingSnapshot({ now: () => 0, readQueue, readCpu: () => ({ user: 0, system: 0 }) });
    const end = timingSnapshot({ now: () => 100, readQueue, readCpu: () => ({ user: 2000, system: 0 }) });
    assert.deepEqual(blockingBudget(timingDelta(start, end)), { mode: 'cpu-only', blockingMs: 2 });
  }
  assert.equal(readQueueWaitMs({ read: () => '1 2500000 3', platform: 'linux' }), 2.5);
});
