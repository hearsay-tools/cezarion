#!/usr/bin/env node
// One local gate before a PR opens (spec: .ai/specs/2026-11-11-one-full-run-delivery-pipeline.md,
// § Before the PR). It reads Squeal's results for the changed files and for lint, and runs
// what Squeal does not cover: typecheck, citations, clones and GitHub's per-file patch limits. CI runs everything else.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { isDocsPath } = require('../.github/scripts/change-surface.cjs');
const { GITHUB_PATCH_LIMITS, patchFacts } = require('../.github/scripts/missing-patches.cjs');

export const SQUEAL_WAIT_MS = 120_000;

/** Judge one `squeal status --wait <ms> <paths> --json` result (exit code and parsed stdout). */
export function judgeSqueal(exitCode, status, ignorePath = () => false, lintExpected = false) {
  const selection = status?.selection ?? {};
  // Browser specs are CI's: Squeal runs them only on request.
  const files = (selection.testFiles ?? []).filter(f => !f.path.endsWith('.e2e.ts'));
  const unmatched = (selection.unmatched ?? []).map(u => u?.path ?? String(u)).filter(p => !ignorePath(p));
  const failed = files.filter(f => f.state === 'current' && !['pass', 'skip'].includes(f.verdict)).map(f => f.path);
  const failures = selection.verdict?.failures ?? {};
  if (exitCode === 1 || failed.length || failures.tests || failures.testFiles || failures.setups) {
    return { state: 'fail', failed, missing: [], lint: lintOf(status, lintExpected) };
  }
  const missing = [...files.filter(f => f.state !== 'current').map(f => f.path), ...unmatched.map(p => `${p} (selects no test file)`)];
  const lint = lintOf(status, lintExpected);
  if (lint.failing) return { state: 'fail', failed: [], missing, lint };
  return { state: missing.length || lint.unfinished ? 'incomplete' : 'pass', failed: [], missing, lint, count: files.length };
}

// lintExpected: a changed file is one Squeal lints, so a lint run that has not started is not a clean one.
function lintOf(status, lintExpected = false) {
  const l = status?.lint;
  if (!l) return { failing: 0, unfinished: 1 };
  if (l.off || l.failed || l.unreadable) return { failing: l.failing ?? 0, unfinished: 1, unavailable: String(l.off ?? l.failed ?? l.unreadable) };
  // Squeal omits `linting` once lint is done; an object with total 0 is a run that has not started.
  const total = l.linting?.total ?? 0;
  const notDone = l.linting ? Math.max(0, total - (l.linting.done ?? 0)) + (lintExpected && total === 0 ? 1 : 0) : 0;
  return { failing: l.failing ?? 0, unfinished: (l.pending ?? 0) + (l.stale ?? 0) + (l.unknown ?? 0) + notDone };
}

/** True when the parsed status shows a live Squeal daemon for this worktree. */
export function daemonAlive(status) {
  return status?.available === true && status?.daemon?.state === 'alive';
}

