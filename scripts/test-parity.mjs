#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { globSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, matchesGlob, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function selectFiles(cwd) {
  return globSync('packages/**/*-parity.test.ts', {
    cwd, exclude: ['**/node_modules/**', '**/dist/**'],
  }).sort();
}

function installedCommand(command, cwd, run, platform) {
  if (platform !== 'win32') return true;
  // cmd.exe reports a missing shim as an exit code, not an ENOENT spawn error.
  const result = run('where.exe', [command], { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status === 1) return false;
  if (result.status !== 0) throw new Error('Cannot locate the Squeal command');
  return true;
}

function shellCommand(command, platform) {
  if (platform !== 'win32') return command;
  if (/["%]/.test(command)) {
    throw new Error('SQUEAL_BIN_DIR command paths cannot contain double quotes or percent signs on Windows');
  }
  return `"${command}"`;
}

function launchCommand(command, args, options, run, platform) {
  if (platform === 'win32' && args.some(arg => /[\s&|<>^()%!"]/.test(arg))) {
    throw new Error('Generated parity arguments cannot contain whitespace or cmd metacharacters on Windows');
  }
  return run(shellCommand(command, platform), args, { ...options, shell: platform === 'win32' });
}

// A readable store alone does not mean a daemon is validating this worktree.
export function detectDaemon(cwd, run = spawnSync, home = homedir(), env = process.env, platform = process.platform) {
  // Documented launcher: https://github.com/hearsay-tools/squeal#install (SQUEAL_BIN_DIR overrides ~/.local/bin).
  const candidates = ['squeal', join(env.SQUEAL_BIN_DIR ?? join(home, '.local/bin'), 'squeal')];
  for (const command of candidates) {
    if (!installedCommand(command, cwd, run, platform)) continue;
    const result = launchCommand(command, ['status', '--json'], {
      cwd, encoding: 'utf8',
    }, run, platform);
    if (result.error?.code === 'ENOENT') continue;
    if (result.error) throw result.error;
    const status = JSON.parse(result.stdout);
    if (status.available === false) return null;
    if (status.schemaVersion !== 1 || !status.daemon?.state) {
      throw new Error('Squeal returned an unsupported status shape');
    }
    if (resolve(status.worktreeRoot) !== resolve(cwd)) {
      throw new Error('Cannot confirm a Squeal daemon for this worktree');
    }
    if (status.daemon.stopped === true) return null;
    if (status.daemon.state === 'down' && status.daemon.since === null) return null;
    if (!['alive', 'down'].includes(status.daemon.state)) {
      throw new Error('Cannot confirm a Squeal daemon for this worktree');
    }
    // A registered daemon with a late heartbeat can still be busy.
    return command;
  }
  return null;
}

function verdictRows(files, status) {
  const entries = status.selection?.testFiles ?? [];
  return files.map(file => {
    const matches = entries.filter(entry => entry.path === file);
    const currentPass = matches.length > 0 && matches.every(entry =>
      entry.state === 'current' && entry.verdict === 'pass');
    const pending = matches.some(entry => entry.state === 'pending');
    const detail = matches.length ? matches.map(entry =>
      `${entry.state}/${entry.verdict ?? 'no verdict'}`).join(', ') : 'unknown/no verdict';
    const label = currentPass ? 'PASS'
      : matches.some(entry => entry.verdict === 'fail') ? 'FAIL'
        : pending ? 'PENDING' : 'UNKNOWN';
    return { file, label, detail, pending };
  });
}

export function reportVerdicts(files, status, log) {
  const rows = verdictRows(files, status);
  for (const { file, label, detail } of rows) log(`${label} ${file}: ${detail}`);
  return rows.every(row => row.label === 'PASS') ? 0 : 1;
}

// squeal.config.json's check group that holds the parity files until the agent pauses.
const PARITY_GROUP = 'run-loop';

// The files that `status --wait` does not start: they wait for the group's moment.
export function groupFiles(config, files) {
  const group = config.checks?.find(check => check.name === PARITY_GROUP && !check.lint);
  if (!group) return [];
  const globs = group.tests ?? ['**'];
  return files.filter(file => globs.some(glob => matchesGlob(file, glob)));
}

function askGroupRun(command, files, { cwd, run, platform }) {
  const result = launchCommand(command, ['run', PARITY_GROUP, ...files], {
    cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  }, run, platform);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`squeal run ${PARITY_GROUP} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
}

function waitForVerdicts(command, files, { cwd, run, log, now, platform }) {
  const config = JSON.parse(readFileSync(join(cwd, 'squeal.config.json'), 'utf8'));
  const cap = config.runner?.timeoutMs;
  if (!Number.isSafeInteger(cap) || cap <= 0) {
    throw new Error('squeal.config.json must give runner.timeoutMs as a positive integer');
  }
  const deadline = now() + cap + 5 * 60 * 1000;
  const held = groupFiles(config, files);
  let round = 0;
  while (true) {
    // Asked each round: an edit during the wait makes the group's files wait for a pause again.
    if (held.length) askGroupRun(command, held, { cwd, run, platform });
    const wait = Math.max(1, Math.min(60000, deadline - now()));
    const result = launchCommand(command, ['status', '--wait', String(wait), '--json', ...files], {
      cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    }, run, platform);
    if (result.error) throw result.error;
    const status = JSON.parse(result.stdout);
    const rows = verdictRows(files, status);
    const pass = rows.filter(row => row.label === 'PASS').length;
    const pending = rows.filter(row => row.pending).length;
    log(`[test:parity] round ${++round}: ${pass} pass, ${pending} pending`);
    if (pending === 0 || now() >= deadline) {
      const code = reportVerdicts(files, status, log);
      return result.status === 0 ? code : 1;
    }
  }
}

export function runParity({ cwd = process.cwd(), args = process.argv.slice(2),
  run = spawnSync, log = console.log, home = homedir(), now = Date.now, platform = process.platform } = {}) {
  if (args.some(arg => arg !== '--plan')) throw new Error('Use only --plan');
  const files = selectFiles(cwd);
  if (!files.length) throw new Error('No *-parity.test.ts files under packages/');
  const command = detectDaemon(cwd, run, home, process.env, platform);
  const mode = command ? 'squeal' : 'npm';
  if (args.includes('--plan')) {
    log(JSON.stringify({ mode, files }, null, 2));
    return 0;
  }
  log(`[test:parity] ${mode}: ${files.length} files`);
  if (!command) {
    const result = launchCommand(platform === 'win32' ? 'npm.cmd' : 'npm',
      ['test', '--', ...files], { cwd, stdio: 'inherit' }, run, platform);
    if (result.error) throw result.error;
    return result.status ?? 1;
  }
  return waitForVerdicts(command, files, { cwd, run, log, now, platform });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = runParity(); }
  catch (error) { console.error(`[test:parity] ${error.message}`); process.exitCode = 1; }
}
