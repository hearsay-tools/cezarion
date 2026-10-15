#!/usr/bin/env node
// Upstream scan — append every new upstream commit to .ai/upstream/ledger.yaml
// as `pending` and write scans/<date>.md (spec .ai/specs/2026-09-18-upstream-ledger.md).
//
//   node .github/scripts/upstream-scan.cjs [--date YYYY-MM-DD] [--head <ref>] [--no-fetch]
//   node .github/scripts/upstream-scan.cjs validate
//   node .github/scripts/upstream-scan.cjs render      # regenerate LEDGER.md after editing the YAML
//   node .github/scripts/upstream-scan.cjs targets <sha>… [--no-fetch]   # re-check a port's files before planning it
//
// Upstream main is fetched into `refs/cez-upstream/main`, NEVER a remote: `gh`
// prefers a remote named `upstream` over `origin`, so adding one repoints
// cezar's own GitHub tab at the upstream repository (observed 2026-09-16).
// `--head` scans up to a given upstream commit instead of the fetched tip,
// which is how a backfill records an older scan honestly.
//
// Prints one JSON line on stdout: { added, date, upstreamHead, since, report }.
// Exit 0 with `added: 0` when upstream has nothing new; exit 1 on an invalid
// ledger, so a workflow never commits a ledger the unit gate would reject.
//
// `targets` takes ledger sha prefixes and prints a Markdown report on the files
// those upstream commits touch, as the fork's HEAD has them now: present or
// gone, reached by production code or only by tests, changed since the row
// landed, and a fresh per-file dry run (hearsay-tools/cezarion#1002). Advisory:
// exit 0 whenever the report printed; exit 1 with one line on stderr otherwise.
'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const yaml = require('yaml');
const {
  LEDGER_PATH, LOG_FORMAT, parseLog, parseApplyCheck, validateLedger, scanRange, applyScan, renderScanReport, renderLedger,
} = require('./upstream-ledger.cjs');
const { parseApplyCheckByFile, dryRunOf, parseNameStatus, reachabilityOf, renderTargetsReport } = require('./upstream-targets.cjs');
const { collectReachability } = require('./upstream-reachability.cjs');

const UPSTREAM_REF = 'refs/cez-upstream/main';
const root = path.resolve(__dirname, '../..');

