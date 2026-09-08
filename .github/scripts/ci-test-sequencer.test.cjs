const assert = require('node:assert/strict');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');

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
