import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createLane, removeLane, runLocalSuite } from '../.ai/scripts/e2e-lanes.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cez-e2e-lanes-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, '.ai/scripts'), { recursive: true });
  mkdirSync(join(repo, 'packages/cezar/web/dist'), { recursive: true });
  mkdirSync(join(repo, 'packages/cezar/dist'), { recursive: true });
  mkdirSync(join(repo, 'node_modules/zod'), { recursive: true });
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\npackages/cezar/dist/\npackages/cezar/web/dist/\n.ai/qa/\n');
  writeFileSync(join(repo, 'package.json'), '{"private":true}\n');
  writeFileSync(join(repo, 'kept.txt'), 'base\n');
  writeFileSync(join(repo, 'deleted.txt'), 'remove me\n');
  writeFileSync(join(repo, '.ai/scripts/e2e.sh'), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(repo, '.ai/scripts/test-env-up.sh'), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(repo, '.ai/scripts/test-env-down.sh'), '#!/bin/sh\nexit 0\n');
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=E2E Test', '-c', 'user.email=e2e@example.invalid', 'commit', '-qm', 'fixture']);
  writeFileSync(join(repo, 'node_modules/zod/package.json'), '{}\n');
  writeFileSync(join(repo, 'packages/cezar/dist/index.js'), 'built server\n');
  writeFileSync(join(repo, 'packages/cezar/web/dist/index.html'), 'built web\n');
  writeFileSync(join(repo, 'packages/cezar/web/dist/.cez-e2e-build'), '1\n');
  return { root, repo };
}

