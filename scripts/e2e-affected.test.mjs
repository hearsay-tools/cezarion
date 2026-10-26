import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  classify, latestMap, mapProblem, parseOptions, readMap, referenceGraph, resolveLiteral, selectSpecs, stringLiterals,
} from './e2e-affected.mjs';

// hearsay-tools/cezarion#1816: npm run test:e2e:affected chooses browser specs from the spec map.

const script = fileURLToPath(new URL('./e2e-affected.mjs', import.meta.url));
const COMMIT = 'a'.repeat(40);
const spec = name => `packages/web/e2e/${name}.e2e.ts`;

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-affected-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const put = (path, text = '') => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  return { dir, put };
}

const sampleMap = (overrides = {}) => ({
  version: 1, commit: COMMIT, createdAt: '2026-10-26T00:00:00.000Z',
  specs: [spec('artifact-project-links'), spec('chat-code-fence'), spec('smoke')],
  incomplete: [],
  sources: {
    'packages/web/src/routes/task-thread/markdown.tsx': [0, 1],
    'packages/web/src/lib/unused.ts': [],
    'packages/api-client/src/client.ts': [0, 1, 2],
  },
  ...overrides,
});

test('options: --plan and --map are the selector’s own; everything else goes to npm run test:e2e', () => {
  assert.deepEqual(parseOptions(['--plan', '--map=m.json', '-t', 'name', '--force']), {
    plan: true, map: 'm.json', forward: ['-t', 'name', '--force'],
  });
  assert.throws(() => parseOptions(['--map']), /--map takes a file/);
  assert.throws(() => parseOptions(['--map=']), /--map takes a file/);
});

test('a map is refused when its shape is not the one the refresh writes', () => {
  assert.equal(mapProblem(sampleMap()), null);
  assert.match(mapProblem({ ...sampleMap(), version: 2 }), /version/);
  assert.match(mapProblem({ ...sampleMap(), commit: 'main' }), /commit/);
  assert.match(mapProblem({ ...sampleMap(), specs: ['smoke.e2e.ts'] }), /spec paths/);
  assert.match(mapProblem({ ...sampleMap(), incomplete: [spec('gone')] }), /incomplete/);
  assert.match(mapProblem({ ...sampleMap(), sources: { 'a.ts': [3] } }), /a\.ts/);
  assert.match(mapProblem({ ...sampleMap(), sources: null }), /no sources/);
});

test('readMap names the file it cannot use', t => {
  const { dir, put } = tempDir(t);
  put('map.json', JSON.stringify(sampleMap()));
  put('bad.json', '{');
  assert.equal(readMap(join(dir, 'map.json')).map.commit, COMMIT);
  assert.match(readMap(join(dir, 'bad.json')).error, /cannot read the spec map at .*bad\.json/);
  assert.match(readMap(join(dir, 'missing.json')).error, /cannot read/);
});

test('the newest map from main is downloaded once, and the cache answers when gh cannot', t => {
  const { dir, put } = tempDir(t);
  const calls = [];
  const gh = (runs, download = () => {}) => (command, args) => {
    calls.push([command, ...args].join(' '));
    if (args[1] === 'list') return JSON.stringify(runs);
    return download(args);
  };
  const writeArtifact = args => put(join(args[args.indexOf('--dir') + 1].slice(dir.length + 1), 'e2e-spec-map.json'), JSON.stringify(sampleMap()));
  const runs = [{ databaseId: 9, event: 'pull_request' }, { databaseId: 7, event: 'push' }];

  const first = latestMap(dir, gh(runs, writeArtifact));
  assert.equal(first.map.commit, COMMIT);
  assert.match(first.file, /\.ai\/qa\/e2e-spec-map\/7\/e2e-spec-map\.json$/);
  assert.equal(calls.filter(call => call.includes('run download 7 --name e2e-spec-map')).length, 1);

  calls.length = 0;
  assert.equal(latestMap(dir, gh(runs, () => { throw new Error('downloaded again'); })).map.commit, COMMIT);
  assert.deepEqual(calls.map(call => call.split(' ')[2]), ['list']);

  const offline = () => { throw Object.assign(new Error('failed'), { stderr: 'error connecting to api.github.com\nmore' }); };
  const warnings = [];
  t.mock.method(console, 'warn', message => warnings.push(message));
  assert.equal(latestMap(dir, offline).map.commit, COMMIT);
  assert.match(warnings[0], /error connecting to api\.github\.com\); using the map cached from run 7\./);

  const empty = tempDir(t);
  assert.match(latestMap(empty.dir, offline).error, /^no spec map: gh cannot list the e2e-spec-map\.yml runs \(error connecting/);
  assert.match(latestMap(empty.dir, gh([{ databaseId: 3, event: 'pull_request' }])).error, /no successful run on main/);
});

