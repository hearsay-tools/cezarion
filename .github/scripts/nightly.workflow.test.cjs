const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');

const read = file => yaml.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', file), 'utf8'));
const commands = job => (job.steps || []).map(step => step.run || '').join('\n');
const suite = job => (job.steps || []).find(step => /\bnpm test\b/.test(step.run || ''))?.run;

// The unsharded suite outgrew the nightly's single 20-minute job on 2026-10-06,
// and 14 nights timed out before anyone noticed (hearsay-tools/cezarion#1272).
// ci.yml's shard count, runner and bound are measured on every push, so the
// nightly reuses them rather than keeping its own estimate.
test('nightly shards the suite exactly as ci.yml does', () => {
  const nightly = read('nightly.yml'), ci = read('ci.yml');
  const shards = nightly.jobs.vitest;
  assert.deepEqual(shards.strategy.matrix.shard, ci.jobs.vitest.strategy.matrix.shard);
  assert.equal(shards['runs-on'], ci.jobs.vitest['runs-on']);
  // Nightly keeps the non-coverage path: same shards, command and 15-minute bound.
  assert.equal(shards['timeout-minutes'], 15);
  assert.equal(suite(shards), suite(ci.jobs.vitest).replace(/ \$\{\{.*?\}\}/g, ''));
  for (const [name, job] of Object.entries(nightly.jobs)) {
    if (name !== 'vitest') assert.equal(suite(job), undefined, `${name} must not run the whole suite in one job`);
  }
});

test('nightly publishes after the full gate, from a GitHub-hosted runner on main only', () => {
  const {jobs} = read('nightly.yml');
  const publish = jobs.nightly;
  const verification = Object.keys(jobs).filter(name => name !== 'decide' && name !== 'nightly');
  assert.deepEqual([...publish.needs].sort(), verification.sort());
  const gate = verification.map(name => commands(jobs[name])).join('\n');
  for (const command of ['npm run typecheck', 'npm run test:unit', 'npm run build', 'npm run test:package']) {
    assert.ok(gate.includes(command), `the nightly gate must run ${command}`);
  }
  // npm provenance needs a GitHub-hosted runner, and only the publish job holds a publishing credential.
  assert.equal(publish['runs-on'], 'ubuntu-latest');
  assert.equal(publish.permissions['id-token'], 'write');
  for (const name of Object.keys(jobs).filter(name => name !== 'nightly')) {
    assert.doesNotMatch(JSON.stringify(jobs[name]), /id-token|NPM_TOKEN/, `${name} must not hold a publishing credential`);
  }
  for (const name of ['decide', 'nightly']) assert.match(jobs[name].if, /github\.ref == 'refs\/heads\/main'/);
});
