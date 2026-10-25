import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { basename, join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { parsePid, readPid, requirePid, writePidSource } from '../../src/pid-file.testkit.ts';

// The scripts under test are the REPO's, not this package's: `.ai/` is agent-pipeline tooling
// that spans every workspace, so it stays at the root.
const repoRoot = resolve(import.meta.dirname, '../../../..');
const fixtures: string[] = [];
const launchedPids = new Set<number>();

afterEach(() => {
  for (const pid of launchedPids) {
    // A descriptor written from an empty pid holds 0, and kill(0) is this runner's own group (#953).
    if (parsePid(String(pid)) === undefined) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The down script already stopped the fixture process.
    }
  }
  launchedPids.clear();
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function commandPath(command: string): string {
  return execFileSync('/bin/sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).trim();
}

const hasSetsid = spawnSync('/bin/sh', ['-c', 'command -v setsid'], { stdio: 'ignore' }).status === 0;

function fixtureGit(root: string, ...args: string[]): void {
  // These calls bypass the sandbox global config. Keep maintenance off on the fixture's
  // commits, before the launcher clones it (hearsay-tools/cezarion#1389).
  const result = spawnSync('git', ['-C', root,
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@cezar.invalid',
    '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], {
    encoding: 'utf8',
    env: { ...fixtureEnv, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TRACE: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /\bbuilt-in: git\b/, 'fixture Git trace must be enabled');
  assert.doesNotMatch(result.stderr, /\b(?:maintenance run|gc) --auto\b/);
}

function makeFixture(withSetsid: boolean): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'cez-test-env-launcher-'));
  fixtures.push(root);
  mkdirSync(join(root, '.ai/scripts'), { recursive: true });
  mkdirSync(join(root, '.ai/browsers'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  copyFileSync(join(repoRoot, '.ai/scripts/test-env-up.sh'), join(root, '.ai/scripts/test-env-up.sh'));
  copyFileSync(join(repoRoot, '.ai/scripts/test-env-down.sh'), join(root, '.ai/scripts/test-env-down.sh'));
  copyFileSync(join(repoRoot, '.ai/scripts/e2e.sh'), join(root, '.ai/scripts/e2e.sh'));
  copyFileSync(join(repoRoot, '.ai/scripts/test-env-lease.mjs'), join(root, '.ai/scripts/test-env-lease.mjs'));
  if (process.platform === 'darwin') symlinkSync(commandPath('ps'), join(root, 'bin/ps'));
  copyFileSync(join(repoRoot, '.ai/scripts/resolve-browser-launch.mjs'), join(root, '.ai/scripts/resolve-browser-launch.mjs'));
  copyFileSync(join(repoRoot, '.ai/scripts/build-e2e.sh'), join(root, '.ai/scripts/build-e2e.sh'));
  copyFileSync(join(repoRoot, '.ai/scripts/e2e-served-repo.mjs'), join(root, '.ai/scripts/e2e-served-repo.mjs'));
  copyFileSync(join(repoRoot, '.ai/scripts/e2e-lanes.mjs'), join(root, '.ai/scripts/e2e-lanes.mjs'));
  // The real postbuild bundles the contract; here it only records which dist it was handed.
  mkdirSync(join(root, 'packages/cezar/scripts'), { recursive: true });
  writeFileSync(join(root, 'packages/cezar/scripts/inline-contract.mjs'),
    "import { writeFileSync } from 'node:fs';\nwriteFileSync('.ai/inline-contract-dist', process.argv[2] ?? '(default)');\n");
  writeFileSync(join(root, '.ai/browsers/agent-browser.md'), '# test provider\n');
  writeFileSync(join(root, 'package.json'), '{"private":true}\n');
  writeFileSync(join(root, 'pnpm-lock.yaml'), '{}\n');
  // Backdate tracked sources so the #31 warm-reuse assertion never depends on
  // how fast the cold boot was relative to these writes.
  const safelyBeforeBoot = new Date(Date.now() - 30_000);
  utimesSync(join(root, 'package.json'), safelyBeforeBoot, safelyBeforeBoot);
  utimesSync(join(root, 'pnpm-lock.yaml'), safelyBeforeBoot, safelyBeforeBoot);

  const commands = ['cat', 'chmod', 'curl', 'date', 'dirname', 'find', 'git', 'grep', 'id', 'kill', 'ln', 'mkdir', 'mv', 'nohup', 'pwd', 'rm', 'sh', 'sleep', 'tail', 'uname'];
  if (withSetsid) commands.push('setsid');
  for (const command of commands) symlinkSync(commandPath(command), join(root, 'bin', command));
  symlinkSync(process.execPath, join(root, 'bin/node'));

  writeFileSync(
    join(root, 'bin/npm'),
    // Models the commands the preparation chain runs, honoring `--outDir` the way tsc and
    // vite do: without it each writes the production build (packages/cezar/dist,
    // packages/cezar/web/dist), so an e2e bootstrap that dropped the flag would be caught
    // writing there. A bare `npm run build` is the production build.
    `#!/bin/sh
set -eu
server() {
  mkdir -p "$1"
  cat > "$1/index.js" <<'EOF'
const http = require('node:http');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
require('node:fs').writeFileSync('.ai/app-argv', process.argv.slice(2).join('\\n'));
require('node:fs').writeFileSync('.ai/app-cez-env', Object.keys(process.env).filter((key) => key.startsWith('CEZ_')).sort().map((key) => key + '=' + process.env[key]).join('\\n'));
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': req.url === '/api/health' ? 'application/json' : 'text/html' });
  res.end(req.url === '/api/health' ? '{"ok":true}' : '<!doctype html>');
}).listen(port, '127.0.0.1');
EOF
}
web() {
  mkdir -p "$1"
  rm -f "$1/.cez-e2e-build"
  printf '<!doctype html>' > "$1/index.html"
  if [ "\${VITE_CEZ_E2E-}" = 1 ]; then
    printf 'e2e\\n' > "$1/.cez-e2e-build"
  fi
}
out=
prev=
for arg do
  [ "$prev" != --outDir ] || out=$arg
  prev=$arg
done
case "$*" in
  install*)
    mkdir -p packages/cezar/node_modules/zod
    printf '{"name":"zod"}' > packages/cezar/node_modules/zod/package.json
    ;;
  'exec -w @wjarka/cezarion -- tsc '*) server "\${out:-packages/cezar/dist}" ;;
  'run build -w @open-mercato/cezar-web'*)
    printf '%s\\n' "\${VITE_CEZ_E2E:-production}" >> .ai/build-invocations
    printf '%s\\n' "\${NODE_ENV-unset}" >> .ai/build-node-env
    web "\${out:-packages/cezar/web/dist}"
    ;;
  'run build')
    printf 'production\\n' >> .ai/build-invocations
    server packages/cezar/dist
    web packages/cezar/web/dist
    ;;
  *) printf 'unexpected npm %s\\n' "$*" >&2; exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(root, 'bin/agent-browser'),
    `#!/bin/sh
log="$0.argv"
printf '%s\\n' "$*" >> "$log"
printf 'TMPDIR=%s\\n' "\${TMPDIR-}" >> "$0.env"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --args|--namespace|--session) shift 2 ;;
    --json|--offline|--quick) shift ;;
    doctor) printf '{"success":true,"checks":[{"id":"chrome.installed","status":"pass"}]}\\n'; exit 0 ;;
    --version) printf 'test-browser 1\\n'; exit 0 ;;
    open) printf '{"success":true,"data":{}}\\n'; exit 0 ;;
    close) printf '{"success":true,"data":{}}\\n'; exit 0 ;;
    *) shift ;;
  esac
