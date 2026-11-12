const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');

const read = file => yaml.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', file), 'utf8'));
// ci.yml expressions that only choose between PR, queue and dispatch paths.
const plain = command => command.replace(/ \$\{\{ \(github\.event_name[^}]*\}\}/g, '');
const commands = job => (job.steps || []).filter(step => step.run).map(step => plain(step.run.trim()));
// Every command of the copy runs in the ci.yml job, in the same order. ci.yml adds only
// its PR, queue and coverage plumbing around them.
function assertCopied(copy, original, name) {
  let at = 0;
  for (const command of commands(copy)) {
    at = commands(original).indexOf(command, at);
    assert.ok(at >= 0, `${name}: ${command} is not in the ci.yml job, or not in its order`);
  }
}

// full-suite.yml is the merge-group verification of ci.yml for a commit no merge queue
// verified (a release/** head, the Nightly rehearsal). A change to a ci.yml suite job
// changes this copy in the same commit.
test('the full suite runs the commands, shards and bounds of the ci.yml jobs it copies', () => {
  const ci = read('ci.yml').jobs, suite = read('full-suite.yml').jobs;
  for (const name of ['typecheck', 'build-and-package', 'vitest', 'cockpit-browser']) assertCopied(suite[name], ci[name], name);
  assert.ok(commands(suite.typecheck).includes('npm run lint') && commands(suite.typecheck).includes('npm run typecheck'));
  // The citation check is a diff check against HEAD^1; ci.yml skips it on pushes, and so does this copy.
  assert.ok(suite.typecheck.steps.some(step => step.name === 'Lint workflows'), 'workflow lint runs in the copy');
  for (const command of ['npm run test:unit', 'npm run test:package', 'npm run build']) assert.ok(commands(suite['build-and-package']).includes(command), command);
  assert.equal(commands(suite.vitest).filter(command => command.startsWith('npm test')).length, 1);
  assert.equal(commands(suite['cockpit-browser']).filter(command => command.includes('npm run test:e2e')).length, 1);
  for (const name of ['vitest', 'cockpit-browser']) {
    assert.deepEqual(suite[name].strategy.matrix, ci[name].strategy.matrix, `${name} shards`);
    assert.equal(suite[name].name, ci[name].name);
    assert.equal(suite[name]['runs-on'], ci[name]['runs-on']);
  }
  assert.equal(suite['cockpit-browser']['timeout-minutes'], ci['cockpit-browser']['timeout-minutes']);
  assert.equal(suite['build-and-package']['timeout-minutes'], ci['build-and-package']['timeout-minutes']);
});

test('the full suite verifies the commit it is given and requires every job', () => {
  const workflow = read('full-suite.yml');
  assert.deepEqual(Object.keys(workflow.on), ['workflow_call']);
  assert.equal(workflow.on.workflow_call.inputs.ref.required, true);
  for (const [name, job] of Object.entries(workflow.jobs).filter(([name]) => name !== 'verify')) {
    const checkout = job.steps.find(step => String(step.uses).startsWith('actions/checkout@'));
    assert.equal(checkout.with.ref, '${{ inputs.ref }}', `${name} checks out the given commit`);
    assert.equal(checkout.with['persist-credentials'], false);
  }
  assert.deepEqual(workflow.jobs.verify.needs.sort(), Object.keys(workflow.jobs).filter(name => name !== 'verify').sort());
  assert.equal(workflow.jobs.verify.if, 'always()');
  assert.deepEqual(workflow.permissions, { contents: 'read' });
});
