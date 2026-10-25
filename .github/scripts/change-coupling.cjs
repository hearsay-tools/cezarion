#!/usr/bin/env node
// Weekly ownership signal, not a merge gate. No network calls in the CLI.
const { execFileSync } = require('node:child_process');

const TRACKING_TITLE = 'Weekly change coupling report';
// Three shared commits remove one-off 100% pairs that carry little ownership signal.
const TRACKING_MIN_SHARED = 3;
const ISSUE_MAX_BYTES = 60000;
const DAY_MS = 24 * 60 * 60 * 1000;

function isTestFile(file) {
  return /(^|\/)(?:test|tests|__tests__|fixtures|__fixtures__|e2e)(\/|$)/.test(file)
    || /\.(?:test|spec|e2e|testkit)\.[^/]+$/.test(file);
}

function readHistory({ cwd = process.cwd(), now = new Date() } = {}) {
  const since = new Date(now.getTime() - 90 * DAY_MS).toISOString();
  // NUL names preserve spaces, tabs, quotes and newlines. Empty tokens mark
  // commit headers; git inserts exactly one newline before the first filename.
  // --since-as-filter traverses old-dated parents too (unlike --since).
  const log = execFileSync('git', ['log', '--since-as-filter=' + since,
    '--no-merges', '--no-renames', '--format=%x00%H%x00%ct', '--name-only', '-z', 'HEAD'],
  { cwd, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  const tokens = log.split('\0');
  const commits = [];
  for (let i = 0; i < tokens.length - 1;) {
    if (tokens[i] !== '') throw new Error('Unexpected git log header');
    const sha = tokens[++i];
    const timestamp = Number(tokens[++i]);
    i++;
    const files = [];
    while (i < tokens.length && tokens[i] !== '') {
      files.push(files.length === 0 ? tokens[i].replace(/^\n/, '') : tokens[i]);
      i++;
    }
    commits.push({ sha, timestamp, files });
  }
  return commits;
}

function countPairs(commits) {
  const counts = new Map();
  const pairs = new Map();
  for (const commit of commits) {
    const raw = [...new Set(commit.files)];
    if (raw.length > 25) continue;
    const files = raw.filter(file => !isTestFile(file)).sort();
    for (const file of files) counts.set(file, (counts.get(file) || 0) + 1);
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const a = files[i], b = files[j];
        const key = JSON.stringify([a, b]);
        const pair = pairs.get(key) || { a, b, shared: 0, latest: commit.sha, timestamp: -Infinity };
        pair.shared++;
        if (commit.timestamp > pair.timestamp) {
          pair.latest = commit.sha;
          pair.timestamp = commit.timestamp;
        }
        pairs.set(key, pair);
      }
    }
  }
  return [...pairs.values()].map(({ a, b, shared, latest }) => {
    const countA = counts.get(a), countB = counts.get(b);
    return { a, b, countA, countB, shared, degree: shared / Math.min(countA, countB), latest };
  }).sort((a, b) => b.degree - a.degree || b.shared - a.shared
    || compare(a.a, b.a) || compare(a.b, b.b));
}

function compare(a, b) { return a < b ? -1 : Number(a > b); }

function escapeCell(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\|/g, '&#124;').replace(/`/g, '&#96;').replace(/[\r\n]/g, ' ')
    .replace(/\[/g, '&#91;').replace(/\]/g, '&#93;').replace(/\\/g, '&#92;');
}

function renderReport(pairs, { repository, minimum = -1, minimumShared = 1, maxBytes = Infinity, runUrl } = {}) {
  const selected = pairs.filter(pair => pair.degree > minimum && pair.shared >= minimumShared);
  const intro = '# Change coupling — last 90 days\n\n'
    + 'Excludes merge commits, commits with more than 25 changed paths (before test exclusion), '
    + 'and test/spec/e2e/testkit files or test/fixture directories. Renames count as deletion and addition.\n\n'
    + 'Degree = shared commits / min(file A commits, file B commits). '
    + 'Counts use only eligible commits. High coupling suggests a shared owner; it is not proof of duplication.\n\n'
    + `Minimum shared commits: ${minimumShared}. A floor of three removes one-off 100% pairs with little ownership signal.\n\n`
    + (runUrl ? `[Complete report (all pairs above 50%, no shared-commit floor), workflow run](${runUrl}) — download the change-coupling-report artifact (retained 90 days).\n\n` : '');
  if (!selected.length) return intro + 'No file pairs above the report threshold.\n';
  const rows = selected.map(pair => {
    const latest = repository
      ? `[${pair.latest.slice(0, 8)}](https://github.com/${repository}/commit/${pair.latest})`
      : pair.latest;
    return `| ${escapeCell(pair.a)} | ${escapeCell(pair.b)} | ${pair.shared} | ${pair.countA} | ${pair.countB} | ${(pair.degree * 100).toFixed(1)}% | ${latest} |`;
  });
  const header = intro + '| File A | File B | Shared commits | A commits | B commits | Degree | Latest shared commit |\n'
    + '| --- | --- | ---: | ---: | ---: | ---: | --- |\n';
  return fitRows(header, rows, maxBytes);
}


function fitRows(header, rows, maxBytes) {
  const kept = [];
  let bytes = Buffer.byteLength(header);
  for (const row of rows) {
    // Reserve enough bytes for the omission notice, including large counts.
    if (bytes + Buffer.byteLength(row) + 1 + 200 > maxBytes) break;
    kept.push(row);
    bytes += Buffer.byteLength(row) + 1;
  }
  const omitted = rows.length - kept.length;
  return header + kept.join('\n') + '\n'
    + (omitted ? `\nShowing ${kept.length} of ${rows.length} pairs; ${omitted} omitted to fit the issue body. See the complete report linked above.\n` : '');
}

function cliOptions(args) {
  const options = {};
  const flags = { '--minimum-shared': 'minimumShared', '--minimum-degree': 'minimum',
    '--max-bytes': 'maxBytes', '--repository': 'repository', '--run-url': 'runUrl' };
  for (let i = 0; i < args.length; i += 2) {
    const key = flags[args[i]], value = args[i + 1];
    if (!key || !value) throw new Error(`Unknown or incomplete option: ${args[i]}`);
    options[key] = ['repository', 'runUrl'].includes(key) ? value : Number(value);
    if (typeof options[key] === 'number' && (!Number.isFinite(options[key]) || options[key] < 0)) {
      throw new Error(`Invalid numeric option: ${args[i]}`);
    }
  }
  return options;
}

async function updateTrackingIssue({ github, owner, repo, body }) {
  // Exact title, all pages and both states: a closed report is reused, never
  // replaced by a fresh weekly issue. Workflow concurrency serializes first run.
  const issues = await github.paginate(github.rest.issues.listForRepo,
    { owner, repo, state: 'all', per_page: 100 });
  const existing = issues.filter(issue => !issue.pull_request && issue.title === TRACKING_TITLE)
    .sort((a, b) => a.number - b.number)[0];
  const result = existing
    ? await github.rest.issues.update({ owner, repo, issue_number: existing.number, state: 'open', body })
    : await github.rest.issues.create({ owner, repo, title: TRACKING_TITLE, body });
  return result.data.html_url;
}

module.exports = { TRACKING_TITLE, TRACKING_MIN_SHARED, ISSUE_MAX_BYTES, cliOptions, isTestFile, readHistory, countPairs, renderReport, updateTrackingIssue };
if (require.main === module) console.log(renderReport(countPairs(readHistory()), cliOptions(process.argv.slice(2))));
