'use strict';
const { readCodeRabbitAdmission } = require('./coderabbit-admission.cjs');
const { reader } = require('./queue-ci-proof.cjs');
// CodeRabbit restarted 33–40 s after first ready on hearsay-tools/cezarion#3050
// and hearsay-tools/cezarion#3031, but not after 8+ min on hearsay-tools/cezarion#3066.
// It provides no signal that a re-review will not start. Owner-approved settle bound.
const POST_READY_SETTLE_MS = 180_000;
// timelineItems is chronological. The first matching event is immutable and
// applies across later ready flips and pushes; it is deliberately not the latest.
const FIRST_READY_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      timelineItems(first: 1, itemTypes: [READY_FOR_REVIEW_EVENT]) {
        nodes { ... on ReadyForReviewEvent { createdAt } }
      }
    }
  }
}`;
function timestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) ? Date.parse(value) : NaN;
}
async function firstReady(read, owner, repo, number) {
  const result = await read('POST /graphql', { query: FIRST_READY_QUERY, variables: { owner, repo, number } });
  const nodes = result?.data?.repository?.pullRequest?.timelineItems?.nodes;
  if (result?.errors || !Array.isArray(nodes) || nodes.length > 1) throw new Error('First ready timeline unavailable');
  if (!nodes.length) return null;
  if (!Number.isFinite(timestamp(nodes[0]?.createdAt))) throw new Error('First ready timestamp unavailable');
  return nodes[0].createdAt;
}
// The caller re-reads the queue entry and the PR, draft state included, after this.
async function readQueueCodeRabbitAdmission({ github, owner, repo, pullNumber, head, now = Date.now, sleep,
  deadline = now() + 60000, ...options }) {
  const read = reader(github, owner, repo, deadline, now, sleep);
  const admission = await readCodeRabbitAdmission({ github, owner, repo, pullNumber, head, now, sleep, deadline, ...options });
  const exempt = admission.exception || admission.providerState === 'no-files';
  const ready = exempt ? null : await firstReady(read, owner, repo, pullNumber);
  // Keep the established verified exceptions; they do not require a model run.
  if (exempt) return admission;
  // An open, non-draft PR with no ready event was opened ready. No ready
  // transition can trigger a re-review, so current-head admission is sufficient.
  if (!ready) return admission;
  return settledReview(admission, ready, now());
}
function settledReview(admission, ready, now) {
  const blocked = reason => ({ ...admission, admitted: false, reason });
  const started = timestamp(admission.providerStartedAt);
  if (!Number.isFinite(started)) return blocked('provider review start unavailable');
  if (started > timestamp(ready)) {
    return admission.providerState === 'pending' ? blocked('provider review pending after first ready') : admission;
  }
  const until = timestamp(ready) + POST_READY_SETTLE_MS;
  if (now < until) return blocked(`provider re-review settle window open, until ${new Date(until).toISOString()}`);
  return admission;
}

module.exports = { readQueueCodeRabbitAdmission, FIRST_READY_QUERY, POST_READY_SETTLE_MS };
