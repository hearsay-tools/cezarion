'use strict';

// Mentions the repository's admins once on an open `main-ci-failure` summary that has been
// open for 60 minutes (docs/sdlc/main-ci-repair.md § Escalation; hearsay-tools/cezarion#3293).
// The marker comment is the durable record: a later run finds it and writes nothing.
const MARKER = '<!-- cez-main-ci-escalation:v1 -->';
const AFTER_MS = 60 * 60 * 1000;

async function repositoryAdmins({ github, owner, repo }) {
  const collaborators = await github.paginate('GET /repos/{owner}/{repo}/collaborators', { owner, repo, permission: 'admin', per_page: 100 });
  return collaborators.filter((c) => c.permissions?.admin && c.type === 'User' && /^[\w-]+$/.test(c.login)).map((c) => c.login).sort();
}

async function escalateMainCiFailures({ github, owner, repo, now = Date.now(), log = () => {} }) {
  const issues = await github.paginate('GET /repos/{owner}/{repo}/issues', { owner, repo, labels: 'main-ci-failure', state: 'open', per_page: 100 });
  const due = issues.filter((i) => !i.pull_request && now - Date.parse(i.created_at) >= AFTER_MS);
  const result = { open: issues.length, due: due.length, mentioned: [] };
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
