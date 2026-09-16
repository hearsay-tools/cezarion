const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
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

function runShell(command, env = {}) {
  return spawnSync('bash', ['-c', command], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function runClassification({ apiOutput, apiFails = false, classifierFails = false, eventName = 'pull_request' }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cezar-ci-workflow-'));
  const outputPath = path.join(tempDir, 'github-output');
  const ghPath = path.join(tempDir, 'gh');
  const apiCallMarker = path.join(tempDir, 'gh-called');
  const classifierPath = path.join(tempDir, '.github', 'scripts', 'change-surface.cjs');
  fs.mkdirSync(path.dirname(classifierPath), { recursive: true });
  fs.writeFileSync(classifierPath, classifierFails
    ? 'process.exit(1);\n'
    : fs.readFileSync(path.join(repoRoot, '.github', 'scripts', 'change-surface.cjs')));
  fs.writeFileSync(ghPath, apiFails
    ? '#!/bin/sh\nexit 1\n'
    : `#!/bin/sh\ntouch "$GH_CALL_MARKER"\nprintf '%s\\n' ${(Array.isArray(apiOutput) ? apiOutput : [apiOutput]).map((record) => JSON.stringify(record)).join(' ')}\n`);
  fs.chmodSync(ghPath, 0o755);

  try {
    const step = workflow().jobs['change-surface'].steps.find((item) => item.id === 'classify');
    assert.ok(step, 'expected a change-surface classification step');
    const result = runShell(step.run, {
      EVENT_NAME: eventName,
      GITHUB_OUTPUT: outputPath,
      GITHUB_REPOSITORY: 'wjarka/cezar',
      GITHUB_WORKSPACE: tempDir,
      GH_CALL_MARKER: apiCallMarker,
      PATH: `${tempDir}:${process.env.PATH}`,
      PR_NUMBER: '42',
    });
    const output = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
    return { result, output, apiCalled: fs.existsSync(apiCallMarker) };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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

test('CI classifies pull request changes from a trusted base checkout', () => {
  const ci = workflow();
  const job = ci.jobs['change-surface'];
  assert.ok(job, 'expected a change-surface job');
  assert.deepEqual(job.permissions, { contents: 'read', 'pull-requests': 'read' });
  assert.equal(job.outputs.surface, '${{ steps.classify.outputs.surface }}');
  const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.ok(checkout, 'expected a checkout step');
  assert.equal(checkout.if, "github.event_name == 'pull_request'");
  assert.equal(checkout.with.ref, '${{ github.event.pull_request.base.sha }}');
  assert.equal(checkout.with['persist-credentials'], false);
  const classify = job.steps.find((step) => step.id === 'classify');
  assert.ok(classify, 'expected an output-producing classify step');
  assert.match(classify.run, /gh api --paginate --jq '\.\[\]\.filename \| @json' "repos\/\$GITHUB_REPOSITORY\/pulls\/\$PR_NUMBER\/files"/);
  assert.match(classify.run, /node [^\n]*\.github\/scripts\/change-surface\.cjs/);
  assert.match(classify.run, /surface=full-matrix/);
  assert.match(classify.run, /if ! files=/);
  assert.match(classify.run, /if ! surface=/);
});

test('change-surface fails closed when the API or classifier fails', () => {
  const docsOnly = runClassification({ apiOutput: '"README.md"' });
  assert.equal(docsOnly.result.status, 0, docsOnly.result.stderr);
  assert.equal(docsOnly.output, 'surface=docs-only\n');

  const mixed = runClassification({ apiOutput: ['"README.md"', '"src/app.js"'] });
  assert.equal(mixed.result.status, 0, mixed.result.stderr);
  assert.equal(mixed.output, 'surface=full-matrix\n');

  const apiFailure = runClassification({ apiFails: true });
  assert.equal(apiFailure.result.status, 0, apiFailure.result.stderr);
  assert.equal(apiFailure.output, 'surface=full-matrix\n');

  const classifierFailure = runClassification({ apiOutput: '"README.md"', classifierFails: true });
  assert.equal(classifierFailure.result.status, 0, classifierFailure.result.stderr);
  assert.equal(classifierFailure.output, 'surface=full-matrix\n');

  const push = runClassification({ apiOutput: ['"README.md"'], eventName: 'push' });
  assert.equal(push.result.status, 0, push.result.stderr);
  assert.equal(push.output, 'surface=full-matrix\n');
  assert.equal(push.apiCalled, false);
});

test('classification is not a path filter and build-and-package stays unconditional', () => {
  const ci = workflow();
  assert.equal(ci.on.pull_request.paths, undefined);
  assert.equal(ci.on.push.paths, undefined);
  assert.equal(ci.jobs['build-and-package'].if, undefined);
  assert.equal(ci.jobs['build-and-package'].needs, undefined);
});

test('test jobs require full-matrix classification without losing the bot bump skip', () => {
  const ci = workflow();
  for (const name of ['vitest', 'cockpit-browser']) {
    const job = ci.jobs[name];
    assert.ok(job.needs === 'change-surface' || job.needs?.includes('change-surface'));
    assert.match(job.if, /needs\.change-surface\.outputs\.surface == ['"]full-matrix['"]/);
    assert.match(job.if, /github\.event_name == ['"]pull_request['"]/);
    assert.match(job.if, /startsWith\(github\.head_ref, ['"]release\/v['"]\)/);
    assert.match(job.if, /github\.actor == ['"]github-actions\[bot\]['"]/);
  }
});

test('verify requires the classifier and permits skipped tests only for docs-only or bump PRs', () => {
  const verify = workflow().jobs.verify;
  assert.ok(verify.needs.includes('change-surface'));
  assert.equal(verify.if, 'always()');
  const gate = verify.steps.find((step) => step.name === 'Require every verification job');
  assert.ok(gate);
  assert.match(JSON.stringify(gate.env), /CHANGE_SURFACE/);
  assert.match(JSON.stringify(gate.env), /BUMP_PR/);
  assert.match(gate.run, /CHANGE_SURFACE/);
  assert.match(gate.run, /docs-only/);
  assert.match(gate.run, /BUMP_PR/);

  const cases = [
    { name: 'docs-only skipped tests', surface: 'docs-only', bump: 'false', vitest: 'skipped', cockpit: 'skipped', status: 0 },
    { name: 'full-matrix skipped tests', surface: 'full-matrix', bump: 'false', vitest: 'skipped', cockpit: 'skipped', status: 1 },
    { name: 'full-matrix successful tests', surface: 'full-matrix', bump: 'false', vitest: 'success', cockpit: 'success', status: 0 },
    { name: 'release bump skipped tests', surface: 'full-matrix', bump: 'true', vitest: 'skipped', cockpit: 'skipped', status: 0 },
  ];
  for (const scenario of cases) {
    const result = runShell(gate.run, {
      BUILD_AND_PACKAGE_RESULT: 'success',
      CHANGE_SURFACE: scenario.surface,
      BUMP_PR: scenario.bump,
      VITEST_RESULT: scenario.vitest,
      COCKPIT_BROWSER_RESULT: scenario.cockpit,
    });
    assert.equal(result.status, scenario.status, `${scenario.name}: ${result.stderr}`);
  }
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
