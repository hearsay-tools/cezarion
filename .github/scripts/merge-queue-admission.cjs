'use strict';
const { readQueueCodeRabbitAdmission } = require('./queue-coderabbit-admission.cjs');
const { sanitize } = require('./failure-diagnostics.cjs');
const { CI_PATH, VERIFY, REVIEW, validSha, positive, reader, readCiRuns, readCiJobs, successfulJobs, newest } = require('./queue-ci-proof.cjs');
function errorMessage(error) {
  // Never serialize request objects, headers, response bodies or stacks.
  const status = Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? ` (HTTP ${error.status})` : '';
  return sanitize(`${error?.name ?? 'Error'}${status}: ${error?.message ?? 'Unknown admission failure'}`);
}
function admissionFailure(error, diagnostics = {}) {
  // This object contains only static check/route names and projected identities,
  // never raw API fields. Preserve validated SHAs that sanitize would redact.
  return `${errorMessage(error)}\nEvidence: ${JSON.stringify(diagnostics)}`;
}
const shaOrNull = sha => validSha(sha) ? sha : null;
const numberOrNull = n => positive(n) ? n : null;
function queueIdentity(entry) {
  return { pullNumber: numberOrNull(entry?.pullRequest?.number), position: numberOrNull(entry?.position),
    head: shaOrNull(entry?.headCommit?.oid), base: shaOrNull(entry?.baseCommit?.oid),
    pullHead: shaOrNull(entry?.pullRequest?.headRefOid) };
}
function startDiagnostics(diagnostics, group) {
  diagnostics.group = { head: shaOrNull(group?.head_sha), base: shaOrNull(group?.base_sha) };
  const expected = /^refs\/heads\/gh-readonly-queue\/main\/pr-(\d+)(?:-[a-f0-9]{40})?$/.exec(group?.head_ref);
  diagnostics.expectedPullNumbers = expected ? [numberOrNull(Number(expected[1]))] : [];
  diagnostics.observedEntries = null;
  diagnostics.check = 'merge-group identity';
}
function diagnosticGithub(github, diagnostics) {
  return { request: async (route, args) => {
    diagnostics.api = { route, status: null };
    try {
      const result = await github.request(route, args);
      diagnostics.api.status = numberOrNull(result.status);
      if (route === 'POST /graphql' && result.data?.errors) {
        const errors = Array.isArray(result.data.errors) ? result.data.errors.slice(0, 5).map(e => e?.message).join('; ') : 'Malformed errors';
        throw new Error(`GraphQL response errors: ${errors}`);
      }
      return result;
    } catch (error) {
      diagnostics.api.status = numberOrNull(error?.status) ?? diagnostics.api.status;
      // Routes are static templates from trusted code. Arguments may be private.
      // The status and retry-after header let the reader retry a transient answer.
      throw Object.assign(new Error(`${route}: ${errorMessage(error)}`), { status: error?.status,
        response: { headers: { 'retry-after': error?.response?.headers?.['retry-after'] } } });
    }
  } };
}
const QUEUE_QUERY = `query($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    mergeQueue(branch: "main") { entries(first: 2) {
      nodes { id position headCommit { oid } baseCommit { oid } pullRequest { number headRefOid } }
      pageInfo { hasNextPage }
    } }
  }
}`;
function requireQueueRules(rules) {
  if (!Array.isArray(rules)) throw new Error('Missing effective rules');
  const queues = rules.filter(r => r.type === 'merge_queue');
  const p = queues[0]?.parameters;
  if (queues.length !== 1 || p?.merge_method !== 'SQUASH' || ![1, 2].includes(p.max_entries_to_build)
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
  // The build window holds at most two entries; this build's entry is the one with the group's head.
  const nodes = data?.repository?.mergeQueue?.entries?.nodes;
  const matches = Array.isArray(nodes) ? nodes.filter(n => n?.headCommit?.oid === group.head_sha) : [];
  const e = matches[0];
  if (matches.length !== 1 || typeof e.id !== 'string' || !e.id || !onChain(nodes, e, group)
    || e.baseCommit?.oid !== group.base_sha || !positive(e.pullRequest?.number) || !validSha(e.pullRequest?.headRefOid)) throw new Error('Queue entry does not match group');
  return e;
}
// Entry 2 is built on entry 1's group head; entry 1 is built on main.
function onChain(nodes, entry, group) {
  if (entry.position === 1) return true;
  const first = nodes.filter(n => n?.position === 1);
  return entry.position === 2 && first.length === 1 && first[0].headCommit?.oid === group.base_sha;
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
function boundedGraphql(read) {
  // Use the same bounded request transport for GraphQL and thread pagination.
  const cursors = new Set();
  let threadPages = 0;
  return async (query, variables) => {
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
}
function nativeSuccess(run, allowInProgress = false) {
  return (run.status === 'completed' && run.conclusion === 'success')
    || (allowInProgress && run.status === 'in_progress' && run.conclusion === null);
}
function requireGroup(group) {
  if (!validSha(group?.head_sha) || !validSha(group?.base_sha) || group.base_ref !== 'refs/heads/main'
    || !group.head_ref?.startsWith('refs/heads/gh-readonly-queue/main/')) throw new Error('Invalid main merge group');
}
function requireStableRun(run, finalRun, finalLatest, eligible) {
  if (!eligible(finalRun) || finalRun.id !== run.id || finalRun.run_attempt !== run.run_attempt
    || finalLatest?.id !== run.id || finalLatest.run_attempt !== run.run_attempt || !eligible(finalLatest)) throw new Error('Native CI changed');
}
async function mergeQueueAdmission({ github, owner, repo, group, now = Date.now, sleep, allowInProgress = false, releaseAppBotLogin, diagnostics = {} }) {
  startDiagnostics(diagnostics, group);
  requireGroup(group);
  github = diagnosticGithub(github, diagnostics);
  const deadline = now() + 120000;
  const read = reader(github, owner, repo, deadline, now, sleep);
  const graphql = boundedGraphql(read);
  diagnostics.check = 'queue rules';
  requireQueueRules(await read('GET /repos/{owner}/{repo}/rules/branches/{branch}', { branch: 'main', per_page: 100 }));
  const queue = async () => {
    const data = await graphql(QUEUE_QUERY, { owner, repo });
    const nodes = data?.repository?.mergeQueue?.entries?.nodes;
    diagnostics.observedEntries = Array.isArray(nodes) ? nodes.slice(0, 2).map(queueIdentity) : null;
    return data;
  };
  diagnostics.check = 'queue membership';
  const entry = entryFrom(await queue(), group);
  const pull = () => read('GET /repos/{owner}/{repo}/pulls/{pull_number}', { pull_number: entry.pullRequest.number });
  diagnostics.check = 'PR eligibility';
  const pr = await pull(); const fullName = `${owner}/${repo}`;
  if (!validPull(pr, fullName, entry)) throw new Error('PR head is no longer eligible');
  diagnostics.check = 'native workflow identity';
  const workflow = await read('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}', { workflow_id: 'ci.yml' });
  if (!positive(workflow?.id) || workflow.path !== CI_PATH || workflow.state !== 'active') throw new Error('CI workflow unavailable');
  const runs = () => readCiRuns(read, workflow.id, pr.head.sha, 'pull_request_target');
  diagnostics.check = 'native CI/review';
  const latest = newest(await runs());
  const run = latest && await read('GET /repos/{owner}/{repo}/actions/runs/{run_id}', { run_id: latest.id });
  const eligible = r => nativeRun(r, fullName, workflow.id, entry, pr) && nativeSuccess(r, allowInProgress);
  if (!eligible(run)) throw new Error('Current native PR CI/review has not passed');
  diagnostics.check = 'native protected jobs';
  if (!successfulJobs(await readCiJobs(read, run.id), [VERIFY, REVIEW])) throw new Error('Native CI/review gates missing');
  diagnostics.check = 'CodeRabbit admission';
  const admission = await readQueueCodeRabbitAdmission({ github, owner, repo, pullNumber: pr.number, head: pr.head.sha,
    releaseAppBotLogin, now, sleep, deadline: Math.min(deadline, now() + 60000) });
  if (!admission.admitted) throw new Error(`Unresolved or unsuccessful CodeRabbit admission: ${admission.reason}`);
  diagnostics.check = 'final native CI/review';
  const finalRun = await read('GET /repos/{owner}/{repo}/actions/runs/{run_id}', { run_id: run.id });
  const finalLatest = newest(await runs());
  requireStableRun(run, finalRun, finalLatest, eligible);
  diagnostics.check = 'final queue membership';
  const finalEntry = entryFrom(await queue(), group);
  diagnostics.check = 'final queue/PR identity';
  if (finalEntry.id !== entry.id || finalEntry.pullRequest.number !== pr.number
    || finalEntry.pullRequest.headRefOid !== pr.head.sha || !validPull(await pull(), fullName, entry)) throw new Error('Queue or PR changed');
  return { pullNumber: pr.number, head: pr.head.sha, runId: run.id, attempt: run.run_attempt };
}
module.exports = { mergeQueueAdmission, requireQueueRules, entryFrom, QUEUE_QUERY, nativeSuccess, admissionFailure };
