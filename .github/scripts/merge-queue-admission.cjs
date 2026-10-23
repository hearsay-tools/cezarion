'use strict';
const { listReviewThreads } = require('./automated-review.cjs');
const { CI_PATH, VERIFY, REVIEW, validSha, positive, reader, readCiRuns, readCiJobs, successfulJobs, newest } = require('./queue-ci-proof.cjs');
const QUEUE_QUERY = `query($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    mergeQueue(branch: "main") { entries(first: 1) {
      nodes { id position headCommit { oid } baseCommit { oid } pullRequest { number headRefOid } }
      pageInfo { hasNextPage }
    } }
  }
}`;
function requireSerialRules(rules) {
  if (!Array.isArray(rules)) throw new Error('Missing effective rules');
  const queues = rules.filter(r => r.type === 'merge_queue');
  const p = queues[0]?.parameters;
  if (queues.length !== 1 || p?.merge_method !== 'SQUASH' || p.max_entries_to_build !== 1
    || p.min_entries_to_merge !== 1 || p.max_entries_to_merge !== 1
    || p.grouping_strategy !== 'ALLGREEN' || p.check_response_timeout_minutes !== 45) throw new Error('Unsupported queue settings');
  for (const name of [VERIFY, REVIEW]) {
    if (!rules.some(r => r.type === 'required_status_checks' && r.parameters?.required_status_checks?.some(
      c => c.context === name && c.integration_id === 15368))) throw new Error('Required Actions check missing');
  }
  if (!rules.some(r => r.type === 'pull_request' && r.parameters?.required_review_thread_resolution === true)) {
    throw new Error('Review thread protection missing');
  }
}
function entryFrom(data, group) {
  const entries = data?.repository?.mergeQueue?.entries;
  const e = entries?.nodes?.[0];
  // Later queued entries may exist; serial build + position one identifies this build.
  if (!Array.isArray(entries?.nodes) || entries.nodes.length !== 1 || typeof e?.id !== 'string' || !e.id
    || e.position !== 1 || e.headCommit?.oid !== group.head_sha || e.baseCommit?.oid !== group.base_sha
    || !positive(e.pullRequest?.number) || !validSha(e.pullRequest?.headRefOid)) throw new Error('Queue entry does not match group');
  return e;
}
function validPull(pr, fullName, entry) {
  return pr?.number === entry.pullRequest.number && pr.state === 'open' && pr.draft === false
    && pr.base?.ref === 'main' && pr.base.repo?.full_name === fullName
    && pr.head?.sha === entry.pullRequest.headRefOid && typeof pr.head.repo?.full_name === 'string';
}
function nativeRun(run, fullName, workflowId, entry, pr) {
  return positive(run?.id) && positive(run.run_attempt) && run.workflow_id === workflowId && run.path === CI_PATH
    && run.repository?.full_name === fullName && run.head_repository?.full_name === pr.head.repo.full_name
    && run.event === 'pull_request_target' && run.head_sha === entry.pullRequest.headRefOid
    && run.head_branch === pr.head.ref && run.pull_requests?.some(p => p.number === pr.number
      && p.head?.sha === pr.head.sha && p.base?.ref === 'main');
}
async function mergeQueueAdmission({ github, owner, repo, group, now = Date.now }) {
  if (!validSha(group?.head_sha) || !validSha(group?.base_sha) || group.base_ref !== 'refs/heads/main'
    || !group.head_ref?.startsWith('refs/heads/gh-readonly-queue/main/')) throw new Error('Invalid main merge group');
  const read = reader(github, owner, repo, now() + 120000, now);
  // Use the same bounded request transport for GraphQL and thread pagination.
  const cursors = new Set();
  let threadPages = 0;
  const graphql = async (query, variables) => {
    const data = await read('POST /graphql', { query, variables });
    if (data.errors) throw new Error('Incomplete GraphQL response');
    if (query !== QUEUE_QUERY) {
      const page = data.data?.repository?.pullRequest?.reviewThreads;
      if (++threadPages > 100 || !Array.isArray(page?.nodes) || typeof page.pageInfo?.hasNextPage !== 'boolean'
        || (page.pageInfo.hasNextPage && (typeof page.pageInfo.endCursor !== 'string' || !page.pageInfo.endCursor
          || cursors.has(page.pageInfo.endCursor)))) throw new Error('Incomplete review threads');
      if (page.pageInfo.hasNextPage) cursors.add(page.pageInfo.endCursor);
    }
    return data.data;
  };
  const rules = () => read('GET /repos/{owner}/{repo}/rules/branches/{branch}', { branch: 'main', per_page: 100 });
  requireSerialRules(await rules());
  const queue = () => graphql(QUEUE_QUERY, { owner, repo });
  const entry = entryFrom(await queue(), group);
  const pull = () => read('GET /repos/{owner}/{repo}/pulls/{pull_number}', { pull_number: entry.pullRequest.number });
  const pr = await pull(); const fullName = `${owner}/${repo}`;
  if (!validPull(pr, fullName, entry)) throw new Error('PR head is no longer eligible');
  const workflow = await read('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}', { workflow_id: 'ci.yml' });
  if (!positive(workflow?.id) || workflow.path !== CI_PATH || workflow.state !== 'active') throw new Error('CI workflow unavailable');
  const runs = () => readCiRuns(read, workflow.id, pr.head.sha, 'pull_request_target');
  const latest = newest(await runs());
  const run = latest && await read('GET /repos/{owner}/{repo}/actions/runs/{run_id}', { run_id: latest.id });
  const eligible = r => nativeRun(r, fullName, workflow.id, entry, pr) && r.status === 'completed' && r.conclusion === 'success';
  if (!eligible(run)) throw new Error('Current native PR CI/review has not passed');
  if (!successfulJobs(await readCiJobs(read, run.id), [VERIFY, REVIEW])) throw new Error('Native CI/review gates missing');
  const threads = await listReviewThreads({ github: { graphql }, owner, repo, pullNumber: pr.number });
  if (threads.some(t => !t.isResolved)) throw new Error('Unresolved review threads');
  const finalRun = await read('GET /repos/{owner}/{repo}/actions/runs/{run_id}', { run_id: run.id });
  const finalLatest = newest(await runs());
  if (!eligible(finalRun) || finalRun.id !== run.id || finalRun.run_attempt !== run.run_attempt
    || finalLatest?.id !== run.id || finalLatest.run_attempt !== run.run_attempt || !eligible(finalLatest)) throw new Error('Native CI changed');
  requireSerialRules(await rules());
  const finalEntry = entryFrom(await queue(), group);
  if (finalEntry.id !== entry.id || finalEntry.pullRequest.number !== pr.number
    || finalEntry.pullRequest.headRefOid !== pr.head.sha || !validPull(await pull(), fullName, entry)) throw new Error('Queue or PR changed');
  return { pullNumber: pr.number, head: pr.head.sha, runId: run.id, attempt: run.run_attempt };
}
module.exports = { mergeQueueAdmission, requireSerialRules, entryFrom, QUEUE_QUERY };