done
`,
    { mode: 0o755 },
  );
  symlinkSync('npm', join(root, 'bin/pnpm'));
  // The served project is a clone of this checkout, so the fixture is a repository whose
  // generated state is ignored the way the real one's is.
  writeFileSync(join(root, '.gitignore'), '/.ai/qa/\n/bin/\nnode_modules/\n/packages/cezar/dist/\n/packages/cezar/web/\n/.ai/build-invocations\n/.ai/build-node-env\n/.ai/inline-contract-dist\n/.ai/app-argv\n/.ai/app-cez-env\n/app.pid\n');
  const git = (...args: string[]) => fixtureGit(root, ...args);
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  return { root, path: join(root, 'bin') };
}

// Fixtures are independent checkouts, even when Squeal runs inside a leased browser setup.
const fixtureEnv = { ...process.env };
for (const key of ['TEST_ENV_LEASE_TOKEN', 'TEST_ENV_LEASE_ENTRY', 'TEST_ENV_LEASE_BOOTSTRAPPED', 'TEST_ENV_LEASE_JOB', 'TEST_ENV_LEASE_BROKER']) delete fixtureEnv[key];

const E2E_BUILD = '.ai/qa/build/cezar';

// A real HTTP server and the real wrapper/bootstrap; only browser work is replaced by a
// barrier. Removing the lifetime lease lets the second bootstrap kill the first server.
for (const invalidation of ['ttl', 'source', 'force', 'down'] as const) {
  test(`a ${invalidation} bootstrap waits until the active browser run releases its environment`, async () => {
    const fixture = makeFixture(false);
    const env = { ...fixtureEnv, PATH: fixture.path, TEST_ENV_CACHE_TTL_SECONDS: '600' };
    const script = join(fixture.root, '.ai/scripts');
    const npm = join(fixture.root, 'bin/npm');
    writeFileSync(npm, readFileSync(npm, 'utf8').replace('case "$*" in', `case "$*" in
  'exec -- vitest '*)
    exec node -e '
      const fs = require("node:fs");
      setTimeout(() => process.exit(2), 30_000).unref();
      const d = JSON.parse(fs.readFileSync(".ai/qa/test-env.json", "utf8"));
      fs.writeFileSync(".ai/spec-started", "ready");
      const timer = setInterval(async () => {
        if (!fs.existsSync(".ai/release-spec")) return;
        clearInterval(timer);
        try { const r = await fetch(d.baseUrl); process.exit(r.ok ? 0 : 1); }
        catch { process.exit(1); }
      }, 20);
    '
    ;;
