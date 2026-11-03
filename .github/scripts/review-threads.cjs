'use strict';
// Shared read-only admission primitive, extracted from automated-review.cjs.
// Outdated threads still block. No author or formal-review counting policy here.
const REVIEW_THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id isResolved }
      }
    }
  }
}`;
function requirePage(page, data) {
  if (data?.errors || !Array.isArray(page?.nodes) || page.nodes.length > 100
    || typeof page.pageInfo?.hasNextPage !== 'boolean') throw new Error('Incomplete review threads');
}
function appendThreads(threads, ids, nodes) {
  for (const node of nodes) {
    if (typeof node?.id !== 'string' || !node.id || ids.has(node.id)
      || typeof node.isResolved !== 'boolean') throw new Error('Malformed review thread');
    ids.add(node.id); threads.push(node);
  }
}
async function listReviewThreads({ github, owner, repo, pullNumber }) {
  const threads = [], cursors = new Set(), ids = new Set();
  let cursor = null;
  for (let index = 0; index < 100; index++) {
    const data = await github.graphql(REVIEW_THREADS_QUERY, { owner, repo, number: pullNumber, cursor });
    const page = data?.repository?.pullRequest?.reviewThreads;
    requirePage(page, data);
    appendThreads(threads, ids, page.nodes);
    if (!page.pageInfo.hasNextPage) return threads;
    cursor = page.pageInfo.endCursor;
    if (typeof cursor !== 'string' || !cursor || cursors.has(cursor) || page.nodes.length !== 100) {
      throw new Error('Incomplete review threads pagination');
    }
    cursors.add(cursor);
  }
  throw new Error('Review thread pagination limit');
}
module.exports = { listReviewThreads, REVIEW_THREADS_QUERY };
