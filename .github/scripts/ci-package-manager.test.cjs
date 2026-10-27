const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { runInNewContext } = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
// Resolve the parser from its declared workspace owner, including isolated pnpm installs.
const yaml = createRequire(path.join(__dirname, '../../packages/cezar/package.json'))('yaml');

const workflow = yaml.parse(fs.readFileSync(path.join(__dirname, '../workflows/ci.yml'), 'utf8'));
const jobs = ['typecheck', 'build-and-package', 'vitest', 'cockpit-browser', 'publish-snapshot', 'prepare-pr-snapshot'];

function evaluate(value, root, steps = {}) {
  if (!value) return true;
  const expression = value.startsWith('${{') ? value.slice(3, -2) : value;
  return runInNewContext(expression, {
    hashFiles: file => fs.existsSync(path.join(root, file)) ? 'present-lockfile-hash' : '',
    steps,
  });
}

for (const jobName of jobs) {
  for (const [label, locks, manager] of [
    ['npm checkout', ['package-lock.json'], 'npm'],
    ['pnpm checkout', ['pnpm-lock.yaml'], 'pnpm'],
    ['both lockfiles', ['package-lock.json', 'pnpm-lock.yaml'], 'pnpm'],
  ]) {
    test(`${jobName} selects the installer and cache for a ${label}`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cez-ci-package-manager-'));
      try {
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'commonjs' }));
        for (const file of locks) fs.writeFileSync(path.join(root, file), 'fixture');
        const steps = workflow.jobs[jobName].steps;
        // Every earlier step succeeded, so a retry gated on a step's outcome stays unselected.
        const succeeded = Object.fromEntries(steps.filter(step => step.id).map(step => [step.id, { outcome: 'success', conclusion: 'success' }]));
        const selected = steps.filter(step => (
          step.uses?.startsWith('actions/setup-node@') ||
          step.uses?.startsWith('pnpm/action-setup@') ||
          /^(?:npm ci|pnpm install)/.test(step.run || '')
        ) && evaluate(step.if, root, succeeded));
        const nodes = selected.filter(step => step.uses?.startsWith('actions/setup-node@'));
        const [node] = nodes;
        const pnpm = selected.filter(step => step.uses?.startsWith('pnpm/action-setup@'));
        assert.ok(node, 'Node setup is required for both installers');
        assert.equal(nodes.length, 1, 'a successful Node setup must not be repeated');
        assert.equal(pnpm.length, manager === 'pnpm' ? 1 : 0);
        if (manager === 'pnpm') {
          assert.equal(pnpm[0].with.version, '12.11.2');
          assert.ok(steps.indexOf(pnpm[0]) < steps.indexOf(node), 'pnpm must exist before setup-node resolves its cache');
        }
        if (node.with.cache !== undefined) {
          const cache = node.with.cache.startsWith('${{') ? evaluate(node.with.cache, root) : node.with.cache;
          assert.equal(cache, manager);
          if (manager === 'pnpm' || node.with['cache-dependency-path'] !== undefined) {
            assert.equal(
              evaluate(node.with['cache-dependency-path'], root),
              manager === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json',
            );
          }
        }
        // Execute the workflow's real install command, replacing only the external installer.
        // The cockpit delegates installation to its existing E2E script.
        const installs = selected.filter(step => /^(?:npm ci|pnpm install)/.test(step.run || ''));
        assert.equal(installs.length, jobName === 'cockpit-browser' ? 0 : 1);
        if (!installs.length) return;
        const log = path.join(root, 'installer.log');
        for (const command of ['npm', 'pnpm']) {
          const stub = `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.TASK_INSTALL_LOG, JSON.stringify([${JSON.stringify(command)}, ...process.argv.slice(2)]));
process.exit(Number(process.env.TASK_INSTALL_EXIT || 0));
`;
          fs.writeFileSync(path.join(root, command), stub, { mode: 0o755 });
        }
        const env = { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}`, TASK_INSTALL_LOG: log };
        const result = spawnSync('bash', ['-e', '-c', installs[0].run], { cwd: root, env, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(fs.readFileSync(log, 'utf8')), manager === 'pnpm' ? ['pnpm', 'install', '--frozen-lockfile'] : ['npm', 'ci']);
        const failure = spawnSync('bash', ['-e', '-c', installs[0].run], { cwd: root, env: { ...env, TASK_INSTALL_EXIT: '23' }, encoding: 'utf8' });
        assert.equal(failure.status, 23, 'an installer failure must fail CI');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
