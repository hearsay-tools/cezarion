#!/usr/bin/env node
// One local gate before a PR opens (spec: .ai/specs/2026-11-11-one-full-run-delivery-pipeline.md,
// § Before the PR). It reads Squeal's results for the changed files and for lint, and runs
// what Squeal does not cover: typecheck, citations and clones. CI runs everything else.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const { isDocsPath } = createRequire(import.meta.url)('../.github/scripts/change-surface.cjs');

export const SQUEAL_WAIT_MS = 120_000;

/** Judge one `squeal status --wait <ms> <paths> --json` result (exit code and parsed stdout). */
export function judgeSqueal(exitCode, status, ignorePath = () => false) {
  const selection = status?.selection ?? {};
  // Browser specs are CI's: Squeal runs them only on request.
  const files = (selection.testFiles ?? []).filter(f => !f.path.endsWith('.e2e.ts'));
  const unmatched = (selection.unmatched ?? []).map(u => u?.path ?? String(u)).filter(p => !ignorePath(p));
  const failed = files.filter(f => f.state === 'current' && !['pass', 'skip'].includes(f.verdict)).map(f => f.path);
  const failures = selection.verdict?.failures ?? {};
  if (exitCode === 1 || failed.length || failures.tests || failures.testFiles || failures.setups) {
    return { state: 'fail', failed, missing: [], lint: lintOf(status) };
  }
  const missing = [...files.filter(f => f.state !== 'current').map(f => f.path), ...unmatched.map(p => `${p} (selects no test file)`)];
  const lint = lintOf(status);
  if (lint.failing) return { state: 'fail', failed: [], missing, lint };
  return { state: missing.length || lint.unfinished ? 'incomplete' : 'pass', failed: [], missing, lint, count: files.length };
}

function lintOf(status) {
  const l = status?.lint;
  if (!l) return { failing: 0, unfinished: 1 };
  if (l.off || l.failed || l.unreadable) return { failing: l.failing ?? 0, unfinished: 1, unavailable: String(l.off ?? l.failed ?? l.unreadable) };
  const notDone = Math.max(0, (l.linting?.total ?? 0) - (l.linting?.done ?? 0));
  return { failing: l.failing ?? 0, unfinished: (l.pending ?? 0) + (l.stale ?? 0) + (l.unknown ?? 0) + notDone };
}

/** True when the parsed status shows a live Squeal daemon for this worktree. */
export function daemonAlive(status) {
  return status?.available === true && status?.daemon?.state === 'alive';
}

