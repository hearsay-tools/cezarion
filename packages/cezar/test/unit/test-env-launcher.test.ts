import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';

// The scripts under test are the REPO's, not this package's: `.ai/` is agent-pipeline tooling
// that spans every workspace, so it stays at the root.
const repoRoot = resolve(import.meta.dirname, '../../../..');
const fixtures: string[] = [];
const launchedPids = new Set<number>();

afterEach(() => {
  for (const pid of launchedPids) {
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
  writeFileSync(join(root, '.ai/browsers/agent-browser.md'), '# test provider\n');
  writeFileSync(join(root, 'package.json'), '{"private":true}\n');
  writeFileSync(join(root, 'package-lock.json'), '{}\n');
  // Backdate tracked sources so the #31 warm-reuse assertion never depends on
  // how fast the cold boot was relative to these writes.
  const safelyBeforeBoot = new Date(Date.now() - 30_000);
  utimesSync(join(root, 'package.json'), safelyBeforeBoot, safelyBeforeBoot);
  utimesSync(join(root, 'package-lock.json'), safelyBeforeBoot, safelyBeforeBoot);

  const commands = ['cat', 'chmod', 'curl', 'date', 'dirname', 'find', 'grep', 'id', 'kill', 'mkdir', 'mv', 'nohup', 'pwd', 'rm', 'sh', 'sleep', 'tail', 'uname'];
  if (withSetsid) commands.push('setsid');
  for (const command of commands) symlinkSync(commandPath(command), join(root, 'bin', command));
  symlinkSync(process.execPath, join(root, 'bin/node'));

  writeFileSync(
    join(root, 'bin/npm'),
    // Writes the same artifacts the real preparation chain produces, at the same paths —
    // the up script asserts on them by name (BUILD_ARTIFACTS), so this stub has to follow
    // the workspace layout rather than invent its own.
    `#!/bin/sh
set -eu
mkdir -p node_modules/zod packages/cezar/dist packages/cezar/web/dist
if [ "\${1-}" = run ] && [ "\${2-}" = build ]; then
  printf 'build\\n' >> .ai/build-invocations
  rm -f packages/cezar/web/dist/.cez-e2e-build
  if [ "\${VITE_CEZ_E2E-}" = 1 ]; then
    printf 'e2e\\n' > packages/cezar/web/dist/.cez-e2e-build
  fi
fi
printf '{"name":"zod"}' > node_modules/zod/package.json
cat > packages/cezar/dist/index.js <<'EOF'
const http = require('node:http');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': req.url === '/api/health' ? 'application/json' : 'text/html' });
  res.end(req.url === '/api/health' ? '{"ok":true}' : '<!doctype html>');
}).listen(port, '127.0.0.1');
EOF
printf '<!doctype html>' > packages/cezar/web/dist/index.html
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
  return { root, path: join(root, 'bin') };
}

test('a production web rebuild invalidates both live reuse and the build cache', () => {
  const fixture = makeFixture(false);
  const env = { ...process.env, PATH: fixture.path, TEST_ENV_CACHE_TTL_SECONDS: '600' };
  const up = join(fixture.root, '.ai/scripts/test-env-up.sh');
  const down = join(fixture.root, '.ai/scripts/test-env-down.sh');
  const npm = join(fixture.root, 'bin/npm');
  const builds = () => readFileSync(join(fixture.root, '.ai/build-invocations'), 'utf8').trim().split('\n').length;
  const productionBuild = () => {
    const result = spawnSync(npm, ['run', 'build'], { cwd: fixture.root, encoding: 'utf8', env: { ...env, VITE_CEZ_E2E: '' } });
    assert.equal(result.status, 0, result.stderr);
  };

  const cold = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(cold.status, 0, cold.stderr);
  const first = descriptor(fixture.root);
  launchedPids.add(first.app.pid);
  assert.equal(builds(), 1);

  const valid = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /TEST_ENV_REUSED=1/);
  assert.equal(builds(), 1);

  productionBuild();
  const liveOverwrite = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(liveOverwrite.status, 0, liveOverwrite.stderr);
  assert.match(liveOverwrite.stdout, /TEST_ENV_REUSED=0/);
  assert.equal(builds(), 3);
  launchedPids.delete(first.app.pid);
  const second = descriptor(fixture.root);
  launchedPids.add(second.app.pid);

  const stopped = spawnSync('/bin/sh', [down], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(stopped.status, 0, stopped.stderr);
  launchedPids.delete(second.app.pid);
  productionBuild();
  const stoppedOverwrite = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(stoppedOverwrite.status, 0, stoppedOverwrite.stderr);
  assert.match(stoppedOverwrite.stdout, /TEST_ENV_REUSED=0/);
  assert.equal(builds(), 5);
  const third = descriptor(fixture.root);
  launchedPids.add(third.app.pid);
  spawnSync('/bin/sh', [down], { encoding: 'utf8', env, timeout: 20_000 });
  launchedPids.delete(third.app.pid);
});

test('a prebuilt lane boots without rebuilding shared assets and records its namespace', () => {
  const fixture = makeFixture(false);
  const env = {
    ...process.env,
    PATH: fixture.path,
    E2E_PREBUILT_ASSETS: '1',
    E2E_BROWSER_NAMESPACE: 'cez-e2e-lane-2',
  };
  const npm = join(fixture.root, 'bin/npm');
  const built = spawnSync(npm, ['run', 'build'], {
    cwd: fixture.root, encoding: 'utf8', env: { ...env, VITE_CEZ_E2E: '1' },
  });
  assert.equal(built.status, 0, built.stderr);
  rmSync(join(fixture.root, '.ai/build-invocations'));

  const up = spawnSync('/bin/sh', [join(fixture.root, '.ai/scripts/test-env-up.sh')], {
    encoding: 'utf8', env, timeout: 20_000,
  });
  assert.equal(up.status, 0, up.stderr);
  assert.equal(descriptor(fixture.root).browser.namespace, 'cez-e2e-lane-2');
  assert.equal(descriptor(fixture.root).browser.installed, true);
  assert.equal(spawnSync('/bin/sh', ['-c', 'test ! -e .ai/build-invocations'], { cwd: fixture.root }).status, 0);
  launchedPids.add(descriptor(fixture.root).app.pid);
  spawnSync('/bin/sh', [join(fixture.root, '.ai/scripts/test-env-down.sh')], { encoding: 'utf8', env, timeout: 20_000 });
  launchedPids.delete(descriptor(fixture.root).app.pid);
});

function descriptor(root: string): {
  baseUrl: string;
  app: { pid: number };
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
    app: { pid: number };
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

function unhealthyFixture(mode: 'stalled' | 'unavailable' | 'exited') {
  const fixture = makeFixture(false);
  const env = { ...process.env, PATH: fixture.path, E2E_PREBUILT_ASSETS: '1' };
  const built = spawnSync(join(fixture.root, 'bin/npm'), ['run', 'build'], {
    cwd: fixture.root, encoding: 'utf8', env: { ...env, VITE_CEZ_E2E: '1' },
  });
  assert.equal(built.status, 0, built.stderr);
  writeFileSync(join(fixture.root, 'packages/cezar/dist/index.js'), `
const fs = require('node:fs');
fs.writeFileSync('app.pid', String(process.pid));
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
  const pid = Number(readFileSync(join(fixture.root, 'app.pid'), 'utf8'));
  launchedPids.add(pid);
  assert.equal(result.status, 1, `launcher did not enforce its health deadline (${elapsed}s): ${result.stderr}`);
  assert.ok(elapsed >= 4 && elapsed < 8, `five-second health wait took ${elapsed}s`);
  assert.match(result.stderr, /health wait timed out after 5s/);
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
  if (existsSync(join(fixture.root, 'app.pid'))) {
    launchedPids.add(Number(readFileSync(join(fixture.root, 'app.pid'), 'utf8')));
  }
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

for (const timeout of ['0', '-1', '1.5', 'invalid']) {
  test(`malformed health timeout ${timeout} is rejected before starting the app`, () => {
    const fixture = makeFixture(false);
    const result = spawnSync('/bin/sh', [join(fixture.root, '.ai/scripts/test-env-up.sh')], {
      encoding: 'utf8', env: { ...process.env, PATH: fixture.path, TEST_ENV_HEALTH_TIMEOUT_SECONDS: timeout },
      timeout: 9_000, killSignal: 'SIGKILL',
    });
    // Track the app for cleanup if a regressed launcher incorrectly accepts the value.
    if (result.status === 0) launchedPids.add(descriptor(fixture.root).app.pid);
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
        ? ['/bin/sh', '-c', 'echo $$ > "$2"; sh "$1"', 'launcher-parent', up, callerPidFile]
        : ['-c', 'echo $$ > "$2"; sh "$1"', 'launcher-parent', up, callerPidFile];
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
        const callerPid = Number(readFileSync(callerPidFile, 'utf8').trim());
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