`));
    const first = spawn('/bin/sh', [join(script, 'e2e.sh')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const firstExit = once(first, 'close');
    let firstLog = '';
    first.stderr.on('data', chunk => { firstLog += chunk; });
    let second: ReturnType<typeof spawn> | undefined;
    try {
      const deadline = Date.now() + 20_000;
      while (!existsSync(join(fixture.root, '.ai/spec-started'))) {
        assert.equal(first.exitCode, null, firstLog);
        assert.ok(Date.now() < deadline, `spec did not start: ${firstLog}`);
        await delay(20);
      }
      const held = descriptor(fixture.root);
      launchedPids.add(held.app.pid);
      if (invalidation === 'ttl') {
        const file = join(fixture.root, '.ai/qa/test-env.json');
        writeFileSync(file, JSON.stringify({ ...held, startedAt: new Date(Date.now() - 700_000).toISOString() }));
      }
      if (invalidation === 'source') writeFileSync(join(fixture.root, 'package.json'), '{"private":true,"changed":true}\n');
      const before = readFileSync(join(fixture.root, '.ai/qa/test-env.json'), 'utf8');
      second = spawn('/bin/sh', [join(script, invalidation === 'down' ? 'test-env-down.sh' : 'e2e.sh'),
        ...(invalidation === 'force' ? ['--force'] : [])], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      const secondExit = once(second, 'close');
      let log = '';
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`no lease wait: ${log}`)), 15_000);
        second!.stderr!.on('data', chunk => {
          log += chunk;
          if (/waiting for test environment/.test(log)) { clearTimeout(timeout); resolve(); }
        });
        second!.once('close', () => { clearTimeout(timeout); resolve(); });
      });
      assert.equal(second.exitCode, null, `bootstrap must wait while specs use the server: ${log}`);
      assert.equal(readFileSync(join(fixture.root, '.ai/qa/test-env.json'), 'utf8'), before);
      assert.equal((await fetch(held.baseUrl)).status, 200);
      writeFileSync(join(fixture.root, '.ai/release-spec'), 'release');
      assert.equal((await firstExit)[0], 0, firstLog);
      assert.equal((await secondExit)[0], 0, log);
      const after = descriptor(fixture.root);
      if (invalidation !== 'down') launchedPids.add(after.app.pid);
    } finally {
      writeFileSync(join(fixture.root, '.ai/release-spec'), 'release');
      first.kill('SIGKILL');
      second?.kill('SIGKILL');
    }
  });
}

/** What a lane's source checkout runs once before linking: install, then build-e2e.sh. */
function prebuildE2e(fixture: { root: string }, env: NodeJS.ProcessEnv): void {
  for (const [command, args] of [[join(fixture.root, 'bin/pnpm'), ['install']], ['/bin/sh', ['.ai/scripts/build-e2e.sh']]] as const) {
    const result = spawnSync(command, args, { cwd: fixture.root, encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
  }
}

test('the bootstrap builds into the ignored mirror and never writes the production build', () => {
  const fixture = makeFixture(false);
  const env = { ...fixtureEnv, PATH: fixture.path, TEST_ENV_CACHE_TTL_SECONDS: '600' };
  const up = join(fixture.root, '.ai/scripts/test-env-up.sh');
  const down = join(fixture.root, '.ai/scripts/test-env-down.sh');
  const invocations = () => readFileSync(join(fixture.root, '.ai/build-invocations'), 'utf8').trim().split('\n');
  const e2eBuilds = () => invocations().filter((line) => line === '1').length;

  const cold = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(cold.status, 0, cold.stderr);
  const first = descriptor(fixture.root);
  launchedPids.add(first.app.pid);
  assert.deepEqual(invocations(), ['1']);
  // A declared input of the packaged-CLI and browser checks: a test boot must not touch it.
  assert.equal(existsSync(join(fixture.root, 'packages/cezar/dist')), false);
  assert.equal(existsSync(join(fixture.root, 'packages/cezar/web/dist')), false);
  assert.equal(existsSync(join(fixture.root, E2E_BUILD, 'dist/index.js')), true);
  assert.equal(existsSync(join(fixture.root, E2E_BUILD, 'web/dist/.cez-e2e-build')), true);
  // Absolute, because inline-contract runs from the repo root and tsc from the workspace.
  assert.match(readFileSync(join(fixture.root, '.ai/inline-contract-dist'), 'utf8'), /^\/.*\/\.ai\/qa\/build\/cezar\/dist$/);
  for (const entry of ['scripts', 'package.json', 'node_modules']) {
    assert.equal(readlinkSync(join(fixture.root, E2E_BUILD, entry)), `../../../../packages/cezar/${entry}`);
  }
  assert.match(first.app.startCommand, /node \.ai\/qa\/build\/cezar\/dist\/index\.js /);

  // A production build lands in packages/cezar and leaves the running e2e instance attachable.
  const production = spawnSync(join(fixture.root, 'bin/npm'), ['run', 'build'], { cwd: fixture.root, encoding: 'utf8', env });
  assert.equal(production.status, 0, production.stderr);
  const productionMtime = statSync(join(fixture.root, 'packages/cezar/dist/index.js')).mtimeMs;
  const warm = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(warm.status, 0, warm.stderr);
  assert.match(warm.stdout, /TEST_ENV_REUSED=1/, `warm boot refused reuse:\n${warm.stderr}`);

  // …and a stopped environment cold-boots from the cached mirror without rebuilding.
  const stopped = spawnSync('/bin/sh', [down], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(stopped.status, 0, stopped.stderr);
  launchedPids.delete(first.app.pid);
  const cached = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(cached.status, 0, cached.stderr);
  assert.match(cached.stderr, /build cache hit/);
  launchedPids.add(descriptor(fixture.root).app.pid);
  assert.equal(e2eBuilds(), 1);
  assert.equal(statSync(join(fixture.root, 'packages/cezar/dist/index.js')).mtimeMs, productionMtime);
  spawnSync('/bin/sh', [down], { encoding: 'utf8', env, timeout: 20_000 });
  launchedPids.delete(descriptor(fixture.root).app.pid);
});

// hearsay-tools/cezarion#1087: Squeal drives the e2e Vitest project directly, so its globalSetup
// runs test-env-up.sh -> build-e2e.sh with Vitest's NODE_ENV=test inherited. Vite then built a
// development bundle (import.meta.env.DEV true): the cockpit pointed its SharedWorker at the
// dev-server-only `/assets/live-worker-*.ts`, the worker failed, every document fell back to
// finite HTTP polling and `window.__cezLive` never became true.
test('the e2e cockpit is a production bundle whatever NODE_ENV the caller inherited', () => {
  const fixture = makeFixture(false);
  for (const inherited of ['test', 'development', undefined]) {
    const env: NodeJS.ProcessEnv = { ...fixtureEnv, PATH: fixture.path };
    if (inherited === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = inherited;
    prebuildE2e(fixture, env);
  }
  assert.deepEqual(readFileSync(join(fixture.root, '.ai/build-node-env'), 'utf8').trim().split('\n'), ['production', 'production', 'production']);
});

test('a mirror without the e2e marker refuses live reuse and the build cache', () => {
  const fixture = makeFixture(false);
  const env = { ...fixtureEnv, PATH: fixture.path, TEST_ENV_CACHE_TTL_SECONDS: '600' };
  const up = join(fixture.root, '.ai/scripts/test-env-up.sh');
  const down = join(fixture.root, '.ai/scripts/test-env-down.sh');
  const builds = () => readFileSync(join(fixture.root, '.ai/build-invocations'), 'utf8').trim().split('\n').length;

  const cold = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(cold.status, 0, cold.stderr);
  launchedPids.add(descriptor(fixture.root).app.pid);
  rmSync(join(fixture.root, E2E_BUILD, 'web/dist/.cez-e2e-build'));

  const rebuilt = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  assert.match(rebuilt.stdout, /TEST_ENV_REUSED=0/);
  assert.match(rebuilt.stderr, /not an e2e build/);
  assert.equal(builds(), 2);
  launchedPids.add(descriptor(fixture.root).app.pid);
  spawnSync('/bin/sh', [down], { encoding: 'utf8', env, timeout: 20_000 });
  launchedPids.delete(descriptor(fixture.root).app.pid);
});

test('a prebuilt lane boots without rebuilding shared assets and records its namespace', () => {
  const fixture = makeFixture(false);
  const env = {
    ...fixtureEnv,
    PATH: fixture.path,
    E2E_PREBUILT_ASSETS: '1',
    E2E_BROWSER_NAMESPACE: 'cez-e2e-lane-2',
  };
  prebuildE2e(fixture, env);
  rmSync(join(fixture.root, '.ai/build-invocations'));
  writeFileSync(join(fixture.root, '.git/cezar-e2e-lane.json'), '{"version":1}\n');

  const up = spawnSync('/bin/sh', [join(fixture.root, '.ai/scripts/test-env-up.sh')], {
    encoding: 'utf8', env, timeout: 20_000,
  });
  assert.equal(up.status, 0, up.stderr);
  assert.equal(descriptor(fixture.root).browser.namespace, 'cez-e2e-lane-2');
  // A lane is already an isolated clone (e2e-lanes.mjs), so it serves itself.
  assert.equal(descriptor(fixture.root).servedRoot, fixture.root);
  assert.equal(existsSync(join(fixture.root, '.ai/qa/served')), false);
  assert.equal(descriptor(fixture.root).browser.installed, true);
  assert.equal(spawnSync('/bin/sh', ['-c', 'test ! -e .ai/build-invocations'], { cwd: fixture.root }).status, 0);
  launchedPids.add(descriptor(fixture.root).app.pid);
  spawnSync('/bin/sh', [join(fixture.root, '.ai/scripts/test-env-down.sh')], { encoding: 'utf8', env, timeout: 20_000 });
  launchedPids.delete(descriptor(fixture.root).app.pid);
});

function descriptor(root: string): {
  baseUrl: string;
  servedRoot: string;
  app: { pid: number; startCommand: string };
  startedAt: string;
  browser: {
    installed: boolean;
    notes: string;
    launchArgs?: string[];
    runtimeEnv?: Record<string, string>;
    namespace?: string;
  };
} {
  return JSON.parse(readFileSync(join(root, '.ai/qa/test-env.json'), 'utf8')) as {
    baseUrl: string;
    servedRoot: string;
    app: { pid: number; startCommand: string };
    startedAt: string;
    browser: {
      installed: boolean;
      notes: string;
      launchArgs?: string[];
      runtimeEnv?: Record<string, string>;
      namespace?: string;
    };
  };
}

test('a cold boot serves an isolated clone of the checkout, never the checkout itself', () => {
  const fixture = makeFixture(false);
  const env = { ...fixtureEnv, PATH: fixture.path, TEST_ENV_CACHE_TTL_SECONDS: '600' };
  const up = join(fixture.root, '.ai/scripts/test-env-up.sh');
  // The clone carries the checkout's current edits, committed or not.
  writeFileSync(join(fixture.root, 'package.json'), '{"private":true,"edited":true}\n');
  writeFileSync(join(fixture.root, 'untracked.md'), 'new\n');

  const cold = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(cold.status, 0, cold.stderr);
  const first = descriptor(fixture.root);
  launchedPids.add(first.app.pid);
  const served = join(fixture.root, '.ai/qa/served', basename(fixture.root));
  assert.equal(first.servedRoot, served);
  // What the app was really started with, not what the descriptor says it was.
  const argv = readFileSync(join(fixture.root, '.ai/app-argv'), 'utf8').split('\n');
  assert.equal(argv[argv.indexOf('--repo') + 1], served);
  // Its own administration: a linked worktree would share the checkout's refs and queue (#795).
  assert.equal(realpathSync(execFileSync('git', ['-C', served, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim()),
    realpathSync(join(served, '.git')));
  assert.equal(readFileSync(join(served, 'package.json'), 'utf8'), '{"private":true,"edited":true}\n');
  assert.equal(readFileSync(join(served, 'untracked.md'), 'utf8'), 'new\n');

  // A reused server keeps reading its project live, as it read the checkout: the clone follows
  // the checkout's edits, including a reverted file and a deleted one. agent-browser.md is
  // tracked and, unlike package.json, not a build input, so editing it keeps the server.
  const provider = join(fixture.root, '.ai/browsers/agent-browser.md');
  const committedProvider = readFileSync(provider, 'utf8');
  writeFileSync(provider, '# edited after boot\n');
  writeFileSync(join(fixture.root, 'untracked.md'), 'edited\n');
  writeFileSync(join(fixture.root, 'later.md'), 'later\n');
  const warm = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.match(warm.stdout, /TEST_ENV_REUSED=1/, `warm boot refused reuse:\n${warm.stderr}`);
  assert.equal(readFileSync(join(served, '.ai/browsers/agent-browser.md'), 'utf8'), '# edited after boot\n');
  assert.equal(readFileSync(join(served, 'untracked.md'), 'utf8'), 'edited\n');
  assert.equal(readFileSync(join(served, 'later.md'), 'utf8'), 'later\n');
  writeFileSync(provider, committedProvider);
  rmSync(join(fixture.root, 'later.md'));
  const synced = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.match(synced.stdout, /TEST_ENV_REUSED=1/, `warm boot refused reuse:\n${synced.stderr}`);
  assert.equal(readFileSync(join(served, '.ai/browsers/agent-browser.md'), 'utf8'), committedProvider);
  assert.equal(existsSync(join(served, 'later.md')), false);

  // A commit moves HEAD past the clone's base: that takes a fresh clone, so a cold boot.
  fixtureGit(fixture.root, 'commit', '-q', '--allow-empty', '-m', 'later');
  const moved = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(moved.status, 0, moved.stderr);
  assert.match(moved.stdout, /TEST_ENV_REUSED=0/);
  assert.match(moved.stderr, /cannot follow this checkout/);
  launchedPids.add(descriptor(fixture.root).app.pid);
  assert.equal(execFileSync('git', ['-C', served, 'rev-parse', 'HEAD'], { encoding: 'utf8' }),
    execFileSync('git', ['-C', fixture.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }));

  // A descriptor from before the served clone (it served the checkout) is never reused.
  const legacy = JSON.parse(readFileSync(join(fixture.root, '.ai/qa/test-env.json'), 'utf8')) as Record<string, unknown>;
  delete legacy.servedRoot;
  writeFileSync(join(fixture.root, '.ai/qa/test-env.json'), JSON.stringify(legacy));
  const rebooted = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(rebooted.status, 0, rebooted.stderr);
  assert.match(rebooted.stdout, /TEST_ENV_REUSED=0/);
  assert.match(rebooted.stderr, /the served project is not/);
  launchedPids.add(descriptor(fixture.root).app.pid);
  assert.equal(descriptor(fixture.root).servedRoot, served);
  spawnSync('/bin/sh', [join(fixture.root, '.ai/scripts/test-env-down.sh')], { encoding: 'utf8', env, timeout: 20_000 });
});

// hearsay-tools/cezarion#1045: an agent's shell inherits the live cockpit's opt-ins. The shared
// server boots with none of them unless the run asks with --server-env, which is the reuse key.
test('ambient CEZ_* never reaches the shared server; --server-env does and keys reuse', () => {
  const fixture = makeFixture(false);
  const env = {
    ...fixtureEnv, PATH: fixture.path, E2E_PREBUILT_ASSETS: '1',
    CEZ_PREVIEW: '1', CEZ_AUTOMATIONS: '1', CEZ_FOLLOWUPS: '1', CEZ_SINGLE_PROJECT: '1', CEZ_TASK_ID: 'ambient',
  };
  prebuildE2e(fixture, env);
  const up = join(fixture.root, '.ai/scripts/test-env-up.sh');
  const appEnv = () => readFileSync(join(fixture.root, '.ai/app-cez-env'), 'utf8').split('\n')
    .filter((line) => !line.startsWith('CEZ_HOME='));
  const boot = (...args: string[]) => {
    const result = spawnSync('/bin/sh', [up, ...args], { encoding: 'utf8', env, timeout: 20_000 });
    assert.equal(result.status, 0, result.stderr);
    launchedPids.add(descriptor(fixture.root).app.pid);
    return result;
  };

  boot();
  assert.deepEqual(appEnv(), ['CEZ_DRY_RUN=1']);
  const plain = JSON.parse(readFileSync(join(fixture.root, '.ai/qa/test-env.json'), 'utf8')) as { environment: unknown };
  assert.deepEqual(plain.environment, { singleProject: false, serverEnv: 'none', watch: 'idle=30 interval=30', serverHome: '.ai/qa/server-home', serverUserProfile: '.ai/qa/server-home' });

  const opted = boot('--server-env=CEZ_FOLLOWUPS=1', '--server-env=CEZ_AUTOMATIONS=1');
  assert.match(opted.stdout, /TEST_ENV_REUSED=0/);
  assert.match(opted.stderr, /--server-env set changed/);
  assert.deepEqual(appEnv(), ['CEZ_AUTOMATIONS=1', 'CEZ_DRY_RUN=1', 'CEZ_FOLLOWUPS=1']);
  assert.match(descriptor(fixture.root).app.startCommand, /^CEZ_AUTOMATIONS=1 CEZ_FOLLOWUPS=1 CEZ_DRY_RUN=1 /);
  // Order does not matter; the same set reuses the running server.
  assert.match(boot('--server-env=CEZ_AUTOMATIONS=1', '--server-env=CEZ_FOLLOWUPS=1').stdout, /TEST_ENV_REUSED=1/);

  const single = boot('--server-env=CEZ_SINGLE_PROJECT=1');
  assert.match(single.stdout, /TEST_ENV_REUSED=0/);
  assert.deepEqual(JSON.parse(readFileSync(join(fixture.root, '.ai/qa/test-env.json'), 'utf8')).environment,
    { singleProject: true, serverEnv: 'CEZ_SINGLE_PROJECT=1', watch: 'idle=30 interval=30', serverHome: '.ai/qa/server-home', serverUserProfile: '.ai/qa/server-home' });

  for (const bad of [
    ['--server-env=CEZ_HOME=/elsewhere'], ['--server-env=PATH=/x'], ['--server-env=CEZ_X=a b'],
    // Same name twice: a sorted key could not tell the two orders apart.
    ['--server-env=CEZ_X=0', '--server-env=CEZ_X=1'],
  ]) {
    const refused = spawnSync('/bin/sh', [up, ...bad], { encoding: 'utf8', env, timeout: 20_000 });
    assert.equal(refused.status, 2, bad.join(' '));
    assert.match(refused.stderr, /invalid --server-env/);
  }
  spawnSync('/bin/sh', [join(fixture.root, '.ai/scripts/test-env-down.sh')], { encoding: 'utf8', env, timeout: 20_000 });
});

test('the served clone never replaces a directory it did not create', () => {
  const fixture = makeFixture(false);
  const env = { ...fixtureEnv, PATH: fixture.path, E2E_PREBUILT_ASSETS: '1' };
  prebuildE2e(fixture, env);
  const served = join(fixture.root, '.ai/qa/served', basename(fixture.root));
  mkdirSync(served, { recursive: true });
  writeFileSync(join(served, 'keep.txt'), 'not a clone\n');

  const result = spawnSync('/bin/sh', [join(fixture.root, '.ai/scripts/test-env-up.sh')], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /refusing to replace .* not a served E2E clone/);
  assert.equal(readFileSync(join(served, 'keep.txt'), 'utf8'), 'not a clone\n');
  assert.equal(existsSync(join(fixture.root, '.ai/app-argv')), false, 'the app must not start without its project');
});

test('a failed cold boot leaves no descriptor of the env it replaced', () => {
  const fixture = unhealthyFixture('exited');
  // What main carried for a month: a running-status descriptor of a long-dead env whose browser
  // check had failed. Specs read its notes and reported a missing browser instead of the boot error.
  writeFileSync(join(fixture.root, '.ai/qa/test-env.json'), JSON.stringify({
    status: 'running', baseUrl: 'http://127.0.0.1:9', startedByThisRepo: true, app: {},
    browser: { installed: false, notes: 'live browser launch failed after autonomous install' },
  }));
  const result = spawnSync('/bin/sh', [join(fixture.root, '.ai/scripts/test-env-up.sh')], {
    encoding: 'utf8', env: { ...fixture.env, TEST_ENV_HEALTH_TIMEOUT_SECONDS: '5' }, timeout: 9_000, killSignal: 'SIGKILL',
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /the app exited during boot/);
  assert.equal(existsSync(join(fixture.root, '.ai/qa/test-env.json')), false);
});

function unhealthyFixture(mode: 'stalled' | 'unavailable' | 'exited') {
  const fixture = makeFixture(false);
  const env = { ...fixtureEnv, PATH: fixture.path, E2E_PREBUILT_ASSETS: '1' };
  prebuildE2e(fixture, env);
  writeFileSync(join(fixture.root, E2E_BUILD, 'dist/index.js'), `
