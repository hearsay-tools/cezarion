#!/usr/bin/env node
'use strict';
// Runs StrykerJS on the lines a pull request changed, one package at a time, and writes the artifact
// the comment job reads. `scope` decides whether there is anything to mutate; `run` mutates it.
// An advisory job that never blocks a merge: a package over budget, a Stryker timeout or a Stryker
// error is recorded in the artifact, and the process still exits 0.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { parseDiff, plan, mutateArgs, readBudget, checkChangedLines, checkRelatedTests } = require('./mutants-scope.cjs');
const { functionRanges, duplicateNames } = require('./mutants-functions.cjs');
const { readEquivalent } = require('./mutants-equivalent.cjs');
const { VERSION, collectPackage, renderReport } = require('./mutants-report.cjs');

const EVIDENCE = 'mutation-evidence';
const REPORT = path.join('reports', 'mutation', 'mutation.json');
const STRYKER = path.join('node_modules', '.bin', 'stryker');
const STRYKER_VERSION = require('../../package.json').devDependencies['@stryker-mutator/core'];
const NO_COUNTS = { killed: 0, survived: 0, noCoverage: 0, timeout: 0, error: 0, ignored: 0 };

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== 'scope' && command !== 'run') throw new Error('usage: mutants-run.cjs scope or run [--base <rev>] [--head <rev>]');
  const opts = { command, base: 'HEAD^1', head: 'HEAD' };
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i] === '--base' || rest[i] === '--head') opts[rest[i].slice(2)] = rest[i + 1];
  }
  return opts;
}

const emptyPackage = (group, reason) => ({
  name: group.name, state: 'skipped', reason, changedLines: group.changedLines, relatedTests: null,
  durationMs: 0, counts: { ...NO_COUNTS }, mutants: [], omitted: 0,
});

