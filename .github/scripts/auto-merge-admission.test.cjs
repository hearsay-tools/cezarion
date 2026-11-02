'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');

test('a small queue admission gate change requires owner review', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-admission-policy-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q');
  const file = path.join(cwd, '.github/scripts/merge-queue-admission.cjs');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'module.exports = false;\n');
  git('add', '.github/scripts/merge-queue-admission.cjs');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  fs.writeFileSync(file, 'module.exports = true;\n');
  git('add', '.github/scripts/merge-queue-admission.cjs');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'change');
  const script = path.resolve(__dirname, '../../.ai/skills/auto-merge/check.mjs');
  const result = spawnSync(process.execPath, [script, '--title', 'fix: adjust queue admission', '--base', base],
    { cwd, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /gate or test harness: \.github\/scripts\/merge-queue-admission\.cjs/);
});