${writePidSource('app.pid')}
for (let i = 1; i <= 25; i++) console.log('boot-line-' + i);
${mode === 'exited' ? 'process.exit(1);' : `
require('node:http').createServer((req, res) => {
  ${mode === 'unavailable' ? 'res.writeHead(503); res.end();' : '/* Keep the health request open until curl times out. */'}
}).listen(Number(process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1');
`}
`);
  return { ...fixture, env };
}

test('health timeout bounds elapsed time even when a real HTTP probe stalls', async () => {
  const fixture = unhealthyFixture('stalled');
  // Trace the launcher's own health clock and every probe budget it hands curl, in call order.
  // `date +%s` is read only by the health wait, so the first traced reading is its start.
  const trace = join(fixture.root, '.ai/health-trace');
  rmSync(join(fixture.root, 'bin/date'));
  writeFileSync(join(fixture.root, 'bin/date'), `#!/bin/sh
if [ "\${1-}" = +%s ]; then
  now=$("${commandPath('date')}" +%s)
  printf 'date %s\\n' "$now" >> '${trace}'
  printf '%s\\n' "$now"
else
  exec "${commandPath('date')}" "$@"
fi
`, { mode: 0o755 });
  rmSync(join(fixture.root, 'bin/curl'));
  writeFileSync(join(fixture.root, 'bin/curl'), `#!/bin/sh
