'use strict';
const { fixture, HEAD } = require('./coderabbit.testkit.cjs');
const { CLAIM_NAME, claimKey } = require('./coderabbit-recovery-claim.cjs');
const { reconcile } = require('./coderabbit-reconcile.cjs');
function recoveryFixture() {
  const h = fixture(), { s } = h, request = h.github.request;
  Object.assign(s.checks[0], { conclusion: 'skipped', output: { title: 'No files to review' } });
  s.origin = { id: 90, path: '.github/workflows/coderabbit-reconcile.yml', event: 'workflow_run',
    head_branch: 'main', repository: { full_name: 'o/r' }, head_repository: { full_name: 'o/r' } };
  s.claims = []; s.claimPosts = []; s.comments = []; s.commentPosts = []; s.updates = []; s.logs = [];
  h.github.request = async (route, args) => {
    s.recoveryHook?.(route, args);
    let data;
    if (route.endsWith('/commits/{ref}/check-runs') && args.check_name === CLAIM_NAME) {
      data = { total_count: s.claimTotal ?? s.claims.length, check_runs: s.hideClaims ? [] : s.claimPages?.[args.page - 1] ?? s.claims };
    } else if (route.endsWith('/runs/{run_id}') && args.run_id === 90) data = s.origin;
    else if (route === 'POST /repos/{owner}/{repo}/check-runs') {
      s.claimPosts.push(args);
      data = { ...args, id: 200 + s.claims.length, app: { id: 15368, slug: 'github-actions' } };
      s.claims.push(data);
      if (s.claimError) throw new Error('ambiguous creation');
      if (s.invalidClaimResponse) data = { ...data, external_id: 'wrong' };
    } else if (route === 'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}') {
      s.updates.push(args);
      if (s.updateError) throw new Error('update failed');
      data = Object.assign(s.claims.find(c => c.id === args.check_run_id), args);
    } else if (route.endsWith('/issues/{issue_number}/comments')) {
      if (!route.startsWith('GET')) throw new Error('Comment sent with control-plane client');
      if (s.commentReadError) throw new Error('receipt unavailable');
      data = s.commentPages?.[args.page - 1] ?? s.comments;
    } else return request(route, args);
    s.calls.push([route, args]);
    return { data: structuredClone(data) };
  };
  h.recoverySender = { slug: 'release-app', github: { request: async (route, args) => {
    if (route !== 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments') throw new Error('Sender used outside comment POST');
    s.commentPosts.push(args);
    const comment = { id: 300, body: args.body, user: { login: 'release-app[bot]', type: 'Bot' } };
    if (!s.rejectComment) s.comments.push(comment);
    if (s.commentError || s.rejectComment) throw new Error('ambiguous comment');
    return { data: s.invalidComment ? {} : comment };
  } } };
  h.args = () => ({ ...h, owner: 'o', repo: 'r', pullNumber: s.pr.number, runId: 90,
    releaseAppBotLogin: 'release-app[bot]', log: message => s.logs.push(message) });
  h.run = () => reconcile(h.args());
  h.claim = (extra = {}) => ({ id: 200, name: CLAIM_NAME, head_sha: HEAD, external_id: claimKey(7, HEAD),
    details_url: 'https://github.com/o/r/actions/runs/90', app: { id: 15368, slug: 'github-actions' },
    status: 'completed', conclusion: 'action_required', output: { title: 'claimed' }, ...extra });
  return h;
}
module.exports = { recoveryFixture };
