const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseApplyCheckByFile,
  dryRunOf,
  parseNameStatus,
  isReachabilityCandidate,
  reachabilityOf,
  urlEntrySpecifiers,
  urlEntryCandidates,
  staticImportSpecifiers,
  distImportCandidates,
  isRepoScript,
  fileFlags,
  renderTargetsReport,
} = require('./upstream-targets.cjs');

const SHA_U = '2b5411e479c63870f857d12314a87572f2cc2ec0';

// Captured from `git format-patch -1 --stdout 2b5411e4 | git apply --check --3way -` on main (2026-10-16).
const REAL_APPLY_OUTPUT = [
  'Applied patch to \'BACKWARD_COMPATIBILITY.md\' with conflicts.',
  'error: packages/web/src/components/project-groups.tsx: does not exist in index',
  'Performing three-way merge...',
  'Applied patch to \'packages/web/src/lib/project-order.ts\' with conflicts.',
].join('\n');

test('parseApplyCheckByFile reads the real 3-way dry run per file', () => {
  const byFile = parseApplyCheckByFile(REAL_APPLY_OUTPUT);
  assert.equal(byFile.get('BACKWARD_COMPATIBILITY.md'), 'conflict');
  assert.equal(byFile.get('packages/web/src/components/project-groups.tsx'), 'missing');
  assert.equal(byFile.get('packages/web/src/lib/project-order.ts'), 'conflict');
  assert.equal(byFile.size, 3);
});

test('parseApplyCheckByFile knows the clean and patch-failed forms', () => {
  const byFile = parseApplyCheckByFile([
    'Applied patch to \'a.ts\' cleanly.',
    'error: patch failed: b.ts:12',
    'error: b.ts: patch does not apply',
    'error: c.ts: patch does not apply',
    // An older git falls back to a three-way merge after the direct apply fails; its verdict wins.
    'error: patch failed: d.ts:3',
    'Falling back to three-way merge...',
    'Applied patch to \'d.ts\' cleanly.',
  ].join('\n'));
  assert.equal(byFile.get('a.ts'), 'clean');
  assert.equal(byFile.get('b.ts'), 'conflict');
  assert.equal(byFile.get('c.ts'), 'conflict');
  assert.equal(byFile.get('d.ts'), 'clean');
});

test('dryRunOf reads a file the output never mentions as unknown, and a rename by its old path', () => {
  const byFile = parseApplyCheckByFile(REAL_APPLY_OUTPUT);
  assert.equal(dryRunOf(byFile, { path: 'CHANGELOG.md' }), 'unknown');
  assert.equal(dryRunOf(byFile, { path: 'BACKWARD_COMPATIBILITY.md' }), 'conflict');
  assert.equal(dryRunOf(byFile, { from: 'packages/web/src/components/project-groups.tsx', path: 'packages/web/src/components/groups.tsx' }), 'missing');
});

test('parseNameStatus reads `git diff-tree -z --name-status -M` including renames', () => {
  const text = ['M', 'BACKWARD_COMPATIBILITY.md', 'A', 'packages/web/src/lib/project-order.ts', 'D', 'old.md', 'R087', 'packages/a.ts', 'packages/b.ts', ''].join('\0');
  assert.deepEqual(parseNameStatus(text), [
    { status: 'M', path: 'BACKWARD_COMPATIBILITY.md' },
    { status: 'A', path: 'packages/web/src/lib/project-order.ts' },
    { status: 'D', path: 'old.md' },
    { status: 'R', from: 'packages/a.ts', path: 'packages/b.ts' },
  ]);
});

test('isReachabilityCandidate admits package source files and nothing else', () => {
  const table = {
    'packages/web/src/components/project-groups.tsx': true,
    'packages/cezar/src/server/server.ts': true,
    'packages/contract/src/workspace.ts': true,
    'packages/web/src/lib/a.js': true,
    'packages/web/src/lib/a.jsx': true,
    'packages/web/src/lib/a.mjs': true,
    'packages/web/src/lib/a.cjs': true,
    'packages/web/src/vite-env.d.ts': false,
    'packages/web/src/components/project-groups.test.tsx': false,
    'packages/web/src/lib/project-order.spec.ts': false,
    'packages/cezar/src/test/helpers.ts': false,
    'packages/cezar/src/runs/__tests__/a.ts': false,
    'packages/web/src/e2e/a.ts': false,
    'packages/cezar/src/fixtures/a.ts': false,
    'packages/cezar/src/__fixtures__/a.ts': false,
    'packages/cezar/src/__snapshots__/a.ts': false,
    'packages/web/e2e/project-groups.e2e.ts': false,
    'packages/web/src/styles/index.css': false,
    'packages/cezar/scripts/mock-codex-app-server.mjs': false,
    'packages/a/b/src/x.ts': false,
    'CHANGELOG.md': false,
  };
  for (const [file, expected] of Object.entries(table)) assert.equal(isReachabilityCandidate(file), expected, file);
});

test('reachabilityOf fails closed toward unknown and never calls a file test-only without a populated build', () => {
  const file = 'packages/web/src/components/dead.tsx';
  const built = { error: null, inputs: new Set(['packages/web/src/main.tsx']) };
  assert.equal(reachabilityOf({ path: file, forkExists: true }, built), 'test-only');
  assert.equal(reachabilityOf({ path: 'packages/web/src/main.tsx', forkExists: true }, built), 'production');
  assert.equal(reachabilityOf({ path: file, forkExists: false }, built), 'n/a');
  assert.equal(reachabilityOf({ path: 'CHANGELOG.md', forkExists: true }, built), 'n/a');
  assert.equal(reachabilityOf({ path: file, forkExists: true }, { error: 'Could not resolve "./x"', inputs: new Set() }), 'unknown');
  assert.equal(reachabilityOf({ path: file, forkExists: true }, { error: null, inputs: new Set() }), 'unknown', 'an empty build is not evidence');
});

