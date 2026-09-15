const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('cockpit config separates heavy suites and covers every discovered spec deterministically', async () => {
  const { createVitest, BaseSequencer } = await import('vitest/node');
  const ctx = await createVitest('test', {
    config: path.resolve(__dirname, '../../packages/web/e2e/vitest.config.ts'),
  });
  try {
    const specs = await ctx.globTestSpecifications();
    const Sequencer = ctx.config.sequence.sequencer;
    const partition = async (input) => Promise.all([1, 2, 3, 4].map((index) => {
      const sequencer = new Sequencer({ config: { ...ctx.config, shard: { index, count: 4 } } });
      return sequencer.shard(input);
    }));
    const shards = await partition(specs);
    const containing = (name) => shards.findIndex((shard) => shard.some((s) => path.basename(s.moduleId) === name));
    assert.notEqual(containing('github.e2e.ts'), -1);
    assert.notEqual(containing('touch-targets.e2e.ts'), -1);
    assert.notEqual(containing('github.e2e.ts'), containing('touch-targets.e2e.ts'));
    assert.equal(shards.flat().length, specs.length);
    assert.deepEqual(new Set(shards.flat()), new Set(specs));
    assert.deepEqual(await partition([...specs].reverse()), shards);
    // Only allocation changes: local and within-shard execution keep Vitest's sort.
    assert.equal(Sequencer.prototype.sort, BaseSequencer.prototype.sort);
    assert.equal(ctx.config.fileParallelism, false);

    const added = { ...specs[0], moduleId: path.join(ctx.config.root, 'brand-new.e2e.ts') };
    const reduced = [specs[0], added];
    const sequencer = new Sequencer({ config: { ...ctx.config, shard: { index: 1, count: 1 } } });
    const selected = await sequencer.shard(reduced);
    assert.equal(selected.length, 2);
    assert.deepEqual(new Set(selected), new Set(reduced));
  } finally {
    await ctx.close();
  }
});
