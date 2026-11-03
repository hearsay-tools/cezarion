const test = require('node:test');
const assert = require('node:assert/strict');

const { defaultMaxWorkers, WORKER_MEMORY_BYTES } = require('./vitest-worker-count.cjs');

test('memory limits workers before the CPU ceiling', () => {
  assert.equal(defaultMaxWorkers(WORKER_MEMORY_BYTES * 7.9, 24), 3);
  assert.equal(defaultMaxWorkers(WORKER_MEMORY_BYTES * 100, 24), 24);
});

test('a 4 GiB container cannot use the host’s 29 GiB memory budget', () => {
  const hostFreeBytes = 29 * 1024 ** 3;
  const processAvailableBytes = 4 * 1024 ** 3;
  assert.equal(defaultMaxWorkers(hostFreeBytes, 24), 14);
  assert.equal(defaultMaxWorkers(processAvailableBytes, 24), 2);
});

test('worker count stays between one and the available CPUs', () => {
  for (const cpus of [1, 2, 4, 24]) {
    for (const memory of [0, 1, WORKER_MEMORY_BYTES - 1, WORKER_MEMORY_BYTES, WORKER_MEMORY_BYTES * 100]) {
      const workers = defaultMaxWorkers(memory, cpus);
      assert.ok(Number.isInteger(workers));
      assert.ok(workers >= 1 && workers <= cpus);
    }
  }
});

test('root config keeps Vitest CLI and environment worker overrides', async () => {
  const { createVitest } = await import('vitest/node');
  const cli = await createVitest('test', { watch: false, maxWorkers: 4, project: ['contract'] });
  try {
    assert.equal(cli.config.maxWorkers, 4);
  } finally {
    await cli.close();
  }
  const availableMemory = process.availableMemory;
  process.availableMemory = () => 4 * 1024 ** 3;
  try {
    const capped = await createVitest('test', { watch: false, project: ['contract'] });
    try {
      const { availableParallelism } = require('node:os');
      assert.equal(capped.config.maxWorkers, Math.min(2, availableParallelism()));
    } finally {
      await capped.close();
    }
  } finally {
    process.availableMemory = availableMemory;
  }
  const previous = process.env.VITEST_MAX_WORKERS;
  process.env.VITEST_MAX_WORKERS = '2';
  try {
    const env = await createVitest('test', { watch: false, project: ['contract'] });
    try {
      assert.equal(env.config.maxWorkers, 2);
    } finally {
      await env.close();
    }
  } finally {
    if (previous === undefined) delete process.env.VITEST_MAX_WORKERS;
    else process.env.VITEST_MAX_WORKERS = previous;
  }
});
