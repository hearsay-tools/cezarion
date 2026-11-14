'use strict';
// All consumers use this live reader. Native Actions checks remain the protected
// checks; success or the exact trusted no-files decision supplies provider
// admission. Neither decision proves finding settlement.
const { reader, pages, validSha, positive, newest } = require('./queue-ci-proof.cjs');
const { listReviewThreads } = require('./review-threads.cjs');
const { isBotReleaseBumpPr, isAppUpstreamScanPr, filesAreVersionStampsOnly } = require('./release-bump-pr.cjs');
const APP_ID = 347564, APP_SLUG = 'coderabbitai', CHECK_NAME = 'CodeRabbit';
const trustedCheck = check => check?.app?.id === APP_ID && check.app.slug === APP_SLUG && check.name === CHECK_NAME;
function validPull(pr, fullName, pullNumber, head) {
  return pr?.number === pullNumber && pr.state === 'open' && pr.head?.sha === head
    && typeof pr.head.ref === 'string' && typeof pr.head.repo?.full_name === 'string'
    && pr.base?.ref === 'main' && pr.base.repo?.full_name === fullName && validSha(pr.base.sha);
}
async function pullFiles(read, pr) {
  if (!positive(pr.changed_files) || pr.changed_files > 200) throw new Error('Incomplete exception files');
  const files = [];
  for (let page = 1; page <= 2; page++) {
    const rows = await read('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', { pull_number: pr.number, page, per_page: 100 });
    if (!Array.isArray(rows) || rows.some(f => typeof f?.filename !== 'string' || typeof f.status !== 'string')) {
      throw new Error('Malformed exception files');
    }
    files.push(...rows);
    if (files.length === pr.changed_files && new Set(files.map(f => f.filename)).size === files.length) return files;
    if (files.length > pr.changed_files || rows.length !== 100) break;
  }
  throw new Error('Incomplete exception files');
}
async function verifiedException(read, pr, fullName, releaseAppBotLogin) {
  // Avoid file/content requests on ordinary PRs. Identity is only a prefilter.
  if (pr.head.repo.full_name !== fullName || !/^(release\/v|upstream-scan\/)/.test(pr.head.ref)) return null;
  const files = await pullFiles(read, pr);
  const paths = files.map(f => f.filename);
  const input = { headRef: pr.head.ref, prAuthor: pr.user?.login, files: paths, releaseAppBotLogin };
  // A rename must not hide a removed path outside the exception's allowlist.
  if (files.some(f => f.status === 'renamed' || f.previous_filename)) return null;
  if (isAppUpstreamScanPr(input)) return 'upstream-ledger';
  if (!isBotReleaseBumpPr(input)) return null;
  const contents = new Map();
  for (const path of paths) {
    for (const ref of [pr.base.sha, pr.head.sha]) {
      const file = await read('GET /repos/{owner}/{repo}/contents/{path}', { path, ref });
      if (file?.encoding !== 'base64' || typeof file.content !== 'string' || file.type !== 'file'
        || file.truncated === true || !positive(file.size) || file.size > 2000000) throw new Error('Incomplete release contents');
      const bytes = Buffer.from(file.content, 'base64');
      if (bytes.length !== file.size) throw new Error('Truncated release contents');
      const text = bytes.toString('utf8');
      contents.set(`${ref}:${path}`, path === 'pnpm-lock.yaml' ? text : JSON.parse(text));
    }
  }
  const readFile = ({ ref, path }) => contents.get(`${ref}:${path}`);
  return filesAreVersionStampsOnly({ repository: fullName, files: paths, baseRef: pr.base.sha,
    headRef: pr.head.sha, readJsonFile: readFile, readTextFile: readFile }) ? 'release-stamps' : null;
}
async function providerCheck(read, head) {
  const checks = await pages(read, 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs',
    { ref: head, filter: 'all', check_name: CHECK_NAME, app_id: APP_ID }, 'check_runs');
  const candidates = checks.filter(trustedCheck);
  if (candidates.some(c => !positive(c.id) || c.head_sha !== head || typeof c.status !== 'string')
    || new Set(checks.map(c => c.id)).size !== checks.length) throw new Error('Malformed provider execution');
  return newest(candidates);
}
const fingerprint = check => JSON.stringify(check && [check.id, check.head_sha, check.status, check.conclusion,
  check.started_at, check.completed_at, check.app.id, check.app.slug, check.name, check.output?.title]);