test('urlEntrySpecifiers pulls relative entries out of new URL(…, import.meta.url)', () => {
  // The three path-loaded entries in packages/cezar, verbatim.
  assert.deepEqual(urlEntrySpecifiers('    const entry = fileURLToPath(new URL(\'./mcp.js\', import.meta.url));'), ['./mcp.js']);
  assert.deepEqual(
    urlEntrySpecifiers('  const helper = fileURLToPath(new URL(source ? \'./git-worktree-lock-helper.ts\' : \'./git-worktree-lock-helper.js\', import.meta.url));'),
    ['./git-worktree-lock-helper.ts', './git-worktree-lock-helper.js'],
  );
  assert.deepEqual(
    urlEntrySpecifiers('    const entry = new URL(`./transcript-facts-worker.${source ? \'ts\' : \'js\'}`, import.meta.url);'),
    ['./transcript-facts-worker.'],
  );
  // packages/web/src/api/live-coordinator.ts: only the import.meta.url call is an entry.
  assert.deepEqual(
    urlEntrySpecifiers('const url = import.meta.env.DEV ? new URL(\'./live-worker.ts\', import.meta.url) : new URL(\'/live-worker.js\', location.href)\nconst a = dirname(fileURLToPath(import.meta.url))'),
    ['./live-worker.ts'],
  );
  assert.deepEqual(urlEntrySpecifiers('new URL(\'https://example.com/x.js\', import.meta.url)'), []);
  assert.deepEqual(urlEntrySpecifiers('new URL(\n  \'../shared/run.js\',\n  import.meta.url,\n)'), ['../shared/run.js']);
});

test('urlEntryCandidates resolves against the file directory with source extensions', () => {
  assert.deepEqual(urlEntryCandidates('packages/cezar/src/ci-wait/controller.ts', './mcp.js'), [
    'packages/cezar/src/ci-wait/mcp.js', 'packages/cezar/src/ci-wait/mcp.ts', 'packages/cezar/src/ci-wait/mcp.tsx',
  ]);
  assert.deepEqual(urlEntryCandidates('packages/cezar/src/git-worktree-lock.ts', './git-worktree-lock-helper.ts'), [
    'packages/cezar/src/git-worktree-lock-helper.ts',
  ]);
  assert.deepEqual(urlEntryCandidates('packages/cezar/src/runs/transcript-facts-queue.ts', './transcript-facts-worker.'), [
    'packages/cezar/src/runs/transcript-facts-worker.ts',
    'packages/cezar/src/runs/transcript-facts-worker.tsx',
    'packages/cezar/src/runs/transcript-facts-worker.js',
    'packages/cezar/src/runs/transcript-facts-worker.jsx',
    'packages/cezar/src/runs/transcript-facts-worker.mjs',
    'packages/cezar/src/runs/transcript-facts-worker.cjs',
  ]);
  assert.deepEqual(urlEntryCandidates('packages/cezar/src/core/x.ts', '../../scripts/mock.mjs'), ['packages/cezar/scripts/mock.mjs']);
});

test('staticImportSpecifiers lists every static import and re-export, type-only ones included', () => {
  const text = [
    "import type { UiEvent } from './ui-events.ts';",
    "import { a, type B } from '../b.js'",
    'import type {',
    '  C,',
    '  D,',
    "} from '@open-mercato/cezar-contract'",
    "import './styles/index.css'",
    "export * from './protocol/index.ts'",
    "export type { E } from \"./e.ts\"",
    "const lazy = await import('./lazy.ts')",
    "import { a as again } from '../b.js'",
  ].join('\n');
  assert.deepEqual(staticImportSpecifiers(text), [
    './ui-events.ts', '../b.js', '@open-mercato/cezar-contract', './styles/index.css', './protocol/index.ts', './e.ts',
  ]);
});

test('distImportCandidates maps a script\'s imports of a built dist/ back to package source', () => {
  const candidates = (js) => [js, js.replace(/\.js$/, '.ts'), js.replace(/\.js$/, '.tsx')];
  // scripts/release.mjs:49, verbatim.
  assert.deepEqual(
    distImportCandidates('scripts/release.mjs', 'import { isPublishable, RELEASE_MANIFEST_DIRS } from \'../packages/cezar/dist/release/manifests.js\';'),
    [candidates('packages/cezar/src/release/manifests.js')],
  );
  // packages/cezar/scripts/check-pack.mjs:17, verbatim.
  assert.deepEqual(
    distImportCandidates('packages/cezar/scripts/check-pack.mjs', 'import { findPackGaps } from \'../dist/pack-check.js\';'),
    [candidates('packages/cezar/src/pack-check.js')],
  );
  assert.deepEqual(
    distImportCandidates('packages/cezar/scripts/omp-ci-wait.mjs', 'const built = new URL(\'../dist/ci-wait/tools.js\', import.meta.url);'),
    [candidates('packages/cezar/src/ci-wait/tools.js')],
  );
  // packages/cezar/scripts/measure-transcript-facts-health.mjs:19: a directory names no file.
  assert.deepEqual(distImportCandidates('packages/cezar/scripts/x.mjs', 'const runtime = { url: new URL(\'../dist/\', import.meta.url), ext: \'js\' };'), []);
  assert.deepEqual(distImportCandidates('packages/cezar/scripts/x.mjs', [
    'import { a } from \'node:fs\'',
    'import { b } from \'./sibling.mjs\'',
    'const source = new URL(\'../src/ci-wait/tools.ts\', import.meta.url);',
    'const page = new URL(\'../web/dist/index.html\', import.meta.url);',
    'const other = new URL(\'../dist/cli.d.ts\', import.meta.url);',
  ].join('\n')), [], 'only a .js file under a package dist/ counts; the bundled cockpit under web/dist is not one');
});

test('isRepoScript admits root and package scripts, never their tests', () => {
  const table = {
    'scripts/release.mjs': true,
    'scripts/release-snapshot.mjs': true,
    'packages/cezar/scripts/check-pack.mjs': true,
    'packages/cezar/scripts/a.cjs': true,
    'packages/cezar/scripts/a.js': true,
    'scripts/test-changed.test.mjs': false,
    'packages/cezar/scripts/a.test.mjs': false,
    'scripts/a.js': false,
    'packages/cezar/scripts/benchmark-run-store.ts': false,
    'packages/cezar/scripts/nested/a.mjs': false,
    'packages/cezar/src/a.mjs': false,
    '.github/scripts/upstream-scan.cjs': false,
  };
  for (const [file, expected] of Object.entries(table)) assert.equal(isRepoScript(file), expected, file);
});

