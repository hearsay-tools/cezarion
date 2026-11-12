'use strict';

// Decisions of the Release workflow before anything is published: which commit is the
// candidate, which versions it takes, and whether the gates let it go
// (spec .ai/specs/2026-11-11-one-full-run-delivery-pipeline.md § Release,
// hearsay-tools/cezarion#3212). Pure helpers first; GitHub and npm reads are injected.
const { execFileSync } = require('node:child_process');
const { computeStableVersion, isReleaseBump } = require('../../packages/cezar/src/release/stable.ts');
const { blockerVersion, BLOCKER_LABEL } = require('./release-blocker.cjs');

const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;
const COOLDOWN_MS = 24 * 60 * 60 * 1000;
const SHA = /^[a-f0-9]{40}$/;

function identifiers(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version ?? '');
  if (!match) throw new Error(`Not a semantic version: ${version}`);
  return { core: match.slice(1, 4).map(Number), pre: match[4] ? match[4].split('.') : [] };
}

// Semantic version precedence, prerelease identifiers included.
function compareVersions(a, b) {
  const left = identifiers(a), right = identifiers(b);
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i] < right.core[i] ? -1 : 1;
  if (!left.pre.length || !right.pre.length) return right.pre.length - left.pre.length;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const [x, y] = [left.pre[i], right.pre[i]];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const [nx, ny] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (nx && ny) return Number(x) < Number(y) ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

const isStable = version => STABLE.test(version ?? '');
const patchAfter = version => {
  const [major, minor, patch] = identifiers(version).core;
  return `${major}.${minor}.${patch + 1}`;
};

// A failed candidate leaves its rc versions on the registry; the next dispatch of the
// same stable version takes the next number.
function nextCandidateVersion(version, versions) {
  const prefix = `${version}-rc.`;
  const taken = versions.filter(entry => entry.startsWith(prefix) && /^\d+$/.test(entry.slice(prefix.length)))
    .map(entry => Number(entry.slice(prefix.length)));
  return `${prefix}${taken.length ? Math.max(...taken) + 1 : 1}`;
}

// `next` never moves backwards: a maintenance-line candidate below it gets its own tag.
function candidateDistTag(candidate, distTags) {
  const current = distTags.next;
  if (!current || compareVersions(candidate, current) > 0) return 'next';
  const [major, minor] = identifiers(candidate).core;
  return `next-${major}.${minor}`;
}

// `latest` never moves backwards either: a maintenance release below it gets `latest-x.y`.
function stableDistTag(version, distTags) {
  const current = distTags.latest;
  if (!current || compareVersions(version, current) > 0) return 'latest';
  const [major, minor] = identifiers(version).core;
  return `latest-${major}.${minor}`;
}

function lastStablePublish(time) {
  const stamps = Object.entries(time ?? {}).filter(([version]) => isStable(version))
    .map(([, stamp]) => Date.parse(stamp)).filter(Number.isFinite);
  return stamps.length ? Math.max(...stamps) : null;
}

// Rollback version: the next patch above every stable version of the `latest` line.
function rollbackVersion(latest, versions) {
  const [major, minor] = identifiers(latest).core;
  const line = versions.filter(version => isStable(version)
    && identifiers(version).core[0] === major && identifiers(version).core[1] === minor);
  return patchAfter([latest, ...line].sort(compareVersions).at(-1));
}

function rollbackTag(latest, tags, requested) {
  const stableTags = tags.filter(tag => /^v\d+\.\d+\.\d+$/.test(tag)
    && compareVersions(tag.slice(1), latest) < 0).sort((a, b) => compareVersions(a.slice(1), b.slice(1)));
  if (requested) {
    if (!stableTags.includes(requested)) throw new Error(`Rollback target ${requested} is not a stable release tag below latest ${latest}.`);
    return requested;
  }
  if (!stableTags.length) throw new Error(`No stable release tag below latest ${latest} to roll back to.`);
  return stableTags.at(-1);
}