test('string literals: imports and spec-relative paths, never comments', () => {
  const text = [
    "import { browser } from './agent-browser' // the seam's 'helper'",
    "/* './commented.ts' */",
    "const data = resolve(import.meta.dirname, 'fixtures/run.ndjson')",
    'const url = `http://x/${id}`',
  ].join('\n');
  assert.deepEqual(stringLiterals(text), ['./agent-browser', 'fixtures/run.ndjson']);
});

test('a literal resolves to a repository file, an alias target, or a directory below the file', t => {
  const { dir, put } = tempDir(t);
  put('packages/web/e2e/poll.ts');
  put('packages/web/e2e/fixtures/run.ndjson');
  put('packages/web/e2e/fixtures/images/a.png');
  put('packages/web/src/lib/utils.ts');
  put('packages/api-client/src/contract/defined.ts');
  const from = 'packages/web/e2e/a.e2e.ts';
  assert.equal(resolveLiteral(dir, from, './poll'), 'packages/web/e2e/poll.ts');
  assert.equal(resolveLiteral(dir, from, './poll.js'), 'packages/web/e2e/poll.ts');
  assert.equal(resolveLiteral(dir, from, 'fixtures/run.ndjson'), 'packages/web/e2e/fixtures/run.ndjson');
  assert.equal(resolveLiteral(dir, from, 'fixtures/images'), 'packages/web/e2e/fixtures/images/');
  assert.equal(resolveLiteral(dir, from, '../src/lib/utils'), 'packages/web/src/lib/utils.ts');
  assert.equal(resolveLiteral(dir, from, '@open-mercato/cezar-api-client/contract/defined'), 'packages/api-client/src/contract/defined.ts');
  assert.equal(resolveLiteral(dir, 'packages/web/src/app.tsx', '@/lib/utils'), 'packages/web/src/lib/utils.ts');
  // A directory above the file, such as the repository root, is not something it reads.
  assert.equal(resolveLiteral(dir, from, '../../..'), null);
  assert.equal(resolveLiteral(dir, from, '../src'), null);
  assert.equal(resolveLiteral(dir, from, 'node:fs'), null);
  assert.equal(resolveLiteral(dir, from, 'a few words'), null);
});

