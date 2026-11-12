'use strict';

// Guards the reset a failed merge-group shard runs before its rerun (ci.yml, docs/sdlc/ci.md
// § Rerun of a failed queue shard): real Vitest runs on a fixture pin the results cache's place
// and format, and the order the rerun gets back.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.join(__dirname, '..', '..');
const script = path.join(__dirname, 'vitest-rerun-reset.cjs');
const vitestBin = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');

// A repository whose Vitest root is pkg/: the passing file is the larger one, so a run with no
// cache takes it first (Vitest orders unknown files by size) and a cached failure flips that.
function fixture(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vitest-rerun-reset-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const root = path.join(repo, 'pkg');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  // An explicit config, so Vitest never takes a config from a directory above the fixture.
  fs.writeFileSync(path.join(root, 'vitest.config.mjs'), 'export default { test: { globals: true } }\n');
  fs.writeFileSync(path.join(root, 'passes.test.js'), `// ${'padding '.repeat(64)}\ntest('passes', () => {})\n`);
  fs.writeFileSync(path.join(root, 'sub', 'fails.test.js'), "test('fails', () => { throw new Error('first run') })\n");
  return { repo, root };
}

function runVitest(root) {
  return spawnSync(process.execPath, [vitestBin, 'run', '--config', 'vitest.config.mjs'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '', CI: 'true' },
  });
}

function reset(repo, ...args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: repo, encoding: 'utf8' });
}

function cacheFiles(root) {
  const dir = path.join(root, 'node_modules', '.vite', 'vitest');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((hash) => path.join(dir, hash, 'results.json')).filter((file) => fs.existsSync(file));
}

async function order(root) {
  const { createVitest } = await import('vitest/node');
  const { default: CiTestSequencer } = await import('./ci-test-sequencer.mjs');
  const vitest = await createVitest('test', { root, config: path.join(root, 'vitest.config.mjs'), watch: false });
  try {
    const sorted = await new CiTestSequencer(vitest).sort(await vitest.globTestSpecifications());
    return sorted.map((specification) => path.relative(root, specification.moduleId));
  } finally {
    await vitest.close();
  }
}

test('records the first run\'s failed files from the repository root and deletes the results cache', (t) => {
  const { repo, root } = fixture(t);
  assert.equal(runVitest(root).status, 1, 'the fixture\'s first run fails');
  assert.equal(cacheFiles(root).length, 1, 'Vitest wrote its results cache where the reset looks');
  const result = reset(repo, 'pkg', 'failed.txt');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(repo, 'failed.txt'), 'utf8'), 'pkg/sub/fails.test.js\n');
  assert.deepEqual(cacheFiles(root), []);
  assert.match(result.stdout, /pkg\/sub\/fails\.test\.js/);
});

test('the rerun sorts the shard as the first run did, and without the reset it would not', async (t) => {
  const { repo, root } = fixture(t);
  const first = await order(root);
  assert.deepEqual(first, ['passes.test.js', path.join('sub', 'fails.test.js')]);
  runVitest(root);
  assert.notDeepEqual(await order(root), first, 'Vitest runs a cached failure first');
  assert.equal(reset(repo, 'pkg', 'failed.txt').status, 0);
  assert.deepEqual(await order(root), first);
});

test('with no results cache it writes an empty list and succeeds', (t) => {
  const { repo } = fixture(t);
  const result = reset(repo, 'pkg', 'failed.txt');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(repo, 'failed.txt'), 'utf8'), '');
});

test('an unreadable results cache names no file, warns, and is still deleted', (t) => {
  const { repo, root } = fixture(t);
  const cache = path.join(root, 'node_modules', '.vite', 'vitest', 'hash', 'results.json');
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, '{"results": 7');
  const result = reset(repo, 'pkg', 'failed.txt');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^::warning title=Unreadable Vitest results cache::/m);
  assert.equal(fs.readFileSync(path.join(repo, 'failed.txt'), 'utf8'), '');
  assert.deepEqual(cacheFiles(root), []);
});

test('it refuses to run without a Vitest root and a list file', (t) => {
  const { repo } = fixture(t);
  const result = reset(repo, 'pkg');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage/);
});

test('the shard configs keep their results caches where the reset looks', async () => {
  const { createVitest } = await import('vitest/node');
  for (const [config, root] of [[undefined, '.'], ['packages/web/e2e/vitest.config.ts', 'packages/web/e2e']]) {
    const vitest = await createVitest('test', { root: repoRoot, config: config && path.join(repoRoot, config), watch: false });
    try {
      const cache = vitest.cache.results.getCachePath();
      assert.equal(path.dirname(path.dirname(cache)), path.join(repoRoot, root, 'node_modules', '.vite', 'vitest'), config ?? 'root config');
      assert.equal(path.basename(cache), 'results.json');
    } finally {
      await vitest.close();
    }
  }
});
