#!/usr/bin/env node
// One-command local browser gate: one build, four independent app/browser lanes.
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
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

export function createLane({ repoRoot, scratchRoot, index, baseRef = 'HEAD' }) {
  const laneRoot = join(scratchRoot, `lane-${index}`);
  git(repoRoot, 'worktree', 'add', '--detach', laneRoot, baseRef);
  try {
    copyCurrentEdits(repoRoot, laneRoot, baseRef);
    linkBuiltAssets(repoRoot, laneRoot);
    return laneRoot;
  } catch (error) {
    removeLane({ repoRoot, laneRoot });
    throw error;
  }
}

export function removeLane({ repoRoot, laneRoot }) {
  if (!existsSync(laneRoot)) return;
  // Browser specs can create Cezar task worktrees below the lane. Removing the parent first
  // leaves their Git registrations behind, pointing at paths that no longer exist.
  const descendants = git(repoRoot, 'worktree', 'list', '--porcelain', '-z').toString('utf8')
    .split('\0\0').filter(Boolean)
    .map((record) => {
      const fields = record.split('\0');
      return {
        path: fields.find((field) => field.startsWith('worktree '))?.slice('worktree '.length),
        branch: fields.find((field) => field.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length),
      };
    })
    .filter((entry) => entry.path?.startsWith(`${laneRoot}${sep}`))
    .sort((a, b) => b.path.length - a.path.length);
  for (const entry of descendants) {
    git(repoRoot, 'worktree', 'remove', '--force', entry.path);
    if (entry.branch) git(repoRoot, 'branch', '-D', '--', entry.branch);
  }
  git(repoRoot, 'worktree', 'remove', '--force', laneRoot);
}

async function runProcess(command, args, { cwd, env, logPath, running }) {
  const output = openSync(logPath, 'w');
  try {
    return await new Promise((resolveRun, rejectRun) => {
      const child = spawn(command, args, {
        cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', output, output],
      });
      running.add(child);
      child.once('error', rejectRun);
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
  if (!existsSync(join(repoRoot, 'node_modules/zod/package.json'))) {
    execFileSync('npm', ['ci'], { cwd: repoRoot, stdio: 'inherit' });
  }
  execFileSync('npm', ['run', 'build'], {
    cwd: repoRoot, env: { ...process.env, VITE_CEZ_E2E: '1' }, stdio: 'inherit',
  });
}

export async function runLocalSuite({ repoRoot = ownRoot, scratchRoot, buildSource: prepareBuild = buildSource } = {}) {
  const scratch = scratchRoot ?? mkdtempSync(join(tmpdir(), 'cez-e2e-lanes-'));
  mkdirSync(scratch, { recursive: true });
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
    for (const lane of [...lanes].reverse()) {
      try { retainEvidence(lane, logDir); } catch (error) { process.stderr.write(`E2E evidence: ${error}\n`); }
      try {
        await runProcess('sh', ['.ai/scripts/test-env-down.sh'], {
          cwd: lane.root, env: lane.env, logPath: join(logDir, `lane-${lane.index}-down.log`), running,
        });
      } catch (error) { process.stderr.write(`E2E teardown: ${error}\n`); }
      removeLane({ repoRoot, laneRoot: lane.root });
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runLocalSuite();
    for (const lane of result.lanes) process.stdout.write(`lane ${lane.shard}: ${lane.status} (${lane.logPath})\n`);
    process.stdout.write(`E2E lane logs: ${result.logDir}\nTEST_E2E_STATUS=${result.status}\n`);
    if (result.status === 'failed') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error}\nTEST_E2E_STATUS=failed\n`);
    process.exitCode = 1;
  }
}
