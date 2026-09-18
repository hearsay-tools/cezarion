#!/usr/bin/env node
// Upstream scan — append every new upstream commit to .ai/upstream/ledger.yaml
// as `pending` and write scans/<date>.md (spec .ai/specs/2026-09-18-upstream-ledger.md).
//
//   node .github/scripts/upstream-scan.cjs [--date YYYY-MM-DD] [--head <ref>] [--no-fetch]
//   node .github/scripts/upstream-scan.cjs validate
//   node .github/scripts/upstream-scan.cjs render      # regenerate LEDGER.md after editing the YAML
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
'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const yaml = require('yaml');
const {
  LEDGER_PATH, LOG_FORMAT, parseLog, parseApplyCheck, validateLedger, scanRange, applyScan, renderScanReport, renderLedger,
} = require('./upstream-ledger.cjs');

const UPSTREAM_REF = 'refs/cez-upstream/main';
const root = path.resolve(__dirname, '../..');

function git(args, { cwd = root } = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

function readLedger() {
  const file = path.join(root, LEDGER_PATH);
  const ledger = yaml.parse(fs.readFileSync(file, 'utf8'));
  const problems = validateLedger(ledger);
  if (problems.length) {
    console.error(`${LEDGER_PATH} is invalid:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  return { file, ledger };
}

/** Files a 3-way dry run of one upstream commit cannot apply onto HEAD. Advisory, dated.
 *  `git apply --check --3way` exits 0 AND reports its conflicts on stderr, so both streams
 *  are read whatever the exit code — an exit-code-only check would call everything clean. */
function conflictHint(sha, cwd = root) {
  const patch = git(['format-patch', '-1', '--stdout', sha], { cwd });
  const result = spawnSync('git', ['apply', '--check', '--3way', '-'], { cwd, input: patch, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  return parseApplyCheck(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
}

function scan({ date, head, fetch }) {
  const { file, ledger } = readLedger();
  if (fetch) git(['fetch', '--no-tags', '--quiet', `https://github.com/${ledger.upstream.repo}`, `${ledger.upstream.branch}:${UPSTREAM_REF}`]);
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
  if (positionals[0] === 'render') {
    const { file, ledger } = readLedger();
    writeLedgerView(file, ledger);
    process.stdout.write(`${path.relative(root, path.join(path.dirname(file), 'LEDGER.md'))} written\n`);
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.date)) throw new Error('--date must be YYYY-MM-DD');
  scan({ date: values.date, head: values.head, fetch: !values['no-fetch'] });
}

module.exports = { conflictHint, UPSTREAM_REF };

if (require.main === module) main();
