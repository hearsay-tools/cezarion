#!/usr/bin/env node
// Upstream scan — append every new upstream commit to .ai/upstream/ledger.yaml
// as `pending` and write scans/<date>.md (spec .ai/specs/2026-09-18-upstream-ledger.md).
//
//   node .github/scripts/upstream-scan.cjs [--date YYYY-MM-DD] [--head <ref>] [--no-fetch]
//   node .github/scripts/upstream-scan.cjs validate
//   node .github/scripts/upstream-scan.cjs render      # regenerate LEDGER.md after editing the YAML
//   node .github/scripts/upstream-scan.cjs targets <sha>… [--no-fetch]   # re-check a port's files before planning it
//
// Reject an unknown subcommand with exit 2 before Git or filesystem effects.
//
// Fetch upstream into refs/cez-upstream/main without adding a discovery-visible remote.
// `--date` defaults to the current UTC date for scans and target reports.
// `--head` scans up to a given upstream commit instead of the fetched tip,
// which is how a backfill records an older scan honestly. For targets, --head selects
// the fork commit to inspect (default HEAD); --date labels the report, not the tree.
//
// Prints one JSON line on stdout: { added, date, upstreamHead, since, report }.
// Exit 0 with `added: 0` when upstream has nothing new; exit 1 on an invalid
// ledger, so a workflow never commits a ledger the unit gate would reject.
//
// `targets` takes ledger sha prefixes and prints a Markdown report on the files
// those upstream commits touch, as the fork's selected commit has them: present or
// gone, reached by production code or only by tests, changed since the row
// landed, and a fresh per-file dry run (hearsay-tools/cezarion#1002). A merge is
// compared with its first parent, here and in the scan's conflict hints. Every
// verdict describes the selected committed fork revision: uncommitted changes, staged or not, are
// ignored; only `ledger.yaml` is read from the work tree. It needs git 2.41 or
// newer (`--attr-source`). Advisory: exit 0 whenever the report printed; exit 1
// with one line on stderr otherwise.
'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
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