prev=
for arg do
  [ "$prev" != --max-time ] || budget=$arg
  prev=$arg
done
printf 'curl %s %s\\n' "\${budget-none}" "$arg" >> '${trace}'
exec "${commandPath('curl')}" "$@"
`, { mode: 0o755 });

  const started = performance.now();
  const result = spawnSync('/bin/sh', [join(fixture.root, '.ai/scripts/test-env-up.sh')], {
    // The kill is a hang guard, not the proof (#1105): a launcher that ignored the 5s override
    // would wait out its 180s default, so stop it well before that and let the status
    // assertion fail. 60s is several times the slowest loaded run seen (8.6s at load ~90), so
    // scheduling delay cannot reach it while the deadline is enforced.
    encoding: 'utf8', env: { ...fixture.env, TEST_ENV_HEALTH_TIMEOUT_SECONDS: '5' }, timeout: 60_000, killSignal: 'SIGKILL',
  });
  const elapsed = (performance.now() - started) / 1_000;
  const pid = requirePid(join(fixture.root, 'app.pid'));
  launchedPids.add(pid);
  const traced = existsSync(trace) ? readFileSync(trace, 'utf8') : '';
  assert.equal(result.status, 1, `launcher did not enforce its health deadline (${elapsed}s): ${result.stderr}\n${traced}`);
  // Lower bounds only: load can stretch the wait but never shorten it, so these prove the
  // probe really stalled until the deadline without breaking on a busy host.
  assert.ok(elapsed >= 4, `five-second health wait took ${elapsed}s`);
  // The launcher reports whole elapsed seconds on its own clock, so a slow runner can print
  // 6s or more for a 5s deadline (#856). It must still have waited out the deadline.
  const reported = Number(result.stderr.match(/health wait timed out after (\d+)s/)?.[1]);
  assert.ok(reported >= 5, `five-second health wait reported ${reported}s: ${result.stderr}`);
  // The bound itself, in the launcher's own clock rather than the host's wall clock (#1105):
  // every stalled probe must be budgeted to end by health start + 5s. A launcher that fell
  // back to its 180s default keeps issuing 5s probes after that point, and one that ignored
  // the remaining budget lets the last probe overrun it. Scheduling delay moves both the
  // clock reading and the probe together, so it cannot break this.
  const lines = traced.trim().split('\n');
  const healthStart = Number(lines.find((line) => line.startsWith('date '))?.slice('date '.length));
  assert.ok(Number.isInteger(healthStart), `no health clock reading traced:\n${traced}`);
  let clock = Number.NaN;
  let probes = 0;
  for (const line of lines) {
    const [kind, value, url] = line.split(' ');
    if (kind === 'date') clock = Number(value);
    if (kind !== 'curl' || !url?.endsWith('/api/v1/health') || Number.isNaN(clock)) continue;
    probes++;
    assert.ok(clock + Number(value) <= healthStart + 5,
      `probe at ${clock - healthStart}s was budgeted ${value}s past the 5s deadline:\n${traced}`);
  }
  assert.ok(probes >= 1, `no health probe traced:\n${traced}`);
  assert.deepEqual(result.stderr.match(/^boot-line-\d+$/gm),
    Array.from({ length: 20 }, (_, i) => `boot-line-${i + 6}`));
  assert.equal(result.stdout, '', 'a failed boot must not emit running markers');
  // Observe termination, including delivery of the launcher's SIGTERM after it exits.
  for (let tries = 0; tries < 100; tries++) {
    try { process.kill(pid, 0); } catch { launchedPids.delete(pid); return; }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  assert.fail('timed-out app is still alive');
});

test('unset health timeout allows 180 elapsed seconds before stopping an unhealthy app', () => {
  const fixture = unhealthyFixture('unavailable');
  // Advance only the health clock; ISO timestamps still come from the real date.
  rmSync(join(fixture.root, 'bin/date'));
  writeFileSync(join(fixture.root, 'bin/date'), `#!/bin/sh
if [ "\${1-}" = +%s ]; then
  tick=0
  [ ! -f "$0.tick" ] || read -r tick < "$0.tick"
  printf '%s\\n' "$tick"
  printf '%s\\n' "$((tick + 30))" > "$0.tick"
else
  exec "${commandPath('date')}" "$@"
