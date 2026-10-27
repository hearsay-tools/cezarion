'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runInNewContext } = require('node:vm');
const { spawnSync } = require('node:child_process');
const yaml = require('yaml');

const ci = yaml.parse(fs.readFileSync(path.join(__dirname, '../workflows/ci.yml'), 'utf8'));
const leaf = ci.jobs.typecheck;
const gate = ci.jobs.verify.steps.find(step => step.name === 'Require every verification job');
const evaluate = (expression, context) => runInNewContext(expression.slice(3, -2)
  .replace(/needs\.([\w]+-[\w-]+)/g, "needs['$1']"), context);

test('typecheck uses the smallest Blacksmith runner only for PRs and dispatches', () => {
  for (const [event_name, expected] of [
    ['pull_request_target', 'blacksmith-2vcpu-ubuntu-2404'],
    ['workflow_dispatch', 'blacksmith-2vcpu-ubuntu-2404'],
    ['push', 'ubuntu-24.04'], ['merge_group', 'ubuntu-24.04'],
  ]) {
    assert.equal(evaluate(leaf['runs-on'], { github: { event_name } }), expected);
    for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
      for (const verified of ['true', 'false', '']) for (const cancelled of [true, false]) {
        assert.equal(evaluate(leaf.if, { cancelled: () => cancelled,
          needs: { 'queue-proof': { result, outputs: { verified } } } }),
        !cancelled && !(result === 'success' && verified === 'true'));
      }
    }
  }
  assert.equal(leaf.needs, 'queue-proof');
  assert.equal(leaf.if, ci.jobs['build-and-package'].if);
  assert.deepEqual(leaf.permissions, { contents: 'read', 'pull-requests': 'read' });
});

test('typecheck keeps minimum Node, its bounded retry and an independent full check', () => {
  const build = ci.jobs['build-and-package'];
  const setups = job => job.steps.filter(step => step.uses?.startsWith('actions/setup-node@'));
  assert.deepEqual(setups(leaf), setups(build));
  assert.equal(leaf['timeout-minutes'], build['timeout-minutes']);
  assert.deepEqual(leaf.steps.filter(step => step.run && step.id !== 'resolve-dispatch'), [
    { name: 'Install dependencies', if: "hashFiles('pnpm-lock.yaml') == ''", run: 'npm ci' },
    { name: 'Install pnpm dependencies', if: "hashFiles('pnpm-lock.yaml') != ''", run: 'pnpm install --frozen-lockfile' },
    { name: 'Typecheck', run: 'npm run typecheck' },
  ]);
  assert.equal(build.steps.some(step => step.run === 'npm run typecheck'), false);
  const prepare = build.steps.findIndex(step => step.run === 'npm run build:server');
  assert.ok(prepare >= 0 && prepare < build.steps.findIndex(step => step.run === 'npm run test:unit'));
  assert.equal(build.needs, 'queue-proof', 'build and typecheck must run independently');
});

test('required typecheck cannot fail or skip behind docs, infra or release-bump exemptions', () => {
  assert.ok(ci.jobs.verify.needs.includes('typecheck'));
  assert.equal(gate.env.TYPECHECK_RESULT, '${{ needs.typecheck.result }}');
  for (const CHANGE_SURFACE of ['full-matrix', 'docs-only', 'infra-only']) {
    for (const BUMP_PR of ['false', 'true']) for (const TYPECHECK_RESULT of ['success', 'failure', 'cancelled', 'skipped', '']) {
      const result = spawnSync('bash', ['-eu', '-c', gate.run], { encoding: 'utf8', env: {
        PATH: process.env.PATH, EVENT_NAME: 'pull_request_target', CLASSIFY_RESULT: 'success', SURFACE_RESULT: 'success',
        COMPLEXITY_GATE_RESULT: 'success', CLONE_GATE_RESULT: 'success', BUILD_AND_PACKAGE_RESULT: 'success',
        VITEST_RESULT: 'success', COCKPIT_BROWSER_RESULT: 'success', CHANGE_SURFACE, BUMP_PR, TYPECHECK_RESULT,
        PROOF_RESULT: 'success', PROOF_VERIFIED: 'false',
      } });
      assert.equal(result.status === 0, TYPECHECK_RESULT === 'success', `${CHANGE_SURFACE}/${BUMP_PR}/${TYPECHECK_RESULT}: ${result.stderr}`);
    }
  }
});
