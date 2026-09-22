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

function step(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(
    new RegExp(`- name: ${escaped}\\n[\\s\\S]*?(?=\\n      - name: |\\n      - id: |(?![\\s\\S]))`),
  );
  assert.ok(match, `expected step "${name}"`);
  return match[0];
}

test('Verify runs in its own job so a publish failure cannot taint the Vitest report', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const verify = job(workflow, 'verify');
  const release = job(workflow, 'release');

  assert.match(verify, /npm test/,
    'the Vitest suite must run on the verify job');
  assert.doesNotMatch(verify, /node scripts\/release\.mjs/,
    'verify must not publish — that is what mixed a green suite into a red job');
  assert.match(release, /needs:\s*\[?verify\]?/,
    'publish must wait on verify so re-run-failed-jobs skips the suite');
  assert.doesNotMatch(release, /npm test/,
    'the release job must not re-run Vitest and append a second summary');
  assert.match(verify, /npm run typecheck/);
  assert.match(verify, /npm run test:unit/);
  assert.match(verify, /npm run build/,
    'build stays on verify so a compile break fails the green job, not publish');
});

test('OIDC and the production environment stay on the publish job only', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const verify = job(workflow, 'verify');
  const release = job(workflow, 'release');

  assert.doesNotMatch(verify, /environment:\s*production/,
    'verify must not require the production environment gate');
  assert.doesNotMatch(verify, /id-token:\s*write/,
    'verify does not publish and must not request the OIDC token');
  assert.match(release, /environment:\s*production/,
    'the trusted publisher is still pinned to production on the publish job');
  assert.match(release, /id-token:\s*write/,
    'trusted publishing still needs the job OIDC token on release');
});

test('the publish step has no npm credential and authenticates via OIDC', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  assert.match(workflow, /id-token: write/, 'trusted publishing needs the job OIDC token');
  assert.match(workflow, /environment: production/, 'the trusted publisher is pinned to production');

  const publish = step(job(workflow, 'release'), 'Publish release');
  assert.doesNotMatch(
    publish,
    /NODE_AUTH_TOKEN:/,
    'a stable release must not set NODE_AUTH_TOKEN; npm authenticates with the job OIDC token',
  );
  assert.doesNotMatch(publish, /secrets\.NPM_TOKEN/);
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
  assert.equal(app.with['permission-pull-requests'], 'write');
  assert.equal(app.with.repositories, '${{ github.event.repository.name }}');
  assert.ok(steps.indexOf(app) < steps.findIndex(s => s.name === 'Publish release'));
  const validate = steps.find(s => s.id === 'validate_release_app');
  assert.ok(validate && steps.indexOf(validate) < steps.indexOf(app));
  assert.match(validate.if, /inputs.bump != 'existing'/);
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
  const valid = { RELEASE_APP_ID: '12345', RELEASE_APP_BOT_LOGIN: 'cezar-release[bot]', HAS_PRIVATE_KEY: 'true' };
  const run = (step, env) => spawnSync('bash', ['-e', '-c', step.run], { env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.equal(run(validate, valid).status, 0);
  for (const change of [{RELEASE_APP_ID:''}, {RELEASE_APP_ID:'bad'}, {HAS_PRIVATE_KEY:'false'}, {RELEASE_APP_BOT_LOGIN:'human'}]) {
    const result = run(validate, { ...valid, ...change });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /docs\/publishing.md#release-app-setup/);
  }
  const identity = steps.find(s => s.name === 'Check release App identity');
  assert.ok(steps.indexOf(identity) < steps.findIndex(s => s.name === 'Publish release'));
  assert.equal(run(identity, { APP_SLUG: 'cezar-release', EXPECTED_LOGIN: valid.RELEASE_APP_BOT_LOGIN }).status, 0);
  assert.equal(run(identity, { APP_SLUG: 'another', EXPECTED_LOGIN: valid.RELEASE_APP_BOT_LOGIN }).status, 1);
});
