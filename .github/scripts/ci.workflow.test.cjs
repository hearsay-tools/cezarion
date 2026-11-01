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

test('dispatched verification checks out the attributed SHA even after its branch moves', () => {
  const { runInNewContext } = require('node:vm');
  const ci = workflow();
  for (const name of ['typecheck', 'build-and-package', 'vitest', 'cockpit-browser']) {
    const checkout = ci.jobs[name].steps.find((s) => s.uses?.startsWith('actions/checkout@'));
    const expression = checkout.with.ref.slice(3, -2).trim().replace(/needs\.([\w-]+)/g, "needs['$1']");
    const ref = runInNewContext(expression, { github: {
      event: { pull_request: {}, merge_group: {} }, ref: 'refs/heads/release/v0.13.6', sha: 'a'.repeat(40),
    }, needs: { 'pr-test-input': { outputs: { sha: '' } } }, inputs: {}, steps: { 'resolve-dispatch': { outputs: {} } } });
    assert.equal(ref, 'a'.repeat(40), `${name} must verify the commit receiving the check`);
    assert.equal(checkout.with['persist-credentials'], false);
    assert.equal(ci.jobs[name].permissions?.contents ?? ci.permissions.contents, 'read');
  }
});

function runShell(command, env = {}) {
  return spawnSync('bash', ['-e', '-c', command], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, CANCELLED: 'false', PREFLIGHT_RESULT: 'success', BASE_REF: 'main', REVIEW_RESULT: 'success', TYPECHECK_RESULT: 'success', CLASSIFY_RESULT: 'success', SURFACE_RESULT: 'success', CLONE_GATE_RESULT: 'success', COMPLEXITY_GATE_RESULT: 'success', EVENT_NAME: 'pull_request_target', ...env },
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
  assert.equal(job['runs-on'], 'ubicloud-standard-2');
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
  assert.equal(ci.on.pull_request, undefined, 'one authoritative PR event, including during migration');
  assert.deepEqual(ci.on.pull_request_target.branches, ['main', 'release/**']);
  const job = ci.jobs['change-surface'];
  assert.ok(job, 'expected a change-surface job');
  assert.deepEqual(job.permissions, { contents: 'read', 'pull-requests': 'read' });
  assert.equal(job.outputs.surface, '${{ steps.classify.outputs.surface }}');
  const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.ok(checkout, 'expected a checkout step');
  assert.equal(checkout.if, "github.event_name == 'pull_request_target' || steps['resolve-dispatch'].outputs.valid == 'true'");
  assert.equal(checkout.with.ref, "${{ github.event.pull_request.base.sha || steps['resolve-dispatch'].outputs.base_sha }}");
  assert.equal(checkout.with['persist-credentials'], false);
  const classify = job.steps.find((step) => step.id === 'classify');
  assert.ok(classify, 'expected an output-producing classify step');
  assert.match(classify.run, /gh api --paginate --slurp/);
  assert.match(classify.run, /changed_files/);
  assert.match(classify.run, /previous_filename/);
  assert.match(classify.run, /node [^\n]*\.github\/scripts\/change-surface\.cjs/);
  assert.match(classify.run, /surface=full-matrix/);
  assert.match(classify.run, /docs-only\|infra-only\|full-matrix/);
  assert.match(classify.run, /if ! files=/);
});

