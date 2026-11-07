import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

test('nightly producers pin both release channel aliases to the same value', () => {
  for (const name of ['nightly', 'ci-benchmark']) {
    const workflow = parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
    const steps = Object.values(workflow.jobs).flatMap(job => job.steps ?? []);
    const producers = steps.filter(step => step.env?.CEZ_RELEASE_CHANNEL !== undefined);
    assert.equal(producers.length, 1);
    assert.equal(producers[0].env.CEZ_RELEASE_CHANNEL, 'nightly');
    assert.equal(producers[0].env.HSQ_RELEASE_CHANNEL, producers[0].env.CEZ_RELEASE_CHANNEL);
  }
});