function git(args, { cwd = root, env, input } = {}) {
  return execFileSync('git', args, { cwd, env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

/** Exit status 0 means yes; for `cat-file -e`, which answers by exit code alone. */
function gitSucceeds(args, { cwd = root } = {}) {
  return spawnSync('git', args, { cwd, stdio: 'ignore' }).status === 0;
}

/** Both output streams, whatever the exit code; for `git apply --check`, which exits 0 AND
 *  reports its conflicts on stderr. */
function gitOutput(args, { cwd = root, env, input } = {}) {
  const result = spawnSync('git', args, { cwd, env, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
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

function fetchUpstream(ledger, run = git) {
  run(['fetch', '--no-tags', '--quiet', `https://github.com/${ledger.upstream.repo}`, `${ledger.upstream.branch}:${UPSTREAM_REF}`]);
}

/** A fork ref (HEAD by default) as a full commit sha. A run resolves it once and names that sha in every later git
 *  call, so a commit landing in the checkout mid-run cannot mix two trees in one result. */
function resolveHead(cwd = root, ref = 'HEAD') {
  return git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], { cwd }).trim();
}

/**
 * Run Git against one resolved head with --attr-source=<head>. Require option support so
 * working-tree attributes cannot silently affect analysis. Committed attributes and repository
 * config still apply.
 */
function pinnedGit(cwd, head) {
  const pin = (args) => [`--attr-source=${head}`, ...args];
  return {
    head,
    git: (args, opts) => git(pin(args), { ...opts, cwd }),
    gitSucceeds: (args) => gitSucceeds(pin(args), { cwd }),
    gitOutput: (args, opts) => gitOutput(pin(args), { ...opts, cwd }),
  };
}

/** Why this git cannot read attributes from `g.head`, or null when it can: one pinned `rev-parse`
 *  of the sha just resolved, which only a rejected `--attr-source` can fail. */
function attrSourceRejection(g) {
  try {
    g.git(['rev-parse', '--verify', g.head]);
    return null;
  } catch (err) {
    return oneLine(err);
  }
}

/** A private index holding `g.head`'s tree, in a new `cez-targets-*` dir under os.tmpdir(); the
 *  real index is never written. The caller calls `remove()`; a failure here leaves no dir. */
function headIndex(g) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cez-targets-'));
  const remove = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    const real = fs.realpathSync(dir);
    const index = path.join(real, 'index');
    g.git(['read-tree', g.head], { env: { ...process.env, GIT_INDEX_FILE: index } });
    return { dir: real, index, remove };
  } catch (err) {
    remove();
    throw err;
  }
}

/** One upstream commit as `targets` and the scan's hints compare it: with its parent, or, for a
 *  merge, with its first parent, the upstream main it landed on. Read as one commit a merge shows
 *  nothing (a bare `diff-tree <merge>` lists no file and `format-patch -1 <merge>` is mail headers
 *  alone), which would report no files and a clean dry run. `merge` is `{ firstParent }` or null;
 *  the parents come from one `rev-list` per commit. */
function upstreamCommit(sha, g) {
  const [, ...parents] = g.git(['rev-list', '--parents', '-n', '1', sha]).trim().split(' ');
  return { sha, merge: parents.length > 1 ? { firstParent: parents[0] } : null };
}

/** The files `commit` changes against its first parent: two tree-ish, so a merge lists its files
 *  and a single-parent commit lists what its own diff does. */
function changedFiles(commit, g) {
  return parseNameStatus(g.git(['diff-tree', '-r', '-z', '--name-status', '-M', `${commit.sha}^1`, commit.sha]));
}

/** The patch a dry run applies: `format-patch` for a single-parent commit; for a merge, the diff
 *  from its first parent. That diff is plumbing (`diff-tree -p`), not `git diff`: the porcelain
 *  follows the user's `diff.noprefix`, `color.diff`, external diff and textconv, and any of them
 *  makes a patch `git apply` misreads. `--full-index` names the blobs the 3-way merge needs. */
function upstreamPatch(commit, g) {
  return commit.merge
    ? g.git(['diff-tree', '-p', '--binary', '--full-index', '-M', `${commit.sha}^1`, commit.sha])
    : g.git(['format-patch', '-1', '--stdout', commit.sha]);
}

/** What a 3-way dry run of one upstream commit (`upstreamCommit`) onto `index` says, a private
 *  index holding `g.head` (`headIndex`). `git apply --check --3way` exits 0 AND reports its
 *  conflicts on stderr, so both streams are read whatever the exit code — an exit-code-only check
 *  would call everything clean. The run reads that index alone (`--cached`) and `g.head`'s
 *  attributes, so nothing staged or edited in the checkout can change the verdict. The index path
 *  reaches the child's environment only. */
function applyCheckOutput(commit, g, index) {
  return g.gitOutput(['apply', '--check', '--3way', '--cached', '-'], { env: { ...process.env, GIT_INDEX_FILE: index }, input: upstreamPatch(commit, g) });
}

/** Files a 3-way dry run of each upstream commit cannot apply onto HEAD, by sha. Advisory, dated.
 *  One private index holding HEAD serves every commit and is removed afterwards. On a git without
 *  `--attr-source`, or when that index cannot be built (a temp dir that is not a directory or is
 *  full), one warning goes to stderr and no commit gets a hint: the scan still records its rows. */
function conflictHints(shas, cwd = root) {
  const hints = {};
  if (shas.length === 0) return hints;
  const g = pinnedGit(cwd, resolveHead(cwd));
  const rejected = attrSourceRejection(g);
  if (rejected) {
    process.stderr.write(`upstream-scan: this git cannot read attributes from HEAD (--attr-source needs git 2.41 or newer), so new rows get no conflict hints: ${rejected}\n`);
    return hints;
  }
  let built;
  try {
    built = headIndex(g);
  } catch (err) {
    process.stderr.write(`upstream-scan: cannot build a private index of HEAD, so new rows get no conflict hints: ${oneLine(err)}\n`);
    return hints;
  }
  try {
    for (const sha of shas) hints[sha] = parseApplyCheck(applyCheckOutput(upstreamCommit(sha, g), g, built.index));
  } finally {
    built.remove();
  }
  return hints;
}

function scan({ date, head, fetch }) {
  const { file, ledger } = readLedger();
  if (fetch) fetchUpstream(ledger);
  const upstreamHead = git(['rev-parse', head ?? UPSTREAM_REF]).trim();
  const since = scanRange(ledger);
  const commits = parseLog(git(['log', '--reverse', `--format=${LOG_FORMAT}`, `${since}..${upstreamHead}`]));
  const known = new Set(ledger.entries.map((e) => e.sha));
  const hints = conflictHints(commits.filter((c) => !known.has(c.sha)).map((c) => c.sha));
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
function ensureUpstreamCommits(ledger, entries, { g, fetch }) {
  const missing = () => entries.filter((e) => !g.gitSucceeds(['cat-file', '-e', `${e.sha}^{commit}`]));
  let absent = missing();
  if (absent.length && fetch) {
    fetchUpstream(ledger, g.git);
    absent = missing();
  }
  if (absent.length) {
    const sha = absent[0].sha.slice(0, 8);
    throw new Error(fetch
      ? `upstream commit ${sha} is not on ${ledger.upstream.repo} ${ledger.upstream.branch}`
      : `upstream commit ${sha} is not in this clone; run without --no-fetch`);
  }
}

/** The commit that added the row's sha to the ledger on `g.head`'s history, and its first parent:
 *  the fork as the scan saw it. `null` when `g.head` never committed the row (an unmerged scan).
 *  The pickaxe reads the ledger's raw text (`--no-textconv`), whatever textconv HEAD commits. */
function ledgerBaseline(entry, g) {
  const introSha = g.git(['log', '--no-textconv', '--reverse', '--format=%H', `-S${entry.sha}`, g.head, '--', LEDGER_PATH]).split('\n')[0];
  if (!introSha) return { intro: null, baseline: null };
  const [, short, subject] = g.git(['log', '-1', `--format=%H${FIELD}%h${FIELD}%s`, introSha]).trim().split(FIELD);
  const intro = { sha: introSha, short, subject };
  if (!g.gitSucceeds(['rev-parse', '--verify', '--quiet', `${introSha}^`])) return { intro, baseline: null };
  const [sha, baseShort, date] = g.git(['log', '-1', `--format=%H${FIELD}%h${FIELD}%cs`, `${introSha}^`]).trim().split(FIELD);
  return { intro, baseline: { sha, short: baseShort, date } };
}

/** One upstream file as the fork has it at `g.head`. A rename is judged by its old path.
 *  Churn counts raw lines (`--no-textconv`). */
function targetFile(file, { g, baseline, reach, dryRun }) {
  const at = file.from ?? file.path;
  const exists = g.gitSucceeds(['cat-file', '-e', `${g.head}:${at}`]);
  let lastTouch = null;
  if (!exists) {
    const last = g.git(['--literal-pathspecs', 'log', '-1', `--format=%h${FIELD}%s`, g.head, '--', at]).trim();
    if (last) {
      const [short, subject] = last.split(FIELD);
      lastTouch = { short, subject };
    }
  }
  let drift = null;
  if (baseline) {
    const range = `${baseline.sha}..${g.head}`;
    const commits = g.git(['--literal-pathspecs', 'log', '--no-merges', '--format=%h', range, '--', at]).split('\n').filter(Boolean).length;
    drift = { commits, added: 0, deleted: 0 };
    for (const line of g.git(['--literal-pathspecs', 'diff', '--numstat', '--no-textconv', baseline.sha, g.head, '--', at]).split('\n').filter(Boolean)) {
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

/** What reachability reads from a checkout (upstream-reachability.cjs): package sources,
 *  manifests and pages, and the repo scripts whose `dist/` imports are roots. */
const SNAPSHOT_PATH_RE = /^(?:packages\/[^/]+\/(?:src\/|scripts\/|package\.json$|index\.html$)|scripts\/)/;

/**
 * Run on a private index and checkout-index tree of the pinned head. Exclude staged/uncommitted
 * work without writing the real index. Missing scratch parts are null with an error; always
 * clean up.
 */
async function withHeadSnapshot(g, fn) {
  const snapshot = { index: null, tree: null, error: null };
  let built = null;
  try {
    built = headIndex(g);
    snapshot.index = built.index;
    const env = { ...process.env, GIT_INDEX_FILE: built.index };
    const tree = path.join(built.dir, 'tree');
    fs.mkdirSync(tree);
    const files = g.git(['ls-files', '-z'], { env }).split('\0').filter((f) => SNAPSHOT_PATH_RE.test(f));
    g.git(['checkout-index', `--prefix=${tree}${path.sep}`, '-z', '--stdin'], { env, input: files.join('\0') });
    snapshot.tree = tree;
  } catch (err) {
    snapshot.error = `cannot snapshot HEAD: ${oneLine(err)}`;
  }
  try {
    return await fn(snapshot);
  } finally {
    built?.remove();
  }
}

/** The data behind `targets`: fork HEAD, the reachability run, one section per ledger row.
 *  HEAD is resolved to one sha first and every later git call goes through `pinnedGit`, naming it
 *  and reading its attributes, so neither a commit landing mid-run nor an uncommitted
 *  `.gitattributes` can change the report. Reachability and the dry run read a snapshot of that
 *  commit; existence and drift read the commit itself. A git without `--attr-source` is an error:
 *  every verdict depends on the pin. */
async function collectTargets(prefixes, { cwd = root, fetch = true, head = 'HEAD', date = new Date().toISOString().slice(0, 10) } = {}) {
  const { ledger, problems } = loadLedger(cwd);
  if (problems.length) throw new Error(`${LEDGER_PATH} is invalid: ${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}`);
  const entries = entriesFor(ledger, prefixes);
  const g = pinnedGit(cwd, resolveHead(cwd, head));
  const rejected = attrSourceRejection(g);
  if (rejected) throw new Error(`needs git 2.41 or newer (--attr-source); this git rejects it: ${rejected}`);
  ensureUpstreamCommits(ledger, entries, { g, fetch });
  const [short, commitDate] = g.git(['log', '-1', `--format=%h${FIELD}%cs`, g.head]).trim().split(FIELD);
  return withHeadSnapshot(g, async (snapshot) => {
    const reach = snapshot.tree
      ? await collectReachability(snapshot.tree)
      : { roots: 0, reachable: 0, inputs: new Set(), error: snapshot.error };
    const sections = entries.map((entry) => {
      const { intro, baseline } = ledgerBaseline(entry, g);
      const commit = upstreamCommit(entry.sha, g);
      const dryRun = snapshot.index ? parseApplyCheckByFile(applyCheckOutput(commit, g, snapshot.index)) : new Map();
      const files = changedFiles(commit, g).map((f) => targetFile(f, { g, baseline, reach, dryRun }));
      return { entry, intro, baseline, merge: commit.merge, files };
    });
    return { ledger, date, head: { sha: g.head, short, date: commitDate }, reach, dryRunError: snapshot.index ? null : snapshot.error, sections };
  });
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

/** Subcommands by name. No positional at all is the scan, which is how
 *  `.github/workflows/upstream-scan.yml` runs it. */
const COMMANDS = new Map([
  ['validate', () => {
    readLedger();
    process.stdout.write(`${LEDGER_PATH} is valid\n`);
  }],
  ['render', () => {
    const { file, ledger } = readLedger();
    writeLedgerView(file, ledger);
    process.stdout.write(`${path.relative(root, path.join(path.dirname(file), 'LEDGER.md'))} written\n`);
  }],
  ['targets', (args, values) => {
    collectTargets(args, { fetch: !values['no-fetch'], head: values.head, date: values.date })
      .then((report) => process.stdout.write(renderTargetsReport(report)))
      .catch((err) => {
        process.stderr.write(`upstream-scan targets: ${oneLine(err)}\n`);
        process.exitCode = 1;
      });
  }],
]);

function main() {
  const { values, positionals } = parseArgs({
    options: {
      date: { type: 'string', default: new Date().toISOString().slice(0, 10) },
      head: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      'no-fetch': { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });
  if (values.help) {
    process.stdout.write(`Usage: upstream-scan.cjs [validate | render | targets <sha>…] [options]
  --date YYYY-MM-DD  Scan/report date (default: current UTC date)
  --head <ref>       Scan: upstream tip (default: fetched tip); targets: fork commit (default: HEAD)
  --no-fetch         Do not fetch upstream
  -h, --help         Show this help
`);
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.date)) throw new Error('--date must be YYYY-MM-DD');
  const [command, ...args] = positionals;
  if ((command === 'validate' || command === 'render') && args.length) {
    process.stderr.write(`upstream-scan: ${command}: unexpected positional argument "${args[0]}"\n`);
    process.exitCode = 2;
    return;
  }
  if (command !== undefined) {
    const run = COMMANDS.get(command);
    if (!run) {
      process.stderr.write(`upstream-scan: unknown command "${command}"; use validate, render, targets <sha>…, or no command to scan\n`);
      process.exitCode = 2;
      return;
    }
    run(args, values);
    return;
  }
  scan({ date: values.date, head: values.head, fetch: !values['no-fetch'] });
}

module.exports = { conflictHints, collectTargets, pinnedGit, resolveHead, withHeadSnapshot, UPSTREAM_REF };

if (require.main === module) main();
