'use strict';
// A throwaway repository shaped like a merge group: a base commit that holds
// the classifier, then queued commits on top. Tests run under test-git-env.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLASSIFIER = path.join(__dirname, 'change-surface.cjs');
const FAILING_CLASSIFIER = 'process.exit(1);\n';

function gitRepo({ classifier = fs.readFileSync(CLASSIFIER, 'utf8') } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-surface-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const commit = (files, message = 'change') => {
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(dir, file);
      if (content === null) { fs.rmSync(target); continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  const base = commit({ '.github/scripts/change-surface.cjs': classifier, 'src/old.ts': 'old\n', 'README.md': 'base\n' }, 'base');
  return { dir, git, commit, base, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

module.exports = { gitRepo, FAILING_CLASSIFIER };
