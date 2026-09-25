const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');

const workflowPath = path.resolve(__dirname, '../workflows/upstream-scan.yml');
function workflow() {
  assert.equal(fs.existsSync(workflowPath), true, 'upstream-scan.yml exists');
  return yaml.parse(fs.readFileSync(workflowPath, 'utf8'));
}

test('the weekly scan runs from the default branch with the trusted-checkout shape and the least permissions that can open a PR', () => {
  const w = workflow();
  assert.deepEqual(w.on.schedule, [{ cron: '17 5 * * 1' }]);
  assert.ok(w.on.workflow_dispatch !== undefined, 'manual dispatch');
  assert.deepEqual(w.permissions, {});
  const job = w.jobs.scan;
  assert.deepEqual(job.permissions, { contents: 'write', 'pull-requests': 'read' });
  assert.match(job.if, /github\.ref.*github\.event\.repository\.default_branch/);
  assert.ok(w.concurrency?.group, 'serialized so two scans never race the same branch');
  const checkout = job.steps.find((s) => s.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, '${{ github.sha }}');
  assert.equal(checkout.with['fetch-depth'], 0, 'the 3-way dry run and the range walk need full history');
  assert.ok(job.steps.some((s) => s.uses?.startsWith('actions/setup-node@')));
  assert.ok(job.steps.some((s) => s.run === 'npm ci'), 'the scan needs the hoisted yaml dependency');
  const scanStep = job.steps.find((s) => s.id === 'scan');
  assert.match(scanStep.run, /node \.github\/scripts\/upstream-scan\.cjs/);
  assert.match(scanStep.run, /GITHUB_OUTPUT/);
  const pr = job.steps.find((s) => s.uses?.startsWith('actions/github-script@'));
  assert.match(pr.with.script, /require\('\.\/\.github\/scripts\/upstream-scan-pr\.cjs'\)\.openScanPr/);
  assert.equal(pr.env.SCAN_JSON, '${{ steps.scan.outputs.summary }}');
  assert.equal(pr.env.BASE_BRANCH, '${{ github.event.repository.default_branch }}');
});

test('scan PR creation uses the scoped App client without giving it branch credentials', async () => {
  const job = workflow().jobs.scan;
  const mint = job.steps.find(step => step.id === 'scan_app');
  assert.ok(mint, 'mint a PR-only installation token for native CI');
  assert.match(mint.uses, /^actions\/create-github-app-token@[a-f0-9]{40}$/);
  assert.equal(mint.with['permission-pull-requests'], 'write');
  assert.equal(mint.with['permission-contents'], undefined);
  assert.equal(mint.with.repositories, '${{ github.event.repository.name }}');
  const prStep = job.steps.find(step => step.id === 'pr');
  assert.equal(prStep.env.SCAN_PR_TOKEN, '${{ steps.scan_app.outputs.token }}');
  const { runInNewContext } = require('node:vm');
  const github = { name: 'workflow client' };
  const appClient = { name: 'App client' };
  let invocation;
  await runInNewContext(`(async () => { ${prStep.with.script} })()`, {
    github, context: {}, core: {}, process: { env: { SCAN_PR_TOKEN: 'test-token' } },
    getOctokit: token => { assert.equal(token, 'test-token'); return appClient; },
    require: module => {
      assert.equal(module, './.github/scripts/upstream-scan-pr.cjs');
      return { openScanPr: async args => { invocation = args; } };
    },
  });
  assert.equal(invocation.github, github, 'lookups keep the workflow token');
  assert.equal(invocation.prGithub, appClient, 'only PR creation uses the App');
  const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.token, undefined, 'git push keeps GITHUB_TOKEN');
});

test('scan App configuration fails before PR creation rather than falling back to suppressed CI', () => {
  const { spawnSync } = require('node:child_process');
  const job = workflow().jobs.scan;
  const validate = job.steps.find(step => step.id === 'validate_scan_app');
  assert.ok(validate, 'validate the existing release App settings');
  assert.ok(job.steps.indexOf(validate) < job.steps.findIndex(step => step.id === 'pr'));
  for (const [id, login, key, success] of [
    ['123', 'cezarion-release[bot]', 'true', true],
    ['', 'cezarion-release[bot]', 'true', false],
    ['123', 'human', 'true', false],
    ['123', 'cezarion-release[bot]', 'false', false],
  ]) {
    const result = spawnSync('bash', ['-e', '-c', validate.run], { encoding: 'utf8',
      env: { ...process.env, RELEASE_APP_ID: id, RELEASE_APP_BOT_LOGIN: login, HAS_PRIVATE_KEY: key } });
    assert.equal(result.status === 0, success, result.stderr);
  }
  const identity = job.steps.find(step => step.name === 'Check scan App identity');
  assert.ok(identity);
  for (const slug of ['cezarion-release', 'wrong-app']) {
    const result = spawnSync('bash', ['-e', '-c', identity.run], { encoding: 'utf8',
      env: { ...process.env, APP_SLUG: slug, EXPECTED_LOGIN: 'cezarion-release[bot]' } });
    assert.equal(result.status === 0, slug === 'cezarion-release', result.stderr);
  }
});