function parseIssueNumbers(text) {
  const parts = String(text ?? '').split(/[\s,]+/).filter(Boolean);
  const numbers = parts.map(part => part.replace(/^#/, ''));
  if (numbers.some(number => !/^[1-9]\d*$/.test(number))) throw new Error(`Expected issue numbers, got: ${text}`);
  return numbers.map(Number);
}

// A rollback is the remedy for a failed release, so the blocker the Release workflow
// filed for the release it replaces (the current `latest`) does not stop it. Every
// other blocker does, unless the owner names it in the dispatch.
function blockingIssues(issues, { rollback = false, latest, ignore = [] } = {}) {
  return issues.filter(issue => issue.state === 'open' && !issue.pull_request
    && (issue.labels ?? []).some(label => (label.name ?? label) === BLOCKER_LABEL))
    .filter(issue => {
      if (!rollback) return true;
      if (ignore.includes(issue.number)) return false;
      const version = blockerVersion(issue.body);
      return !(version && latest && compareVersions(version, latest) === 0);
    });
}

// The job that passes only when every test of the published nightly passed; a reusable
// workflow's jobs are named `<caller job> / <job>`.
const REHEARSAL_JOB = / \/ Release candidate result$/;

// One Nightly run's say on the rehearsal: 'failed', 'passed', or 'none' when it tested no
// published package (main had not moved, or the publish was a dry run).
function rehearsalOutcome(run, jobs) {
  if (run.conclusion !== 'success') return 'failed';
  return jobs.some(job => REHEARSAL_JOB.test(job.name) && job.conclusion === 'success') ? 'passed' : 'none';
}

// The newest Nightly that ran to an end and tested a published package decides; a
// cancelled run says nothing, and neither does a run that skipped the rehearsal.
async function rehearsalVerdict({ github, repo }) {
  const { data } = await github.rest.actions.listWorkflowRuns({ ...repo, workflow_id: 'nightly.yml', branch: 'main', per_page: 30 });
  const finished = data.workflow_runs.filter(run => run.status === 'completed' && !['cancelled', 'skipped'].includes(run.conclusion))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  for (const run of finished) {
    if (run.conclusion !== 'success') return { passed: false, reason: `The last Nightly rehearsal ended ${run.conclusion}: ${run.html_url}` };
    const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, { ...repo, run_id: run.id, filter: 'latest', per_page: 100 });
    if (rehearsalOutcome(run, jobs) === 'passed') return { passed: true, url: run.html_url };
  }
  return { passed: false, reason: 'No recent Nightly run tested a published package. Dispatch Nightly with NPM_TOKEN configured and let it pass first.' };
}

// Every `main` commit passed the full suite in the merge queue; the candidate is the
// newest first-parent commit whose own `ci.yml` push run passed.
function newestVerifiedCommit(firstParents, runs) {
  const verified = new Set(runs.filter(run => run.event === 'push' && run.head_branch === 'main'
    && run.status === 'completed' && run.conclusion === 'success').map(run => run.head_sha));
  return firstParents.find(sha => verified.has(sha)) ?? null;
}

async function readGates({ github, repo, rollback, latest, ignore }) {
  const issues = await github.paginate(github.rest.issues.listForRepo, { ...repo, state: 'open', labels: BLOCKER_LABEL, per_page: 100 });
  const blockers = blockingIssues(issues, { rollback, latest, ignore });
  const reasons = blockers.map(issue => `Open ${BLOCKER_LABEL} issue #${issue.number}: ${issue.html_url}`);
  // The rehearsal files a blocker when it fails; a rollback reads that blocker, not the run.
  if (!rollback) {
    const rehearsal = await rehearsalVerdict({ github, repo });
    if (!rehearsal.passed) reasons.push(rehearsal.reason);
  }
  return reasons;
}

async function verifiedMainCommit({ github, repo, git, head }) {
  const { data } = await github.rest.actions.listWorkflowRuns({ ...repo, workflow_id: 'ci.yml', branch: 'main', event: 'push', status: 'success', per_page: 100 });
  const firstParents = git('rev-list', '--first-parent', '--max-count=500', head).split('\n').filter(Boolean);
  const sha = newestVerifiedCommit(firstParents, data.workflow_runs);
  if (!sha) throw new Error('No commit on main has a passing ci.yml push run among its newest 100 successful runs.');
  return sha;
}

function npmView(name) {
  const out = execFileSync('npm', ['view', name, 'versions', 'time', 'dist-tags', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const data = JSON.parse(out);
  return { versions: data.versions ?? [], time: data.time ?? {}, distTags: data['dist-tags'] ?? {} };
}

function sourceVersion({ git, sha, bump, branch, registry }) {
  const base = JSON.parse(git('show', `${sha}:packages/cezar/package.json`)).version;
  const version = computeStableVersion(bump, base);
  if (!version) throw new Error(`Cannot ${bump}-bump base version ${base}.`);
  if (registry.versions.includes(version)) throw new Error(`${version} is already published. Merge its version-bump PR before a new release.`);
  const latest = registry.distTags.latest;
  if (branch === 'main' && latest && compareVersions(version, latest) <= 0) {
    throw new Error(`${version} is not above latest ${latest}. Merge the pending version-bump PR first.`);
  }
  return version;
}

function rollbackSource({ git, registry, rollbackTo }) {
  const latest = registry.distTags.latest;
  if (!latest) throw new Error('Nothing to roll back: no latest version on the registry.');
  const tag = rollbackTag(latest, git('tag', '--list', 'v*').split('\n').filter(Boolean), rollbackTo || '');
  return { sourceSha: git('rev-parse', `refs/tags/${tag}^{commit}`), version: rollbackVersion(latest, registry.versions) };
}

async function releaseSource({ github, context, git, registry, bump, branch, now }) {
  if (!isReleaseBump(bump)) throw new Error(`Unknown bump ${bump}.`);
  const last = lastStablePublish(registry.time);
  if (last !== null && now - last < COOLDOWN_MS) {
    throw new Error(`The last stable release was published ${new Date(last).toISOString()}. A second stable release within 24 hours is refused; use a rollback for a broken release.`);
  }
  const sourceSha = branch === 'main' ? await verifiedMainCommit({ github, repo: context.repo, git, head: context.sha }) : context.sha;
  return { sourceSha, version: sourceVersion({ git, sha: sourceSha, bump, branch, registry }) };
}

function planOutputs({ rollback, packageName, sourceSha, version, registry, context, inputs, branch, ignore }) {
  const candidate = nextCandidateVersion(version, registry.versions);
  return {
    mode: rollback ? 'rollback' : 'release',
    package: packageName,
    source_sha: sourceSha,
    dispatch_sha: context.sha,
    version,
    stable_tag: stableDistTag(version, registry.distTags),
    candidate,
    candidate_tag: candidateDistTag(candidate, registry.distTags),
    previous: registry.distTags.latest ?? '',
    needs_suite: String(!rollback && branch !== 'main'),
    ignore_blockers: ignore.join(','),
    // The bump PR records the version on the dispatched branch: from the candidate commit,
    // or for a rollback from the dispatch commit, since the old commit's tree is history.
    record_bump: String(rollback || inputs.bump !== 'existing'),
    bump_sha: rollback ? context.sha : sourceSha,
    bump_dir: rollback ? '.' : 'source',
  };
}

async function planRelease({ github, context, inputs, packageName, now = Date.now(), git, view = npmView }) {
  const branch = context.ref.replace(/^refs\/heads\//, '');
  if (branch !== 'main' && !branch.startsWith('release/')) throw new Error('Dispatch the Release workflow from main or a release/** branch.');
  const rollback = inputs.rollback === true || inputs.rollback === 'true';
  const ignore = parseIssueNumbers(inputs.ignoreBlockers);
  if (ignore.length && !rollback) throw new Error('Only a rollback can name blockers that do not affect it.');
  const registry = view(packageName);
  const { sourceSha, version } = rollback
    ? rollbackSource({ git, registry, rollbackTo: inputs.rollbackTo })
    : await releaseSource({ github, context, git, registry, bump: inputs.bump, branch, now });
  if (!SHA.test(sourceSha)) throw new Error('The candidate commit did not resolve.');
  const reasons = await readGates({ github, repo: context.repo, rollback, latest: registry.distTags.latest, ignore });
  if (reasons.length) throw new Error(`Release refused:\n- ${reasons.join('\n- ')}`);
  return planOutputs({ rollback, packageName, sourceSha, version, registry, context, inputs, branch, ignore });
}

// Called again immediately before the promotion: a blocker opened during the candidate
// tests stops the release.
async function recheckGates({ github, context, mode, previous, ignoreBlockers }) {
  const reasons = await readGates({ github, repo: context.repo, rollback: mode === 'rollback', latest: previous || undefined, ignore: parseIssueNumbers(ignoreBlockers) });
  if (reasons.length) throw new Error(`Promotion refused:\n- ${reasons.join('\n- ')}`);
}

module.exports = {
  compareVersions, nextCandidateVersion, candidateDistTag, stableDistTag, lastStablePublish, rollbackVersion, rollbackTag,
  parseIssueNumbers, blockingIssues, rehearsalOutcome, rehearsalVerdict, newestVerifiedCommit, verifiedMainCommit, npmView,
  planRelease, recheckGates, COOLDOWN_MS,
};