function run(cmd, args, options = {}) {
  return new Promise(resolve => {
    const win = process.platform === 'win32';
    const child = spawn(win && cmd === 'npm' ? 'npm.cmd' : cmd, args, { shell: win, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => resolve({ code: 127, out, err: err + String(e) }));
    child.on('close', code => resolve({ code: code ?? 1, out, err }));
  });
}

const tail = (text, n = 15) => text.trim().split('\n').slice(-n).join('\n');

function changedFiles(base) {
  const git = (...a) => spawnSync('git', a, { encoding: 'utf8' });
  const mergeBase = git('merge-base', base, 'HEAD').stdout.trim() || base;
  const tracked = git('diff', '--name-only', '--no-renames', mergeBase).stdout;
  const untracked = git('ls-files', '--others', '--exclude-standard').stdout;
  return [...new Set(`${tracked}\n${untracked}`.split('\n').filter(Boolean))];
}

async function squealChecks(paths, waitMs) {
  const wait = await run('squeal', ['status', '--wait', String(waitMs), '--json', ...paths]);
  let status;
  try { status = JSON.parse(wait.out); } catch { status = undefined; }
  if (wait.code === 127 || !daemonAlive(status)) return { daemon: false };
  return { daemon: true, ...judgeSqueal(wait.code, status, p => p.endsWith('.e2e.ts') || isDocsPath(p)) };
}

// Without a daemon: the focused tests only when the selection is not the full suite.
async function focusedTests(base) {
  const baseArg = `--base=${base}`;
  const plan = await run('node', ['scripts/test-changed.mjs', baseArg, '--plan']);
  let mode;
  try { mode = JSON.parse(plan.out).mode; } catch { mode = 'unknown'; }
  if (mode === 'full' || mode === 'unknown') return { skipped: `the selection is the full suite (mode ${mode}); CI runs it` };
  if (mode === 'skip') return { skipped: 'no tests selected' };
  return run('node', ['scripts/test-changed.mjs', baseArg]);
}

export async function prepr({ base = 'origin/main', waitMs = SQUEAL_WAIT_MS } = {}) {
  const files = changedFiles(base);
  const docsOnly = files.every(isDocsPath);
  const lines = [];
  let failed = false;
  const direct = [
    ...(docsOnly ? [] : [['typecheck', 'npm', ['run', '--silent', 'typecheck']]]),
    ['citations', 'node', ['.github/scripts/check-citations.cjs', '--base', base]],
    ['clones', 'node', ['.github/scripts/check-clones.cjs', '--base', base, '--head', 'HEAD']],
  ];
  const directRuns = direct.map(([, cmd, args]) => run(cmd, args));
  const squeal = files.length ? await squealChecks(files, waitMs) : { daemon: true, state: 'pass', count: 0, failed: [], missing: [], lint: { failing: 0, unfinished: 0 } };
  const note = (ok, text) => { lines.push(`- ${ok ? 'pass' : 'FAIL'}: ${text}`); if (!ok) failed = true; };

  if (!squeal.daemon) {
    lines.push('- No Squeal daemon for this worktree: ran the focused checks (`npm run test:changed`, `npm run lint`).');
    const [tests, lint] = await Promise.all([focusedTests(base), run('npm', ['run', '--silent', 'lint'])]);
    if (tests.skipped) lines.push(`- skipped: focused tests: ${tests.skipped}`);
    else note(tests.code === 0, `focused tests (\`npm run test:changed\`)${tests.code ? `\n${tail(tests.out + tests.err)}` : ''}`);
    note(lint.code === 0, `lint (\`npm run lint\`)${lint.code ? `\n${tail(lint.out + lint.err)}` : ''}`);
  } else if (squeal.state === 'fail') {
    note(false, `Squeal: ${squeal.failed.length ? `failing test files: ${squeal.failed.join(', ')}` : squeal.lint.failing ? `${squeal.lint.failing} lint finding(s)` : 'known test failures'} (\`squeal failures\`, \`squeal status\`)`);
  } else if (squeal.state === 'incomplete') {
    const names = [...squeal.missing.slice(0, 10), ...(squeal.missing.length > 10 ? [`and ${squeal.missing.length - 10} more`] : []), ...(squeal.lint.unfinished ? [`lint (${squeal.lint.unfinished} file(s) not done)`] : [])];
    lines.push(`- pass, incomplete: Squeal had no result within ${Math.round(waitMs / 1000)} s for: ${names.join(', ')}. No failure was seen. CI runs these.`);
  } else {
    note(true, `Squeal: ${squeal.count} affected test file(s) current and passing; lint clean`);
  }

  for (const [i, [name]] of direct.entries()) {
    const r = await directRuns[i];
    note(r.code === 0, `${name}${r.code ? `\n${tail(r.out + r.err)}` : ''}`);
  }
  if (docsOnly) lines.push('- skipped: typecheck (docs-only change)');
  const head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const dirty = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout.trim() !== '';
  const report = [`prepr: ${failed ? 'FAIL' : 'PASS'}`, '', '### Local gate (`npm run prepr`)', '', `Head ${head}${dirty ? ' (uncommitted changes present)' : ''}, base ${base}, ${files.length} changed file(s).`, '', ...lines].join('\n');
  return { failed, report };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  if (args.includes('--help')) {
    console.log('Usage: npm run prepr -- [--base <ref>] [--wait-ms <ms>]\nOne verdict and the PR-body evidence block. Squeal wait bound: 120000 ms.');
  } else {
    const { failed, report } = await prepr({ base: opt('--base'), waitMs: Number(opt('--wait-ms')) || undefined });
    console.log(report);
    process.exitCode = failed ? 1 : 0;
  }
}
