#!/usr/bin/env node
// One-command local browser gate: one build, four independent app/browser lanes.
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ownRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const COUNT = 4;

function git(repoRoot, ...args) {
  return execFileSync('git', ['-C', repoRoot, ...args]);
}

function changedPaths(repoRoot, baseRef) {
  const changed = git(repoRoot, 'diff', '--no-renames', '--name-only', '-z', baseRef);
  const untracked = git(repoRoot, 'ls-files', '--others', '--exclude-standard', '-z');
  return new Set(Buffer.concat([changed, untracked]).toString('utf8').split('\0').filter(Boolean));
}

function copyCurrentEdits(repoRoot, laneRoot, baseRef) {
  for (const relative of changedPaths(repoRoot, baseRef)) {
    const source = join(repoRoot, relative);
    const target = join(laneRoot, relative);
    rmSync(target, { recursive: true, force: true });
    let stat;
    try { stat = lstatSync(source); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    mkdirSync(dirname(target), { recursive: true });
    if (stat.isSymbolicLink()) symlinkSync(readlinkSync(source), target);
    else cpSync(source, target, { recursive: true, preserveTimestamps: true });
  }
}

function linkBuiltAssets(repoRoot, laneRoot) {
  for (const relative of ['node_modules', 'packages/cezar/dist', 'packages/cezar/web/dist']) {
    const source = join(repoRoot, relative);
    if (!existsSync(source)) throw new Error(`missing shared E2E asset: ${source}`);
    const target = join(laneRoot, relative);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(source, target, 'dir');
  }
}

// Project only public fixture metadata. Never copy host config, credentials or hooks.
function configEntries(repoRoot, pattern, scope) {
  let output;
  try { output = git(repoRoot, 'config', ...(scope ? [`--${scope}`] : []), '--null', '--get-regexp', pattern).toString('utf8'); }
  catch (error) {
    if (error.status === 1) return [];
    throw new Error('cannot inspect E2E Git metadata');
  }
  return output.split('\0').filter(Boolean).map((entry) => {
    const split = entry.indexOf('\n');
    return [entry.slice(0, split), entry.slice(split + 1)];
  });
}

function publicRemote(value) {
  if (/[\r\n\0]/.test(value) || value.includes('::')) return false;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return true; // local path or SCP spelling
  try {
    const url = new URL(value);
    return ['https:', 'http:', 'ssh:', 'git:', 'file:'].includes(url.protocol) &&
      !url.password && !url.search && !url.hash &&
      (!url.username || url.protocol === 'ssh:');
  } catch { return false; }
}

function effectiveRemoteUrls(repoRoot, name, push = false) {
  let output;
  try {
    output = execFileSync('git', ['-C', repoRoot, 'remote', 'get-url', ...(push ? ['--push'] : []), '--all', name],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { throw new Error('cannot resolve effective E2E remote metadata'); }
  const urls = output.replace(/\n$/, '').split('\n');
  if (urls.some(url => !url || !publicRemote(url))) {
    throw new Error('E2E remote metadata must use public URLs without credentials');
  }
  return urls;
}

function laneMetadata(repoRoot) {
  const common = git(repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir').toString('utf8').trim();
  const attributes = join(common, 'info/attributes');
  if (existsSync(attributes) && readFileSync(attributes, 'utf8').split(/\r?\n/).some(line => !/^\s*(?:#.*)?$/.test(line))) {
    throw new Error('unsupported E2E checkout info attributes; cannot faithfully isolate the lane');
  }
  // These can transform checkout contents or execute commands outside a fixture.
  const unsupported = configEntries(repoRoot, '^(filter\\..*\\.(clean|smudge|process|required)|core\\.(hookspath|attributesfile|excludesfile|sparsecheckout))$');
  if (unsupported.some(([key, value]) => key !== 'core.sparsecheckout' || !/^(false|no|off|0)$/i.test(value))) {
    throw new Error('unsupported E2E checkout configuration; cannot faithfully isolate the lane');
  }
  const pattern = '^remote\\..*\\.(url|pushurl|fetch)$';
  const remotes = configEntries(repoRoot, pattern, 'local');
  // Worktree config belongs to this checkout too; read it only when enabled, since
  // Git otherwise aliases --worktree to --local and would duplicate each entry.
  let worktreeConfig = false;
  try { worktreeConfig = git(repoRoot, 'config', '--local', '--bool', '--get', 'extensions.worktreeConfig').toString('utf8').trim() === 'true'; }
  catch (error) { if (error.status !== 1) throw new Error('cannot inspect E2E Git metadata'); }
  if (worktreeConfig) remotes.push(...configEntries(repoRoot, pattern, 'worktree'));
  const names = new Set(remotes.map(([key]) => key.slice(7, key.lastIndexOf('.'))));
  // get-url includes inherited same-name declarations. Inspect only their names
  // and scopes, never their values, and refuse ambiguous resolution before copying.
  let scopedNames = [];
  try { scopedNames = git(repoRoot, 'config', '--null', '--show-scope', '--name-only', '--get-regexp', '^remote\\..*\\.(url|pushurl)$').toString('utf8').split('\0').filter(Boolean); }
  catch (error) { if (error.status !== 1) throw new Error('cannot inspect E2E Git metadata'); }
  for (let index = 0; index < scopedNames.length; index += 2) {
    const [scope, key] = scopedNames.slice(index, index + 2);
    if (scope !== 'local' && scope !== 'worktree' && names.has(key.slice(7, key.lastIndexOf('.')))) {
      throw new Error('unsupported inherited E2E remote declaration; cannot isolate repository metadata');
    }
  }
  if (remotes.some(([key, value]) => /\.(url|pushurl)$/.test(key) && !publicRemote(value))) {
    throw new Error('E2E remote metadata must use public URLs without credentials');
  }
  // Resolve Git's insteadOf/pushInsteadOf rules without copying rewrite configuration.
  const effective = new Map();
  for (const name of names) {
    effective.set(name, { fetch: effectiveRemoteUrls(repoRoot, name), push: effectiveRemoteUrls(repoRoot, name, true) });
  }
  const core = configEntries(repoRoot, '^core\\.(autocrlf|eol|symlinks|filemode|ignorecase|precomposeunicode)$');
  const symbolic = git(repoRoot, 'for-each-ref', '--format=%(refname) %(symref)').toString('utf8')
    .trim().split('\n').map(line => line.trim().split(' ')).filter(parts => parts.length === 2);
  return { remotes, core, symbolic, effective };
}

export function createLane({ repoRoot, scratchRoot, index, baseRef = 'HEAD' }) {
  const laneRoot = join(scratchRoot, `lane-${index}`);
  const source = realpathSync(repoRoot);
  const base = git(repoRoot, 'rev-parse', '--verify', `${baseRef}^{commit}`).toString('utf8').trim();
  const metadata = laneMetadata(repoRoot);
  mkdirSync(scratchRoot, { recursive: true });
  mkdirSync(laneRoot); // Exclusive reservation: failure cleanup never owns a preexisting path.
  try {
    // #795: linked worktrees share the host's 120s mutation queue. Each lane needs its
    // own administration AND objects, including when the source borrows alternates.
    execFileSync('git', ['clone', '--template=', '--mirror', '--no-hardlinks', '--dissociate', '--quiet', source, join(laneRoot, '.git')]);
    git(laneRoot, 'config', 'core.bare', 'false');
    // remote remove would delete the mirrored tracking refs as well as the config.
    git(laneRoot, 'config', '--remove-section', 'remote.origin');
    for (const [key, value] of metadata.core) git(laneRoot, 'config', '--replace-all', key, value);
    for (const [key, value] of metadata.remotes) {
      git(laneRoot, 'config', '--add', key, value);
    }
    for (const [name, expected] of metadata.effective) {
      // Keep literal public spelling when inherited rules already preserve its meaning.
      // Otherwise materialize safe effective URLs; never copy rewrite configuration.
      for (const [field, push] of [['fetch', false], ['push', true]]) {
        if (JSON.stringify(effectiveRemoteUrls(laneRoot, name, push)) === JSON.stringify(expected[field])) continue;
        const key = `remote.${name}.${push ? 'pushurl' : 'url'}`;
        try { git(laneRoot, 'config', '--unset-all', key); } catch (error) { if (error.status !== 5) throw error; }
        for (const url of expected[field]) git(laneRoot, 'config', '--add', key, url);
      }
      // A global rewrite may apply again to an already-resolved URL. Refuse that drift.
      if (JSON.stringify(effectiveRemoteUrls(laneRoot, name)) !== JSON.stringify(expected.fetch) ||
          JSON.stringify(effectiveRemoteUrls(laneRoot, name, true)) !== JSON.stringify(expected.push)) {
        throw new Error('unsupported effective E2E remote rewrite; cannot faithfully isolate the lane');
      }
    }
    for (const [name, target] of metadata.symbolic) git(laneRoot, 'symbolic-ref', name, target);
    if (existsSync(join(laneRoot, '.git/objects/info/alternates'))) {
      throw new Error('E2E lane still depends on borrowed Git objects');
    }
    git(laneRoot, 'checkout', '--quiet', '--detach', base);
    writeFileSync(join(laneRoot, '.git/cezar-e2e-lane.json'), JSON.stringify({
      version: 1, source, root: realpathSync(laneRoot),
    }), { flag: 'wx' });
    copyCurrentEdits(repoRoot, laneRoot, base);
    linkBuiltAssets(repoRoot, laneRoot);
    return laneRoot;
  } catch (error) {
    rmSync(laneRoot, { recursive: true, force: true });
    throw error;
  }
}

export function removeLane({ repoRoot, laneRoot }) {
  if (!existsSync(laneRoot)) return;
  if (!lstatSync(laneRoot).isDirectory() || lstatSync(laneRoot).isSymbolicLink()) {
    throw new Error('refusing cleanup of an unowned E2E Git directory');
  }
  const root = realpathSync(laneRoot);
  const administration = join(root, '.git');
  if (!lstatSync(administration).isDirectory() || lstatSync(administration).isSymbolicLink()) {
    throw new Error('refusing cleanup of an unowned E2E Git directory');
  }
  const owner = JSON.parse(readFileSync(join(administration, 'cezar-e2e-lane.json'), 'utf8'));
  if (owner.version !== 1 || owner.root !== root || owner.source !== realpathSync(repoRoot) ||
      realpathSync(git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir').toString('utf8').trim()) !== administration) {
    throw new Error('refusing cleanup of an unowned E2E Git directory');
  }
  const registered = git(root, 'worktree', 'list', '--porcelain', '-z').toString('utf8')
    .split('\0\0').filter(Boolean)
    .map((record) => {
      const fields = record.split('\0');
      return {
        path: fields.find((field) => field.startsWith('worktree '))?.slice('worktree '.length),
        branch: fields.find((field) => field.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length),
      };
    });
  if (registered.some(entry => !entry.path || (entry.path !== root &&
      (!entry.path.startsWith(`${root}${sep}`) || (existsSync(entry.path) && !realpathSync(entry.path).startsWith(`${root}${sep}`)))))) {
    throw new Error('refusing cleanup of an E2E lane with an outside worktree');
  }
  for (const entry of registered.filter(entry => entry.path !== root).sort((a, b) => b.path.length - a.path.length)) {
    git(root, 'worktree', 'remove', '--force', entry.path);
    if (entry.branch) git(root, 'branch', '-D', '--', entry.branch);
  }
  rmSync(root, { recursive: true, force: true });
}

async function runProcess(command, args, { cwd, env, logPath, running }) {
  const output = openSync(logPath, 'w');
  try {
    return await new Promise((resolveRun, rejectRun) => {
      const child = spawn(command, args, {
        cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', output, output],
      });
      running.add(child);
      child.once('error', (error) => { running.delete(child); rejectRun(error); });
      child.once('close', (code, signal) => {
        running.delete(child);
        resolveRun(signal ? 1 : code ?? 1);
      });
    });
  } finally {
    closeSync(output);
  }
}

function terminateChildren(running) {
  for (const child of running) {
    if (!child.pid) continue;
    try {
      if (process.platform === 'win32') child.kill('SIGTERM');
      else process.kill(-child.pid, 'SIGTERM');
    } catch { /* already exited */ }
  }
}

function retainEvidence(lane, logDir) {
  const qa = join(lane.root, '.ai/qa');
  for (const name of ['test-env.json', 'test-env-app.log', 'test-env-build.log']) {
    const source = join(qa, name);
    if (existsSync(source)) copyFileSync(source, join(logDir, `lane-${lane.index}-${name}`));
  }
  const failures = join(qa, 'failures');
  if (existsSync(failures)) cpSync(failures, join(logDir, `lane-${lane.index}-failures`), { recursive: true });
}

export function buildSource(repoRoot) {
  // Windows exposes npm as a .cmd shim, which execFileSync cannot launch directly.
  const npmOptions = { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' };
  if (!existsSync(join(repoRoot, 'node_modules/zod/package.json'))) {
    execFileSync('npm', ['ci'], npmOptions);
  }
  execFileSync('npm', ['run', 'build'], {
    ...npmOptions, env: { ...process.env, VITE_CEZ_E2E: '1' },
  });
}

export async function runLocalSuite({ repoRoot = ownRoot, scratchRoot, buildSource: prepareBuild = buildSource } = {}) {
  const scratch = scratchRoot ?? mkdtempSync(join(tmpdir(), 'cez-e2e-lanes-'));
  if (scratchRoot) mkdirSync(scratch); // Refuse foreign state before build or teardown can claim it.
  const runId = `${Date.now()}-${process.pid}`;
  // Keep the namespace no longer than the serial runner's `cez-e2e`: Chrome's Unix socket
  // path includes both namespace and the test's session name, and GitHub specs nearly fill it.
  const browserRunId = randomBytes(4).readUInt32BE(0) & 0xfffffffc;
  const logDir = join(repoRoot, '.ai/qa/local-runs', runId);
  mkdirSync(logDir, { recursive: true });
  const lanes = [];
  const running = new Set();
  let interrupted = false;
  const interrupt = () => { interrupted = true; terminateChildren(running); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    await prepareBuild(repoRoot);
    for (const relative of ['node_modules/zod/package.json', 'packages/cezar/dist/index.js', 'packages/cezar/web/dist/index.html', 'packages/cezar/web/dist/.cez-e2e-build']) {
      if (!existsSync(join(repoRoot, relative))) throw new Error(`E2E build did not provide ${relative}`);
    }
    const baseRef = git(repoRoot, 'rev-parse', 'HEAD').toString('utf8').trim();

    // Boot sequentially: the first lane installs the browser provider once before peers use it.
    for (let index = 1; index <= COUNT; index += 1) {
      if (interrupted) throw new Error('local E2E run interrupted');
      const root = createLane({ repoRoot, scratchRoot: scratch, index, baseRef });
      const namespace = (browserRunId + index - 1).toString(36).padStart(7, '0');
      const env = { ...process.env, E2E_PREBUILT_ASSETS: '1', E2E_BROWSER_NAMESPACE: namespace };
      const lane = { index, root, namespace, shard: `${index}/${COUNT}`, env,
        logPath: join(logDir, `lane-${index}.log`), bootLogPath: join(logDir, `lane-${index}-boot.log`), status: 'failed' };
      lanes.push(lane);
      const bootExit = await runProcess('sh', ['.ai/scripts/test-env-up.sh'], {
        cwd: root, env, logPath: lane.bootLogPath, running,
      });
      if (bootExit !== 0) throw new Error(`lane ${index} boot failed; see ${lane.bootLogPath}`);
      const descriptor = JSON.parse(readFileSync(join(root, '.ai/qa/test-env.json'), 'utf8'));
      lane.baseUrl = descriptor.baseUrl;
      lane.browser = descriptor.browser;
      if (!descriptor.browser?.installed) {
        lane.status = 'skipped';
        return { status: 'skipped', lanes, logDir };
      }
      if (lanes.slice(0, -1).some((other) => other.baseUrl === lane.baseUrl)) {
        throw new Error(`lane ${index} reused another lane's port`);
      }
    }

    await Promise.all(lanes.map(async (lane) => {
      const exit = await runProcess('sh', ['.ai/scripts/e2e.sh', `--shard=${lane.shard}`], {
        cwd: lane.root, env: lane.env, logPath: lane.logPath, running,
      });
      const output = readFileSync(lane.logPath, 'utf8');
      lane.status = exit !== 0 ? 'failed'
        : /(?:^|\n)TEST_E2E_STATUS=passed(?:\n|$)/.test(output) ? 'passed'
        : /(?:^|\n)TEST_E2E_STATUS=skipped(?:\n|$)/.test(output) ? 'skipped'
        : 'failed';
    }));
    return { status: lanes.some((lane) => lane.status === 'failed') || interrupted ? 'failed'
      : lanes.some((lane) => lane.status === 'skipped') ? 'skipped' : 'passed', lanes, logDir };
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    terminateChildren(running);
    const teardownFailures = [];
    let retainedLane = false;
    for (const lane of [...lanes].reverse()) {
      try { retainEvidence(lane, logDir); } catch (error) { process.stderr.write(`E2E evidence: ${error}\n`); }
      if (lane.browser?.installed && lane.browser.command) {
        try {
          const exit = await runProcess(lane.browser.command, ['--namespace', lane.namespace, 'close', '--all'], {
            cwd: lane.root, env: { ...lane.env, ...lane.browser.runtimeEnv },
            logPath: join(logDir, `lane-${lane.index}-browser-down.log`), running,
          });
          if (exit !== 0) teardownFailures.push(`lane ${lane.index} browser close failed (exit ${exit})`);
        } catch (error) { teardownFailures.push(`lane ${lane.index} browser close failed: ${error}`); }
      }
      try {
        const exit = await runProcess('sh', ['.ai/scripts/test-env-down.sh'], {
          cwd: lane.root, env: lane.env, logPath: join(logDir, `lane-${lane.index}-down.log`), running,
        });
        if (exit !== 0) throw new Error(`exit ${exit}`);
        removeLane({ repoRoot, laneRoot: lane.root });
      } catch (error) {
        retainedLane = true;
        teardownFailures.push(`lane ${lane.index} server stop failed: ${error}`);
      }
    }
    if (!retainedLane) rmSync(scratch, { recursive: true, force: true });
    if (teardownFailures.length) throw new Error(`${teardownFailures.join('; ')}${retainedLane ? `; retained lanes in ${scratch}` : ''}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runLocalSuite();
    for (const lane of result.lanes) process.stdout.write(`lane ${lane.shard}: ${lane.status} (${lane.logPath})\n`);
    process.stdout.write(`E2E lane logs: ${result.logDir}\nTEST_E2E_STATUS=${result.status}\n`);
    // This command is the final local full-suite gate: a skipped browser is unverified.
    if (result.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error}\nTEST_E2E_STATUS=failed\n`);
    process.exitCode = 1;
  }
}
