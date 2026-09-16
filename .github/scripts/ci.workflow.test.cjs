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

function runClassification({ apiOutput, fileObjects, changedFiles, apiFails = false, classifierFails = false, eventName = 'pull_request_target' }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cezar-ci-workflow-'));
  const outputPath = path.join(tempDir, 'github-output');
  const ghPath = path.join(tempDir, 'gh');
  const apiCallMarker = path.join(tempDir, 'gh-called');
  const classifierPath = path.join(tempDir, '.github', 'scripts', 'change-surface.cjs');
  fs.mkdirSync(path.dirname(classifierPath), { recursive: true });
  fs.writeFileSync(classifierPath, classifierFails
    ? 'process.exit(1);\n'
    : fs.readFileSync(path.join(repoRoot, '.github', 'scripts', 'change-surface.cjs')));
  const fileRecords = Array.isArray(apiOutput) ? apiOutput : [apiOutput ?? '"README.md"'];
  const fileList = fileObjects ?? fileRecords.map((record) => ({ filename: JSON.parse(record) }));
  const filePages = JSON.stringify([fileList]);
  fs.writeFileSync(ghPath, apiFails
    ? '#!/bin/sh\nexit 1\n'
    : `#!/bin/sh\ntouch "$GH_CALL_MARKER"\ncase "$*" in\n  *changed_files*) printf '%s\\n' "$EXPECTED_CHANGED_FILES" ;;\n  *'/files'*) printf '%s\\n' '${filePages}' ;;\nesac\n`);
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
      EXPECTED_CHANGED_FILES: String(changedFiles ?? fileList.length),
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
  assert.ok(ci.on.pull_request_target, 'CI must use the trusted pull_request_target trigger');
  assert.ok(
    ci.on.pull_request,
    'GitHub matches pull_request against the PR workflow and pull_request_target against the base; dropping pull_request before the base has pull_request_target launches no CI',
  );
  assert.deepEqual(ci.on.pull_request.branches, ['main', 'develop']);
  assert.deepEqual(ci.on.pull_request_target.branches, ['main', 'develop']);
  const job = ci.jobs['change-surface'];
  assert.ok(job, 'expected a change-surface job');
  assert.deepEqual(job.permissions, { contents: 'read', 'pull-requests': 'read' });
  assert.equal(job.outputs.surface, '${{ steps.classify.outputs.surface }}');
  const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.ok(checkout, 'expected a checkout step');
  assert.equal(checkout.if, "github.event_name == 'pull_request_target'");
  assert.equal(checkout.with.ref, '${{ github.event.pull_request.base.sha }}');
  assert.equal(checkout.with['persist-credentials'], false);
  const classify = job.steps.find((step) => step.id === 'classify');
  assert.ok(classify, 'expected an output-producing classify step');
  assert.match(classify.run, /gh api --paginate --slurp/);
  assert.match(classify.run, /changed_files/);
  assert.match(classify.run, /previous_filename/);
  assert.match(classify.run, /node [^\n]*\.github\/scripts\/change-surface\.cjs/);
  assert.match(classify.run, /surface=full-matrix/);
  assert.match(classify.run, /if ! files=/);
});

test('PR jobs check out the merge ref when CI runs from the trusted target workflow', () => {
  const ci = workflow();
  for (const name of ['build-and-package', 'vitest', 'cockpit-browser']) {
    const checkout = ci.jobs[name].steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    assert.match(checkout?.with?.ref || '', /format\('refs\/pull\/\{0\}\/merge', github\.event\.pull_request\.number\)/);
    assert.equal(checkout?.with?.['allow-unsafe-pr-checkout'], true, `${name} must opt in to fork PR merge checkout explicitly`);
    assert.equal(checkout?.with?.['persist-credentials'], false, `${name} must not persist GITHUB_TOKEN into a PR checkout`);
  }
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

  const incomplete = runClassification({ apiOutput: ['"README.md"'], changedFiles: 2 });
  assert.equal(incomplete.result.status, 0, incomplete.result.stderr);
  assert.equal(incomplete.output, 'surface=full-matrix\n');

  const rename = runClassification({ fileObjects: [{ filename: 'docs/new.md', previous_filename: 'src/old.ts' }] });
  assert.equal(rename.result.status, 0, rename.result.stderr);
  assert.equal(rename.output, 'surface=full-matrix\n');

  const push = runClassification({ apiOutput: ['"README.md"'], eventName: 'push' });
  assert.equal(push.result.status, 0, push.result.stderr);
  assert.equal(push.output, 'surface=full-matrix\n');
  assert.equal(push.apiCalled, false);
});