test('each lane carries current edits and has private state with shared build assets', (t) => {
  const { root, repo } = fixture(t);
  writeFileSync(join(repo, 'kept.txt'), 'working edit\n');
  rmSync(join(repo, 'deleted.txt'));
  writeFileSync(join(repo, 'new.txt'), 'untracked\n');
  symlinkSync('future-file.txt', join(repo, 'future-link'));
  const scratch = join(root, 'scratch');
  mkdirSync(scratch);
  const baseline = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const lane1 = createLane({ repoRoot: repo, scratchRoot: scratch, index: 1, baseRef: baseline });
  // Cezar may autosave this checkout between lane creation calls. Every lane must still
  // start from the same revision and overlay the current source files.
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=E2E Test', '-c', 'user.email=e2e@example.invalid', 'commit', '-qm', 'autosave']);
  const lane2 = createLane({ repoRoot: repo, scratchRoot: scratch, index: 2, baseRef: baseline });
  try {
    assert.equal(execFileSync('git', ['-C', lane2, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baseline);
    assert.equal(readFileSync(join(lane1, 'kept.txt'), 'utf8'), 'working edit\n');
    assert.equal(readFileSync(join(lane2, 'new.txt'), 'utf8'), 'untracked\n');
    assert.equal(readlinkSync(join(lane1, 'future-link')), 'future-file.txt');
    assert.equal(existsSync(join(lane1, 'deleted.txt')), false);
    assert.equal(existsSync(join(lane2, 'deleted.txt')), false);
    assert.equal(existsSync(join(lane1, '.ai/qa')), false);
    assert.equal(existsSync(join(lane2, '.ai/qa')), false);
    assert.equal(readFileSync(join(lane1, 'packages/cezar/web/dist/index.html'), 'utf8'), 'built web\n');
    assert.equal(readFileSync(join(lane2, 'packages/cezar/dist/index.js'), 'utf8'), 'built server\n');
    assert.equal(readFileSync(join(lane1, 'node_modules/zod/package.json'), 'utf8'), '{}\n');
  } finally {
    removeLane({ repoRoot: repo, laneRoot: lane1 });
    removeLane({ repoRoot: repo, laneRoot: lane2 });
  }
  assert.equal(existsSync(lane1), false);
  assert.equal(existsSync(lane2), false);
});

test('four full-suite shards run in separate roots and all lane resources are removed', async (t) => {
  const { root, repo } = fixture(t);
  writeFileSync(join(repo, '.ai/scripts/test-env-up.sh'), `#!/bin/sh
set -eu
mkdir -p .ai/qa
printf '{"browser":{"installed":true},"baseUrl":"http://127.0.0.1:%s"}\\n' "\${E2E_BROWSER_NAMESPACE##*-}" > .ai/qa/test-env.json
`);
  writeFileSync(join(repo, '.ai/scripts/test-env-down.sh'), '#!/bin/sh\nprintf "stopped\\n" > .ai/qa/stopped\n');
  writeFileSync(join(repo, '.ai/scripts/e2e.sh'), `#!/bin/sh
set -eu
printf '%s %s %s\\n' "$PWD" "$E2E_BROWSER_NAMESPACE" "$*"
echo TEST_E2E_STATUS=passed
`);
  const result = await runLocalSuite({ repoRoot: repo, scratchRoot: join(root, 'scratch'), buildSource: async () => {} });
  assert.equal(result.status, 'passed');
  assert.equal(result.lanes.length, 4);
  assert.deepEqual(result.lanes.map((lane) => lane.shard), ['1/4', '2/4', '3/4', '4/4']);
  assert.equal(new Set(result.lanes.map((lane) => lane.namespace)).size, 4);
  // Long GitHub test session names leave only a short suffix in the Unix socket path.
  assert.ok(result.lanes.every((lane) => lane.namespace.length <= 7));
  assert.equal(new Set(result.lanes.map((lane) => lane.baseUrl)).size, 4);
  for (const lane of result.lanes) {
    const log = readFileSync(lane.logPath, 'utf8');
    assert.match(log, /TEST_E2E_STATUS=passed/);
    assert.ok(log.includes(`${lane.root} ${lane.namespace} --shard=${lane.shard}`));
    assert.equal(existsSync(lane.root), false);
  }
});

test('one failing shard makes the full local run fail and retains its log', async (t) => {
  const { root, repo } = fixture(t);
  writeFileSync(join(repo, '.ai/scripts/test-env-up.sh'), '#!/bin/sh\nmkdir -p .ai/qa\nprintf \'{"browser":{"installed":true},"baseUrl":"http://127.0.0.1:%s"}\\n\' "${E2E_BROWSER_NAMESPACE##*-}" > .ai/qa/test-env.json\n');
  writeFileSync(join(repo, '.ai/scripts/e2e.sh'), '#!/bin/sh\ncase "$*" in *--shard=3/4*) echo TEST_E2E_STATUS=failed; exit 1;; esac\necho TEST_E2E_STATUS=passed\n');
  const result = await runLocalSuite({ repoRoot: repo, scratchRoot: join(root, 'scratch'), buildSource: async () => {} });
  assert.equal(result.status, 'failed');
  assert.equal(result.lanes.find((lane) => lane.shard === '3/4').status, 'failed');
  assert.match(readFileSync(result.lanes.find((lane) => lane.shard === '3/4').logPath, 'utf8'), /TEST_E2E_STATUS=failed/);
});

test('missing browser reports skipped without claiming a full-suite pass', async (t) => {
  const { root, repo } = fixture(t);
  writeFileSync(join(repo, '.ai/scripts/test-env-up.sh'), '#!/bin/sh\nmkdir -p .ai/qa\necho \'{"browser":{"installed":false},"baseUrl":"http://127.0.0.1:1"}\' > .ai/qa/test-env.json\n');
  const result = await runLocalSuite({ repoRoot: repo, scratchRoot: join(root, 'scratch'), buildSource: async () => {} });
  assert.equal(result.status, 'skipped');
  assert.equal(result.lanes.length, 1);
  assert.equal(existsSync(result.lanes[0].root), false);
});

test('CLI exits nonzero when the full local suite skips for a missing browser', (t) => {
  const { repo } = fixture(t);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ private: true, scripts: { build: 'node -e "process.exit(0)"' } }));
  writeFileSync(join(repo, '.ai/scripts/e2e-lanes.mjs'), readFileSync(new URL('../.ai/scripts/e2e-lanes.mjs', import.meta.url)));
  writeFileSync(join(repo, '.ai/scripts/test-env-up.sh'), '#!/bin/sh\nmkdir -p .ai/qa\necho \'{"browser":{"installed":false},"baseUrl":"http://127.0.0.1:1"}\' > .ai/qa/test-env.json\n');
  const run = spawnSync(process.execPath, [join(repo, '.ai/scripts/e2e-lanes.mjs')], { cwd: repo, encoding: 'utf8' });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /TEST_E2E_STATUS=skipped/);
});

