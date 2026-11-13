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
    const githubFiles = ['github-core.e2e.ts', 'github-layout.e2e.ts', 'github-states.e2e.ts', 'github-pr-review.e2e.ts'];
    const weights = new Sequencer(ctx).durations;
    for (const file of githubFiles) {
      assert.notEqual(containing(file), -1, `${file} is discovered`);
      assert.ok(weights[file] > 0, `${file} has a measured weight`);
    }
    const threadFiles = ['task-thread-transcript.e2e.ts', 'task-thread-session.e2e.ts', 'task-thread-layout.e2e.ts'];
    for (const file of threadFiles) {
      assert.notEqual(containing(file), -1, `${file} is discovered`);
      assert.ok(weights[file] > 0, `${file} has a measured weight`);
    }
    assert.notEqual(containing('touch-targets.e2e.ts'), -1);
    assert.ok(new Set(githubFiles.map(containing)).size > 1, 'GitHub cases can run in separate lanes');
    assert.equal(shards.flat().length, specs.length);
    assert.deepEqual(new Set(shards.flat()), new Set(specs));
    assert.deepEqual(await partition([...specs].reverse()), shards);
    // Default execution keeps Vitest's order; shuffle retains the same shard members.
    assert.deepEqual(await new Sequencer(ctx).sort(specs), await new BaseSequencer(ctx).sort(specs));
    const shuffled = (input, seed) => {
      const sequencer = new Sequencer(Object.create(ctx, {
        config: { value: { ...ctx.config, sequence: { ...ctx.config.sequence, shuffle: true, seed } } },
      }));
      sequencer.shuffleFiles = true;
      return sequencer.sort(input);
    };
    const first = await shuffled(specs, 2511001);
    assert.deepEqual((await shuffled([...specs].reverse(), 2511001)).map(s => s.moduleId), first.map(s => s.moduleId));
    assert.notDeepEqual((await shuffled(specs, 2511002)).map(s => s.moduleId), first.map(s => s.moduleId));
    assert.deepEqual(new Set(first), new Set(specs));
    for (const shard of shards) {
      assert.deepEqual(new Set(await shuffled(shard, 2511001)), new Set(shard));
    }
    assert.equal(ctx.config.fileParallelism, false);
    assert.ok(ctx.config.setupFiles.some((file) => path.basename(file) === 'fetch-setup.mjs'));

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

for (const [flag, files] of [
  ['--sequence.shuffle', true],
  ['--sequence.shuffle.files', true],
  ['--sequence.shuffle.tests', false],
]) {
  test(`cockpit config preserves file shuffle intent for ${flag}`, async () => {
    const { createVitest, BaseSequencer, parseCLI } = await import('vitest/node');
    const previous = process.argv;
    process.argv = [previous[0], 'vitest', flag, '--sequence.seed=123'];
    let ctx;
    try {
      const { options } = parseCLI(['vitest', flag, '--sequence.seed=123']);
      ctx = await createVitest('test', {
        ...options,
        config: path.resolve(__dirname, '../../packages/web/e2e/vitest.config.ts'),
      });
      const specs = await ctx.globTestSpecifications();
      const sequencer = new ctx.config.sequence.sequencer(ctx);
      assert.equal(sequencer.shuffleFiles, files);
      const result = await sequencer.sort(specs);
      if (files) {
        assert.deepEqual((await sequencer.sort([...specs].reverse())).map(s => s.moduleId), result.map(s => s.moduleId));
      } else {
        assert.deepEqual(result.map(s => s.moduleId), (await new BaseSequencer(ctx).sort(specs)).map(s => s.moduleId));
      }
    } finally {
      process.argv = previous;
      await ctx?.close();
    }
  });
}
