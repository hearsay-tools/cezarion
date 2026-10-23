const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tmpdir } = require('node:os');

const root = path.resolve(__dirname, '../..');
const workflowPath = path.join(root, '.github/workflows/automated-code-review.yml');

test('Review verdict names a confirmed Codex timeout and the failed-jobs rerun command', async () => {
  const { parse } = await import('yaml');
  const workflow = parse(fs.readFileSync(workflowPath, 'utf8'));
  const verdictJob = workflow.jobs['review-complete'];
  const diagnostic = verdictJob.steps.find(step => step.id === 'codex-failure');
  const output = {};
  // The old workflow has no diagnostic step. Still run its actual verdict:
  // red proof must show the missing user-facing message, not a missing import.
  if (diagnostic) {
    const run = new (Object.getPrototypeOf(async function () {}).constructor)('require', 'github', 'context', 'core', 'process', diagnostic.with.script);
    await run(file => require(path.join(root, file.replace(/^\.\/\.review-policy\//, ''))), {
      paginate: async route => route.endsWith('/jobs')
        ? [{ id: 88, name: 'Review / codex-review', conclusion: 'failure' }]
        : [{ annotation_level: 'failure', message: 'The action has timed out.' }],
    }, { repo: { owner: 'owner', repo: 'repo' }, runId: 123, runAttempt: 2 }, {
      setOutput: (key, value) => { output[key] = value; }, warning: () => {},
    }, { env: { GITHUB_RUN_ATTEMPT: '2' } });
  }
  const cwd = fs.mkdtempSync(path.join(tmpdir(), 'codex-verdict-'));
  try {
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eu', '-o', 'pipefail', '-c',
      verdictJob.steps.find(step => step.name === 'Require the selected review path to succeed').run], {
      cwd, encoding: 'utf8', env: { ...process.env, BASH_ENV: '/dev/null',
        VALIDATE_RESULT: 'success', REVIEW_ROUND_RESULT: 'success', CAN_REVIEW: 'true',
        PROVIDER: 'codex', CODEX_RESULT: 'failure', POST_RESULT: 'skipped',
        CODEX_FAILURE_MESSAGE: output.message || '', GITHUB_STEP_SUMMARY: path.join(cwd, 'summary'),
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /The review timed out; re-run failed jobs/);
    assert.match(result.stdout + result.stderr, /gh run rerun 123 --failed --repo owner\/repo/);
    assert.match(fs.readFileSync(path.join(cwd, 'summary'), 'utf8'), /The review timed out/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('Codex action receives a larger budget for a representative large PR', async () => {
  const { parse } = await import('yaml');
  const workflow = parse(fs.readFileSync(workflowPath, 'utf8'));
  const job = workflow.jobs['codex-review'];
  const budget = job.steps.find(step => step.id === 'review-budget');
  const action = job.steps.find(step => step.id === 'codex-review');
  let minutes = action['timeout-minutes'];
  if (budget) {
    const run = new (Object.getPrototypeOf(async function () {}).constructor)('require', 'github', 'context', 'core', 'process', budget.with.script);
    const outputs = {};
    await run(file => require(path.join(root, file.replace(/^\.\/\.review-policy\//, ''))), {
      rest: { pulls: { get: async () => ({ data: { additions: 4162, deletions: 443, changed_files: 66 } }) } },
    }, { repo: { owner: 'owner', repo: 'repo' } }, {
      setOutput: (key, value) => { outputs[key] = value; }, warning: () => {}, info: () => {},
    }, { env: { PR_NUMBER: '1469' } });
    assert.equal(action['timeout-minutes'], '${{ fromJSON(steps.review-budget.outputs.minutes) }}');
    minutes = outputs.minutes;
  }
  assert.equal(Number(minutes), 24);
  assert.ok(job['timeout-minutes'] >= Number(minutes) + 6, 'leave setup and publication time outside the action limit');
});

test('budget boundaries and unavailable sizing keep a finite ceiling', async () => {
  const { reviewMinutes, selectBudget } = require('./codex-review-budget.cjs');
  for (const [metadata, minutes] of [
    [{ additions: 0, deletions: 0, changed_files: 0 }, 12],
    [{ additions: 2000, deletions: 999, changed_files: 49 }, 12],
    [{ additions: 2000, deletions: 1000, changed_files: 49 }, 24],
    [{ additions: 0, deletions: 1, changed_files: 50 }, 24],
    [{ additions: 4162, deletions: 443, changed_files: 66 }, 24],
    [undefined, 24], [{}, 24],
    [{ additions: -1, deletions: 0, changed_files: 0 }, 24],
    [{ additions: '1', deletions: 0, changed_files: 0 }, 24],
  ]) assert.equal(reviewMinutes(metadata), minutes, JSON.stringify(metadata));
  assert.equal(await selectBudget({ github: { rest: { pulls: { get: async () => { throw new Error('API unavailable'); } } } } }), 24);
});

test('timeout diagnostics use only this run attempt and distinguish provider failure from timeout', async () => {
  const { failureMessage } = require('./codex-review-budget.cjs');
  const args = { owner: 'owner', repo: 'repo', runId: 123, runAttempt: 3 };
  const message = await failureMessage({ ...args, github: {
    paginate: async (route, params) => {
      if (route.endsWith('/jobs')) {
        // Reproduce an earlier timeout followed by a different provider failure.
        if (route.includes('/attempts/') && params.run_id === 123 && params.attempt_number === 3) {
          return [{ id: 99, name: 'codex-review', conclusion: 'failure' }];
        }
        return [{ id: 88, name: 'codex-review', conclusion: 'failure' }];
      }
      return [{ annotation_level: 'failure', message: params.check_run_id === 88
        ? 'The action has timed out.' : 'Codex authentication failed.' }];
    },
  } });
  assert.match(message, /No action-timeout annotation was found/);
  assert.doesNotMatch(message, /The review timed out/);
  assert.match(message, /gh run rerun 123 --failed --repo owner\/repo/);
});

test('missing or ambiguous timeout evidence does not invent a timeout', async () => {
  const { failureMessage } = require('./codex-review-budget.cjs');
  const args = { owner: 'owner', repo: 'repo', runId: 123, runAttempt: 2 };
  for (const jobs of [[], [{ id: 1, name: 'codex-review' }, { id: 2, name: 'Review / codex-review' }]]) {
    assert.match(await failureMessage({ ...args, github: { paginate: async () => jobs } }), /timeout evidence is unavailable/);
  }
  assert.match(await failureMessage({ ...args, github: {
    paginate: async route => {
      if (route.endsWith('/jobs')) return [{ id: 1, name: 'codex-review' }];
      throw new Error('annotations forbidden');
    },
  } }), /timeout evidence is unavailable/);
  assert.match(await failureMessage({ ...args, outputPresent: true, github: {
    paginate: async () => { throw new Error('must not blame a timeout after output was written'); },
  } }), /Codex wrote review output, but publication failed/);
});

test('complete output survives action failure; missing and malformed output still fail', async () => {
  const { parse } = await import('yaml');
  const workflow = parse(fs.readFileSync(workflowPath, 'utf8'));
  const job = workflow.jobs['codex-review'];
  const requireReview = job.steps.find(step => step.name === 'Require a complete Codex review');
  assert.equal(job.steps.find(step => step.id === 'codex-review')['continue-on-error'], true);
  for (const [content, status] of [[null, 1], ['', 1], ['{"head_sha":', 1], ['[]', 1], ['{}', 0]]) {
    const cwd = fs.mkdtempSync(path.join(tmpdir(), 'codex-output-'));
    try {
      if (content !== null) fs.writeFileSync(path.join(cwd, 'findings.json'), content);
      const result = spawnSync('bash', ['--noprofile', '--norc', '-eu', '-o', 'pipefail', '-c', requireReview.run], {
        cwd, encoding: 'utf8', env: { ...process.env, BASH_ENV: '/dev/null', REVIEW_OUTCOME: 'failure',
          FINDINGS: 'findings.json', GITHUB_OUTPUT: path.join(cwd, 'output') },
      });
      assert.equal(result.status, status, result.stdout + result.stderr);
      if (status === 0) {
        assert.match(result.stdout, /already written a complete/);
        assert.match(fs.readFileSync(path.join(cwd, 'output'), 'utf8'), /output_present=true/);
      }
      // The provider check is only an object/availability check. The separate
      // trusted post-review validator must still reject this schema-invalid {}.
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test('budget and diagnostics execute trusted workflow policy with read-only permissions', async () => {
  const { parse } = await import('yaml');
  const workflow = parse(fs.readFileSync(workflowPath, 'utf8'));
  for (const job of [workflow.jobs['codex-review'], workflow.jobs['review-complete']]) {
    const checkout = job.steps.find(step => step.with?.path === '.review-policy');
    assert.equal(checkout.with.ref, '${{ github.workflow_sha }}');
    assert.equal(checkout.with['persist-credentials'], false);
    assert.equal(checkout.with['sparse-checkout'], '.github/scripts/codex-review-budget.cjs');
    assert.ok(Object.values(job.permissions).every(level => level === 'read'));
  }
  assert.equal(workflow.jobs['review-complete'].permissions.checks, 'read');
});