function harness({ prs = [], summary, report = '# Upstream scan 2026-09-18\n\n| row |\n' } = {}) {
  const calls = [];
  const created = [];
  const workflowTokenCreates = [];
  const outputs = {};
  const git = (...args) => {
    calls.push(args);
    if (args[0] === 'ls-remote') return '';
    return '';
  };
  const github = {
    paginate: async (_fn, params) => { calls.push(['pulls.list', params]); return prs; },
    rest: {
      pulls: {
        list: 'pulls.list',
        create: async (params) => { workflowTokenCreates.push(params); return { data: { html_url: 'https://example.test/pull/1', number: 1 } }; },
      },
    },
  };
  const prGithub = { rest: { pulls: {
    create: async (params) => { created.push(params); return { data: { html_url: 'https://example.test/pull/1', number: 1 } }; },
  } } };
  const core = { setOutput: (k, v) => { outputs[k] = v; }, info: () => {}, setFailed: (m) => { outputs.failed = m; } };
  const context = { repo: { owner: 'hearsay-tools', repo: 'cezarion' }, sha: 'f'.repeat(40) };
  const env = { SCAN_JSON: JSON.stringify(summary), BASE_BRANCH: 'main' };
  const readFile = (file) => { calls.push(['readFile', file]); return report; };
  return { calls, created, workflowTokenCreates, outputs, run: () => require('./upstream-scan-pr.cjs').openScanPr({ github, prGithub, context, core, env, git, readFile }) };
}

const ADDED = { added: 12, date: '2026-09-18', upstreamHead: '4763447f36b05e0c3934c77798335827f4398de4', since: '0e9dfd76456e0abf44fd0037d4d1b52b43b9e8f7', report: '.ai/upstream/scans/2026-09-18.md' };

test('openScanPr touches nothing when the scan added no rows', async () => {
  const h = harness({ summary: { ...ADDED, added: 0, report: null } });
  await h.run();
  assert.equal(h.outputs.status, 'nothing-new');
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.created, []);
});

test('openScanPr commits the ledger on a dated branch and opens exactly one PR against the default branch', async () => {
  const h = harness({ summary: ADDED });
  await h.run();
  const flat = h.calls.map((c) => c.join(' '));
  assert.ok(flat.some((c) => c === 'checkout -B upstream-scan/2026-09-18'), flat.join('\n'));
  assert.ok(flat.some((c) => c === 'add .ai/upstream'), 'only the ledger directory is staged');
  assert.ok(flat.some((c) => c.startsWith('commit -m chore(upstream): scan 2026-09-18')), flat.join('\n'));
  assert.ok(flat.some((c) => c === 'push --force origin HEAD:refs/heads/upstream-scan/2026-09-18'), flat.join('\n'));
  assert.equal(h.workflowTokenCreates.length, 0, 'GITHUB_TOKEN suppresses native PR CI; only the App may create the PR');
  assert.equal(h.created.length, 1);
  const pr = h.created[0];
  assert.equal(pr.base, 'main');
  assert.equal(pr.head, 'upstream-scan/2026-09-18');
  assert.equal(pr.draft, true);
  assert.match(pr.title, /^chore\(upstream\): scan 2026-09-18 — 12 new upstream commits$/);
  assert.match(pr.body, /\| row \|/, 'the scan report is the body');
  assert.match(pr.body, /ledger\.yaml/, 'tells the reviewer where to decide');
  assert.match(pr.body, /4763447f/);
  assert.equal(h.outputs.status, 'created');
  assert.equal(h.outputs.url, 'https://example.test/pull/1');
});

test('openScanPr leaves an open PR for the same branch alone so reviewer edits survive a rerun', async () => {
  const h = harness({ summary: ADDED, prs: [{ html_url: 'https://example.test/pull/7', state: 'open', head: { ref: 'upstream-scan/2026-09-18' } }] });
  await h.run();
  const flat = h.calls.map((c) => c.join(' '));
  assert.ok(!flat.some((c) => c.startsWith('push')), 'no push over a branch a human may have edited');
  assert.deepEqual(h.created, []);
  assert.equal(h.outputs.status, 'exists');
  assert.equal(h.outputs.url, 'https://example.test/pull/7');
});

test('openScanPr blocks on any open upstream-scan PR, not only the one for today, so two scan PRs never coexist', async () => {
  const h = harness({ summary: ADDED, prs: [{ html_url: 'https://example.test/pull/5', state: 'open', head: { ref: 'upstream-scan/2026-09-11' } }] });
  await h.run();
  const flat = h.calls.map((c) => c.join(' '));
  assert.ok(!flat.some((c) => c.startsWith('push')), 'last week\'s undecided PR must not be joined by a second one');
  assert.deepEqual(h.created, []);
  assert.equal(h.outputs.status, 'exists');
  assert.equal(h.outputs.url, 'https://example.test/pull/5');
});

test('openScanPr ignores open PRs on unrelated branches', async () => {
  const h = harness({ summary: ADDED, prs: [{ html_url: 'https://example.test/pull/9', state: 'open', head: { ref: 'feature/unrelated' } }] });
  await h.run();
  assert.equal(h.created.length, 1);
  assert.equal(h.outputs.status, 'created');
});