function git(args, { cwd = root } = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

/** Exit status 0 means yes; for `cat-file -e`, which answers by exit code alone. */
function gitSucceeds(args, { cwd = root } = {}) {
  return spawnSync('git', args, { cwd, stdio: 'ignore' }).status === 0;
}

function loadLedger(cwd = root) {
  const file = path.join(cwd, LEDGER_PATH);
  const ledger = yaml.parse(fs.readFileSync(file, 'utf8'));
  return { file, ledger, problems: validateLedger(ledger) };
}

function readLedger() {
  const { file, ledger, problems } = loadLedger();
  if (problems.length) {
    console.error(`${LEDGER_PATH} is invalid:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  return { file, ledger };
}

function fetchUpstream(ledger, cwd = root) {
  git(['fetch', '--no-tags', '--quiet', `https://github.com/${ledger.upstream.repo}`, `${ledger.upstream.branch}:${UPSTREAM_REF}`], { cwd });
}

/** What a 3-way dry run of one upstream commit onto HEAD says. `git apply --check --3way`
 *  exits 0 AND reports its conflicts on stderr, so both streams are read whatever the exit
 *  code — an exit-code-only check would call everything clean. */
function applyCheckOutput(sha, cwd = root) {
  const patch = git(['format-patch', '-1', '--stdout', sha], { cwd });
  const result = spawnSync('git', ['apply', '--check', '--3way', '-'], { cwd, input: patch, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

/** Files a 3-way dry run of one upstream commit cannot apply onto HEAD. Advisory, dated. */
function conflictHint(sha, cwd = root) {
  return parseApplyCheck(applyCheckOutput(sha, cwd));
}

function scan({ date, head, fetch }) {
  const { file, ledger } = readLedger();
  if (fetch) fetchUpstream(ledger);
  const upstreamHead = git(['rev-parse', head ?? UPSTREAM_REF]).trim();
  const since = scanRange(ledger);
  const commits = parseLog(git(['log', '--reverse', `--format=${LOG_FORMAT}`, `${since}..${upstreamHead}`]));
  const known = new Set(ledger.entries.map((e) => e.sha));
  const hints = {};
  for (const c of commits) if (!known.has(c.sha)) hints[c.sha] = conflictHint(c.sha);
  const { ledger: next, added } = applyScan(ledger, { commits, hints, upstreamHead, date });
  const summary = { added: added.length, date, upstreamHead, since, report: null };
  if (added.length) {
    const scanRow = next.scans[next.scans.length - 1];
    const reportFile = path.join(path.dirname(file), scanRow.report);
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, renderScanReport(next, scanRow, added));
    fs.writeFileSync(file, yaml.stringify(next, { lineWidth: 0 }));
    writeLedgerView(file, next);
    summary.report = path.relative(root, reportFile);
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

const FIELD = '\x1f';

/** One ledger row per prefix, in the order given; zero or several matches is an error. */
function entriesFor(ledger, prefixes) {
  if (prefixes.length === 0) throw new Error('targets needs at least one ledger sha prefix (7-40 hex characters)');
  return prefixes.map((prefix) => {
    if (!/^[0-9a-f]{7,40}$/i.test(prefix)) throw new Error(`${prefix} is not a commit sha prefix (7-40 hex characters)`);
    const matches = ledger.entries.filter((e) => e.sha.startsWith(prefix.toLowerCase()));
    if (matches.length === 0) throw new Error(`no ledger entry matches ${prefix}`);
    if (matches.length > 1) throw new Error(`${prefix} matches ${matches.length} ledger entries (${matches.map((e) => e.sha.slice(0, 12)).join(', ')}); give more characters`);
    return matches[0];
  });
}

/** Fetch upstream at most once, and only when a commit is missing. Never a remote (see the header). */
function ensureUpstreamCommits(ledger, entries, { cwd, fetch }) {
  const missing = () => entries.filter((e) => !gitSucceeds(['cat-file', '-e', `${e.sha}^{commit}`], { cwd }));
  let absent = missing();
  if (absent.length && fetch) {
    fetchUpstream(ledger, cwd);
    absent = missing();
  }
  if (absent.length) {
    const sha = absent[0].sha.slice(0, 8);
    throw new Error(fetch
      ? `upstream commit ${sha} is not on ${ledger.upstream.repo} ${ledger.upstream.branch}`
      : `upstream commit ${sha} is not in this clone; run without --no-fetch`);
  }
}

/** The commit that added the row's sha to the ledger on HEAD's history, and its first parent:
 *  the fork as the scan saw it. `null` when HEAD never committed the row (an unmerged scan). */
function ledgerBaseline(entry, cwd) {
  const introSha = git(['log', '--reverse', '--format=%H', `-S${entry.sha}`, 'HEAD', '--', LEDGER_PATH], { cwd }).split('\n')[0];
  if (!introSha) return { intro: null, baseline: null };
  const [, short, subject] = git(['log', '-1', `--format=%H${FIELD}%h${FIELD}%s`, introSha], { cwd }).trim().split(FIELD);
  const intro = { sha: introSha, short, subject };
  if (!gitSucceeds(['rev-parse', '--verify', '--quiet', `${introSha}^`], { cwd })) return { intro, baseline: null };
  const [sha, baseShort, date] = git(['log', '-1', `--format=%H${FIELD}%h${FIELD}%cs`, `${introSha}^`], { cwd }).trim().split(FIELD);
  return { intro, baseline: { sha, short: baseShort, date } };
}

/** One upstream file as the fork has it at HEAD. A rename is judged by its old path. */
function targetFile(file, { baseline, reach, dryRun, cwd }) {
  const at = file.from ?? file.path;
  const exists = gitSucceeds(['cat-file', '-e', `HEAD:${at}`], { cwd });
  let lastTouch = null;
  if (!exists) {
    const last = git(['--literal-pathspecs', 'log', '-1', `--format=%h${FIELD}%s`, 'HEAD', '--', at], { cwd }).trim();
    if (last) {
      const [short, subject] = last.split(FIELD);
      lastTouch = { short, subject };
    }
  }
  let drift = null;
  if (baseline) {
    const range = `${baseline.sha}..HEAD`;
    const commits = git(['--literal-pathspecs', 'log', '--no-merges', '--format=%h', range, '--', at], { cwd }).split('\n').filter(Boolean).length;
    drift = { commits, added: 0, deleted: 0 };
    for (const line of git(['--literal-pathspecs', 'diff', '--numstat', baseline.sha, 'HEAD', '--', at], { cwd }).split('\n').filter(Boolean)) {
      const [added, deleted] = line.split('\t');
      drift.added += Number(added) || 0;
      drift.deleted += Number(deleted) || 0;
    }
  }
  return {
    status: file.status,
    path: file.path,
    ...(file.from ? { from: file.from } : {}),
    fork: { exists, lastTouch },
    reachability: reachabilityOf({ path: at, forkExists: exists }, reach),
    drift,
    dryRun: dryRunOf(dryRun, file),
  };
}

/** The data behind `targets`: fork HEAD, the reachability run, one section per ledger row. */
async function collectTargets(prefixes, { cwd = root, fetch = true } = {}) {
  const { ledger, problems } = loadLedger(cwd);
  if (problems.length) throw new Error(`${LEDGER_PATH} is invalid: ${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}`);
  const entries = entriesFor(ledger, prefixes);
  ensureUpstreamCommits(ledger, entries, { cwd, fetch });
  const [sha, short, date] = git(['log', '-1', `--format=%H${FIELD}%h${FIELD}%cs`, 'HEAD'], { cwd }).trim().split(FIELD);
  const reach = await collectReachability(cwd);
  const sections = entries.map((entry) => {
    const { intro, baseline } = ledgerBaseline(entry, cwd);
    const files = parseNameStatus(git(['diff-tree', '-r', '-z', '--no-commit-id', '--name-status', '-M', entry.sha], { cwd }));
    const dryRun = parseApplyCheckByFile(applyCheckOutput(entry.sha, cwd));
    return { entry, intro, baseline, files: files.map((f) => targetFile(f, { baseline, reach, dryRun, cwd })) };
  });
  return { ledger, head: { sha, short, date }, reach, sections };
}

/** One line for stderr: git's own `fatal:` line when git failed, else the error's first line. */
function oneLine(err) {
  const stderr = String(err?.stderr ?? '').split('\n').find((l) => l.trim());
  return (stderr ?? String(err?.message ?? err).split('\n')[0]).trim();
}

/** LEDGER.md sits next to the YAML; the unit guard fails when the two disagree. */
function writeLedgerView(file, ledger) {
  fs.writeFileSync(path.join(path.dirname(file), 'LEDGER.md'), renderLedger(ledger));
}

function main() {
  const { values, positionals } = parseArgs({
    options: {
      date: { type: 'string', default: new Date().toISOString().slice(0, 10) },
      head: { type: 'string' },
      'no-fetch': { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });
  if (positionals[0] === 'validate') {
    readLedger();
    process.stdout.write(`${LEDGER_PATH} is valid\n`);
    return;
  }
  if (positionals[0] === 'targets') {
    collectTargets(positionals.slice(1), { fetch: !values['no-fetch'] })
      .then((report) => process.stdout.write(renderTargetsReport(report)))
      .catch((err) => {
        process.stderr.write(`upstream-scan targets: ${oneLine(err)}\n`);
        process.exitCode = 1;
      });
    return;
  }
  if (positionals[0] === 'render') {
    const { file, ledger } = readLedger();
    writeLedgerView(file, ledger);
    process.stdout.write(`${path.relative(root, path.join(path.dirname(file), 'LEDGER.md'))} written\n`);
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.date)) throw new Error('--date must be YYYY-MM-DD');
  scan({ date: values.date, head: values.head, fetch: !values['no-fetch'] });
}

module.exports = { conflictHint, collectTargets, UPSTREAM_REF };

if (require.main === module) main();