function runUrl(env) {
  return env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY ? `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : '';
}

function finish({ deps, env, head, warning }, state, packages) {
  const artifact = { version: VERSION, state, head, stryker: STRYKER_VERSION, packages, ...(warning ? { warning } : {}) };
  deps.writeFile(`${EVIDENCE}/mutants.json`, `${JSON.stringify(artifact, null, 1)}\n`);
  deps.appendSummary(renderReport(artifact, { head, runUrl: runUrl(env) }));
}

async function scope(context) {
  const hasWork = context.groups.length > 0;
  if (!hasWork) finish(context, 'no-mutable-lines', []);
  context.deps.setOutput('has_work', String(hasWork));
  return 0;
}

/** One package: skip it for its size or its tests, else run Stryker on it within the time that is left. */
async function runPackage(group, { deps, budget, deadline, log, entries, warnings }) {
  const started = deps.now();
  const tooLarge = checkChangedLines(group.changedLines, budget);
  if (tooLarge) return emptyPackage(group, tooLarge);
  let related = null;
  try {
    related = await deps.countRelated(group.name, group.files);
  } catch (error) {
    log(`Could not count the tests for ${group.name}: ${error.message}`);
  }
  const tooMany = related === null ? null : checkRelatedTests(related, budget);
  if (tooMany) return { ...emptyPackage(group, tooMany), relatedTests: related };
  const remaining = deadline - deps.now();
  if (remaining <= 0) return { ...emptyPackage(group, 'the time budget was used up by the packages before it'), relatedTests: related };

  deps.removeReport();
  const result = await deps.stryker(group.name, mutateArgs(group.files), remaining);
  deps.restoreTree();
  const report = result.outcome === 'timed-out' ? null : deps.readReport(group.name);
  const durationMs = deps.now() - started;
  if (report) {
    deps.writeFile(`${EVIDENCE}/stryker-${group.name}.json`, JSON.stringify(report));
    const changed = new Map(group.files.map(({ file, ranges }) => [file, ranges]));
    const rangesByFile = new Map();
    for (const file of entries.length ? Object.keys(report.files ?? {}) : []) {
      try {
        const ranges = deps.functionRanges(file);
        rangesByFile.set(file, ranges);
        for (const name of duplicateNames(ranges)) {
          if (!entries.some(entry => entry.file === file && entry.function === name)) continue;
          const warning = `Ambiguous function ${name} in ${file}; no equivalent mutants excluded for that name.`;
          warnings.push(warning);
          log(warning);
        }
      } catch {
        const warning = `Could not identify functions in ${file}; no equivalent mutants excluded in that file.`;
        warnings.push(warning);
        log(warning);
      }
    }
    return collectPackage({ name: group.name, report, changed, durationMs, relatedTests: related, entries, rangesByFile });
  }
  const reason = result.outcome === 'timed-out'
    ? `did not finish within the ${budget.deadlineMinutes} minute budget`
    : `Stryker exited with code ${result.code} and wrote no report (see the job log)`;
  return { ...emptyPackage(group, reason), state: result.outcome === 'timed-out' ? 'timed-out' : 'error', relatedTests: related, durationMs };
}

async function run(context) {
  const { entries, warning } = context.deps.readEquivalent();
  if (warning) context.deps.log(warning);
  const warnings = warning ? [warning] : [];
  const budget = readBudget(context.env);
  const deadline = context.deps.now() + budget.deadlineMinutes * 60_000;
  const packages = [];
  for (const group of context.groups) {
    packages.push(await runPackage(group, { deps: context.deps, budget, deadline, log: context.deps.log, entries, warnings }));
  }
  finish({ ...context, warning: warnings.join(' ').slice(0, 300) }, 'ran', packages);
  return 0;
}

async function main(argv, env, deps) {
  const opts = parseArgs(argv);
  const diff = deps.git(['-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--no-renames', '--diff-filter=AM', opts.base, opts.head, '--', 'packages']);
  const context = { env, deps, opts, groups: plan(parseDiff(diff)), head: env.PR_HEAD_SHA ?? '' };
  return opts.command === 'scope' ? scope(context) : run(context);
}

/** Run Stryker in its own process group so a timeout can stop the test runners it started too. */
function runStryker(name, mutate, ms, options = {}) {
  return new Promise(resolve => {
    const child = (options.spawn ?? spawn)(STRYKER, ['run', '--mutate', mutate.join(','), ...(options.extraArgs ?? [])], {
      cwd: options.cwd, detached: true, stdio: options.onOutput ? ['inherit', 'pipe', 'pipe'] : 'inherit', env: { ...process.env, STRYKER_PROJECT: name },
    });
    if (options.onOutput) {
      child.stdout.on('data', chunk => { process.stdout.write(chunk); options.onOutput(String(chunk)); });
      child.stderr.on('data', chunk => { process.stderr.write(chunk); options.onOutput(String(chunk)); });
    }
    let timedOut = false;
    const stop = signal => { try { (options.kill ?? process.kill)(-child.pid, signal); } catch { /* the group is already gone */ } };
    const timer = setTimeout(() => {
      timedOut = true;
      stop('SIGTERM');
      setTimeout(() => stop('SIGKILL'), 20_000).unref();
    }, ms);
    const abort = () => stop('SIGKILL');
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const clear = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
    const result = code => ({ outcome: timedOut ? 'timed-out' : 'exited', code });
    child.on('exit', code => { clear(); stop('SIGKILL'); if (!options.onOutput) resolve(result(code)); });
    if (options.onOutput) child.on('close', code => resolve(result(code)));
    child.on('error', () => { clear(); resolve({ outcome: 'exited', code: 'spawn-error' }); });
  });
}

function countRelated(name, files) {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'mutants-related.mjs'), ...files.map(f => f.file)], {
    encoding: 'utf8', timeout: 5 * 60_000, env: { ...process.env, STRYKER_PROJECT: name },
  });
  const count = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}').count;
  if (!Number.isInteger(count)) throw new Error(`mutants-related.mjs printed no count (exit ${result.status})`);
  return count;
}

function defaultDeps(env) {
  const append = (file, text) => { if (file) fs.appendFileSync(file, text); };
  return {
    readEquivalent,
    functionRanges,
    git: args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
    countRelated: async (name, files) => countRelated(name, files),
    stryker: async (name, mutate, ms) => runStryker(name, mutate, ms),
    removeReport: () => fs.rmSync(REPORT, { force: true }),
    readReport: () => (fs.existsSync(REPORT) ? JSON.parse(fs.readFileSync(REPORT, 'utf8')) : null),
    // A killed Stryker can leave a mutated file behind; the tree was clean when the job began.
    restoreTree: () => { spawnSync('git', ['checkout', '--', 'packages']); fs.rmSync('.stryker-tmp', { recursive: true, force: true }); },
    writeFile: (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); },
    appendSummary: text => append(env.GITHUB_STEP_SUMMARY, `${text}\n`),
    setOutput: (key, value) => append(env.GITHUB_OUTPUT, `${key}=${value}\n`),
    now: Date.now,
    log: message => console.log(message),
  };
}

if (require.main === module) {
  main(process.argv.slice(2), process.env, defaultDeps(process.env)).then(code => process.exit(code), error => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { runStryker, main, parseArgs, EVIDENCE, REPORT };
