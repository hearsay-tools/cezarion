// Trusted CI code. PR trees are Git data and are never checked out or executed.
const { execFileSync } = require('node:child_process');
const { devNull } = require('node:os');

// The largest local `git diff` of one file that GitHub still returns as a patch. Measured on
// this repository's PRs; docs/sdlc/ci.md § GitHub patch limits names it, and scripts/prepr.mjs reads it.
const GITHUB_PATCH_LIMITS = Object.freeze({ fileBytes: 102_400 });

// The `git` arguments that give GitHub's patch shape, whatever the user's settings: each
// diff.*, color.* or core.* key in `git help -c` that changes a patch's bytes or makes Git
// call a text file binary is pinned here. Renames, where a caller turns them on, use git's
// default limit of 1000.
const PATCH_DIFF = Object.freeze(['-c', 'diff.suppressBlankEmpty=false', '-c', 'core.quotePath=true',
  '-c', 'core.abbrev=7', '-c', 'core.bigFileThreshold=512m', '-c', `core.attributesFile=${devNull}`,
  'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-relative', '--unified=3',
  '--inter-hunk-context=0', '--diff-algorithm=myers', '--indent-heuristic', '--src-prefix=a/',
  '--dst-prefix=b/', '--submodule=short', '--ignore-submodules=none', '-l1000', `-O${devNull}`]);

// The environment for a patch read: without the variables `git help git` lists as changing
// diff output, so they cannot override PATCH_DIFF.
function patchEnv(env = process.env) {
  const { GIT_DIFF_OPTS, GIT_EXTERNAL_DIFF, ...rest } = env;
  return rest;
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 << 20, stdio: 'pipe' });
}

function gitBytes(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: patchEnv(), maxBuffer: 256 << 20, stdio: 'pipe' });
}

/** Size and NUL presence of one file's local patch (a Buffer). */
function patchFacts(patch) {
  return { bytes: patch.length, nul: patch.includes(0) };
}

/** Rows of `git diff --numstat -z` with renames on: a rename row names its old and new path. */
function numstatRows(numstat) {
  const tokens = numstat.split('\0');
  const rows = [];
  for (let i = 0; i < tokens.length && tokens[i]; i++) {
    const [, added, deleted, path] = /^([^\t]*)\t([^\t]*)\t(.*)$/s.exec(tokens[i]);
    const paths = path === '' ? [tokens[++i], tokens[++i]] : [path];
    rows.push({ added, deleted, paths });
  }
  return rows;
}

const FILE_HEADER = Buffer.from('diff --git ');

/** One whole-range patch split at each file header. A content line starts with +, - or space. */
function splitPatches(patch) {
  const starts = patch.subarray(0, FILE_HEADER.length).equals(FILE_HEADER) ? [0] : [];
  const boundary = Buffer.concat([Buffer.from('\n'), FILE_HEADER]);
  for (let at = patch.indexOf(boundary); at !== -1; at = patch.indexOf(boundary, at + 1)) starts.push(at + 1);
  return starts.map((start, k) => patch.subarray(start, starts[k + 1] ?? patch.length));
}

/** Status letters of `git diff --name-status -z`, one per changed file; R and C name two paths. */
function statusLetters(nameStatus) {
  const tokens = nameStatus.split('\0');
  const letters = [];
  for (let i = 0; i < tokens.length && tokens[i]; i += /^[RC]/.test(tokens[i]) ? 3 : 2) letters.push(tokens[i][0]);
  return letters;
}

/**
 * Each changed file's numstat counts, paths and patch facts, with renames on as on GitHub.
 * Whole-range reads in Git's one file order, so no pathspec can select a second file. A type
 * change (T) is one file with two patch blocks: its facts cover both.
 * `read(args)` runs git with those arguments and returns its stdout as a Buffer.
 */
function localPatches(read, from, to) {
  const range = [...PATCH_DIFF, '--find-renames'];
  const rows = numstatRows(read([...range, '--numstat', '-z', from, to]).toString('utf8'));
  const letters = statusLetters(read([...range, '--name-status', '-z', from, to]).toString('utf8'));
  const patches = splitPatches(read([...range, from, to]));
  const blocks = letters.reduce((sum, letter) => sum + (letter === 'T' ? 2 : 1), 0);
  if (letters.length !== rows.length || patches.length !== blocks) {
    throw new Error(`git diff gave ${patches.length} patch blocks and ${letters.length} statuses for ${rows.length} changed files`);
  }
  let next = 0;
  return rows.map((row, k) => {
    const own = patches.slice(next, next += letters[k] === 'T' ? 2 : 1);
    return { ...row, facts: patchFacts(Buffer.concat(own)) };
  });
}

