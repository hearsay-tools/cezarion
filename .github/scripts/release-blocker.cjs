'use strict';

// Files the `release-blocker` issue for a failed release candidate, a failed promotion
// or a failed Nightly rehearsal. One open issue per release version, and one for the
// rehearsal: a repeat adds a comment. The marker records the version, so a rollback
// can tell the blocker of the release it replaces from every other blocker.
const { execFileSync } = require('node:child_process');

const BLOCKER_LABEL = 'release-blocker';
const MARKER = /<!-- cez-release-blocker:v1:(release|rehearsal):([0-9A-Za-z.-]+) -->/;

const marker = (kind, key) => `<!-- cez-release-blocker:v1:${kind}:${key} -->`;

function blockerVersion(body) {
  const match = MARKER.exec(body ?? '');
  return match && match[1] === 'release' ? match[2] : null;
}

function blockerKey({ kind, version }) {
  if (kind === 'release') {
    if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('A release blocker needs the stable version.');
    return version;
  }
  if (kind === 'rehearsal') return 'nightly';
  throw new Error(`Unknown blocker kind ${kind}`);
}

function issueBody({ kind, version, stage, runUrl, key }) {
  const what = kind === 'release'
    ? `The Release workflow stopped release \`${version}\` at: ${stage}.`
    : `The Nightly rehearsal failed at: ${stage}.`;
  return [
    marker(kind, key),
    '## Context / Why', '',
    what, `While this issue is open, the Release workflow refuses every stable release.`, '',
    `- [Failed run](${runUrl})`, '',
    '## What needs to be done', '',
    '- Read the failed jobs of the run and find the cause.',
    kind === 'release'
      ? '- If the stable version is already on `latest` and is broken, dispatch Release with `rollback` (docs/publishing.md § Rolling back). This blocker does not stop that rollback.'
      : '- Fix the cause, then dispatch Nightly and let the rehearsal pass.',
    '- Close this issue when the cause is fixed.', '',
    '## Acceptance Criteria', '',
    '- [ ] The cause is fixed or shown to be unrelated to the release',
    '- [ ] The next run of the failed workflow passes', '',
  ].join('\n');
}

// Whether any name already carries the version: a publish that stopped before the first
// name left nothing to block, and a rerun retries it.
function publishedSome({ names, version, view = viewVersion }) {
  return String(names ?? '').split(',').filter(Boolean).some(name => view(name, version));
}

function viewVersion(name, version) {
  try {
    return execFileSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() === version;
  } catch (error) {
    if (/\bE404\b/.test(`${error.stdout ?? ''}${error.stderr ?? ''}`)) return false;
    throw error;
  }
}

async function fileReleaseBlocker({ github, repo, kind, version, stage, runUrl }) {
  const key = blockerKey({ kind, version });
  const tag = marker(kind, key);
  const open = await github.paginate(github.rest.issues.listForRepo, { ...repo, state: 'open', labels: BLOCKER_LABEL, per_page: 100 });
  const existing = open.find(issue => !issue.pull_request && (issue.body ?? '').includes(tag));
  const comment = `Another failure at: ${stage}. [Run](${runUrl})`;
  if (existing) {
    await github.rest.issues.createComment({ ...repo, issue_number: existing.number, body: comment });
    return { number: existing.number, url: existing.html_url, created: false };
  }
  const title = kind === 'release' ? `Release ${version} blocked: ${stage}` : `Nightly rehearsal failed: ${stage}`;
  const { data } = await github.rest.issues.create({
    ...repo, title, labels: [BLOCKER_LABEL, 'area-ci'], body: issueBody({ kind, version, stage, runUrl, key }),
  });
  return { number: data.number, url: data.html_url, created: true };
}

module.exports = { BLOCKER_LABEL, blockerVersion, fileReleaseBlocker, marker, publishedSome };