fi
`, { mode: 0o755 });
  rmSync(join(fixture.root, 'bin/sleep'));
  writeFileSync(join(fixture.root, 'bin/sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { ...fixture.env };
  delete env.TEST_ENV_HEALTH_TIMEOUT_SECONDS;
  const result = spawnSync('/bin/sh', [join(fixture.root, '.ai/scripts/test-env-up.sh')], {
    encoding: 'utf8', env, timeout: 9_000, killSignal: 'SIGKILL',
  });
  // The accelerated clock can exhaust the budget before Node begins executing.
  const pid = readPid(join(fixture.root, 'app.pid'));
  if (pid !== undefined) launchedPids.add(pid);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /health wait timed out after 180s/);
});

test('health wait still detects an app that exits during boot', () => {
  const fixture = unhealthyFixture('exited');
  const result = spawnSync('/bin/sh', [join(fixture.root, '.ai/scripts/test-env-up.sh')], {
    encoding: 'utf8', env: { ...fixture.env, TEST_ENV_HEALTH_TIMEOUT_SECONDS: '5' }, timeout: 9_000, killSignal: 'SIGKILL',
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /the app exited during boot/);
  assert.match(result.stderr, /boot-line-25/);
  assert.doesNotMatch(result.stderr, /health wait timed out/);
  assert.equal(result.stdout, '');
});

for (const timeout of ['0', '-1', '1.5', 'invalid', '--version', '--help']) {
  test(`malformed health timeout ${timeout} is rejected before starting the app`, () => {
    const fixture = makeFixture(false);
    // Malformed input must fail before preparation. A failing build also prevents
    // a regressed option parser from leaving a detached app without a descriptor.
    writeFileSync(join(fixture.root, 'bin/npm'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    const result = spawnSync('/bin/sh', [join(fixture.root, '.ai/scripts/test-env-up.sh')], {
      encoding: 'utf8', env: { ...fixtureEnv, PATH: fixture.path, TEST_ENV_HEALTH_TIMEOUT_SECONDS: timeout },
      timeout: 9_000, killSignal: 'SIGKILL',
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /TEST_ENV_HEALTH_TIMEOUT_SECONDS.*positive integer/);
    assert.equal(result.stdout, '');
  });
}

for (const withSetsid of [true, false]) {
  test(
    `generated launcher survives its caller and stops by descriptor PID (${withSetsid ? 'setsid' : 'nohup fallback'})`,
    { skip: withSetsid && !hasSetsid ? 'setsid is not available on this platform' : false },
    async () => {
      const fixture = makeFixture(withSetsid);
      const env = { ...fixtureEnv, PATH: fixture.path, TEST_ENV_CACHE_TTL_SECONDS: '600', TEST_ENV_HEALTH_TIMEOUT_SECONDS: '5' };
      const up = join(fixture.root, '.ai/scripts/test-env-up.sh');
      const down = join(fixture.root, '.ai/scripts/test-env-down.sh');
      const callerPidFile = join(fixture.root, 'caller.pid');

      const coldCommand = withSetsid ? commandPath('setsid') : '/bin/sh';
      const coldArgs = withSetsid
        ? ['/bin/sh', '-c', 'echo $$ > "$2.tmp"; mv "$2.tmp" "$2"; sh "$1"', 'launcher-parent', up, callerPidFile]
        : ['-c', 'echo $$ > "$2.tmp"; mv "$2.tmp" "$2"; sh "$1"', 'launcher-parent', up, callerPidFile];
      const cold = spawnSync(coldCommand, coldArgs, {
        cwd: tmpdir(),
        encoding: 'utf8',
        env,
        timeout: 20_000,
      });
      assert.equal(cold.status, 0, cold.stderr);
      assert.match(cold.stdout, /TEST_ENV_REUSED=0/);

      const first = descriptor(fixture.root);
      launchedPids.add(first.app.pid);
      if (withSetsid) {
        const callerPid = requirePid(callerPidFile);
        try {
          process.kill(-callerPid, 'SIGTERM');
        } catch (error) {
          assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH');
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      }
      assert.equal(process.kill(first.app.pid, 0), true);
      const health = await fetch(`${first.baseUrl}/api/health`).then((response) => response.json());
      assert.deepEqual(health, { ok: true });

      const warm = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
      assert.equal(warm.status, 0, warm.stderr);
      // try_reuse logs the reason it bailed to stderr, but a cold boot still exits 0 —
      // surface it in the assertion message so a REUSED=0 failure names its cause.
      assert.match(warm.stdout, /TEST_ENV_REUSED=1/, `warm boot refused reuse:\n${warm.stderr}`);
      assert.equal(descriptor(fixture.root).app.pid, first.app.pid, `warm boot refused reuse:\n${warm.stderr}`);

      const stopped = spawnSync('/bin/sh', [down], { encoding: 'utf8', env, timeout: 20_000 });
      assert.equal(stopped.status, 0, stopped.stderr);
      assert.match(stopped.stdout, /TEST_ENV_STATUS=stopped/);
      assert.throws(() => process.kill(first.app.pid, 0));
      launchedPids.delete(first.app.pid);
    },
  );
}

test('a tracked file inside the boot second is reused; a later edit still refuses (#36)', () => {
  // startedAt used to strip milliseconds, so find -newermt treated every mtime
  // in the boot's own second as newer than boot. Keep the fraction: a file dated
  // at the second's start (not after startedAt) must attach, and a file dated
  // after startedAt must still refuse and name the path.
  const fixture = makeFixture(false);
  const env = { ...fixtureEnv, PATH: fixture.path, TEST_ENV_CACHE_TTL_SECONDS: '600' };
  const up = join(fixture.root, '.ai/scripts/test-env-up.sh');
  const down = join(fixture.root, '.ai/scripts/test-env-down.sh');

  const cold = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(cold.status, 0, cold.stderr);
  assert.match(cold.stdout, /TEST_ENV_REUSED=0/);
  const first = descriptor(fixture.root);
  launchedPids.add(first.app.pid);
  assert.match(first.startedAt, /\.\d{3}Z$/);

  const startedMs = Date.parse(first.startedAt);
  const insideBootSecond = new Date(Math.floor(startedMs / 1000) * 1000);
  utimesSync(join(fixture.root, 'package.json'), insideBootSecond, insideBootSecond);

  const sameSecond = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(sameSecond.status, 0, sameSecond.stderr);
  assert.match(sameSecond.stdout, /TEST_ENV_REUSED=1/, `same-second file refused reuse:\n${sameSecond.stderr}`);
  assert.equal(descriptor(fixture.root).app.pid, first.app.pid);

  const afterBoot = new Date(startedMs + 2_000);
  utimesSync(join(fixture.root, 'package.json'), afterBoot, afterBoot);

  const refused = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(refused.status, 0, refused.stderr);
  assert.match(refused.stdout, /TEST_ENV_REUSED=0/);
  assert.match(refused.stderr, /source changed since boot/);
  assert.match(refused.stderr, /package\.json/);
  launchedPids.delete(first.app.pid);
  const rebuilt = descriptor(fixture.root);
  launchedPids.add(rebuilt.app.pid);
  const beforeRebuilt = new Date(Date.parse(rebuilt.startedAt) - 30_000);
  utimesSync(join(fixture.root, 'package.json'), beforeRebuilt, beforeRebuilt);

  const warm = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(warm.status, 0, warm.stderr);
  assert.match(warm.stdout, /TEST_ENV_REUSED=1/, `warm boot refused reuse:\n${warm.stderr}`);

  const stopped = spawnSync('/bin/sh', [down], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stdout, /TEST_ENV_STATUS=stopped/);
  launchedPids.delete(descriptor(fixture.root).app.pid);
});

test('browser doctor receives the resolver’s container args and short runtime path', () => {
  const fixture = makeFixture(false);
  writeFileSync(
    join(fixture.root, '.ai/scripts/resolve-browser-launch.mjs'),
    `console.log(JSON.stringify({
      inContainer: true,
      launchArgs: ['--no-sandbox'],
      runtimeEnv: { TMPDIR: '/tmp', TMP: '/tmp', TEMP: '/tmp' },
      namespace: 'cez-e2e',
    }))
`,
  );
  const env = { ...fixtureEnv, PATH: fixture.path, TEST_ENV_CACHE_TTL_SECONDS: '600' };
  const up = join(fixture.root, '.ai/scripts/test-env-up.sh');
  const down = join(fixture.root, '.ai/scripts/test-env-down.sh');
  const cold = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(cold.status, 0, cold.stderr);
  const argvLog = readFileSync(join(fixture.root, 'bin/agent-browser.argv'), 'utf8');
  assert.match(argvLog, /--namespace cez-e2e/);
  assert.match(argvLog, /--args --no-sandbox/);
  assert.match(argvLog, /doctor --json --offline/);
  const envLog = readFileSync(join(fixture.root, 'bin/agent-browser.env'), 'utf8');
  assert.match(envLog, /^TMPDIR=\/tmp$/m);
  const desc = descriptor(fixture.root);
  launchedPids.add(desc.app.pid);
  assert.deepEqual(desc.browser.launchArgs, ['--no-sandbox']);
  assert.equal(desc.browser.runtimeEnv?.TMPDIR, '/tmp');
  assert.equal(desc.browser.namespace, 'cez-e2e');
  assert.equal(desc.browser.installed, true);
  spawnSync('/bin/sh', [down], { encoding: 'utf8', env, timeout: 20_000 });
  launchedPids.delete(descriptor(fixture.root).app.pid);
});

test('doctor launch failure is not a missing browser when a live launch works', () => {
  const fixture = makeFixture(false);
  writeFileSync(
    join(fixture.root, '.ai/scripts/resolve-browser-launch.mjs'),
    `console.log(JSON.stringify({
      inContainer: true,
      launchArgs: ['--no-sandbox'],
      runtimeEnv: { TMPDIR: '/tmp', TMP: '/tmp', TEMP: '/tmp' },
      namespace: 'cez-e2e',
    }))
`,
  );
  writeFileSync(
    join(fixture.root, 'bin/agent-browser'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$0.argv"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --args|--namespace|--session) shift 2 ;;
    --json|--offline|--quick) shift ;;
    doctor)
      printf '{"success":false,"checks":[{"id":"chrome.installed","status":"pass"},{"id":"launch.launch","status":"fail","message":"No usable sandbox"}]}\\n'
      exit 1
      ;;
    --version) printf 'test-browser 1\\n'; exit 0 ;;
    open) printf '{"success":true,"data":{}}\\n'; exit 0 ;;
    close) printf '{"success":true,"data":{}}\\n'; exit 0 ;;
    *) shift ;;
  esac
done
exit 1
`,
    { mode: 0o755 },
  );
  const env = { ...fixtureEnv, PATH: fixture.path, TEST_ENV_CACHE_TTL_SECONDS: '600' };
  const up = join(fixture.root, '.ai/scripts/test-env-up.sh');
  const down = join(fixture.root, '.ai/scripts/test-env-down.sh');
  const cold = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(cold.status, 0, cold.stderr);
  const desc = descriptor(fixture.root);
  launchedPids.add(desc.app.pid);
  assert.equal(desc.browser.installed, true);
  assert.match(desc.browser.notes, /live launch succeeded/i);
  assert.doesNotMatch(desc.browser.notes, /unavailable|missing/i);
  const argvLog = readFileSync(join(fixture.root, 'bin/agent-browser.argv'), 'utf8');
  assert.match(argvLog, /--args --no-sandbox.*open about:blank/s);
  const probeSessions = [...argvLog.matchAll(/--session (cez-boot-probe-\d+)/g)].map((m) => m[1]);
  assert.ok(probeSessions.length >= 2);
  assert.equal(new Set(probeSessions).size, 1);
  assert.notEqual(probeSessions[0], 'cez-boot-probe');
  spawnSync('/bin/sh', [down], { encoding: 'utf8', env, timeout: 20_000 });
  launchedPids.delete(descriptor(fixture.root).app.pid);
});

