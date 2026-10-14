import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

function makeFixture(withSetsid: boolean): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'cez-test-env-launcher-'));
  fixtures.push(root);
  mkdirSync(join(root, '.ai/scripts'), { recursive: true });
  mkdirSync(join(root, '.ai/browsers'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  copyFileSync(join(repoRoot, '.ai/scripts/test-env-up.sh'), join(root, '.ai/scripts/test-env-up.sh'));
  copyFileSync(join(repoRoot, '.ai/scripts/test-env-down.sh'), join(root, '.ai/scripts/test-env-down.sh'));
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
  writeFileSync(join(root, '.gitignore'), '/.ai/qa/\n/bin/\nnode_modules/\n/packages/cezar/dist/\n/packages/cezar/web/\n/.ai/build-invocations\n/.ai/inline-contract-dist\n/.ai/app-argv\n/app.pid\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@cezar.invalid', ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'ignore',
  });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  return { root, path: join(root, 'bin') };
}

const E2E_BUILD = '.ai/qa/build/cezar';

/** What a lane's source checkout runs once before linking: install, then build-e2e.sh. */
function prebuildE2e(fixture: { root: string }, env: NodeJS.ProcessEnv): void {
  for (const [command, args] of [[join(fixture.root, 'bin/pnpm'), ['install']], ['/bin/sh', ['.ai/scripts/build-e2e.sh']]] as const) {
    const result = spawnSync(command, args, { cwd: fixture.root, encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
  }
}

test('the bootstrap builds into the ignored mirror and never writes the production build', () => {
  const fixture = makeFixture(false);
  const env = { ...process.env, PATH: fixture.path, TEST_ENV_CACHE_TTL_SECONDS: '600' };
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

test('a mirror without the e2e marker refuses live reuse and the build cache', () => {
  const fixture = makeFixture(false);
  const env = { ...process.env, PATH: fixture.path, TEST_ENV_CACHE_TTL_SECONDS: '600' };
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
    ...process.env,
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
  const env = { ...process.env, PATH: fixture.path, TEST_ENV_CACHE_TTL_SECONDS: '600' };
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

  const warm = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.match(warm.stdout, /TEST_ENV_REUSED=1/, `warm boot refused reuse:\n${warm.stderr}`);

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

test('the served clone never replaces a directory it did not create', () => {
  const fixture = makeFixture(false);
  const env = { ...process.env, PATH: fixture.path, E2E_PREBUILT_ASSETS: '1' };
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
  const env = { ...process.env, PATH: fixture.path, E2E_PREBUILT_ASSETS: '1' };
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
  const started = performance.now();
  const result = spawnSync('/bin/sh', [join(fixture.root, '.ai/scripts/test-env-up.sh')], {
    encoding: 'utf8', env: { ...fixture.env, TEST_ENV_HEALTH_TIMEOUT_SECONDS: '5' }, timeout: 9_000, killSignal: 'SIGKILL',
  });
  const elapsed = (performance.now() - started) / 1_000;
  const pid = requirePid(join(fixture.root, 'app.pid'));
  launchedPids.add(pid);
  assert.equal(result.status, 1, `launcher did not enforce its health deadline (${elapsed}s): ${result.stderr}`);
  assert.ok(elapsed >= 4 && elapsed < 8, `five-second health wait took ${elapsed}s`);
  // The launcher reports whole elapsed seconds, so a slow runner can print 6s for a 5s
  // deadline (#856). Bound it like `elapsed`: at least the deadline, never the 180s default.
  const reported = Number(result.stderr.match(/health wait timed out after (\d+)s/)?.[1]);
  assert.ok(reported >= 5 && reported < 8, `five-second health wait reported ${reported}s: ${result.stderr}`);
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
      encoding: 'utf8', env: { ...process.env, PATH: fixture.path, TEST_ENV_HEALTH_TIMEOUT_SECONDS: timeout },
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
      const env = { ...process.env, PATH: fixture.path, TEST_ENV_CACHE_TTL_SECONDS: '600', TEST_ENV_HEALTH_TIMEOUT_SECONDS: '5' };
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
  const env = { ...process.env, PATH: fixture.path, TEST_ENV_CACHE_TTL_SECONDS: '600' };
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
  const env = { ...process.env, PATH: fixture.path, TEST_ENV_CACHE_TTL_SECONDS: '600' };
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
  const env = { ...process.env, PATH: fixture.path, TEST_ENV_CACHE_TTL_SECONDS: '600' };
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
  const env = { ...process.env, PATH: fixture.path, TEST_ENV_CACHE_TTL_SECONDS: '600' };
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
