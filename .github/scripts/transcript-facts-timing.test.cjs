const test = require('node:test');
const assert = require('node:assert/strict');

const timing = import('../../packages/cezar/scripts/transcript-facts-timing.mjs');

test('separates CPU, run-queue wait and residual blocked time', async () => {
  const { timingDelta } = await timing;
  assert.deepEqual(timingDelta({ at: 0, cpuMs: 10, queueWaitMs: 5 }, { at: 100, cpuMs: 12, queueWaitMs: 35 }),
    { elapsedMs: 100, mainThreadCpuMs: 2, queueWaitMs: 30, blockedMs: 68 });
});

test('does not invent scheduler evidence when procfs is absent', async () => {
  const { timingDelta } = await timing;
  assert.deepEqual(timingDelta({ at: 0, cpuMs: 10, queueWaitMs: null }, { at: 100, cpuMs: 12, queueWaitMs: null }),
    { elapsedMs: 100, mainThreadCpuMs: 2, queueWaitMs: null, blockedMs: null });
});

test('clamps residual skew from independently sampled clocks', async () => {
  const { timingDelta } = await timing;
  assert.equal(timingDelta({ at: 0, cpuMs: 0, queueWaitMs: 0 }, { at: 1, cpuMs: 1, queueWaitMs: 1 }).blockedMs, 0);
});

test('takes a finite current-thread CPU snapshot and optional scheduler snapshot', async () => {
  const { timingSnapshot } = await timing;
  const sample = timingSnapshot();
  assert.ok(Number.isFinite(sample.at));
  assert.ok(Number.isFinite(sample.cpuMs));
  assert.ok(sample.queueWaitMs === null || Number.isFinite(sample.queueWaitMs));
});
