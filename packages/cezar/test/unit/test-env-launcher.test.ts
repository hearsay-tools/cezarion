import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
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

for (const withSetsid of [true, false]) {
  test(
    `generated launcher survives its caller and stops by descriptor PID (${withSetsid ? 'setsid' : 'nohup fallback'})`,
    { skip: withSetsid && !hasSetsid ? 'setsid is not available on this platform' : false },
    async () => {
      const fixture = makeFixture(withSetsid);
      const env = { ...process.env, PATH: fixture.path, TEST_ENV_CACHE_TTL_SECONDS: '600' };
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