test('cleanup removes task worktrees that a lane leaves inside its temporary root', async (t) => {
  const { root, repo } = fixture(t);
  writeFileSync(join(repo, '.ai/scripts/test-env-up.sh'), '#!/bin/sh\nmkdir -p .ai/qa\nprintf \'{"browser":{"installed":true},"baseUrl":"http://127.0.0.1:%s"}\\n\' "${E2E_BROWSER_NAMESPACE}" > .ai/qa/test-env.json\n');
  writeFileSync(join(repo, '.ai/scripts/e2e.sh'), '#!/bin/sh\nmkdir -p .ai/cezar/worktrees\ngit worktree add -b "fixture-$E2E_BROWSER_NAMESPACE" .ai/cezar/worktrees/fixture HEAD\necho TEST_E2E_STATUS=passed\n');
  const scratch = join(root, 'scratch');
  const result = await runLocalSuite({ repoRoot: repo, scratchRoot: scratch, buildSource: async () => {} });
  assert.equal(result.status, 'passed');
  const registered = execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  assert.equal(registered.includes(scratch), false, registered);
  const branches = execFileSync('git', ['-C', repo, 'branch', '--list', 'fixture-*'], { encoding: 'utf8' });
  assert.equal(branches.trim(), '');
});

test('a failed server stop fails the run and retains the lane for cleanup', async (t) => {
  const { root, repo } = fixture(t);
  writeFileSync(join(repo, '.ai/scripts/test-env-up.sh'), '#!/bin/sh\nmkdir -p .ai/qa\nprintf \'{"browser":{"installed":true},"baseUrl":"http://127.0.0.1:%s"}\\n\' "${E2E_BROWSER_NAMESPACE}" > .ai/qa/test-env.json\n');
  writeFileSync(join(repo, '.ai/scripts/test-env-down.sh'), '#!/bin/sh\necho cannot-stop >&2\nexit 1\n');
  writeFileSync(join(repo, '.ai/scripts/e2e.sh'), '#!/bin/sh\necho TEST_E2E_STATUS=passed\n');
  const scratch = join(root, 'scratch');
  try {
    await assert.rejects(
      runLocalSuite({ repoRoot: repo, scratchRoot: scratch, buildSource: async () => {} }),
      /server stop failed/,
    );
    assert.equal(existsSync(join(scratch, 'lane-1')), true);
  } finally {
    for (let index = 1; index <= 4; index += 1) {
      const lane = join(scratch, `lane-${index}`);
      if (existsSync(lane)) removeLane({ repoRoot: repo, laneRoot: lane });
    }
  }
});

test('teardown closes only each lane browser namespace', async (t) => {
  const { root, repo } = fixture(t);
  const browser = join(root, 'fake-browser.sh');
  writeFileSync(browser, `#!/bin/sh
printf '%s\\n' "$*" >> "${join(root, 'browser-close.log')}"
`);
  chmodSync(browser, 0o755);
  writeFileSync(join(repo, '.ai/scripts/test-env-up.sh'), `#!/bin/sh
mkdir -p .ai/qa
printf '{"browser":{"installed":true,"command":"${browser}"},"baseUrl":"http://127.0.0.1:%s"}\\n' "$E2E_BROWSER_NAMESPACE" > .ai/qa/test-env.json
`);
  writeFileSync(join(repo, '.ai/scripts/e2e.sh'), '#!/bin/sh\necho TEST_E2E_STATUS=passed\n');
  const result = await runLocalSuite({ repoRoot: repo, scratchRoot: join(root, 'scratch'), buildSource: async () => {} });
  const calls = readFileSync(join(root, 'browser-close.log'), 'utf8').trim().split('\n');
  assert.deepEqual(calls.sort(), result.lanes.map((lane) => `--namespace ${lane.namespace} close --all`).sort());
});