test('classification is not a path filter and build-and-package stays unconditional', () => {
  const ci = workflow();
  assert.equal(ci.on.pull_request.paths, undefined);
  assert.equal(ci.on.pull_request_target.paths, undefined);
  assert.equal(ci.on.push.paths, undefined);
  assert.equal(ci.jobs['build-and-package'].if, undefined);
  assert.equal(ci.jobs['build-and-package'].needs, undefined);
});

test('test jobs require full-matrix classification without losing the bot bump skip', () => {
  const ci = workflow();
  for (const name of ['vitest', 'cockpit-browser']) {
    const job = ci.jobs[name];
    assert.ok(job.needs?.includes('change-surface'));
    assert.match(job.if, /needs\.change-surface\.outputs\.surface == ['"]full-matrix['"]/);
    assert.ok(job.needs?.includes('classify-pr'));
    assert.match(job.if, /needs\.classify-pr\.outputs\.bump_pr != ['"]true['"]/);
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
test('bot-authored release/v* PRs skip Vitest and cockpit E2E via classify-pr file allowlist', () => {
  const ci = workflow();
  const classify = ci.jobs['classify-pr'];
  assert.ok(classify, 'expected classify-pr job');
  assert.deepEqual(classify.permissions, { contents: 'read', 'pull-requests': 'read' });
  assert.equal(classify.outputs.bump_pr, '${{ steps.classify.outputs.bump_pr }}');
  const checkout = classify.steps.find((step) => step.name === 'Check out trusted classifier');
  assert.equal(checkout.with.ref, '${{ github.event.pull_request.base.sha || github.sha }}');
  assert.equal(checkout.with['persist-credentials'], false);
  const classifyStep = classify.steps.find((step) => step.id === 'classify');
  assert.match(classifyStep.run, /release-bump-pr\.cjs/);
  assert.match(classifyStep.run, /EVENT_NAME.*pull_request_target/);
  assert.match(classifyStep.run, /pulls\/\$\{PR_NUMBER\}\/files/);
  assert.match(classifyStep.run, /PR_FILES_OK=1/);
  assert.doesNotMatch(classifyStep.run, /\|\| true/);
  assert.match(classifyStep.run, /LIVE_HEAD_SHA/);
  assert.match(classifyStep.run, /bump_pr=false/);
  assert.equal(classifyStep.env.EVENT_NAME, '${{ github.event_name }}');
  assert.equal(classifyStep.env.PR_AUTHOR, '${{ github.event.pull_request.user.login }}');
  assert.equal(classifyStep.env.EXPECTED_HEAD_SHA, '${{ github.event.pull_request.head.sha }}');
  assert.deepEqual(ci.jobs.vitest.needs, ['change-surface', 'classify-pr']);
  assert.deepEqual(ci.jobs['cockpit-browser'].needs, ['change-surface', 'classify-pr']);
  assert.match(ci.jobs.vitest.if, /needs\.classify-pr\.outputs\.bump_pr != 'true'/);
  assert.match(ci.jobs['cockpit-browser'].if, /needs\.classify-pr\.outputs\.bump_pr != 'true'/);
  assert.ok(ci.jobs.verify.needs.includes('classify-pr'));
  const verifyEnv = ci.jobs.verify.steps.find((step) => step.name === 'Require every verification job').env;
  assert.equal(verifyEnv.BUMP_PR, '${{ needs.classify-pr.outputs.bump_pr }}');
  assert.doesNotMatch(ci.jobs.vitest.if, /github\.actor/);
  assert.doesNotMatch(ci.jobs['cockpit-browser'].if, /github\.actor/);
  assert.doesNotMatch(JSON.stringify(ci.jobs), /github\.actor/);
});

test('CI runs on push to main and still does not publish snapshots from main', () => {
  const ci = workflow();
  assert.ok(ci.on.push.branches.includes('main'));
  assert.ok(ci.on.push.branches.includes('develop'));
  assert.equal(ci.concurrency.group, 'ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}');
  assert.equal(ci.concurrency['cancel-in-progress'], true);
  const publishIf = ci.jobs['publish-snapshot'].if;
  assert.match(publishIf, /github\.ref == 'refs\/heads\/develop'/);
  assert.match(publishIf, /github\.event_name == 'pull_request'/);
  assert.match(publishIf, /github\.event_name == 'pull_request_target'/);
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
