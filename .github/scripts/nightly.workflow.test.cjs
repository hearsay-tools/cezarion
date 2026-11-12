const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');

const read = file => yaml.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', file), 'utf8'));

// The rehearsal takes the commit a release would take, verifies it with the release's
// own full suite, publishes it, and runs the release-candidate tests on the published
// package (hearsay-tools/cezarion#3212).
test('nightly rehearses the release on the newest verified commit', () => {
  const { jobs } = read('nightly.yml');
  const candidate = jobs.decide.steps.find(step => step.id === 'candidate');
  assert.match(candidate.with.script, /verifiedMainCommit/);
  assert.equal(jobs.decide.outputs.candidate, '${{ steps.candidate.outputs.sha }}');
  assert.equal(jobs.suite.uses, './.github/workflows/full-suite.yml');
  assert.equal(jobs.suite.with.ref, '${{ needs.decide.outputs.candidate }}');
  assert.deepEqual(jobs.nightly.needs, ['decide', 'suite']);
  assert.match(jobs.nightly.if, /needs\.suite\.result == 'success'/);
  assert.equal(jobs.nightly.steps[0].with.ref, '${{ needs.decide.outputs.candidate }}');
  assert.equal(jobs.rehearsal.uses, './.github/workflows/release-candidate-tests.yml');
  assert.equal(jobs.rehearsal.with.ref, '${{ needs.decide.outputs.candidate }}');
  assert.match(jobs.rehearsal.if, /dry_run != 'true'/);
});

test('a failed rehearsal files a release-blocker issue from a job that runs no candidate code', () => {
  const { jobs } = read('nightly.yml');
  assert.deepEqual(jobs.blocker.needs, ['decide', 'suite', 'nightly', 'rehearsal']);
  assert.match(jobs.blocker.if, /always\(\)/);
  assert.match(jobs.blocker.if, /contains\(join\(needs\.\*\.result, ' '\), 'failure'\)/);
  assert.match(jobs.blocker.steps.at(-1).with.script, /kind: 'rehearsal'/);
  assert.deepEqual(jobs.blocker.permissions, { contents: 'read', issues: 'write' });
  assert.equal(jobs.blocker.steps[0].with.ref, undefined, 'the blocker job checks out the trusted dispatch commit');
});

test('nightly publishes from a GitHub-hosted runner on main only, and only that job holds a credential', () => {
  const { jobs } = read('nightly.yml');
  const publish = jobs.nightly;
  // npm provenance needs a GitHub-hosted runner.
  assert.equal(publish['runs-on'], 'ubuntu-latest');
  assert.equal(publish.permissions['id-token'], 'write');
  for (const name of Object.keys(jobs).filter(name => name !== 'nightly')) {
    assert.doesNotMatch(JSON.stringify(jobs[name]), /id-token|NPM_TOKEN/, `${name} must not hold a publishing credential`);
  }
  for (const name of ['decide', 'nightly']) assert.match(jobs[name].if, /github\.ref == 'refs\/heads\/main'/);
});
