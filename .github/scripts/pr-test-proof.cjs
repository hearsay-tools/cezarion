'use strict';
const { mergeQueueAdmission, entryFrom, QUEUE_QUERY, nativeSuccess } = require('./merge-queue-admission.cjs');
const { reader, readCiRuns, readCiJobs, successfulJobs, newest, validSha, CI_PATH } = require('./queue-ci-proof.cjs');
const { attestationName } = require('./pr-test-input.cjs');
const PR_TEST_JOBS = [
  ...[1, 2, 3, 4].map(n => `Vitest shard ${n}/4`),
  ...[1, 2, 3, 4].map(n => `Cockpit browser E2E shard ${n}/4`),
];
async function onlyEntry(read, owner, repo, group) {
  const response = await read('POST /graphql', { query: QUEUE_QUERY, variables: { owner, repo } });
  if (response.errors || response.data?.repository?.mergeQueue?.entries?.pageInfo?.hasNextPage !== false) {
    throw new Error('Queue is not a known single entry');
  }
  return entryFrom(response.data, group);
}
async function matchingMain(read, base) {
  const main = await read('GET /repos/{owner}/{repo}/git/ref/{ref}', { ref: 'heads/main' });
  if (main?.object?.sha !== base) throw new Error('Main changed');
}
async function sameTree(read, group, head) {
  const commit = sha => read('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', { commit_sha: sha });
  const queued = await commit(group.head_sha);
  const source = await commit(head);
  if (queued?.sha !== group.head_sha || source?.sha !== head || !validSha(source.tree?.sha)
    || queued.tree?.sha !== source.tree.sha || queued.parents?.[0]?.sha !== group.base_sha) throw new Error('Combined tree differs');
}
async function matchingWorkflow(read, group) {
  const workflow = ref => read('GET /repos/{owner}/{repo}/contents/{path}', { path: CI_PATH, ref });
  const base = await workflow(group.base_sha);
  const queued = await workflow(group.head_sha);
  const validFile = file => file?.type === 'file' && file.path === CI_PATH && validSha(file.sha);
  if (!validFile(base) || !validFile(queued) || base.sha !== queued.sha) throw new Error('Test workflow changed');
}
async function unchangedRun(read, admission) {
  const run = await read('GET /repos/{owner}/{repo}/actions/runs/{run_id}', { run_id: admission.runId });
  const latest = newest(await readCiRuns(read, run.workflow_id, admission.head, 'pull_request_target'));
  if (run.id !== admission.runId || run.run_attempt !== admission.attempt || !nativeSuccess(run, true)
    || latest?.id !== run.id || latest.run_attempt !== run.run_attempt || !nativeSuccess(latest, true)) {
    throw new Error('Native run changed');
  }
}
function requireCurrentPull(pull, head, base, fullName) {
  if (pull?.head?.sha !== head || pull.base?.sha !== base || pull.state !== 'open' || pull.draft !== false
      || pull.base.ref !== 'main' || pull.base.repo?.full_name !== fullName
      || pull.head.repo?.full_name !== fullName) throw new Error('Pull changed');
}
async function prTestProof({ github, owner, repo, eventName, group, now = Date.now }) {
  const fallback = reason => ({ verified: false, reason });
  if (eventName !== 'merge_group') return fallback('not-merge-group');
  const read = reader(github, owner, repo, now() + 60000, now);
  // Keep admission's pagination, rules and thread checks inside the same deadline.
  const bounded = { request: async (route, args) => ({ data: await read(route, args) }) };
  try {
    const entry = await onlyEntry(read, owner, repo, group);
    await matchingMain(read, group.base_sha);
    const admission = await mergeQueueAdmission({ github: bounded, owner, repo, group, now, allowInProgress: true });
    if (admission.pullNumber !== entry.pullRequest.number || admission.head !== entry.pullRequest.headRefOid) return fallback('entry-changed');
    const jobs = await readCiJobs(read, admission.runId);
    if (!successfulJobs(jobs, [...PR_TEST_JOBS, attestationName(group.base_sha, admission.head)])) return fallback('native-inputs-not-proven');
    await sameTree(read, group, admission.head);
    await matchingWorkflow(read, group);
    await unchangedRun(read, admission);
    const final = await onlyEntry(read, owner, repo, group);
    if (final.id !== entry.id || final.pullRequest.number !== admission.pullNumber || final.pullRequest.headRefOid !== admission.head) return fallback('entry-changed');
    await matchingMain(read, group.base_sha);
    const pull = await read('GET /repos/{owner}/{repo}/pulls/{pull_number}', { pull_number: admission.pullNumber });
    requireCurrentPull(pull, admission.head, group.base_sha, `${owner}/${repo}`);
    return { verified: true, pullNumber: admission.pullNumber, head: admission.head, base: group.base_sha,
      runId: admission.runId, attempt: admission.attempt,
      url: `https://github.com/${owner}/${repo}/actions/runs/${admission.runId}/attempts/${admission.attempt}` };
  } catch {
    // Missing proof costs tests. Do not expose API errors, headers or signed URLs.
    return fallback('native-proof-unavailable');
  }
}
module.exports = { prTestProof, PR_TEST_JOBS };
