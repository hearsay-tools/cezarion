const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflowPath = path.join(__dirname, '..', 'workflows', 'release.yml');

function job(source, name) {
  const match = source.match(new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  [\\w-]+:\\n|(?![\\s\\S]))`, 'm'));
  assert.ok(match, `expected ${name} job`);
  return match[0];
}

const parsed = async () => (await import('yaml')).parse(fs.readFileSync(workflowPath, 'utf8'));

test('one candidate commit goes plan, suite, stage, candidate tests, then promotion', async () => {
  const { jobs } = await parsed();
  assert.equal(jobs.suite.uses, './.github/workflows/full-suite.yml');
  assert.equal(jobs.suite.if, "needs.plan.outputs.needs_suite == 'true'");
  assert.deepEqual(jobs.stage.needs, ['plan', 'suite']);
  assert.match(jobs.stage.if, /needs\.suite\.result == 'success' \|\| needs\.suite\.result == 'skipped'/);
  assert.equal(jobs.candidate.uses, './.github/workflows/release-candidate-tests.yml');
  assert.deepEqual(jobs.candidate.needs, ['plan', 'stage']);
  assert.equal(jobs.candidate.with.version, '${{ needs.plan.outputs.candidate }}');
  assert.equal(jobs.candidate.with.ref, '${{ needs.plan.outputs.source_sha }}');
  assert.equal(jobs.candidate.with.previous, '${{ needs.plan.outputs.previous }}');
  // No stable version is published before the tests of its published candidate pass.
  assert.deepEqual(jobs.release.needs, ['plan', 'candidate']);
  assert.match(jobs.release.if, /needs\.candidate\.result == 'success'/);
  for (const name of ['stage', 'release']) {
    const checkout = jobs[name].steps.find(step => step.name === 'Check out the candidate commit');
    assert.equal(checkout.with.ref, '${{ needs.plan.outputs.source_sha }}', `${name} builds the candidate commit`);
    assert.equal(checkout.with.path, 'source');
  }
});

test('the candidate stages under its own tag and the promotion publishes the same commit under the stable tag', async () => {
  const { jobs } = await parsed();
  const stage = jobs.stage.steps.find(step => step.id === 'release');
  const stageSteps = jobs.stage.steps.map(step => step.name);
  assert.equal(stageSteps.indexOf('Check the candidate tag'), stageSteps.indexOf('Publish the release candidate') - 1, 'the candidate tag is checked right before staging');
  assert.equal(stage.env.RELEASE_VERSION, '${{ needs.plan.outputs.candidate }}');
  assert.equal(stage.env.RELEASE_DIST_TAG, '${{ needs.plan.outputs.candidate_tag }}');
  const promote = jobs.release.steps.find(step => step.id === 'release');
  assert.equal(promote.name, 'Publish release');
  assert.equal(promote.env.RELEASE_VERSION, '${{ needs.plan.outputs.version }}');
  assert.equal(promote.env.RELEASE_DIST_TAG, '${{ needs.plan.outputs.stable_tag }}');
  for (const step of [stage, promote]) assert.equal(step.env.HSQ_RELEASE_ROOT, '${{ github.workspace }}/source');
  const steps = jobs.release.steps.map(step => step.name);
  assert.equal(steps.indexOf('Check the gates again'), steps.indexOf('Publish release') - 1, 'the gates are checked again right before promotion, after both builds');
  const gate = jobs.release.steps.find(step => step.name === 'Check the gates again');
  assert.equal(gate.env.VERSION, '${{ needs.plan.outputs.version }}');
  assert.equal(gate.env.STABLE_TAG, '${{ needs.plan.outputs.stable_tag }}');
  assert.ok(steps.indexOf('Publish release') < steps.indexOf('Install through the alias and boot'));
  const smoke = jobs.release.steps.find(step => step.id === 'alias_smoke');
  assert.equal(smoke.env.PACKAGE, '${{ steps.release.outputs.installName }}');
  assert.equal(jobs.release.outputs.alias_smoke, '${{ steps.alias_smoke.outcome }}');
  for (const name of ['Create GitHub Release', 'Open version-bump PR (patch/minor/major only)']) {
    const step = jobs.release.steps.find(entry => entry.name === name);
    assert.match(step.env.SOURCE_SHA, /needs\.plan\.outputs\.(source_sha|bump_sha)/, `${name} names the candidate, not the dispatch commit`);
  }
});

test('a failed candidate or promoted install files the release blocker', async () => {
  const { jobs } = await parsed();
  assert.deepEqual(jobs.blocker.needs, ['plan', 'candidate', 'release']);
  assert.match(jobs.blocker.if, /needs\.candidate\.result == 'failure'/);
  assert.match(jobs.blocker.if, /needs\.release\.outputs\.alias_smoke == 'failure'/);
  assert.deepEqual(jobs.blocker.permissions, { contents: 'read', issues: 'write' });
  for (const name of Object.keys(jobs).filter(name => name !== 'blocker')) {
    assert.notEqual(jobs[name].permissions?.issues, 'write', `${name} must not write issues`);
  }
});

test('OIDC and the production environment stay on the publishing jobs only', async () => {
  const { jobs } = await parsed();
  for (const [name, job] of Object.entries(jobs)) {
    const publishes = name === 'stage' || name === 'release';
    assert.equal(job.environment === 'production', publishes, `${name} production environment`);
    assert.equal(job.permissions?.['id-token'] === 'write', publishes, `${name} OIDC token`);
  }
});

test('the publish steps have no npm credential and authenticate via OIDC', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  for (const name of ['stage', 'release']) {
    const source = job(workflow, name);
    assert.doesNotMatch(source, /NODE_AUTH_TOKEN:/, `${name} must not set NODE_AUTH_TOKEN; npm authenticates with the job OIDC token`);
    assert.doesNotMatch(source, /secrets\.NPM_TOKEN/);
  }
});

test('snapshots, nightlies, and dist-tag cleanup still pass NPM_TOKEN', () => {
  const workflows = path.join(__dirname, '..', 'workflows');
  for (const file of ['ci.yml', 'nightly.yml', 'npm-preview-cleanup.yml']) {
    const source = fs.readFileSync(path.join(workflows, file), 'utf8');
    assert.ok(
      source.includes('NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}'),
      `${file} must keep the token: OIDC cannot cover dist-tag rm, and one trusted publisher cannot cover three workflows`,
    );
  }
});

// Branch contents and published release metadata are exercised through the actual
// workflow steps in release-finalization.test.cjs.


test('release App setup is checked before publish and token only reaches PR creation', async () => {
  const { parse } = await import('yaml');
  const w = parse(fs.readFileSync(workflowPath, 'utf8'));
  const steps = w.jobs.release.steps;
  const app = steps.find(s => s.id === 'release_app');
  assert.ok(app, 'release needs a short-lived App token');
  assert.match(app.uses, /^actions\/create-github-app-token@[a-f0-9]{40}$/);
  assert.equal(app.with['client-id'], '${{ vars.RELEASE_APP_CLIENT_ID }}');
  assert.equal(app.with['app-id'], undefined);
  assert.equal(app.with['permission-pull-requests'], 'write');
  assert.equal(app.with.repositories, '${{ github.event.repository.name }}');
  assert.ok(steps.indexOf(app) < steps.findIndex(s => s.name === 'Publish release'));
  const validate = steps.find(s => s.id === 'validate_release_app');
  assert.ok(validate && steps.indexOf(validate) < steps.indexOf(app));
  assert.match(validate.if, /needs.plan.outputs.record_bump == 'true'/);
  const consumers = steps.filter(s => JSON.stringify(s).includes('steps.release_app.outputs.token'));
  assert.equal(consumers.length, 1);
  assert.equal(consumers[0].id, 'bump_pr');
  assert.match(consumers[0].with.script, /prGithub/);
  assert.match(consumers[0].with.script, /nativeCi: true/);
});

test('release App preflight rejects missing setup and mismatched identity before publishing', async () => {
  const { parse } = await import('yaml');
  const { spawnSync } = require('node:child_process');
  const steps = parse(fs.readFileSync(workflowPath, 'utf8')).jobs.release.steps;
  const validate = steps.find(s => s.id === 'validate_release_app');
  const valid = { RELEASE_APP_CLIENT_ID: 'Iv23ct5zcAQpntZQdSfo', RELEASE_APP_BOT_LOGIN: 'cezar-release[bot]', HAS_PRIVATE_KEY: 'true' };
  const run = (step, env) => spawnSync('bash', ['-e', '-c', step.run], { env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.equal(run(validate, valid).status, 0);
  for (const change of [{RELEASE_APP_CLIENT_ID:''}, {RELEASE_APP_CLIENT_ID:'12345'}, {HAS_PRIVATE_KEY:'false'}, {RELEASE_APP_BOT_LOGIN:'human'}]) {
    const result = run(validate, { ...valid, ...change });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /docs\/publishing.md#release-app-setup/);
  }
  const identity = steps.find(s => s.name === 'Check release App identity');
  assert.ok(steps.indexOf(identity) < steps.findIndex(s => s.name === 'Publish release'));
  assert.equal(run(identity, { APP_SLUG: 'cezar-release', EXPECTED_LOGIN: valid.RELEASE_APP_BOT_LOGIN }).status, 0);
  assert.equal(run(identity, { APP_SLUG: 'another', EXPECTED_LOGIN: valid.RELEASE_APP_BOT_LOGIN }).status, 1);
});