test('fileFlags names every flag that applies', () => {
  const live = { status: 'M', forkExists: true, reachability: 'production', drift: { commits: 0, added: 0, deleted: 0 } };
  assert.deepEqual(fileFlags(live), []);
  assert.deepEqual(fileFlags({ ...live, reachability: 'test-only' }), ['test-only']);
  assert.deepEqual(fileFlags({ ...live, drift: { commits: 2, added: 5, deleted: 1 } }), ['drifted']);
  assert.deepEqual(fileFlags({ ...live, drift: null }), [], 'unknown drift is not drift');
  assert.deepEqual(fileFlags({ ...live, reachability: 'unknown' }), [], 'unknown reachability is not test-only');
  for (const status of ['M', 'D', 'R']) {
    assert.deepEqual(fileFlags({ ...live, status, forkExists: false, reachability: 'n/a', drift: { commits: 1, added: 0, deleted: 9 } }), ['missing', 'drifted'], status);
  }
  assert.deepEqual(fileFlags({ ...live, status: 'A', forkExists: false, reachability: 'n/a' }), [], 'an added file is expected to be absent');
});

function report(overrides = {}) {
  const file = (path, extra = {}) => ({
    status: 'M', path, fork: { exists: true, lastTouch: null }, reachability: 'n/a', drift: { commits: 0, added: 0, deleted: 0 }, dryRun: 'clean', ...extra,
  });
  return {
    ledger: { upstream: { repo: 'open-mercato/cezar' }, fork: { repo: 'hearsay-tools/cezarion' } },
    head: { short: 'aaaa1111', date: '2026-10-16' },
    reach: { roots: 3, reachable: 912, error: null },
    sections: [{
      entry: { sha: SHA_U, pr: 953, title: 'feat(sidebar): drag | drop (#953)', status: 'ported', fork: { issue: 438, pr: 999 }, hint: { conflicts: 3 }, note: 'drag moved to the rail' },
      intro: { short: 'eadd0633', subject: 'feat(upstream): ledger of upstream commits (#425)' },
      baseline: { short: 'bbbb2222', date: '2026-09-18' },
      files: [
        file('CHANGELOG.md', { dryRun: 'conflict' }),
        file('packages/web/src/components/project-groups.tsx', {
          fork: { exists: false, lastTouch: { short: '956577f7', subject: 'refactor(web): drop ProjectGroups (#1074)' } },
          drift: { commits: 9, added: 40, deleted: 310 }, dryRun: 'missing',
        }),
        file('docs/a|b.md'),
        file('packages/web/src/lib/project-order.ts', { reachability: 'test-only', dryRun: 'conflict' }),
      ],
    }],
    ...overrides,
  };
}

test('renderTargetsReport puts flagged rows first, in diff order, and escapes cells', () => {
  const md = renderTargetsReport(report());
  const rows = md.split('\n').filter((l) => l.startsWith('| `') || l.startsWith('| docs'));
  const order = rows.map((r) => /\| `?([^`|]+)/.exec(r)[1]);
  assert.deepEqual(order, [
    'packages/web/src/components/project-groups.tsx',
    'packages/web/src/lib/project-order.ts',
    'CHANGELOG.md',
    'docs/a\\',
  ]);
  assert.match(md, /`docs\/a\\\|b\.md`/, 'pipe in a path is escaped');
  assert.match(md, /missing, drifted/);
  assert.match(md, /956577f7/);
  assert.match(md, /9 commits, \+40 −310/);
  assert.match(md, /\| File \| Upstream \| Fork \| Flags \| Reachability \| Drift \| Dry run \|/);
});

