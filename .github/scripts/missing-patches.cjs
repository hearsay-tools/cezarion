// Trusted CI code. PR trees are Git data and are never checked out or executed.
const { execFileSync } = require('node:child_process');

// The largest local `git diff` of one file that GitHub still returns as a patch. Measured on
// this repository's PRs; docs/sdlc/ci.md § GitHub patch limits names it, and scripts/prepr.mjs reads it.
const GITHUB_PATCH_LIMITS = Object.freeze({ fileBytes: 102_400 });

// The `git diff` options that give GitHub's patch shape, whatever the user's diff settings.
const PATCH_SHAPE = Object.freeze(['--no-ext-diff', '--no-textconv', '--no-color', '--unified=3',
  '--diff-algorithm=myers', '--src-prefix=a/', '--dst-prefix=b/']);

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 << 20, stdio: 'pipe' });
}

function gitBytes(cwd, ...args) {
  return execFileSync('git', args, { cwd, maxBuffer: 256 << 20, stdio: 'pipe' });
}

/** Size and NUL presence of one file's local patch (a Buffer). */
function patchFacts(patch) {
  return { bytes: patch.length, nul: patch.includes(0) };
}

// A rename is measured as GitHub shows it: the patch between the old and the new path.
function localPatch(cwd, from, to, file) {
  const paths = file.previous_filename ? [file.previous_filename, file.filename] : [file.filename];
  const renames = file.previous_filename ? '--find-renames' : '--no-renames';
  return gitBytes(cwd, 'diff', ...PATCH_SHAPE, renames, from, to, '--', ...paths);
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
  const local = new Map(files.filter(file => typeof file.patch !== 'string')
    .map(file => [file.filename, patchFacts(localPatch(cwd, mergeBase, expected.head.sha, file))]));
  const { data: current } = await github.rest.pulls.get(params);
  if (!sameRevision(current, expected)) return report(core, ['PR head or base changed during the patch check; run CI for the current revision.']);
  return report(core, missingPatches(files, stats, pr.changed_files, local));
}

module.exports = { GITHUB_PATCH_LIMITS, PATCH_SHAPE, diffStats, patchFacts, patchCause, missingPatches, checkPullRequest };
