// Trusted CI code: inspect Git blobs as JSON/text; never load code from the head.
const { execFileSync } = require('node:child_process');

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Arrays are multisets: each head entry must fit a distinct base entry. Matching
// can reassign a prior choice so reordered duplicate sites with different counts
// do not report growth. Object keys and numeric limits may only shrink.
function arrayFits(before, after) {
  const owners = new Map();
  function assign(index, seen) {
    for (let i = 0; i < before.length; i++) {
      if (seen.has(i) || compareBaseline(before[i], after[index]).length) continue;
      seen.add(i);
      if (!owners.has(i) || assign(owners.get(i), seen)) {
        owners.set(i, index);
        return true;
      }
    }
    return false;
  }
  return after.every((_, i) => assign(i, new Set()));
}

function compareBaseline(before, after, location = '$') {
  if (typeof before === 'number' && typeof after === 'number') {
    return after <= before ? [] : [`${location}: number grew from ${before} to ${after}`];
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    return arrayFits(before, after) ? [] : [`${location}: added or enlarged an entry`];
  }
  if (object(before) && object(after)) {
    return Object.keys(after).filter(key => key !== '$comment').flatMap(key =>
      Object.hasOwn(before, key)
        ? compareBaseline(before[key], after[key], `${location}.${key}`)
        : [`${location}.${key}: added an entry`]);
  }
  return before === after ? [] : [`${location}: changed an entry or its type`];
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 << 20, stdio: 'pipe' });
}

function tree(cwd, rev) {
  return git(cwd, 'ls-tree', '-r', '--name-only', '-z', rev).split('\0').filter(Boolean);
}

function readBaseline(cwd, rev, file) {
  return JSON.parse(git(cwd, 'show', `${rev}:${file}`));
}

// Conservative literal-reader scan, including test helpers and scripts. A source
// reference to a removed basename must go too; comments can also block deletion.
// This is static evidence, not execution or a proof about computed filenames.
function deletedReaders(cwd, head, deleted) {
  const patterns = deleted.flatMap(file => ['-e', file.slice(file.lastIndexOf('/') + 1)]);
  try {
    return git(cwd, 'grep', '-I', '-l', '-z', '-F', ...patterns, head, '--',
      '*.js', '*.cjs', '*.mjs', '*.jsx', '*.ts', '*.cts', '*.mts', '*.tsx')
      .split('\0').filter(Boolean).map(file => file.slice(head.length + 1));
  } catch (error) {
    if (error.status === 1) return []; // No literal readers remain.
    throw error;
  }
}

function checkBaselineGrowth({ cwd = process.cwd(), base, head, allowGrowth = false }) {
  const beforeFiles = tree(cwd, base).filter(file => file.endsWith('.baseline.json'));
  const headFiles = tree(cwd, head);
  const afterFiles = new Set(headFiles.filter(file => file.endsWith('.baseline.json')));
  const reasons = [];
  for (const file of afterFiles) {
    const after = readBaseline(cwd, head, file); // New and overridden files must still be valid JSON.
    if (!beforeFiles.includes(file)) continue; // A new file starts a new ratchet.
    const changes = compareBaseline(readBaseline(cwd, base, file), after);
    if (!allowGrowth) reasons.push(...changes.map(change => `${file}: ${change}`));
  }
  const deleted = beforeFiles.filter(file => !afterFiles.has(file));
  if (deleted.length) {
    reasons.push(...deletedReaders(cwd, head, deleted)
      .map(file => `deleted baseline still referenced by ${file}`));
  }
  return reasons;
}

// Called only after the workflow checks out the trusted base. The head is fetched
// into the object store and is never checked out. Live metadata supplies the label.
async function checkPullRequest({ github, context, core, cwd = process.cwd() }) {
  const dispatched = context.eventName === 'workflow_dispatch';
  if (context.eventName !== 'pull_request_target' && !dispatched) return;
  const number = dispatched ? Number(context.payload.inputs.pr_number) : context.payload.pull_request.number;
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid PR number');
  const expectedHead = dispatched ? context.sha : context.payload.pull_request.head.sha;
  const base = dispatched ? git(cwd, 'rev-parse', 'HEAD').trim() : context.payload.pull_request.base.sha;
  const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: number });
  if (pr.head.sha !== expectedHead || pr.base.sha !== base) throw new Error('PR changed; rerun CI for the current head/base');
  git(cwd, 'fetch', '--no-tags', 'origin', `refs/pull/${number}/head`);
  const fetched = git(cwd, 'rev-parse', 'FETCH_HEAD').trim();
  if (fetched !== expectedHead) throw new Error('PR changed during fetch; rerun CI');
  // GitHub never moves the event's base.sha when the base branch advances. Measure from the
  // branch tip this workflow runs from, so commits the head took from that branch stay out.
  const mergeBase = git(cwd, 'merge-base', dispatched ? base : context.sha, fetched).trim();
  const allowGrowth = pr.labels.some(label => label.name === 'baseline-growth');
  const reasons = checkBaselineGrowth({ cwd, base: mergeBase, head: fetched, allowGrowth });
  if (reasons.length) core.setFailed(`${reasons.join('\n')}\nFor an owner-approved increase, add the baseline-growth label, then re-run the failed classify-pr job. Deletion readers and invalid JSON must still be fixed.`);
  else core.info(allowGrowth ? 'Baseline growth approved by label; owner merge required.' : 'Baseline ratchets did not grow.');
}

module.exports = { compareBaseline, checkBaselineGrowth, checkPullRequest };