test('renderTargetsReport heads the report with the fork HEAD, counts and the reachability run', () => {
  const md = renderTargetsReport(report());
  assert.match(md, /`aaaa1111` \(2026-10-16\)/);
  assert.match(md, /1 upstream commit checked/);
  assert.match(md, /2 files flagged/);
  assert.match(md, /esbuild from 3 roots, 912 files reachable/);
  assert.match(md, /^## `2b5411e4` \[#953\]\(https:\/\/github\.com\/open-mercato\/cezar\/pull\/953\) feat\(sidebar\): drag \| drop/m);
  assert.match(md, /`ported`/);
  assert.match(md, /issue #438/);
  assert.match(md, /PR #999/);
  assert.match(md, /drag moved to the rail/);
  assert.match(md, /eadd0633/);
  assert.match(md, /bbbb2222/);
  assert.match(md, /2 conflict · 1 missing · 1 clean/);
  assert.match(md, /scan recorded 3/);
});

test('renderTargetsReport prints unknown drift when the baseline is unknown', () => {
  const r = report();
  r.sections[0].intro = null;
  r.sections[0].baseline = null;
  for (const f of r.sections[0].files) f.drift = null;
  const md = renderTargetsReport(r);
  assert.match(md, /^## .*baseline unknown/m);
  const rows = md.split('\n').filter((l) => l.startsWith('| `'));
  assert.ok(rows.length >= 3);
  for (const row of rows) assert.match(row, /\| unknown \| [a-z]+ \|$/, row);
  assert.doesNotMatch(md, /0 commits/);
});

test('renderTargetsReport shows churn that no non-merge commit accounts for, without flagging it', () => {
  const r = report();
  // A merge that resolved a conflict in the file: churn since the baseline, no non-merge commit.
  r.sections[0].files[2].drift = { commits: 0, added: 1, deleted: 1 };
  const md = renderTargetsReport(r);
  assert.match(md, /^\| `docs\/a\\\|b\.md` \| M \| present \| {2}\| n\/a \| 0 commits, \+1 −1 \| clean \|$/m);
  assert.match(md, /^\| `CHANGELOG\.md` \| M \| present \| {2}\| n\/a \| 0 commits \| conflict \|$/m, 'no churn, no numbers');
});

test('renderTargetsReport says why the dry run is unknown when HEAD could not be snapshotted', () => {
  assert.doesNotMatch(renderTargetsReport(report()), /^- Dry run:/m, 'a dry run that ran needs no header line');
  const r = report({ dryRunError: 'cannot snapshot HEAD: ENOSPC: no space left on device' });
  for (const f of r.sections[0].files) f.dryRun = 'unknown';
  const md = renderTargetsReport(r);
  assert.match(md, /^- Dry run: unknown — cannot snapshot HEAD: ENOSPC: no space left on device$/m);
  assert.match(md, /^- Dry run now: 0 conflict · 0 missing · 0 clean · 4 unknown/m);
});

test('renderTargetsReport says why reachability is unknown when the build failed', () => {
  const r = report({ reach: { roots: 3, reachable: 0, error: 'Could not resolve "./gone"' } });
  r.sections[0].files[3].reachability = 'unknown';
  const md = renderTargetsReport(r);
  assert.match(md, /Reachability: unknown — Could not resolve "\.\/gone"/);
  assert.match(md, /`packages\/web\/src\/lib\/project-order\.ts` \| M \| [^|]+ \| [^|]*\| unknown \|/);
});

test('collectReachability on this repo\'s HEAD snapshot reaches the cockpit, the CLI, its path-loaded entries and the contract', async () => {
  const path = require('node:path');
  const { collectReachability } = require('./upstream-reachability.cjs');
  const { resolveHead, withHeadSnapshot } = require('./upstream-scan.cjs');
  // `targets` bundles the files it checks out of HEAD, not the work tree; a file production code
  // imports that the snapshot leaves out would fail the build here.
  const repo = path.resolve(__dirname, '../..');
  const reach = await withHeadSnapshot(repo, resolveHead(repo), (snapshot) => {
    assert.equal(snapshot.error, null);
    return collectReachability(snapshot.tree);
  });
  assert.equal(reach.error, null);
  for (const file of [
    'packages/web/src/components/project-rail.tsx',
    'packages/cezar/src/server/server.ts',
    // Started by path through `new URL(…, import.meta.url)`, never imported.
    'packages/cezar/src/ci-wait/mcp.ts',
    'packages/cezar/src/git-worktree-lock-helper.ts',
    'packages/cezar/src/runs/transcript-facts-worker.ts',
    'packages/web/src/api/live-worker.ts',
    // Imported for types only, which esbuild erases before it resolves anything.
    'packages/cezar/src/core/ui-events.ts',
    'packages/cezar/src/server/forge/types.ts',
    'packages/web/src/components/diff/types.ts',
    // Repo scripts import these from the built dist/ (scripts/release.mjs, check-pack.mjs).
    'packages/cezar/src/release/manifests.ts',
    'packages/cezar/src/release/stable.ts',
    'packages/cezar/src/release/snapshot.ts',
    'packages/cezar/src/pack-check.ts',
  ]) assert.ok(reach.inputs.has(file), `${file} is reachable`);
  assert.ok([...reach.inputs].some((f) => /^packages\/contract\/src\/[^/]+\.ts$/.test(f)), 'the contract is reached through its importers');
  assert.equal(reach.inputs.has('packages/web/src/components/project-rail.test.tsx'), false, 'tests are not production');
  assert.ok(reach.roots >= 3, `roots: ${reach.roots}`);
});

/** A repo laid out like the fork: an "upstream" commit on a side branch touches a live file, a
 *  file only a test imports, a file the fork deletes later and a doc; the ledger row lands on
 *  main, then the fork edits the live file and deletes the other one. */
function forkFixture() {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const yaml = require('yaml');
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cez-upstream-targets-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  const ledger = (entries, base) => yaml.stringify({
    upstream: { repo: 'open-mercato/cezar', branch: 'main' },
    fork: { repo: 'hearsay-tools/cezarion' },
    origin: { mergeBase: base, date: '2026-09-01' },
    scans: [],
    entries,
  });
  git('init', '-q', '-b', 'main');
  write('README.md', 'fixture\n');
  write('packages/web/index.html', '<script type="module" src="/src/main.tsx"></script>\n');
  write('packages/web/package.json', '{ "name": "web", "private": true }\n');
  write('packages/web/src/main.tsx', 'import { Live } from \'./live.tsx\'\nimport { gone } from \'./gone.ts\'\nexport const app = [Live, gone]\n');
  write('packages/web/src/live.tsx', 'export const Live = 1\n// two\n// three\n');
  write('packages/web/src/dead.tsx', 'export const Dead = 1\n');
  write('packages/web/src/dead.test.tsx', 'import { Dead } from \'./dead.tsx\'\nexport const t = Dead\n');
  write('packages/web/src/gone.ts', 'export const gone = 1\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');

  git('checkout', '-q', '-b', 'upstream');
  write('README.md', 'fixture, upstream\n');
  write('packages/web/src/live.tsx', 'export const Live = 2\n// two\n// three\n');
  write('packages/web/src/dead.tsx', 'export const Dead = 2\n');
  write('packages/web/src/gone.ts', 'export const gone = 2\n');
  git('commit', '-q', '-am', 'feat(web): upstream change (#12)');
  const upstream = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');

  const entries = [
    { sha: upstream, pr: 12, title: 'feat(web): upstream change (#12)', date: '2026-09-10', status: 'pending', hint: { conflicts: 0 }, note: 'applies clean' },
    { sha: `abcdef1${'a'.repeat(33)}`, title: 'one of two rows sharing a prefix', date: '2026-09-10', status: 'pending' },
    { sha: `abcdef1${'b'.repeat(33)}`, title: 'two of two rows sharing a prefix', date: '2026-09-10', status: 'pending' },
    { sha: `fedcba9${'c'.repeat(33)}`, title: 'an upstream commit this clone never fetched', date: '2026-09-10', status: 'pending' },
  ];
  write('.ai/upstream/ledger.yaml', ledger(entries, base));
  git('add', '.');
  git('commit', '-q', '-m', 'chore(upstream): scan');

  write('packages/web/src/live.tsx', 'export const Live = 3\n// two\n// three\n');
  git('commit', '-q', '-am', 'feat(web): fork edits live');
  git('rm', '-q', 'packages/web/src/gone.ts');
  write('packages/web/src/main.tsx', 'import { Live } from \'./live.tsx\'\nexport const app = [Live]\n');
  git('commit', '-q', '-am', 'refactor(web): drop gone');
  const dropGone = git('rev-parse', '--short', 'HEAD');
  return { dir, git, write, ledger, entries, base, upstream, dropGone, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('collectTargets re-checks an upstream commit against the fork HEAD', async (t) => {
  const { collectTargets } = require('./upstream-scan.cjs');
  const fx = forkFixture();
  t.after(fx.cleanup);
  const report = await collectTargets([fx.upstream.slice(0, 8)], { cwd: fx.dir, fetch: false });
  assert.equal(report.reach.error, null);
  assert.equal(report.head.short, fx.dropGone);
  assert.equal(report.sections.length, 1);
  const [section] = report.sections;
  assert.equal(section.entry.sha, fx.upstream);
  assert.equal(section.intro.subject, 'chore(upstream): scan');
  assert.equal(section.baseline.short, fx.git('rev-parse', '--short', fx.base));
  const byPath = Object.fromEntries(section.files.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(byPath), ['README.md', 'packages/web/src/dead.tsx', 'packages/web/src/gone.ts', 'packages/web/src/live.tsx']);

  const dead = byPath['packages/web/src/dead.tsx'];
  assert.equal(dead.reachability, 'test-only');
  assert.deepEqual(dead.drift, { commits: 0, added: 0, deleted: 0 });
  assert.equal(dead.dryRun, 'clean');
  assert.deepEqual(fileFlags({ ...dead, forkExists: dead.fork.exists }), ['test-only']);

  const gone = byPath['packages/web/src/gone.ts'];
  assert.equal(gone.fork.exists, false);
  assert.deepEqual(gone.fork.lastTouch, { short: fx.dropGone, subject: 'refactor(web): drop gone' });
  assert.equal(gone.reachability, 'n/a');
  assert.equal(gone.dryRun, 'missing');
  assert.deepEqual(fileFlags({ ...gone, forkExists: gone.fork.exists }), ['missing', 'drifted']);

  const live = byPath['packages/web/src/live.tsx'];
  assert.equal(live.reachability, 'production');
  assert.deepEqual(live.drift, { commits: 1, added: 1, deleted: 1 });
  assert.equal(live.dryRun, 'conflict');
  assert.deepEqual(fileFlags({ ...live, forkExists: live.fork.exists }), ['drifted']);

  const readme = byPath['README.md'];
  assert.equal(readme.reachability, 'n/a');
  assert.deepEqual(fileFlags({ ...readme, forkExists: readme.fork.exists }), []);

  const md = renderTargetsReport(report);
  assert.match(md, new RegExp(`^## \`${fx.upstream.slice(0, 8)}\` `, 'm'));
  assert.match(md, /3 files flagged/);
  assert.match(md, /1 conflict · 1 missing · 2 clean/);
  const rows = md.split('\n').filter((l) => l.startsWith('| `'));
  assert.match(rows[rows.length - 1], /^\| `README\.md` \|/, 'the unflagged row comes last');
  assert.match(md, /`packages\/web\/src\/gone\.ts` \| M \| absent, last touched by `[0-9a-f]+` refactor\(web\): drop gone \| missing, drifted \|/);
});

test('collectTargets reads drift as unknown for a ledger row HEAD never committed', async (t) => {
  const { collectTargets } = require('./upstream-scan.cjs');
  const fx = forkFixture();
  t.after(fx.cleanup);
  fx.git('checkout', '-q', 'upstream');
  fx.write('packages/web/src/live.tsx', 'export const Live = 4\n// two\n// three\n');
  fx.git('commit', '-q', '-am', 'fix(web): a later upstream change (#13)');
  const later = fx.git('rev-parse', 'HEAD');
  fx.git('checkout', '-q', 'main');
  fx.write('.ai/upstream/ledger.yaml', fx.ledger([...fx.entries, { sha: later, pr: 13, title: 'fix(web): a later upstream change (#13)', date: '2026-09-20', status: 'pending' }], fx.base));
  const report = await collectTargets([later.slice(0, 10), fx.upstream.slice(0, 7)], { cwd: fx.dir, fetch: false });
  assert.deepEqual(report.sections.map((s) => s.entry.sha), [later, fx.upstream], 'one section per commit, in the order given');
  assert.equal(report.sections[0].baseline, null);
  assert.equal(report.sections[0].files[0].drift, null);
  assert.match(renderTargetsReport(report), /^## .*baseline unknown/m);
  assert.notEqual(report.sections[1].baseline, null);
});

/** What `collectTargets` must leave alone: the fixture's status and its real index, byte for byte.
 *  `--no-optional-locks` keeps `git status` itself from refreshing the index. */
function repoState(fx) {
  const fs = require('node:fs');
  const path = require('node:path');
  return {
    status: fx.git('--no-optional-locks', 'status', '--porcelain', '--untracked-files=all'),
    index: fs.readFileSync(path.join(fx.dir, '.git', 'index')).toString('base64'),
  };
}

/** Points `os.tmpdir()` at a fresh directory for one test, so the snapshot's temp dirs can be counted. */
function privateTmp(t) {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const saved = process.env.TMPDIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cez-upstream-tmp-'));
  process.env.TMPDIR = dir;
  t.after(() => {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, leftovers: () => fs.readdirSync(dir).filter((n) => n.startsWith('cez-targets-')) };
}

test('collectTargets judges reachability on HEAD, not on uncommitted edits', async (t) => {
  const { collectTargets } = require('./upstream-scan.cjs');
  const fx = forkFixture();
  t.after(fx.cleanup);
  const tmp = privateTmp(t);
  // HEAD's entry imports live.tsx; the work tree's no longer does.
  fx.write('packages/web/src/main.tsx', 'export const app = []\n');
  const before = repoState(fx);
  const report = await collectTargets([fx.upstream.slice(0, 8)], { cwd: fx.dir, fetch: false });
  assert.equal(report.reach.error, null);
  assert.ok(report.reach.inputs.has('packages/web/src/main.tsx'), 'reachable paths stay repo-relative');
  const live = report.sections[0].files.find((f) => f.path === 'packages/web/src/live.tsx');
  assert.equal(live.reachability, 'production');
  assert.deepEqual(repoState(fx), before, 'the work tree and the real index are untouched');
  assert.deepEqual(tmp.leftovers(), []);
});

test('collectTargets dry-runs against HEAD, not against a staged index', async (t) => {
  const { collectTargets } = require('./upstream-scan.cjs');
  const fx = forkFixture();
  t.after(fx.cleanup);
  const tmp = privateTmp(t);
  // Base exports 1, upstream 2, HEAD 3: a conflict. The staged base version would apply clean.
  fx.write('packages/web/src/live.tsx', 'export const Live = 1\n// two\n// three\n');
  fx.git('add', 'packages/web/src/live.tsx');
  assert.match(fx.git('show', 'HEAD:packages/web/src/live.tsx'), /Live = 3/);
  const before = repoState(fx);
  const report = await collectTargets([fx.upstream.slice(0, 8)], { cwd: fx.dir, fetch: false });
  const byPath = Object.fromEntries(report.sections[0].files.map((f) => [f.path, f.dryRun]));
  assert.deepEqual(byPath, {
    'README.md': 'clean',
    'packages/web/src/dead.tsx': 'clean',
    'packages/web/src/gone.ts': 'missing',
    'packages/web/src/live.tsx': 'conflict',
  });
  assert.equal(report.dryRunError, null);
  assert.deepEqual(repoState(fx), before, 'the work tree and the real index are untouched');
  assert.deepEqual(tmp.leftovers(), []);
});

test('collectTargets dry-runs with HEAD\'s attributes, not an uncommitted .gitattributes', async (t) => {
  const { collectTargets } = require('./upstream-scan.cjs');
  const fx = forkFixture();
  t.after(fx.cleanup);
  const tmp = privateTmp(t);
  // A union merge would resolve live.tsx's conflict; HEAD names no merge driver.
  fx.write('.gitattributes', 'packages/web/src/live.tsx merge=union\n');
  const before = repoState(fx);
  const report = await collectTargets([fx.upstream.slice(0, 8)], { cwd: fx.dir, fetch: false });
  assert.equal(report.dryRunError, null);
  const live = report.sections[0].files.find((f) => f.path === 'packages/web/src/live.tsx');
  assert.equal(live.dryRun, 'conflict');
  assert.deepEqual(repoState(fx), before, 'the work tree and the real index are untouched');
  assert.deepEqual(tmp.leftovers(), []);
});

test('collectTargets checks HEAD out with HEAD\'s attributes, not an uncommitted .gitattributes', async (t) => {
  const { collectTargets } = require('./upstream-scan.cjs');
  const fx = forkFixture();
  t.after(fx.cleanup);
  const tmp = privateTmp(t);
  // The fixture's own config, never a global one. A dirty attribute naming it would strip main.tsx's imports.
  fx.git('config', 'filter.review.smudge', 'sed /import/d');
  fx.write('.gitattributes', 'packages/web/src/main.tsx filter=review\n');
  const before = repoState(fx);
  const report = await collectTargets([fx.upstream.slice(0, 8)], { cwd: fx.dir, fetch: false });
  assert.equal(report.reach.error, null);
  const live = report.sections[0].files.find((f) => f.path === 'packages/web/src/live.tsx');
  assert.equal(live.reachability, 'production');
  assert.deepEqual(repoState(fx), before, 'the work tree and the real index are untouched');
  assert.deepEqual(tmp.leftovers(), []);
});

/** Puts a `git` that rejects `--attr-source` first on PATH for one test, as a git older than 2.41
 *  does; every other call reaches the real git. A child spawned afterwards inherits it. */
function gitWithoutAttrSource(t) {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cez-old-git-'));
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase "$1" in --attr-source*) echo "unknown option: $1" >&2; exit 129;; esac\nexec '${real}' "$@"\n`, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${saved}`;
  t.after(() => {
    process.env.PATH = saved;
    fs.rmSync(bin, { recursive: true, force: true });
  });
}

test('collectTargets reads reachability and the dry run as unknown on a git that cannot pin attributes to HEAD', async (t) => {
  const { collectTargets } = require('./upstream-scan.cjs');
  const fx = forkFixture();
  t.after(fx.cleanup);
  const tmp = privateTmp(t);
  gitWithoutAttrSource(t);
  const report = await collectTargets([fx.upstream.slice(0, 8)], { cwd: fx.dir, fetch: false });
  assert.match(report.reach.error, /^cannot snapshot HEAD: unknown option: --attr-source/);
  assert.match(report.dryRunError, /^cannot snapshot HEAD: unknown option: --attr-source/);
  const live = report.sections[0].files.find((f) => f.path === 'packages/web/src/live.tsx');
  assert.equal(live.reachability, 'unknown');
  assert.equal(live.dryRun, 'unknown');
  assert.deepEqual(tmp.leftovers(), []);
});

test('collectTargets keeps applying attributes HEAD commits', async (t) => {
  const { collectTargets } = require('./upstream-scan.cjs');
  const fx = forkFixture();
  t.after(fx.cleanup);
  // Guard, green with or without attribute pinning: committed attributes and the repository's
  // own filter config are HEAD's behaviour, even with the work tree's copy deleted.
  fx.git('config', 'filter.review.smudge', 'sed /import/d');
  fx.write('.gitattributes', 'packages/web/src/live.tsx merge=union\npackages/web/src/main.tsx filter=review\n');
  fx.git('add', '.gitattributes');
  fx.git('commit', '-q', '-m', 'chore: attributes');
  require('node:fs').rmSync(require('node:path').join(fx.dir, '.gitattributes'));
  const report = await collectTargets([fx.upstream.slice(0, 8)], { cwd: fx.dir, fetch: false });
  const live = report.sections[0].files.find((f) => f.path === 'packages/web/src/live.tsx');
  assert.equal(live.dryRun, 'clean', 'the committed union merge driver applies');
  assert.equal(live.reachability, 'test-only', 'the committed smudge filter strips main.tsx\'s imports');
});

test('collectTargets reads every verdict at the HEAD it started from when a commit lands mid-run', async (t) => {
  const { collectTargets } = require('./upstream-scan.cjs');
  const fx = forkFixture();
  t.after(fx.cleanup);
  const started = fx.git('rev-parse', 'HEAD');
  const running = collectTargets([fx.upstream.slice(0, 8)], { cwd: fx.dir, fetch: false });
  // The call returns at its first await, the reachability build; existence and drift are read
  // after it. Another session commits in the same checkout meanwhile: gone.ts is back, live.tsx moves.
  fx.write('packages/web/src/gone.ts', 'export const gone = 3\n');
  fx.write('packages/web/src/live.tsx', 'export const Live = 5\n// two\n// three\n');
  fx.git('add', '.');
  fx.git('commit', '-q', '-m', 'feat(web): lands mid-run');
  assert.notEqual(fx.git('rev-parse', 'HEAD'), started);
  const report = await running;
  assert.equal(report.head.sha, started);
  const byPath = Object.fromEntries(report.sections[0].files.map((f) => [f.path, f]));
  assert.deepEqual(byPath['packages/web/src/gone.ts'].fork, { exists: false, lastTouch: { short: fx.dropGone, subject: 'refactor(web): drop gone' } });
  assert.deepEqual(byPath['packages/web/src/live.tsx'].drift, { commits: 1, added: 1, deleted: 1 });
});

test('withHeadSnapshot checks HEAD out under os.tmpdir() and removes it when the work inside throws', async (t) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { resolveHead, withHeadSnapshot } = require('./upstream-scan.cjs');
  const fx = forkFixture();
  t.after(fx.cleanup);
  const tmp = privateTmp(t);
  fx.write('packages/web/src/main.tsx', 'export const app = []\n');
  let seen = null;
  await assert.rejects(withHeadSnapshot(fx.dir, resolveHead(fx.dir), (snapshot) => {
    seen = { ...snapshot, leftovers: tmp.leftovers(), main: fs.readFileSync(path.join(snapshot.tree, 'packages/web/src/main.tsx'), 'utf8') };
    throw new Error('boom');
  }), /boom/);
  assert.equal(seen.error, null);
  assert.equal(seen.leftovers.length, 1);
  assert.match(seen.main, /import \{ Live \}/, 'HEAD\'s file, not the work tree\'s');
  assert.equal(fs.existsSync(path.join(seen.tree, 'README.md')), false, 'only what reachability reads');
  assert.deepEqual(tmp.leftovers(), []);
});

test('collectTargets reads reachability and the dry run as unknown, with the reason, when HEAD cannot be snapshotted', async (t) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { collectTargets } = require('./upstream-scan.cjs');
  const fx = forkFixture();
  t.after(fx.cleanup);
  const tmp = privateTmp(t);
  const notADir = path.join(tmp.dir, 'not-a-dir');
  fs.writeFileSync(notADir, '');
  process.env.TMPDIR = notADir;
  const report = await collectTargets([fx.upstream.slice(0, 8)], { cwd: fx.dir, fetch: false });
  assert.match(report.reach.error, /^cannot snapshot HEAD: ENOTDIR/);
  assert.match(report.dryRunError, /^cannot snapshot HEAD: ENOTDIR/);
  const byPath = Object.fromEntries(report.sections[0].files.map((f) => [f.path, f]));
  assert.equal(byPath['packages/web/src/live.tsx'].reachability, 'unknown');
  assert.equal(byPath['packages/web/src/dead.tsx'].reachability, 'unknown', 'never test-only without a build');
  for (const f of report.sections[0].files) assert.equal(f.dryRun, 'unknown', f.path);
  const md = renderTargetsReport(report);
  assert.match(md, /^- Reachability: unknown — cannot snapshot HEAD: ENOTDIR/m);
  assert.match(md, /^- Dry run: unknown — cannot snapshot HEAD: ENOTDIR/m);
});

test('collectTargets names the prefix that matches no row, several rows, or a commit this clone lacks', async (t) => {
  const { collectTargets } = require('./upstream-scan.cjs');
  const fx = forkFixture();
  t.after(fx.cleanup);
  await assert.rejects(collectTargets([], { cwd: fx.dir, fetch: false }), /at least one/);
  await assert.rejects(collectTargets(['1234567'], { cwd: fx.dir, fetch: false }), /no ledger entry matches 1234567/);
  await assert.rejects(collectTargets(['abcdef1'], { cwd: fx.dir, fetch: false }), /abcdef1 matches 2 ledger entries/);
  await assert.rejects(collectTargets(['xyz'], { cwd: fx.dir, fetch: false }), /xyz is not a commit sha prefix/);
  await assert.rejects(collectTargets(['fedcba9'], { cwd: fx.dir, fetch: false }), /fedcba9c is not in this clone/);
});

/** The CLI copied into a fixture. Its repository root is where the script sits, so whatever a run
 *  does lands in the fixture, never in this checkout. Dependencies still resolve from here. */
function fixtureCli(fx) {
  const fs = require('node:fs');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const scripts = path.join(fx.dir, '.github', 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  for (const name of fs.readdirSync(__dirname).filter((n) => /^upstream-[\w-]+\.cjs$/.test(n) && !n.endsWith('.test.cjs'))) {
    fs.copyFileSync(path.join(__dirname, name), path.join(scripts, name));
  }
  const env = { ...process.env, NODE_PATH: path.resolve(__dirname, '../../node_modules') };
  return (...args) => spawnSync(process.execPath, [path.join(scripts, 'upstream-scan.cjs'), ...args], { cwd: fx.dir, env, encoding: 'utf8' });
}

test('upstream-scan targets exits 1 with a one-line message on a bad prefix', (t) => {
  const fx = forkFixture();
  t.after(fx.cleanup);
  const cli = fixtureCli(fx);
  for (const args of [['targets'], ['targets', '0000000']]) {
    const result = cli(...args);
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim().split('\n').length, 1, result.stderr);
  }
});

test('upstream-scan rejects an unknown command before it scans', (t) => {
  const fx = forkFixture();
  t.after(fx.cleanup);
  // Upstream has a commit the ledger lacks, so a typo that fell through to the scan would append
  // a row, write LEDGER.md and a scan report, and exit 0.
  fx.git('checkout', '-q', 'upstream');
  fx.write('packages/web/src/dead.tsx', 'export const Dead = 3\n');
  fx.git('commit', '-q', '-am', 'fix(web): a later upstream change (#13)');
  fx.git('checkout', '-q', 'main');
  fx.git('update-ref', 'refs/cez-upstream/main', 'upstream');
  const cli = fixtureCli(fx);
  const state = () => ({ refs: fx.git('for-each-ref'), files: fx.git('--no-optional-locks', 'status', '--porcelain', '--untracked-files=all') });
  const before = state();
  // `--no-fetch` keeps a run without the fix off the network; the rejection must not depend on it.
  for (const args of [['target', fx.upstream.slice(0, 8), '--no-fetch'], ['tragets', '--no-fetch']]) {
    const result = cli(...args);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, new RegExp(`^upstream-scan: unknown command "${args[0]}"`));
    assert.equal(result.stderr.trim().split('\n').length, 1, result.stderr);
    assert.deepEqual(state(), before, args.join(' '));
  }
});

/** A commit on upstream the ledger lacks, taking live.tsx from 2 to 4, with
 *  `refs/cez-upstream/main` at it. HEAD has 3, so a 3-way dry run conflicts. */
function laterUpstreamCommit(fx) {
  fx.git('checkout', '-q', 'upstream');
  fx.write('packages/web/src/live.tsx', 'export const Live = 4\n// two\n// three\n');
  fx.git('commit', '-q', '-am', 'fix(web): a later upstream change (#13)');
  const later = fx.git('rev-parse', 'HEAD');
  fx.git('checkout', '-q', 'main');
  fx.git('update-ref', 'refs/cez-upstream/main', 'upstream');
  return later;
}

/** The ledger row a fixture scan appended for `sha`. */
function scannedRow(fx, sha) {
  const fs = require('node:fs');
  const path = require('node:path');
  const yaml = require('yaml');
  return yaml.parse(fs.readFileSync(path.join(fx.dir, '.ai/upstream/ledger.yaml'), 'utf8')).entries.find((e) => e.sha === sha);
}

test('upstream-scan records each new commit\'s conflict hint against HEAD, not against a staged index', (t) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const fx = forkFixture();
  t.after(fx.cleanup);
  const tmp = privateTmp(t);
  // The staged copy of upstream's 2 would apply clean.
  const later = laterUpstreamCommit(fx);
  fx.write('packages/web/src/live.tsx', 'export const Live = 2\n// two\n// three\n');
  fx.git('add', 'packages/web/src/live.tsx');
  const cli = fixtureCli(fx);
  const index = () => fs.readFileSync(path.join(fx.dir, '.git', 'index')).toString('base64');
  const before = index();
  const result = cli('--no-fetch', '--date', '2026-10-16');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).added, 1);
  assert.deepEqual(scannedRow(fx, later).hint, { conflicts: 1 });
  assert.equal(index(), before, 'the real index is untouched');
  assert.deepEqual(tmp.leftovers(), []);
});

test('upstream-scan records each new commit\'s conflict hint with HEAD\'s attributes, not an uncommitted .gitattributes', (t) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const fx = forkFixture();
  t.after(fx.cleanup);
  const tmp = privateTmp(t);
  // A union merge would resolve live.tsx's conflict; HEAD names no merge driver.
  const later = laterUpstreamCommit(fx);
  fx.write('.gitattributes', 'packages/web/src/live.tsx merge=union\n');
  const cli = fixtureCli(fx);
  const index = () => fs.readFileSync(path.join(fx.dir, '.git', 'index')).toString('base64');
  const before = index();
  const result = cli('--no-fetch', '--date', '2026-10-16');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(scannedRow(fx, later).hint, { conflicts: 1 });
  assert.equal(index(), before, 'the real index is untouched');
  assert.deepEqual(tmp.leftovers(), []);
});