function stablePull(pr, final, fullName, pullNumber, head) {
  return validPull(final, fullName, pullNumber, head) && final.base.sha === pr.base.sha
    && final.changed_files === pr.changed_files && final.head.ref === pr.head.ref && final.user?.login === pr.user?.login
    && final.head.repo.full_name === pr.head.repo.full_name;
}
function providerState(check) {
  if (!check) return 'missing';
  if (['queued', 'in_progress'].includes(check.status)) return 'pending';
  if (check.status !== 'completed') return 'unknown';
  if (check.conclusion === 'skipped' && check.output?.title === 'No files to review') return 'no-files';
  return ['success', 'skipped', 'neutral', 'failure', 'cancelled', 'timed_out', 'action_required', 'stale']
    .includes(check.conclusion) ? check.conclusion : 'unknown';
}
function providerAction(state, openThreads) {
  const actions = openThreads ? ['Resolve every open review thread.'] : [];
  if (state === 'pending') actions.push('Wait for the current CodeRabbit execution to complete.');
  else if (!['success', 'no-files', 'exception'].includes(state)) {
    actions.push('Inspect the trusted CodeRabbit check and App installation; repair the provider or request @coderabbitai full review manually.');
  }
  return actions.join(' ');
}
function admissionResult(check, exception, threads, head) {
  const openThreads = threads.filter(t => !t.isResolved).length;
  const state = exception ? 'exception' : providerState(check);
  const accepted = ['exception', 'success', 'no-files'].includes(state);
  return { admitted: Boolean(accepted && openThreads === 0), head, checkId: check?.id ?? null, exception,
    providerStartedAt: check?.started_at ?? null, providerState: state, action: providerAction(state, openThreads),
    reason: openThreads ? 'unresolved-threads' : accepted ? 'admitted' : `provider-${state}` };
}
async function readCodeRabbitAdmission({ github, owner, repo, pullNumber, head, releaseAppBotLogin,
  now = Date.now, sleep, deadline = now() + 60000 }) {
  if (!positive(pullNumber) || !validSha(head)) throw new Error('Invalid review identity');
  const read = reader(github, owner, repo, deadline, now, sleep), fullName = `${owner}/${repo}`;
  const pull = () => read('GET /repos/{owner}/{repo}/pulls/{pull_number}', { pull_number: pullNumber });
  const pr = await pull();
  if (!validPull(pr, fullName, pullNumber, head)) throw new Error('PR head changed or invalid target');
  const exception = await verifiedException(read, pr, fullName, releaseAppBotLogin);
  const check = exception ? null : await providerCheck(read, head);
  const graphql = async (query, variables) => {
    const result = await read('POST /graphql', { query, variables });
    if (result?.errors) throw new Error('Incomplete GraphQL response');
    return result?.data;
  };
  const threads = await listReviewThreads({ github: { graphql }, owner, repo, pullNumber });
  const finalCheck = exception ? null : await providerCheck(read, head);
  const final = await pull();
  if (!stablePull(pr, final, fullName, pullNumber, head) || fingerprint(check) !== fingerprint(finalCheck)) {
    throw new Error('Review evidence changed while reading');
  }
  return admissionResult(check, exception, threads, head);
}

module.exports = { readCodeRabbitAdmission, trustedCheck, APP_ID, APP_SLUG, CHECK_NAME, providerCheck, verifiedException };