test('installed Chrome that still cannot launch with resolved settings is not treated as missing', () => {
  const fixture = makeFixture(false);
  writeFileSync(
    join(fixture.root, '.ai/scripts/resolve-browser-launch.mjs'),
    `console.log(JSON.stringify({
      inContainer: true,
      launchArgs: ['--no-sandbox'],
      runtimeEnv: { TMPDIR: '/tmp', TMP: '/tmp', TEMP: '/tmp' },
      namespace: 'cez-e2e',
    }))
`,
  );
  writeFileSync(
    join(fixture.root, 'bin/agent-browser'),
    `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    --args|--namespace|--session) shift 2 ;;
    --json|--offline|--quick) shift ;;
    doctor)
      printf '{"success":false,"checks":[{"id":"chrome.installed","status":"pass"},{"id":"launch.launch","status":"fail","message":"Socket path too long"}]}\\n'
      exit 1
      ;;
    --version) printf 'test-browser 1\\n'; exit 0 ;;
    open)
      printf '{"success":false,"error":"Socket path too long"}\\n'
      exit 1
      ;;
    close) printf '{"success":true}\\n'; exit 0 ;;
    *) shift ;;
  esac
done
exit 1
`,
    { mode: 0o755 },
  );
  const env = { ...fixtureEnv, PATH: fixture.path, TEST_ENV_CACHE_TTL_SECONDS: '600' };
  const up = join(fixture.root, '.ai/scripts/test-env-up.sh');
  const down = join(fixture.root, '.ai/scripts/test-env-down.sh');
  const cold = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(cold.status, 0, cold.stderr);
  const desc = descriptor(fixture.root);
  launchedPids.add(desc.app.pid);
  assert.equal(desc.browser.installed, false);
  assert.match(desc.browser.notes, /failed to launch with resolved settings/i);
  spawnSync('/bin/sh', [down], { encoding: 'utf8', env, timeout: 20_000 });
  launchedPids.delete(descriptor(fixture.root).app.pid);
});

// ---- the server's own end (hearsay-tools/cezarion#1448) ------------------------------------
// The detached server outlives every caller; its watcher stops it once nothing uses it.

const WATCH = { TEST_ENV_WATCH_INTERVAL_SECONDS: '0.2' };

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

async function waitForExit(pid: number, what: string, log: () => string): Promise<void> {
  // bound: a hang guard far above one 0.2 s poll plus the watcher's 10 s stop budget.
  const deadline = Date.now() + 30_000;
  while (alive(pid)) {
    assert.ok(Date.now() < deadline, `${what} (pid ${pid}) is still running:\n${log()}`);
    await delay(50);
  }
}

function watchLog(root: string): string {
  try { return readFileSync(join(root, '.ai/qa/test-env-watch.log'), 'utf8'); } catch { return '(no watcher log)'; }
}

async function watcherPid(root: string): Promise<number> {
  // bound: the watcher logs this line as it starts, right after detach-app returns.
  const deadline = Date.now() + 10_000;
  while (true) {
    const match = /\[test-env\] watcher (\d+) watching cezar pid \d+/.exec(watchLog(root));
    const pid = match && parsePid(match[1]!);
    if (pid) return pid;
    assert.ok(Date.now() < deadline, `no watcher started:\n${watchLog(root)}`);
    await delay(20);
  }
}