test('PR jobs use reviewed merge inputs from the trusted target workflow', () => {
  const ci = workflow();
  for (const name of ['typecheck', 'build-and-package', 'vitest', 'cockpit-browser']) {
    const checkout = ci.jobs[name].steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    if (['vitest', 'cockpit-browser'].includes(name)) {
      assert.match(checkout.with.ref, /needs\.pr-test-input\.outputs\.sha/);
    } else {
      assert.match(checkout.with.ref, /format\('refs\/pull\/\{0\}\/merge', github\.event\.pull_request\.number \|\| inputs\.pr_number\)/);
    }
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

  const infraOnly = runClassification({ apiOutput: '".github/workflows/sweep-ci-failures.yml"' });
  assert.equal(infraOnly.result.status, 0, infraOnly.result.stderr);
  assert.equal(infraOnly.output, 'surface=infra-only\n');

  const releaseRunnerEdit = runClassification({ apiOutput: '".github/workflows/release.yml"' });
  assert.equal(releaseRunnerEdit.result.status, 0, releaseRunnerEdit.result.stderr);
  assert.equal(releaseRunnerEdit.output, 'surface=full-matrix\n', 'release.yml runs npm test and stays full-matrix');

  const infraMixed = runClassification({ apiOutput: ['".github/workflows/release.yml"', '"packages/cezar/src/index.ts"'] });
  assert.equal(infraMixed.result.status, 0, infraMixed.result.stderr);
  assert.equal(infraMixed.output, 'surface=full-matrix\n');

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

test('ledger-only PRs skip both matrices but cannot bypass the required build and ledger validation', () => {
  const { runInNewContext } = require('node:vm');
  const files = ['.ai/upstream/ledger.yaml', '.ai/upstream/LEDGER.md', '.ai/upstream/scans/2026-09-25.md'];
  const classified = runClassification({ apiOutput: files.map(file => JSON.stringify(file)) });
  assert.equal(classified.result.status, 0, classified.result.stderr);
  assert.equal(classified.output, 'surface=docs-only\n');
  const ci = workflow();
  const surface = classified.output.trim().split('=')[1];
  for (const name of ['vitest', 'cockpit-browser']) {
    // Actions permits hyphens in property names; JavaScript requires brackets.
    const condition = ci.jobs[name].if.replace(/needs\.([a-z]+-[a-z]+)/g, "needs['$1']");
    assert.equal(runInNewContext(condition, { github: { event_name: 'pull_request_target', event: { pull_request: { base: { ref: 'main' } } } }, cancelled: () => false, needs: {
      'queue-proof': { result: 'success', outputs: { verified: 'false' } }, preflight: { result: 'success' }, 'review-result': { result: 'success' },
      'change-surface': { outputs: { surface } }, 'classify-pr': { outputs: { bump_pr: 'false' } },
    } }), false, name);
  }
  const gate = ci.jobs.verify.steps.find(step => step.name === 'Require every verification job');
  for (const buildResult of ['success', 'failure', 'skipped']) {
    const result = runShell(gate.run, {
      BUILD_AND_PACKAGE_RESULT: buildResult, VITEST_RESULT: 'skipped', COCKPIT_BROWSER_RESULT: 'skipped',
      CHANGE_SURFACE: surface, BUMP_PR: 'false',
    });
    assert.equal(result.status === 0, buildResult === 'success');
  }
  const renamed = runClassification({ fileObjects: [{
    filename: '.ai/upstream/scans/2026-09-25.md', previous_filename: 'packages/cezar/src/index.ts',
  }] });
  assert.equal(renamed.output, 'surface=full-matrix\n');
  assert.ok(ci.jobs['build-and-package'].steps.some(step => step.run === 'npm run test:unit'));
  assert.match(ci.jobs['build-and-package'].if, /!cancelled\(\)/);
});

test('classification is not a path filter and build-and-package requires review without surface skips', () => {
  const ci = workflow();
  assert.equal(ci.on.pull_request_target.paths, undefined);
  assert.equal(ci.on.push.paths, undefined);
  assert.match(ci.jobs['build-and-package'].if, /!cancelled\(\)/);
  assert.deepEqual(ci.jobs['build-and-package'].needs, ['queue-proof', 'preflight', 'review-result']);
});

test('preflight typecheck lints workflows with pinned, hash-verified actionlint and shellcheck (hearsay-tools/cezarion#1130)', () => {
  const steps = workflow().jobs.typecheck.steps;
  const index = steps.findIndex((step) => step.name === 'Lint workflows');
  assert.ok(index > 0, 'expected a Lint workflows step');
  assert.equal(steps[index - 1].name, 'Check out repository', 'lint before Node setup so it fails in seconds');
  const { env, run } = steps[index];
  const [major, minor, patch] = String(env.ACTIONLINT_VERSION).split('.').map(Number);
  assert.ok(major * 1e6 + minor * 1e3 + patch >= 1_007_010,
    `actionlint ${env.ACTIONLINT_VERSION}: 1.7.10 is the first release that reads YAML anchors`);
  assert.match(String(env.SHELLCHECK_VERSION), /^\d+\.\d+\.\d+$/);
  assert.match(env.ACTIONLINT_SHA256, /^[0-9a-f]{64}$/);
  assert.match(env.SHELLCHECK_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(env.SHELLCHECK_OPTS, '--severity=warning');
  assert.doesNotMatch(run, /\$\{\{/, 'versions and hashes reach the script through env, not interpolation');
  const verify = run.indexOf('sha256sum -c');
  assert.ok(verify > run.lastIndexOf('curl -fsSL --retry 3 '), 'verify after both downloads');
  assert.ok(verify < run.indexOf('tar '), 'verify before extracting');
  assert.match(run, /\$ACTIONLINT_SHA256/);
  assert.match(run, /\$SHELLCHECK_SHA256/);
  const lint = run.split('\n').find((line) => line.includes('-shellcheck='));
  assert.match(lint ?? '', /-shellcheck="[^"]*shellcheck-v\$\{SHELLCHECK_VERSION\}\/shellcheck"/, 'shellcheck comes from the pinned download, not the runner image');
  assert.match(lint, /-pyflakes=(\s|$)/, 'pyflakes is off');
});

test('preflight typecheck fails an added bare issue citation before every merge (hearsay-tools/cezarion#1310)', () => {
  const steps = workflow().jobs.typecheck.steps;
  const checkout = steps.find((step) => step.name === 'Check out repository');
  assert.equal(checkout.with['fetch-depth'], 2, 'the merge result and the base it merged into');
  const index = steps.findIndex((step) => step.name === 'Check issue citations');
  assert.ok(index > 0, 'expected a Check issue citations step');
  assert.equal(steps[index].run, 'node .github/scripts/check-citations.cjs --base HEAD^1');
  // A push reaches main only through a checked PR, and HEAD^1 there is only its last commit.
  assert.equal(steps[index].if, "github.event_name != 'push'", 'PRs of every surface, merge groups and dispatches');
  assert.ok(index > steps.findIndex((step) => step.name === 'Install pnpm dependencies'), '@babel/parser is installed first');
});

test('preflight typecheck runs the repository lint on every change surface (hearsay-tools/cezarion#2416)', () => {
  const ci = workflow();
  const steps = ci.jobs.typecheck.steps;
  const index = steps.findIndex((step) => step.name === 'Lint');
  assert.ok(index > 0, 'expected a Lint step');
  assert.equal(steps[index].run, 'npm run lint');
  assert.equal(steps[index].if, undefined, 'lint runs whatever the event and test selection');
  assert.ok(index > steps.findIndex((step) => step.name === 'Install pnpm dependencies'), 'oxlint is installed first');
  assert.ok(!ci.jobs.typecheck.needs.includes('change-surface'), 'a docs-only or test-less change still runs lint');
  assert.ok(ci.jobs.preflight.needs.includes('typecheck'), 'preflight requires the lint result');
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

test('verify requires the classifier and permits skipped tests only for docs-only, infra-only, or bump PRs', () => {
  const verify = workflow().jobs.verify;
  assert.ok(verify.needs.includes('change-surface'));
  assert.equal(verify.if, 'always()');
  const gate = verify.steps.find((step) => step.name === 'Require every verification job');
  assert.ok(gate);
  assert.match(JSON.stringify(gate.env), /CHANGE_SURFACE/);
  assert.match(JSON.stringify(gate.env), /BUMP_PR/);
  assert.match(gate.run, /CHANGE_SURFACE/);
  assert.match(gate.run, /docs-only/);
  assert.match(gate.run, /infra-only/);
  assert.match(gate.run, /BUMP_PR/);

  const cases = [
    { name: 'docs-only skipped tests', surface: 'docs-only', bump: 'false', vitest: 'skipped', cockpit: 'skipped', status: 0 },
    { name: 'infra-only skipped tests', surface: 'infra-only', bump: 'false', vitest: 'skipped', cockpit: 'skipped', status: 0 },
    { name: 'infra-only successful tests', surface: 'infra-only', bump: 'false', vitest: 'success', cockpit: 'success', status: 0 },
    { name: 'infra-only failed tests', surface: 'infra-only', bump: 'false', vitest: 'failed', cockpit: 'skipped', status: 1 },
    { name: 'unknown surface skipped tests', surface: 'weird-surface', bump: 'false', vitest: 'skipped', cockpit: 'skipped', status: 1 },
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
  assert.equal(checkout.with.ref, "${{ github.event.pull_request.base.sha || steps['resolve-dispatch'].outputs.base_sha || github.event.merge_group.base_sha || github.sha }}");
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
  assert.equal(classifyStep.env.EXPECTED_HEAD_SHA, '${{ github.event.pull_request.head.sha || github.sha }}');
  assert.deepEqual(ci.jobs.vitest.needs, ['queue-proof', 'change-surface', 'classify-pr', 'preflight', 'review-result', 'pr-test-input', 'pr-test-proof']);
  assert.deepEqual(ci.jobs['cockpit-browser'].needs, ['queue-proof', 'change-surface', 'classify-pr', 'preflight', 'review-result', 'pr-test-input', 'pr-test-proof']);
  assert.match(ci.jobs.vitest.if, /needs\.classify-pr\.outputs\.bump_pr != 'true'/);
  assert.match(ci.jobs['cockpit-browser'].if, /needs\.classify-pr\.outputs\.bump_pr != 'true'/);
  assert.ok(ci.jobs.verify.needs.includes('classify-pr'));
  const verifyEnv = ci.jobs.verify.steps.find((step) => step.name === 'Require every verification job').env;
  assert.equal(verifyEnv.BUMP_PR, '${{ needs.classify-pr.outputs.bump_pr }}');
  assert.doesNotMatch(ci.jobs.vitest.if, /github\.actor/);
  assert.doesNotMatch(ci.jobs['cockpit-browser'].if, /github\.actor/);
  assert.doesNotMatch(JSON.stringify(ci.jobs), /github\.actor/);
});

test('CI runs on push to main and publishes dev snapshots from main', () => {
  const ci = workflow();
  assert.deepEqual(ci.on.push.branches, ['main']);
  assert.equal(ci.concurrency.group, 'ci-${{ github.workflow }}-${{ github.event.pull_request.number || inputs.pr_number || github.ref }}');
  assert.equal(ci.concurrency['cancel-in-progress'], true);
  const publishIf = ci.jobs['publish-snapshot'].if;
  assert.match(publishIf, /github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(publishIf, /pull_request/);
  assert.doesNotMatch(publishIf, /pull_request_target/);
  assert.doesNotMatch(publishIf, /heads\/develop/);
});

test('verification bindings keep the final gate in CI and reserve local full browser runs', () => {
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, '.ai/agentic.config.json'), 'utf8'));
  const commands = config.validation.commands;
  assert.ok(commands.includes('npm run test:package'));
  assert.ok(commands.includes('npm run test:e2e'));
  assert.ok(!commands.includes('npm run test:e2e:local'));
  const vitest = workflow().jobs.vitest;
  const shards = vitest.strategy.matrix.shard;
  assert.deepEqual(shards, [1, 2, 3, 4]);
  assert.equal(vitest.name, 'Vitest shard ${{ matrix.shard }}/4');
  assert.equal(vitest.strategy['fail-fast'], false);
  const run = vitest.steps.map((step) => step.run).find((cmd) => /^npm test -- --shard=/.test(cmd ?? ''));
  assert.ok(run, 'expected the Vitest job to run sharded npm test');
  assert.ok(run.startsWith('npm test -- --shard=${{ matrix.shard }}/4 --maxWorkers=4'));
  const shardCommands = shards.map((n) => run.replace('${{ matrix.shard }}', String(n)).replace(/ \$\{\{.*?\}\}/g, ''));
  assert.deepEqual(commands.filter((cmd) => cmd.startsWith('npm test')), shardCommands,
    'validation.commands must list exactly the Vitest shards CI runs (hearsay-tools/cezarion#981)');
  const claude = fs.readFileSync(path.join(repoRoot, 'CLAUDE.md'), 'utf8');
  const agents = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');
  const row = claude.match(/^\| Verification \|([^|]+)\|/m);
  assert.ok(row, 'expected a Verification bindings row');
  assert.match(row[1], /npm run test:package/);
  assert.match(row[1], /Full gate in CI:.*`npm run test:e2e`/);
  assert.match(agents.match(/^\| Verification \|([^|]+)\|/m)?.[1] ?? '', /Full gate in CI:.*`npm run test:e2e`/);
  assert.match(claude, /npm run test:e2e:local\s+# explicitly requested full local browser run/);
  assert.match(agents, /npm run test:e2e:local\s+# explicitly requested full local browser run/);
  const ciDocs = fs.readFileSync(path.join(repoRoot, 'docs/sdlc/ci.md'), 'utf8');
  assert.match(ciDocs, /npm run test:e2e:local/);
});

 test('PR snapshot preparation has no publishing credentials and follows verification', () => {
  const ci = workflow();
  const prepare = ci.jobs['prepare-pr-snapshot'];
  assert.ok(prepare, 'same-repository PR snapshots must remain reachable');
  assert.equal(prepare.needs, 'verify');
  assert.deepEqual(prepare.permissions, { contents: 'read' });
  assert.match(prepare.if, /pull_request_target/);
  assert.match(prepare.if, /head.repo.full_name == github.repository/);
  assert.doesNotMatch(JSON.stringify(prepare), /secrets\.|id-token|pull-requests: write/);
  assert.match(stepsText(prepare), /--pack-only/);
  assert.ok(prepare.steps.some(s => s.uses?.startsWith('actions/upload-artifact@')));
});

test('build and package verifies the engines minimum without a second full unit run', () => {
  const ci = workflow();
  const readManifest = name => JSON.parse(fs.readFileSync(path.join(repoRoot, name), 'utf8'));
  const floor = readManifest('package.json').engines.node;
  assert.equal(floor, '>=24.21.0');
  assert.equal(readManifest('packages/cezar/package.json').engines.node, floor);
  const job = ci.jobs['build-and-package'];
  const setups = job.steps.filter(s => s.uses?.startsWith('actions/setup-node@'));
  for (const setup of setups) assert.equal(setup.with['node-version'], floor.slice(2));
  const runs = Object.entries(ci.jobs).filter(([id]) => ci.jobs.verify.needs.includes(id))
    .flatMap(([id, job]) => (job.steps ?? []).map(step => ({ id, run: step.run })));
  assert.deepEqual(runs.filter(s => s.run === 'npm run typecheck').map(s => s.id), ['typecheck']);
  for (const command of ['npm run test:unit', 'npm run build', 'npm run test:package']) {
    assert.deepEqual(runs.filter(s => s.run === command).map(s => s.id), ['build-and-package'], command);
  }
  assert.deepEqual(runs.filter(s => s.run?.startsWith('npm test --')).map(s => s.id), ['vitest']);
  assert.equal(ci.jobs['node-floor'], undefined, 'the duplicate full-suite matrix must stay removed');
  assert.ok(ci.jobs.verify.needs.includes('build-and-package'));
  const gate = ci.jobs.verify.steps.find(s => s.name === 'Require every verification job');
  for (const surface of ['full-matrix', 'docs-only']) for (const result of ['failure', 'skipped']) {
    const env = { BUILD_AND_PACKAGE_RESULT: result, VITEST_RESULT: 'success', COCKPIT_BROWSER_RESULT: 'success', CHANGE_SURFACE: surface, BUMP_PR: 'false' };
    assert.notEqual(runShell(gate.run, env).status, 0, `${surface}: build/package ${result}`);
  }
});

test('a stalled minimum Node setup times out and retries once inside the job budget (#1214)', () => {
  const { runInNewContext } = require('node:vm');
  const job = workflow().jobs['build-and-package'];
  assert.equal(job['timeout-minutes'], 15);
  const setups = job.steps.filter(s => s.uses?.startsWith('actions/setup-node@'));
  assert.equal(setups.length, 2, 'one setup and exactly one retry');
  const [setup, retry] = setups;
  for (const step of setups) {
    assert.equal(typeof step['timeout-minutes'], 'number', step.name);
    assert.ok(step['timeout-minutes'] < 5, `${step.name} must not spend the job budget on a stalled download`);
  }
  assert.equal(setup['continue-on-error'], true, 'a stalled first attempt must hand over to the retry');
  assert.equal(retry['continue-on-error'], undefined, 'a second failure must fail the job');
  assert.equal(retry.uses, setup.uses);
  assert.deepEqual(retry.with, setup.with);
  const index = job.steps.indexOf(setup);
  assert.equal(job.steps.indexOf(retry), index + 1);
  const firstInstall = job.steps.findIndex(s => /^(?:npm ci|pnpm install)/.test(s.run || ''));
  assert.ok(firstInstall > index + 1, 'the retry must finish before anything installs');
  // A step without a status function runs under an implicit success(), so a first
  // attempt skipped after an earlier failure must keep the retry skipped too.
  assert.ok(setup.id, 'the retry reads the first attempt by id');
  assert.doesNotMatch(retry.if, /\b(?:success|failure|cancelled|always)\(/);
  // continue-on-error reports a failed attempt's conclusion as success; only outcome tells.
  const runs = (outcome, jobOk = true) => runInNewContext(`success() && (${retry.if})`, {
    steps: { [setup.id]: { outcome, conclusion: outcome === 'skipped' ? 'skipped' : 'success' } }, success: () => jobOk,
  });
  assert.equal(runs('success'), false);
  // A timeout fails the first attempt; a cancelled attempt must retry too.
  assert.equal(runs('failure'), true);
  assert.equal(runs('cancelled'), true);
  assert.equal(runs('skipped', false), false);
});

test('genuine failure and cancellation never green the aggregate', () => {
  const gate = workflow().jobs.verify.steps.find(s => s.name === 'Require every verification job');
  for (const result of ['failure', 'cancelled', 'timed_out']) {
    for (const key of ['BUILD_AND_PACKAGE_RESULT', 'VITEST_RESULT', 'COCKPIT_BROWSER_RESULT']) {
      const env = { BUILD_AND_PACKAGE_RESULT: 'success', VITEST_RESULT: 'success', COCKPIT_BROWSER_RESULT: 'success', CHANGE_SURFACE: 'full-matrix', BUMP_PR: 'false', [key]: result };
      assert.notEqual(runShell(gate.run, env).status, 0, `${key}=${result}`);
    }
  }
});

test('event routing keeps one PR verifier and preserves push/manual publication policy', () => {
  const { runInNewContext } = require('node:vm');
  const ci = workflow();
  for (const base of ['main']) {
    const authoritative = ['pull_request', 'pull_request_target'].filter(event => ci.on[event]?.branches.includes(base));
    assert.deepEqual(authoritative, ['pull_request_target']);
    assert.ok(ci.on.push.branches.includes(base));
  }
  assert.ok(Object.hasOwn(ci.on, 'workflow_dispatch'));
  for (const [event, ref, fork, prepare, publish] of [
    ['pull_request_target', 'refs/heads/main', false, true, false],
    ['pull_request_target', 'refs/heads/main', true, false, false],
    ['push', 'refs/heads/main', false, false, true],
    ['push', 'refs/heads/develop', false, false, false],
    ['workflow_dispatch', 'refs/heads/main', false, false, false],
  ]) {
    const github = { event_name: event, ref, repository: 'o/n', event: { pull_request: { head: { repo: { full_name: fork ? 'fork/n' : 'o/n' } } } } };
    assert.equal(runInNewContext(ci.jobs['prepare-pr-snapshot'].if, { github, cancelled: () => false, needs: { verify: { result: 'success' } } }), prepare);
    assert.equal(runInNewContext(ci.jobs['publish-snapshot'].if, { github, cancelled: () => false, needs: { verify: { result: 'success' } } }), publish);
  }
  const group = (pr, sha) => ci.concurrency.group.replace(/\$\{\{(.*?)\}\}/g, (_, expression) => runInNewContext(expression, {
    github: { workflow: 'CI', sha, ref: 'refs/heads/main', event: { pull_request: { number: pr } } }, inputs: {},
  }));
  assert.equal(group(7, 'old'), group(7, 'new'), 'superseded heads must compete');
  assert.notEqual(group(7, 'new'), group(8, 'new'), 'different PRs must not compete');
  assert.equal(ci.concurrency['cancel-in-progress'], true);
});

test('PR dispatch and event share concurrency while native suites pin immutable inputs', () => {
  const { runInNewContext } = require('node:vm');
  const HEAD = 'a'.repeat(40);
  const evaluate = (value, context) => runInNewContext(value.slice(3, -2).replace(/needs\.([\w-]+)/g, "needs['$1']"), context);
  const config = workflow();
  assert.equal(config.on.workflow_dispatch.inputs.pr_number.required, false);
  function context(number, input, valid = 'true') {
    return { github: { workflow: 'CI', ref: 'refs/heads/release/v1.2.3', sha: HEAD, event: { pull_request: { number } } },
      needs: { 'pr-test-input': { outputs: { sha: number ? 'pinned-merge-sha' : '' } } },
      inputs: { pr_number: input }, steps: { 'resolve-dispatch': { outputs: { valid: input ? valid : '' } } }, format: (s, n) => s.replace('{0}', n) };
  }
  const group = ctx => config.concurrency.group.replace(/\$\{\{(.*?)\}\}/g, (_, expression) => runInNewContext(expression, ctx));
  assert.equal(group(context(42, '')), group(context(undefined, '42')));
  assert.notEqual(group(context(42, '')), group(context(undefined, '43')));
  for (const name of ['typecheck', 'build-and-package', 'vitest', 'cockpit-browser']) {
    const ref = config.jobs[name].steps.find(s => s.uses?.startsWith('actions/checkout@')).with.ref;
    assert.equal(evaluate(ref, context(undefined, '42')), 'refs/pull/42/merge');
    assert.equal(evaluate(ref, context(42, '')), ['vitest', 'cockpit-browser'].includes(name) ? 'pinned-merge-sha' : 'refs/pull/42/merge');
    assert.equal(evaluate(ref, context(undefined, '')), HEAD);
    assert.equal(evaluate(ref, context(undefined, '42', '')), HEAD);
  }
});

test('no workflow declares both pull_request and pull_request_target', () => {
  const dir = path.join(repoRoot, '.github/workflows');
  for (const name of fs.readdirSync(dir).filter(n => /\.ya?ml$/.test(n))) {
    const on = yaml.parse(fs.readFileSync(path.join(dir, name), 'utf8')).on;
    const events = typeof on === 'string' ? [on] : Array.isArray(on) ? on : Object.keys(on || {});
    assert.ok(!(events.includes('pull_request') && events.includes('pull_request_target')), name);
  }
});

// Runs the Reject baseline growth script with stubbed modules. Returns each `git show` object it
// read, and fails unless it then calls the gate it loaded.
async function baselineGateSources(script, eventName) {
  const shown = [];
  let checked = false;
  const modules = {
    'node:fs': { writeFileSync: () => {} },
    'node:path': path,
    'node:child_process': { execFileSync: (command, args) => { shown.push(args.at(-1)); return ''; } },
  };
  const load = name => modules[name] ?? { checkPullRequest: async () => { checked = true; } };
  const run = new (async () => {}).constructor('require', 'context', 'github', 'core', 'process', script);
  await run(load, { eventName, sha: 'workflow-sha' }, {}, {}, { env: { RUNNER_TEMP: os.tmpdir() } });
  assert.ok(checked, `${eventName} must call the gate it loaded`);
  return shown;
}

test('baseline growth is required through trusted classify-pr with default PR event types', async () => {
  const ci = workflow();
  const job = ci.jobs['classify-pr'];
  const checkIndex = job.steps.findIndex(step => step.name === 'Reject baseline growth');
  const checkoutIndex = job.steps.findIndex(step => step.uses?.startsWith('actions/checkout@'));
  assert.ok(checkIndex > checkoutIndex);
  const checkout = job.steps[checkoutIndex];
  assert.match(checkout.with.ref, /pull_request.base.sha/);
  assert.doesNotMatch(checkout.with.ref, /pull_request.head/);
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(checkout.with['fetch-depth'], 0);
  assert.equal(job.permissions.contents, 'read');
  assert.equal(job.permissions['pull-requests'], 'read');
  const check = job.steps[checkIndex];
  assert.equal(check.if, "github.event_name == 'pull_request_target' || steps['resolve-dispatch'].outputs.valid == 'true'");
  // The checkout is the event's base.sha, which can predate the gate; the workflow's own commit cannot.
  // A dispatch runs at the dispatched PR head, so only the checked-out trusted base may supply its gate.
  assert.deepEqual(await baselineGateSources(check.with.script, 'pull_request_target'), ['workflow-sha:.github/scripts/baseline-growth.cjs']);
  assert.deepEqual(await baselineGateSources(check.with.script, 'workflow_dispatch'), ['HEAD:.github/scripts/baseline-growth.cjs']);
  assert.ok(ci.jobs.verify.needs.includes('classify-pr'));
  assert.match(ci.jobs.verify.steps[0].run, /test "\$CLASSIFY_RESULT" = success/);
  assert.equal(ci.on.pull_request_target.types, undefined, 'label changes must not cancel and restart CI');
});

test('the complexity gate runs the workflow commit and reads the pull request head as Git data', () => {
  const ci = workflow();
  const job = ci.jobs['complexity-gate'];
  const checkouts = job.steps.filter(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkouts.length, 1);
  // On pull_request_target github.sha is the current tip of the base branch. The event's base.sha is the
  // tip from when the PR opened and can lack the scripts this workflow calls (hearsay-tools/cezarion#1834).
  // In a merge group github.sha is the combined commit, which holds the pull request's own scripts, so the
  // group's base SHA supplies the trusted code there.
  assert.equal(checkouts[0].with.ref, '${{ github.event.merge_group.base_sha || github.sha }}');
  const { runInNewContext } = require('node:vm');
  // Actions expressions read a missing property as null, so optional chaining stands in for that.
  const ref = (event) => runInNewContext(checkouts[0].with.ref.replace(/^\$\{\{\s*|\s*\}\}$/g, '').replaceAll('.', '?.'), { github: { sha: 'workflow-sha', event } });
  assert.equal(ref({}), 'workflow-sha');
  assert.equal(ref({ merge_group: { base_sha: 'group-base-sha' } }), 'group-base-sha');
  assert.equal(checkouts[0].with['persist-credentials'], false);
  assert.equal(checkouts[0].with['fetch-depth'], 0);
  assert.doesNotMatch(JSON.stringify(job), /base\.sha|refs\/pull\/\{0\}\/merge|allow-unsafe-pr-checkout/);
  assert.deepEqual(job.permissions, { contents: 'read', 'pull-requests': 'read' });
  const install = job.steps.find(step => /^pnpm install/.test(step.run ?? ''));
  assert.match(install.run, /--frozen-lockfile/);
  assert.match(install.run, /--ignore-scripts/);
  assert.ok(job.steps.indexOf(install) > job.steps.indexOf(checkouts[0]));
  assert.ok(ci.jobs.verify.needs.includes('complexity-gate'));
});

test('the complexity gate runs on pull requests, merge groups and bare dispatches, and verify never lets either of the first two skip it', () => {
  const { runInNewContext } = require('node:vm');
  const ci = workflow();
  const condition = ci.jobs['complexity-gate'].if.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  const runs = (eventName, prNumber = '') => runInNewContext(condition, { github: { event_name: eventName }, inputs: { pr_number: prNumber } });
  assert.deepEqual(['pull_request_target', 'merge_group', 'push', 'workflow_dispatch'].map(event => runs(event)), [true, true, false, true]);
  assert.equal(runs('workflow_dispatch', '42'), false, 'a dispatched release PR changes manifests only');
  const gate = ci.jobs.verify.steps.find(step => step.name === 'Require every verification job');
  assert.equal(gate.env.COMPLEXITY_GATE_RESULT, "${{ needs['complexity-gate'].result }}");
  const verify = (event, result) => runShell(gate.run, {
    EVENT_NAME: event, COMPLEXITY_GATE_RESULT: result, BUILD_AND_PACKAGE_RESULT: 'success', VITEST_RESULT: 'success',
    COCKPIT_BROWSER_RESULT: 'success', CHANGE_SURFACE: 'full-matrix', BUMP_PR: 'false',
  }).status;
  assert.equal(verify('pull_request_target', 'success'), 0);
  for (const result of ['failure', 'cancelled', 'skipped', '']) assert.notEqual(verify('pull_request_target', result), 0, result);
  for (const result of ['failure', 'cancelled', 'skipped', '']) assert.notEqual(verify('merge_group', result), 0, `merge_group ${result}`);
  assert.equal(verify('merge_group', 'success'), 0);
  assert.equal(verify('workflow_dispatch', 'skipped'), 0);
  assert.equal(verify('workflow_dispatch', 'success'), 0);
  assert.notEqual(verify('workflow_dispatch', 'failure'), 0);
});

// The step's own shell against a fixture: trusted scripts in the checkout, the pull request only as
// a ref, and a fake `gh` that answers with the pull request's live JSON.
function complexityGateFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cezar-complexity-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const over = `export function over(x) {\n${'  if (x) x++;\n'.repeat(20)}  return x;\n}\n`;
  // `shared` sits at complexity 19. Main and a pull request may each add one decision point, at opposite ends.
  const IF = 'if (x) x++;';
  const shared = (top, bottom) => `export function shared(x) {\n  ${top}\n${'  if (x) x++;\n'.repeat(18)}  ${bottom}\n  return x;\n}\n`;
  const small = 'export function small(x) { return x; }\n';
  const write = (file, source) => fs.writeFileSync(path.join(dir, file), source);
  const commit = (message) => { git('add', '-A'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Gate fixture');
  const scripts = path.join(dir, '.ai/skills/check-code-quality/scripts');
  fs.mkdirSync(scripts, { recursive: true });
  for (const name of ['changed-functions', 'code-metrics', 'complexity-gate', 'metrics']) {
    fs.copyFileSync(path.join(repoRoot, `.ai/skills/check-code-quality/scripts/${name}.mjs`), path.join(scripts, `${name}.mjs`));
  }
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'));
  write('.gitignore', 'node_modules\n');
  write('a.ts', small + shared('// top', '// bottom'));
  const forkPoint = commit('base');
  git('checkout', '-q', '-b', 'pr');
  write('a.ts', small + shared('// top', '// bottom') + over);
  const head = commit('pull request');
  git('checkout', '-q', 'main');
  write('later.ts', 'export const later = 1;\n');
  write('a.ts', small + shared(IF, '// bottom'));
  const tip = commit('main moved on');
  git('remote', 'add', 'origin', dir);
  git('update-ref', 'refs/pull/7/head', head);
  git('update-ref', 'refs/remotes/origin/main', tip);
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cezar-gate-bin-'));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nprintf \'%s\\n\' "$FAKE_PR"\n', { mode: 0o755 });
  const step = workflow().jobs['complexity-gate'].steps.find(candidate => candidate.name === 'Reject function complexity growth');
  const run = (env) => spawnSync('bash', ['-e', '-c', step.run], { cwd: dir, encoding: 'utf8', env: {
    PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GH_TOKEN: 'unused',
    GITHUB_REPOSITORY: 'owner/repo', PR_NUMBER: '7', EXPECTED_HEAD_SHA: head, EVENT_NAME: 'pull_request_target',
    GITHUB_SHA: tip, FAKE_PR: JSON.stringify({ head: { sha: head }, labels: [] }), ...env,
  } });
  // A pull request from the fork point that adds the one bottom decision point, and the merge group
  // that the queue builds from the base tip and that pull request.
  const queued = (number) => {
    git('checkout', '-q', '-b', `pr${number}`, forkPoint);
    write('a.ts', small + shared('// top', IF));
    const prHead = commit('bottom decision point');
    git('update-ref', `refs/pull/${number}/head`, prHead);
    git('checkout', '-q', '-b', `group${number}`, 'main');
    git('merge', '-q', '--no-edit', `pr${number}`);
    const groupHead = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    return { prHead, groupHead };
  };
  const group = (groupHead, number, env = {}) => run({
    EVENT_NAME: 'merge_group', GROUP_BASE_SHA: tip, GROUP_HEAD_SHA: groupHead, GITHUB_SHA: groupHead,
    GROUP_HEAD_REF: `refs/heads/gh-readonly-queue/main/pr-${number}-${groupHead}`, PR_NUMBER: '', EXPECTED_HEAD_SHA: '', ...env,
  });
  return { dir, git, run, head, tip, forkPoint, queued, group };
}

test('the complexity gate step compares the pull request with the merge base of the current base tip, without checking it out', (t) => {
  const f = complexityGateFixture(t);
  const failed = f.run({});
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /over: complexity 21 \(new function; limit 20\)/);
  assert.match(failed.stdout, /For an owner-approved increase, the owner adds the baseline-growth label, then re-runs the failed complexity-gate job\./);
  assert.doesNotMatch(failed.stdout, /later/, 'a change that landed on the base after the fork point is not the pull request\'s');
  assert.equal(f.git('rev-parse', 'HEAD'), f.tip, 'the head is fetched, never checked out');
  assert.equal(f.git('status', '--porcelain'), '');
});

test('the baseline-growth label read live approves the growth, and a stale or moved head fails the step', (t) => {
  const f = complexityGateFixture(t);
  const labelled = f.run({ FAKE_PR: JSON.stringify({ head: { sha: f.head }, labels: [{ name: 'baseline-growth' }] }) });
  assert.equal(labelled.status, 0, labelled.stdout + labelled.stderr);
  assert.match(labelled.stdout, /approved by the baseline-growth label; owner merge required/);
  const stale = f.run({ FAKE_PR: JSON.stringify({ head: { sha: 'a'.repeat(40) }, labels: [] }) });
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /changed after this run started/);
  f.git('update-ref', 'refs/pull/7/head', f.forkPoint);
  const moved = f.run({});
  assert.equal(moved.status, 1);
  assert.match(moved.stderr, /changed during the fetch/);
});

test('a merge group is gated against the base tip it lands on, so two pull requests that pass alone cannot add up to growth', (t) => {
  const f = complexityGateFixture(t);
  const { prHead, groupHead } = f.queued(8);
  // Alone, the pull request takes `shared` from 19 to 20, which the limit allows.
  const alone = f.run({ PR_NUMBER: '8', EXPECTED_HEAD_SHA: prHead, FAKE_PR: JSON.stringify({ head: { sha: prHead }, labels: [] }) });
  assert.equal(alone.status, 0, alone.stdout + alone.stderr);
  // Main already took it to 20, so the combined commit has 21.
  const combined = f.group(groupHead, 8);
  assert.equal(combined.status, 1, combined.stdout + combined.stderr);
  assert.match(combined.stdout, /shared: complexity 21 \(was 20 at the merge base; limit 20\)/);
  assert.match(combined.stdout, /For an owner-approved increase, the owner adds the baseline-growth label, then re-runs the failed complexity-gate job\./);
  assert.equal(f.git('rev-parse', 'HEAD'), f.tip, 'the group head is fetched, never checked out');
  assert.equal(f.git('status', '--porcelain'), '');
});

test('a merge group reads the baseline-growth label of the one pull request its ref names, and fails closed on any other ref', (t) => {
  const f = complexityGateFixture(t);
  const { groupHead } = f.queued(8);
  const labelled = { FAKE_PR: JSON.stringify({ head: { sha: groupHead }, labels: [{ name: 'baseline-growth' }] }) };
  const approved = f.group(groupHead, 8, labelled);
  assert.equal(approved.status, 0, approved.stdout + approved.stderr);
  assert.match(approved.stdout, /approved by the baseline-growth label; owner merge required/);
  for (const ref of ['refs/heads/gh-readonly-queue/main/pr-8', `refs/heads/gh-readonly-queue/dev/pr-8-${groupHead}`, `pr-8-${groupHead}`, '']) {
    const refused = f.group(groupHead, 8, { ...labelled, GROUP_HEAD_REF: ref });
    assert.equal(refused.status, 1, `${ref}: ${refused.stdout}${refused.stderr}`);
  }
  const unlabelled = f.group(groupHead, 8);
  assert.equal(unlabelled.status, 1, 'the label is read live, and its absence blocks the group');
  const missing = f.group('0'.repeat(40), 8);
  assert.notEqual(missing.status, 0, 'a group head that cannot be fetched fails the step');
});

test('a bare dispatch gates the dispatched commit against main', (t) => {
  const f = complexityGateFixture(t);
  f.git('checkout', '-q', '--detach', f.head);
  const result = f.run({ EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: f.head, PR_NUMBER: '', EXPECTED_HEAD_SHA: '' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /over: complexity 21 \(new function; limit 20\)/);
});

test('clone gate uses trusted tooling and is required for PRs and merge groups', () => {
  const ci = workflow();
  const gate = ci.jobs['clone-gate'];
  const complexity = ci.jobs['complexity-gate'];
  assert.deepEqual(gate.steps.slice(0, 4), complexity.steps.slice(0, 4));
  assert.equal(gate.if, complexity.if);
  assert.deepEqual(gate.permissions, { contents: 'read', 'pull-requests': 'read' });
  assert.ok(ci.jobs.verify.needs.includes('clone-gate'));
  const step = gate.steps.at(-1);
  assert.match(step.run, /git fetch --no-tags origin/);
  assert.match(step.run, /EXPECTED_HEAD_SHA/);
  assert.match(step.run, /base="\$GROUP_BASE_SHA"/);
  assert.match(step.run, /head="\$GROUP_HEAD_SHA"/);
  assert.match(step.run, /node \.github\/scripts\/check-clones.cjs --base "\$base" --head "\$head"/);
  const verify = ci.jobs.verify.steps[0];
  assert.equal(verify.env.CLONE_GATE_RESULT, "${{ needs['clone-gate'].result }}");
  for (const event of ['pull_request_target', 'merge_group']) {
    for (const status of ['failure', 'cancelled', 'skipped']) {
      assert.notEqual(runShell(verify.run, { EVENT_NAME: event, CLONE_GATE_RESULT: status }).status, 0);
    }
  }
});