test('the reference graph splits what the suite setup loads from what each spec loads', t => {
  const { dir, put } = tempDir(t);
  put('packages/web/e2e/vitest.config.ts', "import S from '../../../.github/scripts/seq.mjs'\nexport default { setupFiles: ['./failure-setup.ts'], globalSetup: ['./environment.ts'] }");
  put('.github/scripts/seq.mjs');
  put('packages/web/e2e/failure-setup.ts', "import { x } from './agent-browser'");
  put('packages/web/e2e/environment.ts', "const root = resolve(import.meta.dirname, '../../..')");
  put('packages/web/e2e/agent-browser.ts');
  put('packages/web/e2e/poll.ts');
  put('packages/web/e2e/fixtures/run.ndjson');
  put(spec('a'), "import { poll } from './poll'\nreadFileSync(resolve(import.meta.dirname, 'fixtures/run.ndjson'))");
  put(spec('b'), "import { thing } from '../src/thing'");
  put('packages/web/src/thing.ts', "import { cn } from '@/lib/cn'");
  put('packages/web/src/lib/cn.ts');
  const graph = referenceGraph(dir, [spec('a'), spec('b')]);
  assert.deepEqual([...graph.setup].sort(), [
    '.github/scripts/seq.mjs', 'packages/web/e2e/agent-browser.ts', 'packages/web/e2e/environment.ts',
    'packages/web/e2e/failure-setup.ts', 'packages/web/e2e/vitest.config.ts',
  ]);
  assert.deepEqual([...graph.specs.get(spec('a'))].sort(), [spec('a'), 'packages/web/e2e/fixtures/run.ndjson', 'packages/web/e2e/poll.ts']);
  assert.deepEqual([...graph.specs.get(spec('b'))].sort(), [spec('b'), 'packages/web/src/lib/cn.ts', 'packages/web/src/thing.ts']);
});

const graph = {
  setup: new Set(['packages/web/e2e/vitest.config.ts', 'packages/web/e2e/agent-browser.ts', '.github/scripts/cockpit-test-sequencer.mjs']),
  specs: new Map([
    [spec('artifact-project-links'), new Set([spec('artifact-project-links'), 'packages/web/e2e/poll.ts'])],
    [spec('chat-code-fence'), new Set([spec('chat-code-fence'), 'packages/web/e2e/fixtures/images/', 'packages/web/src/routes/task-thread/thread-scroll.ts'])],
    [spec('smoke'), new Set([spec('smoke')])],
  ]),
};
const choose = (file, map = sampleMap()) => classify(file, { map, graph });

test('each kind of changed file selects its specs, none, or every spec', () => {
  const cases = [
    ['packages/web/src/routes/task-thread/markdown.tsx', [spec('artifact-project-links'), spec('chat-code-fence')]],
    ['packages/api-client/src/client.ts', [spec('artifact-project-links'), spec('chat-code-fence'), spec('smoke')]],
    ['packages/web/src/lib/unused.ts', []],
    ['packages/web/src/lib/new-file.ts', []],
    // A cockpit file a spec imports in Node counts for that spec even when no browser runs it.
    ['packages/web/src/routes/task-thread/thread-scroll.ts', [spec('chat-code-fence')]],
    [spec('smoke'), [spec('smoke')]],
    [spec('removed'), []],
    ['packages/web/e2e/poll.ts', [spec('artifact-project-links')]],
    ['packages/web/e2e/fixtures/images/a.png', [spec('chat-code-fence')]],
    ['packages/web/e2e/spec-map/bundle.ts', []],
    ['packages/web/e2e/README.md', []],
    ['AGENTS.md', []],
    ['docs/sdlc/ci.md', []],
    ['packages/web/src/routes/view.test.tsx', []],
    ['packages/web/src/test/setup.ts', []],
    ['scripts/e2e-affected.test.mjs', []],
    ['.github/workflows/e2e-spec-map.yml', []],
    ['packages/web/e2e/agent-browser.ts', null],
    ['.github/scripts/cockpit-test-sequencer.mjs', null],
    ['packages/web/e2e/fixtures/unnamed.ndjson', null],
    ['packages/web/src/index.css', null],
    ['packages/web/vite.config.ts', null],
    ['packages/cezar/src/server/server.ts', null],
    ['packages/contract/src/runs.ts', null],
    ['.ai/scripts/test-env-up.sh', null],
    ['pnpm-lock.yaml', null],
    ['AGENT_PROTOCOL.md', null],
    ['something/new.txt', null],
  ];
  for (const [file, specs] of cases) {
    const result = choose(file);
    assert.deepEqual(result.specs === null ? null : [...result.specs].sort(), specs, file);
    assert.ok(result.reason, file);
  }
});

