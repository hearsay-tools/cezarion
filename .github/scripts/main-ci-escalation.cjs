'use strict';

// Closes an open `main-ci-failure` summary once a later main CI run passed, and mentions the
// repository's admins once on a summary that has been open for 60 minutes
// (docs/sdlc/main-ci-repair.md § Closing and escalation; hearsay-tools/cezarion#3293).
// The marker comment is the durable record: a later run finds it and writes nothing.
const MARKER = '<!-- cez-main-ci-escalation:v1 -->';
const AFTER_MS = 60 * 60 * 1000;

async function repositoryAdmins({ github, owner, repo }) {
  const collaborators = await github.paginate('GET /repos/{owner}/{repo}/collaborators', { owner, repo, permission: 'admin', per_page: 100 });
  return collaborators.filter((c) => c.permissions?.admin && c.type === 'User' && /^[\w-]+$/.test(c.login)).map((c) => c.login).sort();
}

// The run attempt a summary repairs, from the reporter's marker (main-ci-summary.cjs).
// A legacy individual report has none.
function summaryAttempt(issue) {
  const match = /<!-- cez-main-ci-attempt:v1:[\w.-]+\/[\w.-]+:(\d+):(\d+) -->/.exec(issue.body || '');
  return match && { id: Number(match[1]), attempt: Number(match[2]) };
}

// Main is repaired once a later CI push run on main passed. The summary closes; its member
// reports stay open for their causes.
async function closeGreenSummaries({ github, owner, repo, issues, log }) {
  const summaries = issues.filter((i) => !i.pull_request && summaryAttempt(i));
  if (summaries.length === 0) return [];
  const { data } = await github.request('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs', {
    owner, repo, workflow_id: 'ci.yml', branch: 'main', event: 'push', status: 'success', exclude_pull_requests: true, per_page: 1,
  });
  const green = data.workflow_runs?.[0];
  if (!green) return [];
  const closed = [];
  for (const issue of summaries) {
    const { id, attempt } = summaryAttempt(issue);
    if (green.id < id || (green.id === id && green.run_attempt <= attempt)) continue;
    const body = `Main CI passed after this attempt: [run ${green.id} attempt ${green.run_attempt}](${green.html_url}) at commit ${green.head_sha}. This summary closes. Its linked reports stay open for their causes.`;
    await github.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { owner, repo, issue_number: issue.number, body });
    await github.request('PATCH /repos/{owner}/{repo}/issues/{issue_number}', { owner, repo, issue_number: issue.number, state: 'closed', state_reason: 'completed' });
    closed.push(issue.number);
    log(`Closed #${issue.number}: main CI passed in run ${green.id}.`);
  }
  return closed;
}

async function escalateMainCiFailures({ github, owner, repo, now = Date.now(), log = () => {} }) {
  const listed = await github.paginate('GET /repos/{owner}/{repo}/issues', { owner, repo, labels: 'main-ci-failure', state: 'open', per_page: 100 });
  const closed = await closeGreenSummaries({ github, owner, repo, issues: listed, log });
  const issues = listed.filter((i) => !closed.includes(i.number));
  const due = issues.filter((i) => !i.pull_request && now - Date.parse(i.created_at) >= AFTER_MS);
  const result = { open: issues.length, due: due.length, closed, mentioned: [] };
  if (due.length === 0) return result;
  // Read the owners before any write: with none, fail visibly and let the next run retry.
  const admins = await repositoryAdmins({ github, owner, repo });
  if (admins.length === 0) throw new Error('No repository admin to mention.');
  for (const issue of due) {
    const comments = await github.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', { owner, repo, issue_number: issue.number, per_page: 100 });
    if (comments.some((c) => String(c.body).includes(MARKER))) continue;
    const body = `${admins.map((a) => `@${a}`).join(' ')} This main CI failure summary has been open for 60 minutes. The repair automation may be stopped or waiting for a decision.\n\n${MARKER}`;
    await github.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { owner, repo, issue_number: issue.number, body });
    result.mentioned.push(issue.number);
    log(`Mentioned the owner on #${issue.number}.`);
  }
  return result;
}

module.exports = { escalateMainCiFailures, MARKER, AFTER_MS };