test('upstream-scan records rows without a hint, and warns, when it cannot build its private index', (t) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const fx = forkFixture();
  t.after(fx.cleanup);
  const tmp = privateTmp(t);
  const later = laterUpstreamCommit(fx);
  const notADir = path.join(tmp.dir, 'not-a-dir');
  fs.writeFileSync(notADir, '');
  process.env.TMPDIR = notADir;
  const cli = fixtureCli(fx);
  const result = cli('--no-fetch', '--date', '2026-10-16');
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split('\n');
  assert.deepEqual(lines.slice(1), [''], 'exactly one JSON line on stdout');
  const summary = JSON.parse(lines[0]);
  assert.equal(summary.added, 1);
  assert.ok(fs.existsSync(path.join(fx.dir, summary.report)), 'the scan report is written');
  const row = scannedRow(fx, later);
  assert.equal(row.status, 'pending');
  assert.equal('hint' in row, false);
  const warning = result.stderr.trim().split('\n');
  assert.equal(warning.length, 1, result.stderr);
  assert.match(warning[0], /^upstream-scan: .*no conflict hints.*ENOTDIR/);
});

test('upstream-scan records rows without a hint, never a clean one, on a git that cannot pin attributes to HEAD', (t) => {
  const fx = forkFixture();
  t.after(fx.cleanup);
  const tmp = privateTmp(t);
  const later = laterUpstreamCommit(fx);
  gitWithoutAttrSource(t);
  const cli = fixtureCli(fx);
  const result = cli('--no-fetch', '--date', '2026-10-16');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).added, 1);
  assert.equal('hint' in scannedRow(fx, later), false, 'a rejected option must not read as zero conflicts');
  const warning = result.stderr.trim().split('\n');
  assert.equal(warning.length, 1, result.stderr);
  assert.match(warning[0], /^upstream-scan: .*no conflict hints.*unknown option: --attr-source/);
  assert.deepEqual(tmp.leftovers(), []);
});

test('renderTargetsReport keeps a multi-line ledger note on its bullet line', () => {
  const r = report();
  r.sections[0].entry.note = 'drag moved to the rail;\nfallback is registry order\n';
  assert.match(renderTargetsReport(r), /^- Ledger row: .* · note: drag moved to the rail; fallback is registry order$/m);
});
