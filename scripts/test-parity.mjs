#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function selectFiles(cwd) {
  return globSync('packages/**/*-parity.test.ts', {
    cwd, exclude: ['**/node_modules/**', '**/dist/**'],
  }).sort();
}

// A readable store alone does not mean a daemon is validating this worktree.
export function detectDaemon(cwd, run = spawnSync, home = homedir()) {
  const candidates = ['squeal', join(home, '.local/bin/squeal'),
    join(home, '.codex/plugins/data/squeal-hearsay/bin/squeal')];
  for (const command of candidates) {
    const result = run(command, ['status', '--json'], { cwd, encoding: 'utf8' });
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

export function reportVerdicts(files, status, log) {
  const entries = status.selection?.testFiles ?? [];
  let passed = true;
  for (const file of files) {
    const matches = entries.filter(entry => entry.path === file);
    const currentPass = matches.length > 0 && matches.every(entry =>
      entry.state === 'current' && entry.verdict === 'pass');
    const detail = matches.length ? matches.map(entry =>
      `${entry.state}/${entry.verdict ?? 'no verdict'}`).join(', ') : 'unknown/no verdict';
    log(`${currentPass ? 'PASS' : 'FAIL'} ${file}: ${detail}`);
    passed = passed && currentPass;
  }
  return passed ? 0 : 1;
}

export function runParity({ cwd = process.cwd(), args = process.argv.slice(2),
  run = spawnSync, log = console.log, home = homedir() } = {}) {
  if (args.some(arg => arg !== '--plan')) throw new Error('Use only --plan');
  const files = selectFiles(cwd);
  if (!files.length) throw new Error('No *-parity.test.ts files under packages/');
  const command = detectDaemon(cwd, run, home);
  const mode = command ? 'squeal' : 'npm';
  if (args.includes('--plan')) {
    log(JSON.stringify({ mode, files }, null, 2));
    return 0;
  }
  log(`[test:parity] ${mode}: ${files.length} files`);
  if (!command) {
    const result = run(process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['test', '--', ...files], { cwd, stdio: 'inherit' });
    if (result.error) throw result.error;
    return result.status ?? 1;
  }
  const result = run(command, ['status', '--wait', '60000', '--json', ...files], {
    cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const code = reportVerdicts(files, JSON.parse(result.stdout), log);
  return result.status === 0 ? code : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = runParity(); }
  catch (error) { console.error(`[test:parity] ${error.message}`); process.exitCode = 1; }
}
