'use strict';
const { reader, validSha } = require('./queue-ci-proof.cjs');
const REPOSITORY_ID = 1352758052;
const AUTHOR_ID = 1118683;
const WORKFLOW = 'hearsay-tools/cezarion/.github/workflows/ci.yml@refs/heads/main';

function trustedContext(input) {
  return input.eventName === 'pull_request_target' && input.ref === 'refs/heads/main'
    && input.workflowRef === WORKFLOW && input.refProtected === true
    && input.owner === 'hearsay-tools' && input.repo === 'cezarion'
    && input.repositoryId === REPOSITORY_ID
    && Number.isSafeInteger(input.pullNumber) && input.pullNumber > 0 && validSha(input.head);
}

// Run only in the hosted input-resolution job, after its immutable input proof.
// Missing or stale admission evidence keeps the existing hosted runner route.
async function lxcRunnerEligible(input) {
  if (!trustedContext(input)) return false;
  const { github, owner, repo, pullNumber, head, now = Date.now } = input;
  try {
    const read = reader(github, owner, repo, now() + 10000, now);
    const pull = await read('GET /repos/{owner}/{repo}/pulls/{pull_number}', { pull_number: pullNumber });
    return pull?.number === pullNumber && pull.state === 'open' && pull.user?.id === AUTHOR_ID
      && pull.base?.repo?.id === REPOSITORY_ID && pull.base?.ref === 'main'
      && pull.head?.repo?.id === REPOSITORY_ID && pull.head?.sha === head;
  } catch {
    return false;
  }
}

module.exports = { lxcRunnerEligible };
