import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