test('selection: every spec when one file needs it, and incomplete specs whenever a bundled source changed', () => {
  const specFiles = sampleMap().specs;
  const map = sampleMap({ incomplete: [spec('smoke')] });
  const pick = files => selectSpecs({ files, map, graph, specFiles });
  assert.deepEqual(pick(['packages/web/src/routes/task-thread/markdown.tsx']).specs, specFiles);
  assert.deepEqual(pick(['packages/web/e2e/poll.ts']).specs, [spec('artifact-project-links')]);
  assert.deepEqual(pick(['packages/web/src/lib/unused.ts', 'docs/x.md']).specs, [spec('smoke')]);
  assert.deepEqual(pick(['docs/x.md']).specs, []);
  const all = pick(['docs/x.md', 'packages/cezar/src/index.ts']);
  assert.equal(all.all, true);
  assert.deepEqual(all.specs, specFiles);
  assert.deepEqual(all.lines.map(line => line.file), ['docs/x.md', 'packages/cezar/src/index.ts']);
});

function repository(t) {
  const { dir, put } = tempDir(t);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  put('packages/web/e2e/vitest.config.ts', "export default { setupFiles: ['./failure-setup.ts'] }");
  put('packages/web/e2e/failure-setup.ts');
  for (const name of ['artifact-project-links', 'chat-code-fence', 'smoke']) put(spec(name));
  put('packages/web/src/routes/task-thread/markdown.tsx', 'export function Markdown() {}\n');
  put('.github/cockpit-test-durations.json', JSON.stringify({ durationsMs: { 'artifact-project-links.e2e.ts': 90_000, 'chat-code-fence.e2e.ts': 60_000 } }));
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  // The map lives outside the repository: an untracked file inside it is a change.
  const maps = tempDir(t);
  const map = (overrides = {}) => {
    maps.put('map.json', JSON.stringify(sampleMap({ commit: git('rev-parse', 'HEAD'), ...overrides })));
    return `--map=${join(maps.dir, 'map.json')}`;
  };
  return { dir, put, map };
}

const affected = (cwd, ...args) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });

test('--plan diffs the working tree against the map’s commit, untracked files included, and runs nothing', t => {
  const { dir, put, map } = repository(t);
  put('packages/web/src/routes/task-thread/markdown.tsx', 'export function Markdown() { return 1 }\n');
  put('docs/new-page.md', '# New\n');
  const result = affected(dir, '--plan', map());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Spec map: .*map\.json, commit [0-9a-f]{8}/);
  assert.match(result.stdout, /docs\/new-page\.md: 0 specs \(documentation\)/);
  assert.match(result.stdout, /markdown\.tsx: 2 specs \(the specs that run it\)/);
  assert.match(result.stdout, /→ packages\/web\/e2e\/artifact-project-links\.e2e\.ts\n {2}→ packages\/web\/e2e\/chat-code-fence\.e2e\.ts\n/);
  assert.match(result.stdout, /Selected 2 of 3 specs, about 3 min\./);
  assert.doesNotMatch(result.stdout, /TEST_E2E_STATUS/);
});

test('a change no spec reaches runs nothing and exits 0', t => {
  const { dir, put, map } = repository(t);
  put('docs/new-page.md', '# New\n');
  const result = affected(dir, map());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Selected 0 of 3 specs\./);
  assert.match(result.stdout, /No browser spec reaches these changes, so none runs\./);
});

test('a map whose commit the clone lacks selects every spec', t => {
  const { dir, map } = repository(t);
  const result = affected(dir, '--plan', map({ commit: 'b'.repeat(40) }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /the map's commit bbbbbbbb is not in this clone and cannot be fetched\. Every spec runs\./);
  assert.match(result.stdout, /Selected 3 of 3 specs/);
});

test('a --map file that cannot be read is an error, not a full run', t => {
  const { dir } = repository(t);
  const result = affected(dir, '--plan', '--map=missing.json');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cannot read the spec map at .*missing\.json/);
});
