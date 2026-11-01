'use strict';
const { reader, validSha } = require('./queue-ci-proof.cjs');

// The name binds official job metadata to the trusted workflow and tested head.
const attestationName = (base, head) => `Attest PR test inputs / ${base} / ${head}`;
function requireMergeInput(merge, sha, head) {
  if (merge?.sha !== sha || !validSha(merge.tree?.sha) || merge.parents?.length !== 2
    || !validSha(merge.parents[0]?.sha) || merge.parents[1]?.sha !== head) throw new Error('PR merge input moved');
}
function reusableHead(commit, comparison, head, merge, workflowSha) {
  return commit?.sha === head && commit.tree?.sha === merge.tree.sha && comparison.merge_base_commit?.sha === workflowSha
    && ['ahead', 'identical'].includes(comparison.status);
}
async function resolvePrTestInput({ github, owner, repo, pullNumber, head, workflowSha, headRepository, now = Date.now }) {
  const read = reader(github, owner, repo, now() + 45000, now);
  if (!Number.isSafeInteger(pullNumber) || pullNumber < 1 || !validSha(head)) throw new Error('Invalid PR input');
  const pull = await read('GET /repos/{owner}/{repo}/pulls/{pull_number}', { pull_number: pullNumber });
  const sha = pull?.merge_commit_sha;
  if (!validSha(sha)) throw new Error('Missing PR merge revision');
  const merge = await read('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', { commit_sha: sha });
  requireMergeInput(merge, sha, head);
  const fallback = { sha, reusable: false };
  if (!validSha(workflowSha) || merge.parents[0].sha !== workflowSha || headRepository !== `${owner}/${repo}`) return fallback;
  try {
    const commit = await read('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', { commit_sha: head });
    const comparison = await read('GET /repos/{owner}/{repo}/compare/{basehead}', { basehead: `${workflowSha}...${head}` });
    if (!reusableHead(commit, comparison, head, merge, workflowSha)) return fallback;
    return { sha: head, reusable: true };
  } catch {
    return fallback;
  }
}
module.exports = { resolvePrTestInput, attestationName };
