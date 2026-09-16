const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');

const repoRoot = path.join(__dirname, '..', '..');
const workflowPath = path.join(__dirname, '..', 'workflows', 'ci.yml');

function workflow() {
  return yaml.parse(fs.readFileSync(workflowPath, 'utf8'));
}

function stepsText(job) {
  return JSON.stringify(job.steps);
}

test('pull request CI runs npm run test:e2e as a Cockpit browser E2E job', () => {
  const job = workflow().jobs['cockpit-browser'];
  assert.ok(job, 'expected a cockpit-browser job');
  assert.equal(job.name, 'Cockpit browser E2E shard ${{ matrix.shard }}/4');
  assert.deepEqual(job.strategy.matrix.shard, [1, 2, 3, 4]);
  assert.equal(job.strategy['fail-fast'], false);
  assert.equal(job['runs-on'], 'ubuntu-latest');
  const setup = job.steps.find((step) => step.name === 'Set up Node.js');
  assert.equal(setup.with['node-version'], 'lts/*');
  assert.equal(setup.with['check-latest'], true);
  const steps = stepsText(job);
  assert.ok(steps.includes('npm run test:e2e -- --shard=${{ matrix.shard }}/4'));
  assert.match(steps, /require-e2e-passed\.cjs/);
});

test('packaged CLI E2E and cockpit browser E2E stay separate named checks', () => {
  const ci = workflow();
  const packaged = ci.jobs['build-and-package'];
  const cockpit = ci.jobs['cockpit-browser'];
  assert.match(stepsText(packaged), /Run packaged CLI E2E tests/);
  assert.match(stepsText(packaged), /npm run test:package/);
  assert.doesNotMatch(stepsText(packaged), /npm run test:e2e/);
  assert.match(cockpit.name, /^Cockpit browser E2E shard/);
  assert.notEqual(packaged.name, cockpit.name);
  assert.notEqual(cockpit.name, 'Run packaged CLI E2E tests');
});

test('the required aggregate depends on the cockpit browser job', () => {
  const verify = workflow().jobs.verify;
  assert.equal(verify.name, 'Unit, build, E2E, and package');
  assert.ok(Array.isArray(verify.needs) && verify.needs.includes('cockpit-browser'));
  const gate = stepsText(verify);
  assert.match(gate, /needs\['cockpit-browser'\]\.result|needs\.cockpit-browser\.result/);
});

test('bot-authored release/v* PRs skip Vitest and cockpit E2E keyed on PR author', () => {
  const ci = workflow();
  const bump =
    "github.event_name == 'pull_request' && startsWith(github.head_ref, 'release/v') && github.event.pull_request.user.login == 'github-actions[bot]'";
  assert.match(ci.jobs.vitest.if, new RegExp(bump.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(ci.jobs['cockpit-browser'].if, new RegExp(bump.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const verifyEnv = ci.jobs.verify.steps.find((step) => step.name === 'Require every verification job').env;
  assert.equal(verifyEnv.BUMP_PR, `\${{ ${bump} }}`);
  assert.doesNotMatch(ci.jobs.vitest.if, /github\.actor/);
  assert.doesNotMatch(ci.jobs['cockpit-browser'].if, /github\.actor/);
  assert.doesNotMatch(verifyEnv.BUMP_PR, /github\.actor/);
});

test('CI runs on push to main and still does not publish snapshots from main', () => {
  const ci = workflow();
  assert.ok(ci.on.push.branches.includes('main'));
  assert.ok(ci.on.push.branches.includes('develop'));
  assert.equal(ci.concurrency.group, 'ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}');
  assert.equal(ci.concurrency['cancel-in-progress'], true);
  const publishIf = ci.jobs['publish-snapshot'].if;
  assert.match(publishIf, /github\.ref == 'refs\/heads\/develop'/);
  assert.doesNotMatch(publishIf, /heads\/main/);
});

test('verification bindings name packaged and cockpit E2E separately', () => {
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, '.ai/agentic.config.json'), 'utf8'));
  const commands = config.validation.commands;
  assert.ok(commands.includes('npm run test:package'));
  assert.ok(commands.includes('npm run test:e2e'));
  const claude = fs.readFileSync(path.join(repoRoot, 'CLAUDE.md'), 'utf8');
  const row = claude.match(/^\| Verification \|([^|]+)\|/m);
  assert.ok(row, 'expected a Verification bindings row');
  assert.match(row[1], /npm run test:package/);
  assert.match(row[1], /npm run test:e2e/);
});