/** Why GitHub returned no patch for a file, from its local patch facts. */
function patchCause(facts, totalLines) {
  if (!facts) return 'no local diff was read to classify it';
  if (facts.nul) return 'its local diff contains a NUL byte, and GitHub returns no patch for one';
  if (facts.bytes > GITHUB_PATCH_LIMITS.fileBytes) {
    return `its local diff is ${facts.bytes} bytes, over GitHub's ${GITHUB_PATCH_LIMITS.fileBytes}-byte per-file patch limit`;
  }
  return `its local diff is ${facts.bytes} bytes with no NUL byte, under every per-file limit, so GitHub probably dropped it for the PR's total size (${totalLines} changed lines)`;
}

function totals(files) {
  const added = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deleted = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  return { added, deleted, lines: added + deleted };
}

function limitSummary(files) {
  const { added, deleted, lines } = totals(files);
  return `GitHub returns no patch for a file diff over ${GITHUB_PATCH_LIMITS.fileBytes} bytes or one with a NUL byte, and can drop patches when a PR's total diff is large. This PR changes ${lines} lines (+${added}/-${deleted}) in ${files.length} file${files.length === 1 ? '' : 's'}.`;
}

function diffStats(numstat) {
  const paths = new Map();
  for (const row of numstat.split('\0').filter(Boolean)) {
    const first = row.indexOf('\t');
    const second = row.indexOf('\t', first + 1);
    paths.set(row.slice(second + 1), { added: row.slice(0, first), deleted: row.slice(first + 1, second) });
  }
  return paths;
}

function missingPatches(files, stats, changedFiles, local = new Map()) {
  const reasons = [];
  if (files.length !== changedFiles || files.length >= 3000) {
    reasons.push(`GitHub's PR file list is incomplete or reaches its 3000-file limit (${files.length} returned, ${changedFiles} changed). Split the PR so GitHub can return every file.`);
  }
  for (const file of files) {
    if (typeof file.patch === 'string') continue;
    const counts = stats.get(file.filename);
    if (counts?.added === '-' && counts.deleted === '-') continue;
    if (file.additions === 0 && file.deletions === 0 && counts?.added === '0' && counts.deleted === '0') continue;
    if (['renamed', 'copied'].includes(file.status) && file.additions === 0 && file.deletions === 0) continue;
    const cause = patchCause(local.get(file.filename), totals(files).lines);
    reasons.push(`${JSON.stringify(file.filename)}: ${file.status}, +${file.additions}/-${file.deletions}, has no GitHub patch: ${cause}. Split the PR so each file's diff is small enough for GitHub to return a patch.`);
  }
  if (reasons.length) reasons.push(limitSummary(files));
  return reasons;
}

function sameRevision(pr, expected) {
  return pr.head.sha === expected.head.sha && pr.base.sha === expected.base.sha;
}

function report(core, reasons) {
  for (const reason of reasons) core.info(reason);
  // No error annotations: the CI sweep groups identical errors across PRs.
  if (reasons.length) process.exitCode = 1;
  else core.info('GitHub returned a patch for every changed text file.');
  return reasons;
}

async function checkPullRequest({ github, context, core, cwd = process.cwd() }) {
  const expected = context.payload.pull_request;
  if (context.eventName !== 'pull_request_target') return;
  const params = { ...context.repo, pull_number: expected.number };
  const { data: pr } = await github.rest.pulls.get(params);
  if (!sameRevision(pr, expected)) return report(core, ['PR head or base changed during the patch check; run CI for the current revision.']);
  const files = await github.paginate(github.rest.pulls.listFiles, { ...params, per_page: 100 });
  git(cwd, 'fetch', '--no-tags', 'origin', expected.head.sha);
  if (git(cwd, 'rev-parse', 'FETCH_HEAD').trim() !== expected.head.sha) {
    return report(core, ['PR head changed during fetch; run CI for the current revision.']);
  }
  // Disable renames so -z numstat always has one literal destination path per row.
  // Removed binary paths and binary rename destinations are both classified.
  const mergeBase = git(cwd, 'merge-base', context.sha, expected.head.sha).trim();
  const stats = diffStats(git(cwd, 'diff', '--no-ext-diff', '--no-textconv',
    '--no-renames', '--numstat', '-z', `${mergeBase}...${expected.head.sha}`, '--'));
  const local = files.some(file => typeof file.patch !== 'string')
    ? new Map(localPatches(args => gitBytes(cwd, ...args), mergeBase, expected.head.sha).map(row => [row.paths.at(-1), row.facts]))
    : new Map();
  const { data: current } = await github.rest.pulls.get(params);
  if (!sameRevision(current, expected)) return report(core, ['PR head or base changed during the patch check; run CI for the current revision.']);
  return report(core, missingPatches(files, stats, pr.changed_files, local));
}

module.exports = { GITHUB_PATCH_LIMITS, PATCH_DIFF, patchEnv, diffStats, numstatRows, statusLetters, splitPatches, localPatches, patchFacts, patchCause, missingPatches, checkPullRequest };