// Lane administration must not inherit another task's mutation queue (#795).
import { cpSync, realpathSync } from 'node:fs';
const gitText = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const commonDir = (root) => realpathSync(gitText(root, 'rev-parse', '--path-format=absolute', '--git-common-dir'));

function privateLane(t, repo, root, index = 1) {
  const lane = createLane({ repoRoot: repo, scratchRoot: join(root, 'scratch'), index });
  t.after(() => removeLane({ repoRoot: repo, laneRoot: lane }));
  return lane;
}

test('lanes have independent canonical Git administration and never register in the source', (t) => {
  const { root, repo } = fixture(t);
  const before = gitText(repo, 'worktree', 'list', '--porcelain');
  const first = privateLane(t, repo, root);
  const second = privateLane(t, repo, root, 2);
  assert.equal(new Set([commonDir(repo), commonDir(first), commonDir(second)]).size, 3);
  assert.equal(commonDir(first), realpathSync(join(first, '.git')));
  assert.equal(gitText(repo, 'worktree', 'list', '--porcelain'), before);
});

test('lanes preserve complete initial refs, history, detached HEAD and public remote metadata', (t) => {
  const { root, repo } = fixture(t);
  const base = gitText(repo, 'rev-parse', 'HEAD');
  gitText(repo, 'branch', 'other-base');
  gitText(repo, 'tag', 'lightweight');
  gitText(repo, 'tag', '-am', 'annotated fixture', 'annotated');
  gitText(repo, 'notes', 'add', '-m', 'fixture note');
  gitText(repo, 'update-ref', 'refs/remotes/origin/main', base);
  gitText(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  gitText(repo, 'remote', 'add', 'origin', 'https://github.com/wjarka/cezar');
  gitText(repo, 'remote', 'set-url', '--push', 'origin', 'git@github.com:wjarka/cezar.git');
  gitText(repo, 'remote', 'add', 'upstream', 'ssh://git@example.test/team/project.git');
  gitText(repo, 'config', '--add', 'remote.upstream.fetch', '+refs/notes/*:refs/notes/upstream/*');
  const refs = gitText(repo, 'for-each-ref', '--format=%(refname) %(objectname) %(symref)');
  const metadata = gitText(repo, 'config', '--get-regexp', '^remote\..*\.(url|pushurl|fetch)$');
  const lane = privateLane(t, repo, root);
  assert.equal(gitText(lane, 'rev-parse', 'HEAD'), base);
  assert.equal(gitText(lane, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');
  assert.equal(gitText(lane, 'for-each-ref', '--format=%(refname) %(objectname) %(symref)'), refs);
  assert.equal(gitText(lane, 'config', '--get-regexp', '^remote\..*\.(url|pushurl|fetch)$'), metadata);
  assert.equal(gitText(lane, 'log', '--format=%H'), gitText(repo, 'log', '--format=%H'));
  assert.equal(gitText(lane, 'merge-base', 'HEAD', 'other-base'), base);
});

test('lane objects survive deletion of the source alternate lender', (t) => {
  const { root, repo: lender } = fixture(t);
  const repo = join(root, 'borrower');
  execFileSync('git', ['clone', '--shared', '--quiet', lender, repo]);
  for (const asset of ['node_modules', 'packages/cezar/dist', 'packages/cezar/web/dist']) {
    cpSync(join(lender, asset), join(repo, asset), { recursive: true });
  }
  const lane = privateLane(t, repo, root);
  const head = gitText(repo, 'rev-parse', 'HEAD');
  rmSync(lender, { recursive: true, force: true });
  assert.equal(existsSync(join(commonDir(lane), 'objects/info/alternates')), false);
  assert.equal(gitText(lane, 'rev-parse', 'HEAD'), head);
  assert.equal(gitText(lane, 'show', 'HEAD:kept.txt'), 'base');
  gitText(lane, 'fsck', '--full');
});

test('nested lane cleanup cannot delete matching parent or sibling refs', (t) => {
  const { root, repo } = fixture(t);
  const first = privateLane(t, repo, root);
  const second = privateLane(t, repo, root, 2);
  const name = 'owned-task-fixture';
  gitText(repo, 'branch', name);
  // Old shared administration fails here: the sibling sees the parent's new branch.
  gitText(second, 'branch', name);
  const nested = join(first, '.ai/cezar/worktrees/task');
  gitText(first, 'worktree', 'add', '-b', name, nested, 'HEAD');
  removeLane({ repoRoot: repo, laneRoot: first });
  assert.equal(existsSync(first), false);
  assert.ok(gitText(repo, 'rev-parse', `refs/heads/${name}`));
  assert.ok(gitText(second, 'rev-parse', `refs/heads/${name}`));
  assert.equal(gitText(repo, 'worktree', 'list', '--porcelain').includes(nested), false);
});

test('partial construction cleans only its owned directory and refuses preexisting paths', (t) => {
  const { root, repo } = fixture(t);
  const scratch = join(root, 'scratch');
  const lane = join(scratch, 'lane-1');
  mkdirSync(lane, { recursive: true });
  writeFileSync(join(lane, 'keep'), 'unrelated');
  assert.throws(() => createLane({ repoRoot: repo, scratchRoot: scratch, index: 1 }));
  assert.equal(readFileSync(join(lane, 'keep'), 'utf8'), 'unrelated');
  rmSync(lane, { recursive: true });
  rmSync(join(repo, 'packages/cezar/dist'), { recursive: true });
  const before = gitText(repo, 'worktree', 'list', '--porcelain');
  assert.throws(() => createLane({ repoRoot: repo, scratchRoot: scratch, index: 1 }), /missing shared E2E asset/);
  assert.equal(existsSync(lane), false);
  assert.equal(gitText(repo, 'worktree', 'list', '--porcelain'), before);
});

test('safe checkout settings preserve CRLF and symlink materialization', (t) => {
  const { root, repo } = fixture(t);
  gitText(repo, 'config', 'core.autocrlf', 'false');
  gitText(repo, 'config', 'core.eol', 'crlf');
  gitText(repo, 'config', 'core.symlinks', 'false');
  writeFileSync(join(repo, '.gitattributes'), '*.txt text\n');
  symlinkSync('kept.txt', join(repo, 'tracked-link'));
  gitText(repo, 'add', '.gitattributes', 'tracked-link');
  gitText(repo, 'commit', '-qm', 'checkout attributes');
  const lane = privateLane(t, repo, root);
  assert.equal(readFileSync(join(lane, 'kept.txt'), 'utf8'), 'base\r\n');
  assert.equal(readFileSync(join(lane, 'tracked-link'), 'utf8'), 'kept.txt');
  assert.equal(gitText(lane, 'config', 'core.eol'), 'crlf');
});

test('unsupported checkout configuration fails clearly without copying command or credential settings', (t) => {
  const { root, repo } = fixture(t);
  gitText(repo, 'config', 'filter.fixture.smudge', 'sentinel-command-never-run');
  assert.throws(() => createLane({ repoRoot: repo, scratchRoot: join(root, 'scratch'), index: 1 }), /unsupported.*checkout/i);
  assert.equal(existsSync(join(root, 'scratch/lane-1')), false);
});

test('credential-bearing remote URLs are refused without entering errors or lane files', (t) => {
  const { root, repo } = fixture(t);
  const secret = 'synthetic-fixture-secret';
  gitText(repo, 'remote', 'add', 'origin', `https://test:${secret}@example.test/team/project.git`);
  let failure;
  try { createLane({ repoRoot: repo, scratchRoot: join(root, 'scratch'), index: 1 }); } catch (error) { failure = error; }
  assert.ok(failure, 'unsafe remote must fail before creating a lane');
  assert.match(failure.message, /remote.*credentials|credential.*remote/i);
  assert.equal(String(failure.stack).includes(secret), false);
  assert.equal(existsSync(join(root, 'scratch/lane-1')), false);
});

test('a linked source worktree keeps its frozen base and asset identities in a private lane', (t) => {
  const { root, repo: original } = fixture(t);
  const repo = join(root, 'linked-source');
  gitText(original, 'worktree', 'add', '--detach', repo, 'HEAD');
  for (const asset of ['node_modules', 'packages/cezar/dist', 'packages/cezar/web/dist']) {
    cpSync(join(original, asset), join(repo, asset), { recursive: true });
  }
  const before = gitText(original, 'worktree', 'list', '--porcelain');
  const lane = privateLane(t, repo, root);
  assert.notEqual(commonDir(lane), commonDir(repo));
  assert.equal(gitText(lane, 'rev-parse', 'HEAD^{tree}'), gitText(repo, 'rev-parse', 'HEAD^{tree}'));
  assert.equal(gitText(original, 'worktree', 'list', '--porcelain'), before);
  for (const asset of ['node_modules', 'packages/cezar/dist', 'packages/cezar/web/dist']) {
    assert.equal(realpathSync(join(lane, asset)), realpathSync(join(repo, asset)));
  }
});

test('cleanup refuses outside registrations and replaced lane symlinks without touching their targets', (t) => {
  const { root, repo } = fixture(t);
  const lane = privateLane(t, repo, root);
  const external = join(root, 'outside-task');
  gitText(lane, 'worktree', 'add', '--detach', external, 'HEAD');
  assert.throws(() => removeLane({ repoRoot: repo, laneRoot: lane }), /outside worktree/);
  assert.equal(existsSync(join(external, 'kept.txt')), true);
  assert.equal(existsSync(lane), true);
  gitText(lane, 'worktree', 'remove', external);
  const alias = join(root, 'lane-alias');
  symlinkSync(lane, alias, 'dir');
  assert.throws(() => removeLane({ repoRoot: repo, laneRoot: alias }), /unowned/);
  assert.equal(existsSync(join(lane, 'kept.txt')), true);
});

test('public fallback remotes and effective core settings stay exact without copying unrelated config', (t) => {
  const { root, repo } = fixture(t);
  gitText(repo, 'remote', 'add', 'upstream', 'https://github.com/wjarka/cezar');
  gitText(repo, 'config', 'core.filemode', 'false');
  gitText(repo, 'config', 'credential.helper', 'synthetic-helper-must-not-copy');
  gitText(repo, 'config', 'http.extraHeader', 'synthetic-header-must-not-copy');
  const lane = privateLane(t, repo, root);
  assert.equal(gitText(lane, 'remote'), 'upstream');
  assert.equal(gitText(lane, 'remote', 'get-url', 'upstream'), 'https://github.com/wjarka/cezar');
  assert.equal(gitText(lane, 'config', '--get-all', 'core.filemode'), 'false');
  const config = readFileSync(join(lane, '.git/config'), 'utf8');
  assert.equal(config.includes('synthetic-helper'), false);
  assert.equal(config.includes('synthetic-header'), false);
});

test('an explicit older base preserves nested binary edits, deletion and executable overlay without copying hooks', (t) => {
  const { root, repo } = fixture(t);
  const base = gitText(repo, 'rev-parse', 'HEAD');
  gitText(repo, 'branch', 'fixture-base');
  writeFileSync(join(repo, 'later.txt'), 'newer commit\n');
  gitText(repo, 'add', 'later.txt');
  gitText(repo, 'commit', '-qm', 'later source');
  mkdirSync(join(repo, 'space dir'));
  const binary = Buffer.from([0, 255, 13, 10, 128]);
  writeFileSync(join(repo, 'space dir/binary.bin'), binary);
  writeFileSync(join(repo, 'space dir/tool.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  rmSync(join(repo, 'deleted.txt'));
  const hook = join(repo, '.git/hooks/post-checkout');
  mkdirSync(join(repo, '.git/hooks'), { recursive: true });
  writeFileSync(hook, '#!/bin/sh\nexit 97\n', { mode: 0o755 });
  const lane = createLane({ repoRoot: repo, scratchRoot: join(root, 'scratch'), index: 1, baseRef: 'fixture-base' });
  assert.equal(gitText(lane, 'rev-parse', 'HEAD'), base);
  assert.equal(gitText(lane, 'rev-parse', 'HEAD^{tree}'), gitText(repo, 'rev-parse', 'fixture-base^{tree}'));
  assert.equal(readFileSync(join(lane, 'later.txt'), 'utf8'), 'newer commit\n');
  assert.deepEqual(readFileSync(join(lane, 'space dir/binary.bin')), binary);
  assert.equal(existsSync(join(lane, 'deleted.txt')), false);
  assert.equal(spawnSync(join(lane, 'space dir/tool.sh')).status, 0);
  assert.equal(existsSync(join(lane, '.git/hooks/post-checkout')), false);
  removeLane({ repoRoot: repo, laneRoot: lane });
});

test('the suite refuses a preexisting scratch directory before build or cleanup can claim it', async (t) => {
  const { root, repo } = fixture(t);
  const scratchRoot = join(root, 'preexisting');
  mkdirSync(scratchRoot);
  const marker = join(scratchRoot, 'unrelated');
  writeFileSync(marker, 'keep');
  let built = false;
  await assert.rejects(runLocalSuite({ repoRoot: repo, scratchRoot, buildSource: async () => {
    built = true;
    throw new Error('fixture build stopped');
  } }));
  assert.equal(existsSync(marker), true, 'preexisting scratch contents must survive refusal');
  assert.equal(readFileSync(marker, 'utf8'), 'keep');
  assert.equal(built, false);
});

const remoteUrls = (repo, name, push = false) => gitText(repo, 'remote', 'get-url', ...(push ? ['--push'] : []), '--all', name);

test('effective remote projection preserves insteadOf longest matches and multiple fetch URLs', (t) => {
  const { root, repo } = fixture(t);
  gitText(repo, 'config', 'url.https://github.com/.insteadOf', 'fixture:');
  gitText(repo, 'config', 'url.https://example.test/special/.insteadOf', 'fixture:special/');
  gitText(repo, 'remote', 'add', 'origin', 'fixture:team/project.git');
  gitText(repo, 'config', '--add', 'remote.origin.url', 'fixture:special/project.git');
  const lane = privateLane(t, repo, root);
  assert.equal(remoteUrls(lane, 'origin'), remoteUrls(repo, 'origin'));
  assert.equal(remoteUrls(lane, 'origin', true), remoteUrls(repo, 'origin', true));
  assert.equal(readFileSync(join(lane, '.git/config'), 'utf8').includes('insteadOf'), false);
});

test('effective remote projection preserves distinct pushInsteadOf URLs for multiple fetch URLs', (t) => {
  const { root, repo } = fixture(t);
  gitText(repo, 'config', 'url.https://github.com/.insteadOf', 'fixture:');
  gitText(repo, 'config', 'url.ssh://git@push.example.test/.pushInsteadOf', 'fixture:');
  gitText(repo, 'remote', 'add', 'origin', 'fixture:team/project.git');
  gitText(repo, 'config', '--add', 'remote.origin.url', 'fixture:team/second.git');
  const lane = privateLane(t, repo, root);
  assert.equal(remoteUrls(lane, 'origin'), remoteUrls(repo, 'origin'));
  assert.equal(remoteUrls(lane, 'origin', true), remoteUrls(repo, 'origin', true));
});

test('effective remote projection honors multiple explicit push URLs over pushInsteadOf', (t) => {
  const { root, repo } = fixture(t);
  gitText(repo, 'remote', 'add', 'origin', 'https://github.com/team/project.git');
  gitText(repo, 'config', 'url.ssh://git@unused.example.test/.pushInsteadOf', 'https://github.com/');
  gitText(repo, 'config', 'url.ssh://git@push.example.test/.insteadOf', 'push-fixture:');
  gitText(repo, 'config', '--add', 'remote.origin.pushurl', 'push-fixture:team/project.git');
  gitText(repo, 'config', '--add', 'remote.origin.pushurl', 'push-fixture:team/second.git');
  const lane = privateLane(t, repo, root);
  assert.equal(remoteUrls(lane, 'origin'), remoteUrls(repo, 'origin'));
  assert.equal(remoteUrls(lane, 'origin', true), remoteUrls(repo, 'origin', true));
});

test('effective credential-bearing fetch and push rewrites refuse generically before lane creation', (t) => {
  const { root, repo } = fixture(t);
  const secret = 'synthetic-rewrite-secret';
  gitText(repo, 'remote', 'add', 'origin', 'fixture:team/project.git');
  for (const rewrite of ['insteadOf', 'pushInsteadOf']) {
    const key = `url.https://test:${secret}@example.test/.${rewrite}`;
    gitText(repo, 'config', key, 'fixture:');
    let failure;
    try { createLane({ repoRoot: repo, scratchRoot: join(root, 'scratch'), index: 1 }); } catch (error) { failure = error; }
    assert.ok(failure, 'an unsafe effective URL must refuse construction');
    assert.match(failure.message, /remote.*credentials|credential.*remote/i);
    assert.equal(String(failure.stack).includes(secret), false);
    assert.equal(existsSync(join(root, 'scratch/lane-1')), false);
    gitText(repo, 'config', '--unset', key);
  }
});

for (const linkedSource of [false, true]) {
  test(`common-dir info attributes refuse unsupported checkout for ${linkedSource ? 'linked' : 'root'} source`, (t) => {
    const { root, repo: main } = fixture(t);
    writeFileSync(join(commonDir(main), 'info/attributes'), '*.txt text eol=crlf\n');
    const linked = join(root, 'old-linked');
    gitText(main, 'worktree', 'add', '--detach', linked, 'HEAD');
    assert.equal(readFileSync(join(linked, 'kept.txt'), 'utf8'), 'base\r\n');
    assert.equal(gitText(main, 'status', '--porcelain'), '');
    const repo = linkedSource ? linked : main;
    if (linkedSource) {
      for (const asset of ['node_modules', 'packages/cezar/dist', 'packages/cezar/web/dist']) cpSync(join(main, asset), join(repo, asset), { recursive: true });
    }
    assert.throws(() => createLane({ repoRoot: repo, scratchRoot: join(root, 'scratch'), index: 1 }), /unsupported.*attributes/i);
    assert.equal(existsSync(join(root, 'scratch/lane-1')), false);
  });
}

test('absent, empty and comment-only common-dir attributes preserve the default checkout', (t) => {
  const { root, repo } = fixture(t);
  const attributes = join(commonDir(repo), 'info/attributes');
  for (const [index, contents] of [undefined, '', '\n  \n# fixture comment\n'].entries()) {
    if (contents !== undefined) writeFileSync(attributes, contents);
    const lane = privateLane(t, repo, root, index + 1);
    assert.equal(readFileSync(join(lane, 'kept.txt'), 'utf8'), 'base\n');
  }
});

test('inherited rewrites that would transform a resolved URL twice refuse and clean the partial lane', (t) => {
  const { root, repo } = fixture(t);
  const globalConfig = join(root, 'fixture-global.gitconfig');
  writeFileSync(globalConfig, '[url "https://second.example.test/"]\n\tinsteadOf = https://github.com/\n');
  gitText(repo, 'config', 'url.https://github.com/.insteadOf', 'fixture:');
  gitText(repo, 'remote', 'add', 'origin', 'fixture:team/project.git');
  const script = join(root, 'probe.mjs');
  const scratch = join(root, 'scratch');
  writeFileSync(script, `import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createLane } from ${JSON.stringify(new URL('../.ai/scripts/e2e-lanes.mjs', import.meta.url).href)};
assert.throws(() => createLane({repoRoot:${JSON.stringify(repo)},scratchRoot:${JSON.stringify(scratch)},index:1}), /unsupported effective E2E remote rewrite/);
assert.equal(existsSync(${JSON.stringify(join(scratch, 'lane-1'))}), false);
`);
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