function bootWatched(extra: NodeJS.ProcessEnv): { root: string; env: NodeJS.ProcessEnv; pid: number } {
  const fixture = makeFixture(false);
  const env = { ...fixtureEnv, PATH: fixture.path, ...WATCH, ...extra };
  const cold = spawnSync('/bin/sh', [join(fixture.root, '.ai/scripts/test-env-up.sh')], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(cold.status, 0, cold.stderr);
  const pid = descriptor(fixture.root).app.pid;
  launchedPids.add(pid);
  return { root: fixture.root, env, pid };
}

test('the server exits when its checkout is deleted', async () => {
  const { root, pid } = bootWatched({});
  const watcher = await watcherPid(root);
  rmSync(root, { recursive: true, force: true });
  await waitForExit(pid, 'server', () => '(checkout deleted)');
  await waitForExit(watcher, 'watcher', () => '(checkout deleted)');
});

test('the server exits when its test-env state is deleted, and the checkout is not recreated', async () => {
  const { root, pid } = bootWatched({});
  const watcher = await watcherPid(root);
  rmSync(join(root, '.ai/qa'), { recursive: true, force: true });
  await waitForExit(pid, 'server', () => '(.ai/qa deleted)');
  await waitForExit(watcher, 'watcher', () => '(.ai/qa deleted)');
  assert.equal(existsSync(join(root, '.ai/qa')), false);
});

test('a watcher that cannot open its log never loses the started server', () => {
  const fixture = makeFixture(false);
  // A directory where the log belongs makes the watcher's log open fail.
  mkdirSync(join(fixture.root, '.ai/qa/test-env-watch.log'), { recursive: true });
  const env = { ...fixtureEnv, PATH: fixture.path, ...WATCH };
  const cold = spawnSync('/bin/sh', [join(fixture.root, '.ai/scripts/test-env-up.sh')], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(cold.status, 0, cold.stderr);
  const pid = descriptor(fixture.root).app.pid;
  launchedPids.add(pid);
  assert.ok(alive(pid));
  const stopped = spawnSync('/bin/sh', [join(fixture.root, '.ai/scripts/test-env-down.sh')], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.ok(!alive(pid));
});

test('an idle server with no lease holder exits and its descriptor reads stopped', async () => {
  const { root, pid } = bootWatched({ TEST_ENV_IDLE_EXIT_MINUTES: '0.01' });
  const watcher = await watcherPid(root);
  await waitForExit(pid, 'server', () => watchLog(root));
  await waitForExit(watcher, 'watcher', () => watchLog(root));
  const stopped = JSON.parse(readFileSync(join(root, '.ai/qa/test-env.json'), 'utf8'));
  assert.equal(stopped.status, 'stopped');
  // A later teardown must never signal the freed pid.
  assert.equal(stopped.app.pid, undefined);
  assert.match(watchLog(root), new RegExp(`stopping cezar pid ${pid}: idle`));
});

test('a live lease keeps the server; a SIGKILLed holder no longer does', async () => {
  const fixture = makeFixture(false);
  const root = fixture.root;
  const env = { ...fixtureEnv, PATH: fixture.path, ...WATCH, TEST_ENV_IDLE_EXIT_MINUTES: '0.01' };
  const lease = pathToFileURL(join(root, '.ai/scripts/test-env-lease.mjs')).href;
  // The holder boots the server under its own token, so no gap is left without a holder.
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `
    import { spawnSync } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    import { acquireTestEnvLease } from ${JSON.stringify(lease)};
    const { token } = await acquireTestEnvLease(${JSON.stringify(root)});
    const up = spawnSync('/bin/sh', [${JSON.stringify(join(root, '.ai/scripts/test-env-up.sh'))}], {
      encoding: 'utf8', env: { ...process.env, TEST_ENV_LEASE_TOKEN: token },
    });
    writeFileSync(${JSON.stringify(join(root, '.ai/held'))}, JSON.stringify({ status: up.status, stderr: up.stderr }));
    setInterval(() => {}, 1_000_000);
  `], { env, stdio: 'ignore' });
  try {
    // bound: a hang guard for one fixture cold boot.
    const deadline = Date.now() + 20_000;
    while (!existsSync(join(root, '.ai/held'))) {
      assert.ok(Date.now() < deadline, `holder never booted the server:\n${watchLog(root)}`);
      await delay(20);
    }
    const up = JSON.parse(readFileSync(join(root, '.ai/held'), 'utf8')) as { status: number; stderr: string };
    assert.equal(up.status, 0, up.stderr);
    const pid = descriptor(root).app.pid;
    launchedPids.add(pid);
    // bound: proves an absence; 2 s is three idle periods and about ten polls.
    await delay(2_000);
    assert.ok(alive(pid), `a held lease must keep the server:\n${watchLog(root)}`);
    assert.equal((await fetch(descriptor(root).baseUrl)).status, 200);
    holder.kill('SIGKILL');
    await once(holder, 'close');
    await waitForExit(pid, 'server', () => watchLog(root));
  } finally { holder.kill('SIGKILL'); }
});

test('TEST_ENV_IDLE_EXIT_MINUTES=0 keeps an idle server', async () => {
  const { root, env, pid } = bootWatched({ TEST_ENV_IDLE_EXIT_MINUTES: '0' });
  await watcherPid(root);
  // bound: proves an absence across about ten polls.
  await delay(2_000);
  assert.ok(alive(pid), watchLog(root));
  const stopped = spawnSync('/bin/sh', [join(root, '.ai/scripts/test-env-down.sh')], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(stopped.status, 0, stopped.stderr);
});

test('a changed watcher setting refuses reuse, so the new policy reaches a fresh watcher', () => {
  const { root, env, pid } = bootWatched({ TEST_ENV_CACHE_TTL_SECONDS: '600' });
  const up = (extra: NodeJS.ProcessEnv) => spawnSync('/bin/sh', [join(root, '.ai/scripts/test-env-up.sh')], { encoding: 'utf8', env: { ...env, ...extra }, timeout: 20_000 });
  const same = up({});
  assert.equal(same.status, 0, same.stderr);
  assert.match(same.stdout, /TEST_ENV_REUSED=1/, same.stderr);
  const changed = up({ TEST_ENV_IDLE_EXIT_MINUTES: '0' });
  assert.equal(changed.status, 0, changed.stderr);
  assert.match(changed.stdout, /TEST_ENV_REUSED=0/);
  assert.match(changed.stderr, /not reusing: the watcher settings changed \(now: idle=0 interval=0\.2\)/);
  assert.ok(!alive(pid));
  launchedPids.add(descriptor(root).app.pid);
  const stopped = spawnSync('/bin/sh', [join(root, '.ai/scripts/test-env-down.sh')], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(stopped.status, 0, stopped.stderr);
});

test('test-env-down.sh stopping the server also ends its watcher', async () => {
  const { root, env, pid } = bootWatched({});
  const watcher = await watcherPid(root);
  const stopped = spawnSync('/bin/sh', [join(root, '.ai/scripts/test-env-down.sh')], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.ok(!alive(pid));
  await waitForExit(watcher, 'watcher', () => watchLog(root));
  assert.doesNotMatch(watchLog(root), /watcher stopping/);
});

for (const [name, value, rule] of [
  ['TEST_ENV_IDLE_EXIT_MINUTES', '-1', 'non-negative number'],
  ['TEST_ENV_IDLE_EXIT_MINUTES', 'abc', 'non-negative number'],
  ['TEST_ENV_IDLE_EXIT_MINUTES', '1.', 'non-negative number'],
  ['TEST_ENV_WATCH_INTERVAL_SECONDS', '0', 'number of seconds from 0.1 to 3600'],
  ['TEST_ENV_WATCH_INTERVAL_SECONDS', '0.01', 'number of seconds from 0.1 to 3600'],
  ['TEST_ENV_WATCH_INTERVAL_SECONDS', '3000000', 'number of seconds from 0.1 to 3600'],
  ['TEST_ENV_WATCH_INTERVAL_SECONDS', '1e3', 'number of seconds from 0.1 to 3600'],
] as const) {
  test(`malformed ${name}=${JSON.stringify(value)} is refused before boot`, () => {
    const fixture = makeFixture(false);
    writeFileSync(join(fixture.root, 'bin/npm'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    const result = spawnSync('/bin/sh', [join(fixture.root, '.ai/scripts/test-env-up.sh')], {
      encoding: 'utf8', env: { ...fixtureEnv, PATH: fixture.path, [name]: value }, timeout: 9_000, killSignal: 'SIGKILL',
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, new RegExp(`${name} must be a ${rule}`));
    assert.equal(existsSync(join(fixture.root, '.ai/qa/test-env.json')), false);
  });
}

// hearsay-tools/cezarion#1699: isolate only the server, preserving tool caches and Git pins.
test('server HOME is fresh on cold boots, preserved on reuse, and separate from tool HOME', () => {
  const fixture = makeFixture(false);
  const invokingHome = join(fixture.root, 'invoking-home');
  mkdirSync(invokingHome);
  const env = { ...fixtureEnv, PATH: fixture.path, HOME: invokingHome, USERPROFILE: invokingHome, TEST_ENV_CACHE_TTL_SECONDS: '600' };
  const npm = join(fixture.root, 'bin/npm');
  writeFileSync(npm, readFileSync(npm, 'utf8')
    .replace('set -eu', `set -eu\nprintf '%s\\n' "$HOME" >> .ai/tool-home`)
    .replace("const http = require('node:http');", `const http = require('node:http');
require('node:fs').writeFileSync('.ai/app-home', process.env.HOME);
require('node:fs').writeFileSync('.ai/app-userprofile', process.env.USERPROFILE);
require('node:fs').writeFileSync('.ai/app-git-ident', require('node:child_process').execFileSync('git', ['var', 'GIT_AUTHOR_IDENT']));`));
  const up = join(fixture.root, '.ai/scripts/test-env-up.sh');
  const home = join(fixture.root, '.ai/qa/server-home');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'stale'), 'old boot');
  const cold = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(cold.status, 0, cold.stderr);
  const first = descriptor(fixture.root);
  launchedPids.add(first.app.pid);
  assert.equal(readFileSync(join(fixture.root, '.ai/app-home'), 'utf8'), home);
  assert.equal(readFileSync(join(fixture.root, '.ai/app-userprofile'), 'utf8'), home);
  assert.equal(existsSync(join(home, 'stale')), false);
  assert.match(first.app.startCommand, /HOME=\.ai\/qa\/server-home /);
  assert.match(readFileSync(join(fixture.root, '.ai/app-git-ident'), 'utf8'), /^Cezar Tests <tests@cezar.invalid> /);
  assert.deepEqual([...new Set(readFileSync(join(fixture.root, '.ai/tool-home'), 'utf8').trim().split('\n'))], [invokingHome]);
  writeFileSync(join(home, 'live'), 'keep during reuse');
  const warm = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(warm.status, 0, warm.stderr);
  assert.match(warm.stdout, /TEST_ENV_REUSED=1/);
  assert.equal(existsSync(join(home, 'live')), true);
  // A descriptor from an older launcher cannot certify that the live server has an isolated HOME.
  const descriptorPath = join(fixture.root, '.ai/qa/test-env.json');
  const legacy = JSON.parse(readFileSync(descriptorPath, 'utf8'));
  delete legacy.environment.serverUserProfile;
  writeFileSync(descriptorPath, JSON.stringify(legacy));
  const upgraded = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(upgraded.status, 0, upgraded.stderr);
  const next = descriptor(fixture.root);
  launchedPids.add(next.app.pid);
  assert.notEqual(next.app.pid, first.app.pid);
  assert.equal(existsSync(join(home, 'live')), false);
});
