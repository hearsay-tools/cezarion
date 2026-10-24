const assert = require('node:assert/strict');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');
const { readFileSync } = require('node:fs');
const { parse } = require('yaml');

const moduleUrl = pathToFileURL(join(__dirname, 'ci-test-sequencer.mjs')).href;

async function allocator() {
  return (await import(moduleUrl)).assignShards;
}

test('assignShards uses deterministic longest-processing-time bins', async () => {
  const assignShards = await allocator();
  const result = assignShards(
    ['slow.test.ts', 'medium.test.ts', 'small.test.ts', 'tiny.test.ts'],
    {
      'slow.test.ts': 10,
      'medium.test.ts': 6,
      'small.test.ts': 4,
      'tiny.test.ts': 1,
    },
    2,
  );

  assert.deepEqual(result, [
    ['slow.test.ts', 'tiny.test.ts'],
    ['medium.test.ts', 'small.test.ts'],
  ]);
});

test('assignShards includes new files with a positive fallback duration', async () => {
  const assignShards = await allocator();
  const result = assignShards(
    ['known.test.ts', 'new-a.test.ts', 'new-b.test.ts'],
    { 'known.test.ts': 12 },
    2,
  );

  assert.deepEqual(result, [
    ['known.test.ts', 'new-b.test.ts'],
    ['new-a.test.ts'],
  ]);
  assert.deepEqual([...result.flat()].sort(), ['known.test.ts', 'new-a.test.ts', 'new-b.test.ts']);
  assert.equal(result.flat().length, 3);
  assert.ok(result.every((shard) => shard.length > 0));
});

test('assignShards is stable when discovery order changes', async () => {
  const assignShards = await allocator();
  const durations = { 'a.test.ts': 5, 'b.test.ts': 4, 'c.test.ts': 3, 'd.test.ts': 2 };

  assert.deepEqual(
    assignShards(['d.test.ts', 'b.test.ts', 'a.test.ts', 'c.test.ts'], durations, 2),
    assignShards(['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts'], durations, 2),
  );
});

test('assignShards resolves equal weights by path and shard index', async () => {
  const assignShards = await allocator();
  assert.deepEqual(
    assignShards(['d', 'c', 'b', 'a'], { a: 1, b: 1, c: 1, d: 1 }, 2),
    [
      ['a', 'c'],
      ['b', 'd'],
    ],
  );
});

test('assignShards validates a positive integer shard count', async () => {
  const assignShards = await allocator();
  for (const count of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => assignShards(['a'], {}, count), /positive integer/);
  }
});

test('reserved work reduces the longest whole job without dropping test files', async () => {
  const assignShards = await allocator();
  const files = ['a', 'b', 'c', 'd'];
  const durations = { a: 6, b: 5, c: 4, d: 3 };
  const totals = bins => bins.map((bin, index) => bin.reduce((sum, file) => sum + durations[file], index === 0 ? 6 : 0));
  const ordinary = assignShards(files, durations, 2);
  const reserved = assignShards(files, durations, 2, [6, 0]);
  assert.deepEqual(totals(ordinary), [15, 9]);
  assert.deepEqual(totals(reserved), [11, 13]);
  assert.deepEqual(reserved.flat().sort(), files);
  assert.deepEqual(reserved, assignShards([...files].reverse(), durations, 2, [6, 0]));
  assert.deepEqual(ordinary, assignShards(files, durations, 2, [0, 0]));
});

test('invalid reserved work cannot silently corrupt shard assignment', async () => {
  const assignShards = await allocator();
  for (const costs of [null, [1], [-1, 0], [NaN, 0], [Infinity, 0], ['1', 0], Array(2)]) {
    assert.throws(() => assignShards(['a'], {}, 2, costs), /initial shard costs/);
  }
});

test('floor sequencing reserves fixed work and includes every discovered specification once', async () => {
  const { default: FloorSequencer } = await import('./node-floor-test-sequencer.mjs');
  const specifications = [
    { moduleId: '/repo/a.test.ts', project: { name: 'one' } },
    { moduleId: '/repo/a.test.ts', project: { name: 'two' } },
    { moduleId: '/repo/new.test.ts', project: { name: 'one' } },
  ];
  const selected = [];
  for (const index of [1, 2]) {
    const sequencer = new FloorSequencer({ config: { root: '/repo', maxWorkers: 4, shard: { index, count: 2 } } });
    assert.equal(sequencer.shardCosts[0], 155000 * 4);
    assert.equal(sequencer.shardCosts[1], 0);
    assert.ok(sequencer.durations['packages/cezar/src/workflows/ci-wait-failure-parity.test.ts'] > 0);
    selected.push(...await sequencer.shard(specifications));
  }
  assert.equal(selected.length, specifications.length);
  assert.deepEqual(new Set(selected), new Set(specifications));
  const invalid = new FloorSequencer({ config: { root: '/repo', maxWorkers: 0, shard: { index: 1, count: 2 } } });
  assert.throws(() => invalid.shardCosts, /positive integer maxWorkers/);
});

test('the actual floor workflow command loads a sequencer constructor', async () => {
  const { createVitest, parseCLI } = await import('vitest/node');
  const root = join(__dirname, '..', '..');
  const workflow = parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'));
  const step = workflow.jobs['node-floor'].steps.find(step => step.name === 'Run server and cockpit unit suites');
  const npmTest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts.test;
  for (const index of workflow.jobs['node-floor'].strategy.matrix.shard) {
    const command = step.run.replace('npm test --', npmTest).replaceAll('${{ matrix.shard }}', String(index));
    const { options } = parseCLI(command);
    const vitest = await createVitest('test', { ...options, root, watch: false });
    try {
      const Sequencer = vitest.config.sequence.sequencer;
      assert.equal(typeof Sequencer, 'function', 'Vitest must receive a constructor, not a CLI path string');
      const sequencer = new Sequencer(vitest);
      assert.deepEqual(sequencer.shardCosts, [155000 * 4, 0]);
      assert.deepEqual(vitest.config.shard, { index, count: 2 });
      assert.equal(vitest.projects.length, 4, 'the floor retains all four unit projects');
    } finally {
      await vitest.close();
    }
  }
});

test('sequencer shards cover every specification including duplicate module ids', async () => {
  const { default: Sequencer } = await import(moduleUrl);
  const specifications = [
    { moduleId: '/repo/a.test.ts', project: { name: 'one' } },
    { moduleId: '/repo/a.test.ts', project: { name: 'two' } },
    { moduleId: '/repo/new.test.ts', project: { name: 'one' } },
  ];
  const shard = async (input, index) => {
    const sequencer = new Sequencer({ config: { root: '/repo', shard: { index, count: 2 } } });
    return sequencer.shard(input);
  };
  const selected = [...(await shard(specifications, 1)), ...(await shard(specifications, 2))];

  assert.equal(selected.length, specifications.length);
  assert.deepEqual(new Set(selected), new Set(specifications));
  assert.deepEqual(
    (await shard(specifications, 1)).map((spec) => spec.project.name),
    (await shard([...specifications].reverse(), 1)).map((spec) => spec.project.name),
  );
  assert.equal(Object.hasOwn(Sequencer.prototype, 'sort'), false);
});