function run(cmd, args, options = {}) {
  return new Promise(resolve => {
    // Only npm, whose arguments are fixed here, goes through the Windows shell: never a file name.
    const npmOnWindows = process.platform === 'win32' && cmd === 'npm';
    const child = spawn(npmOnWindows ? 'npm.cmd' : cmd, args, { shell: npmOnWindows, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => resolve({ code: 127, out, err: err + String(e) }));
    child.on('close', code => resolve({ code: code ?? 1, out, err }));
  });
}

const tail = (text, n = 15) => text.trim().split('\n').slice(-n).join('\n');

const KILL_GRACE_MS = 10_000;
const LINTED = /^packages\/.*\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const NO_SQUEAL = { daemon: true, state: 'pass', count: 0, failed: [], missing: [], lint: { failing: 0, unfinished: 0 } };

/** Git readers for one checkout: `git` returns text, `gitBytes` a Buffer. */
export const gitIo = (cwd = undefined) => ({
  git: (...a) => spawnSync('git', a, { cwd, encoding: 'utf8' }).stdout,
  gitBytes: (...a) => spawnSync('git', a, { cwd, maxBuffer: 256 << 20 }).stdout,
});

export const realIo = {
  run,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  now: () => Date.now(),
  ...gitIo(),
};

export async function squealChecks(paths, waitMs, io = realIo) {
  const deadline = io.now() + waitMs;
  const lintExpected = paths.some(p => LINTED.test(p));
  const ignore = p => p.endsWith('.e2e.ts') || isDocsPath(p);
  const wait = await io.run('squeal', ['status', '--wait', String(waitMs), '--json', ...paths], { timeout: waitMs + KILL_GRACE_MS });
  let status;
  try { status = JSON.parse(wait.out); } catch { status = undefined; }
  if (wait.code === 127 || !daemonAlive(status)) return { daemon: false };
  let result = judgeSqueal(wait.code, status, ignore, lintExpected);
  // The named-file wait settles on tests alone: give lint the rest of the bound.
  while (result.state === 'incomplete' && !result.missing.length && io.now() < deadline) {
    await io.sleep(Math.min(3000, Math.max(0, deadline - io.now())));
    if (io.now() >= deadline) break;
    const poll = await io.run('squeal', ['status', '--json'], { timeout: Math.max(1000, deadline - io.now()) });
    try { result = judgeSqueal(wait.code, { ...status, lint: JSON.parse(poll.out).lint }, ignore, lintExpected); } catch { break; }
  }
  return { daemon: true, ...result };
}

// Without a daemon: the focused tests only when the selection is not the full suite.
export async function focusedTests(base, io = realIo) {
  const baseArg = `--base=${base}`;
  const plan = await io.run('node', ['scripts/test-changed.mjs', baseArg, '--plan']);
  let mode;
  try { mode = JSON.parse(plan.out).mode; } catch { mode = 'unknown'; }
  if (mode === 'full') return { skipped: 'the selection is the full suite; CI runs it' };
  if (mode === 'skip') return { skipped: 'no tests selected' };
  return io.run('node', ['scripts/test-changed.mjs', baseArg]);
}

const detail = r => (r.code ? `\n${tail(r.out + r.err)}` : '');
const entry = (ok, text) => ({ ok, text: `- ${ok ? 'pass' : 'FAIL'}: ${text}` });

/** Report lines for a Squeal result: an array of { ok, text }. */
export function squealLines(squeal, waitMs) {
  if (squeal.state === 'fail') {
    const what = squeal.failed.length ? `failing test files: ${squeal.failed.join(', ')}`
      : squeal.lint.failing ? `${squeal.lint.failing} lint finding(s)` : 'known test failures';
    return [entry(false, `Squeal: ${what} (\`squeal failures\`, \`squeal status\`)`)];
  }
  if (squeal.state === 'incomplete') {
    const more = squeal.missing.length > 10 ? [`and ${squeal.missing.length - 10} more`] : [];
    const lint = squeal.lint.unfinished ? [`lint (${squeal.lint.unfinished} file(s) not done)`] : [];
    const names = [...squeal.missing.slice(0, 10), ...more, ...lint];
    return [{ ok: true, text: `- pass, incomplete: Squeal had no result within ${Math.round(waitMs / 1000)} s for: ${names.join(', ')}. No failure was seen. CI runs these.` }];
  }
  return [entry(true, `Squeal: ${squeal.count} affected test file(s) current and passing; lint clean`)];
}

/** Report lines when no Squeal daemon runs: the focused tests and lint. */
export async function fallbackLines(base, io = realIo) {
  const [tests, lint] = await Promise.all([focusedTests(base, io), io.run('npm', ['run', '--silent', 'lint'])]);
  return [
    { ok: true, text: '- No Squeal daemon for this worktree: ran the focused checks (`npm run test:changed`, `npm run lint`).' },
    tests.skipped ? { ok: true, text: `- skipped: focused tests: ${tests.skipped}` }
      : entry(tests.code === 0, `focused tests (\`npm run test:changed\`)${detail(tests)}`),
    entry(lint.code === 0, `lint (\`npm run lint\`)${detail(lint)}`),
  ];
}

function mergeBaseOf(base, io) {
  const mergeBase = io.git('merge-base', base, 'HEAD').trim();
  if (!mergeBase) throw new Error(`No merge base with ${base}: run \`git fetch origin main\` first.`);
  return mergeBase;
}

const DIFF = ['diff', '--no-ext-diff', '--no-textconv', '--find-renames'];

/** Rows of `git diff --numstat -z` with renames on: a rename row names its old and new path. */
export function numstatRows(numstat) {
  const tokens = numstat.split('\0');
  const rows = [];
  for (let i = 0; i < tokens.length && tokens[i]; i++) {
    const [, added, deleted, path] = /^([^\t]*)\t([^\t]*)\t(.*)$/s.exec(tokens[i]);
    const paths = path === '' ? [tokens[++i], tokens[++i]] : [path];
    rows.push({ added, deleted, paths });
  }
  return rows;
}

/**
 * Report lines for GitHub's per-file patch limits on the committed branch: a file diff over
 * GITHUB_PATCH_LIMITS.fileBytes or one with a NUL byte gets no API patch, and the PR gate fails.
 * Renames are on, as on GitHub, so a moved file is measured by its rename patch.
 */
export function patchLimitLines(base, io = realIo) {
  const mergeBase = mergeBaseOf(base, io);
  const rows = numstatRows(io.git(...DIFF, '--numstat', '-z', mergeBase, 'HEAD'));
  const limit = GITHUB_PATCH_LIMITS.fileBytes;
  let added = 0;
  let deleted = 0;
  const refused = [];
  for (const row of rows) {
    if (row.added === '-') continue;
    added += Number(row.added);
    deleted += Number(row.deleted);
    const facts = patchFacts(io.gitBytes(...DIFF, mergeBase, 'HEAD', '--', ...row.paths));
    const cause = facts.nul ? 'its diff contains a NUL byte'
      : facts.bytes > limit ? `its diff is ${facts.bytes} bytes, over GitHub's ${limit}-byte per-file patch limit` : '';
    if (cause) refused.push(entry(false, `patch limits: ${JSON.stringify(row.paths.at(-1))}: ${cause}, so GitHub returns no patch and the PR gate fails. Split the change.`));
  }
  if (refused.length) return refused;
  return [entry(true, `patch limits: every file diff is at most ${limit} bytes with no NUL byte; ${added + deleted} changed lines (+${added}/-${deleted}) in ${rows.length} file${rows.length === 1 ? '' : 's'}`)];
}

function changedFiles(base, io) {
  const mergeBase = mergeBaseOf(base, io);
  const tracked = io.git('diff', '--name-only', '--no-renames', '-z', mergeBase);
  const untracked = io.git('ls-files', '--others', '--exclude-standard', '-z');
  return [...new Set(`${tracked}\0${untracked}`.split('\0').filter(Boolean))];
}

export async function prepr({ base = 'origin/main', waitMs = SQUEAL_WAIT_MS, io = realIo } = {}) {
  const files = changedFiles(base, io);
  const docsOnly = files.every(isDocsPath);
  const direct = [
    ...(docsOnly ? [] : [['typecheck', 'npm', ['run', '--silent', 'typecheck']]]),
    ['citations', 'node', ['.github/scripts/check-citations.cjs', '--base', base]],
    ['clones', 'node', ['.github/scripts/check-clones.cjs', '--base', base, '--head', 'HEAD']],
  ];
  const directRuns = direct.map(([, cmd, args]) => io.run(cmd, args));
  const squeal = files.length ? await squealChecks(files, waitMs, io) : NO_SQUEAL;
  const entries = squeal.daemon ? squealLines(squeal, waitMs) : await fallbackLines(base, io);
  entries.push(...patchLimitLines(base, io));
  for (const [i, [name]] of direct.entries()) {
    const r = await directRuns[i];
    entries.push(entry(r.code === 0, `${name}${detail(r)}`));
  }
  if (docsOnly) entries.push({ ok: true, text: '- skipped: typecheck (docs-only change)' });
  const failed = entries.some(e => !e.ok);
  const head = io.git('rev-parse', '--short', 'HEAD').trim();
  const dirty = io.git('status', '--porcelain').trim() !== '';
  const report = [`prepr: ${failed ? 'FAIL' : 'PASS'}`, '', '### Local gate (`npm run prepr`)', '', `Head ${head}${dirty ? ' (uncommitted changes present)' : ''}, base ${base}, ${files.length} changed file(s).`, '', ...entries.map(e => e.text)].join('\n');
  return { failed, report };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  if (args.includes('--help')) {
    console.log('Usage: npm run prepr -- [--base <ref>] [--wait-ms <ms>]\nOne verdict and the PR-body evidence block. Squeal wait bound: 120000 ms.');
  } else {
    try {
      const { failed, report } = await prepr({ base: opt('--base'), waitMs: Number(opt('--wait-ms')) || undefined });
      console.log(report);
      process.exitCode = failed ? 1 : 0;
    } catch (error) {
      console.error(`prepr: ${error.message}`);
      process.exitCode = 2;
    }
  }
}
