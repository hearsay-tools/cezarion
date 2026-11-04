// Trusted CI code. PR trees are Git data and are never checked out or executed.
const { execFileSync } = require('node:child_process');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 << 20, stdio: 'pipe' });
}

function binaryPaths(numstat) {
  const paths = new Set();
  for (const row of numstat.split('\0').filter(Boolean)) {
    const first = row.indexOf('\t');
    const second = row.indexOf('\t', first + 1);
    if (row.slice(0, second) === '-\t-') paths.add(row.slice(second + 1));
  }
  return paths;
}

function missingPatches(files, binaries, changedFiles) {
  const reasons = [];
  if (files.length !== changedFiles || files.length >= 3000) {
    reasons.push(`GitHub's PR file list is incomplete or reaches its 3000-file limit (${files.length} returned, ${changedFiles} changed). Split the PR so GitHub can return every file.`);
  }
  for (const file of files) {
    if (typeof file.patch === 'string' || binaries.has(file.filename)) continue;
    if (['renamed', 'copied'].includes(file.status) && file.additions === 0 && file.deletions === 0) continue;
    reasons.push(`${JSON.stringify(file.filename)}: ${file.status}, +${file.additions}/-${file.deletions}, has no GitHub patch. Split the PR so each file's diff is small enough for GitHub to return a patch.`);
  }
  return reasons;
}

function sameRevision(pr, expected) {
  if (pr.head.sha !== expected.head.sha || pr.base.sha !== expected.base.sha) {
    throw new Error('PR head or base changed during the patch check; run CI for the current revision.');
  }
}

async function checkPullRequest({ github, context, core, cwd = process.cwd() }) {
  const expected = context.payload.pull_request;
  if (context.eventName !== 'pull_request_target' || expected.base.ref !== 'main') return;
  const params = { ...context.repo, pull_number: expected.number };
  const { data: pr } = await github.rest.pulls.get(params);
  sameRevision(pr, expected);
  const files = await github.paginate(github.rest.pulls.listFiles, { ...params, per_page: 100 });
  git(cwd, 'fetch', '--no-tags', 'origin', `refs/pull/${expected.number}/head`);
  if (git(cwd, 'rev-parse', 'FETCH_HEAD').trim() !== expected.head.sha) {
    throw new Error('PR head changed during fetch; run CI for the current revision.');
  }
  // Disable renames so -z numstat always has one literal destination path per row.
  // Removed binary paths and binary rename destinations are both classified.
  const binaries = binaryPaths(git(cwd, 'diff', '--no-ext-diff', '--no-textconv',
    '--no-renames', '--numstat', '-z', `${expected.base.sha}...${expected.head.sha}`, '--'));
  const { data: current } = await github.rest.pulls.get(params);
  sameRevision(current, expected);
  const reasons = missingPatches(files, binaries, pr.changed_files);
  for (const reason of reasons) core.info(reason);
  if (reasons.length) {
    // No error annotations: the CI sweep groups identical errors across PRs.
    process.exitCode = 1;
  } else core.info('GitHub returned a patch for every changed text file.');
  return reasons;
}

module.exports = { binaryPaths, missingPatches, checkPullRequest };
