'use strict';

const SHA = /^[0-9a-f]{40}$/i;
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'error', 'warning', 'notice', 'info']);
const OUTCOMES = new Set(['reviewed', 'skipped', 'failed']);
const VERDICTS = new Set(['addressed', 'unresolved']);
const LIMITS = { path: 1000, body: 10000, summary: 20000, reason: 2000 };
// REST names the workflow token's author `github-actions[bot]`; GraphQL drops the suffix.
const AUTOMATED_AUTHORS = new Set(['github-actions[bot]', 'github-actions']);

function assertKeys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} has unknown key "${key}".`);
}
function assertRequired(value, required, label) {
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`${label} ${key} is required.`);
}
function stringField(value, name, max, { trim = false } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || (trim && value.trim().length === 0)) throw new Error(`${name} must be a non-empty string of at most ${max} characters.`);
}
function validateShape(review) {
  if (!review || typeof review !== 'object' || Array.isArray(review)) throw new Error('Review must be an object.');
  assertKeys(review, new Set(['head_sha', 'outcome', 'findings', 'prior_findings', 'summary']), 'Review');
  assertRequired(review, ['head_sha', 'outcome', 'findings', 'prior_findings', 'summary'], 'Review');
  if (review.head_sha !== null && (typeof review.head_sha !== 'string' || !SHA.test(review.head_sha))) throw new Error('head_sha must be a 40-character hexadecimal SHA or null.');
  if (!OUTCOMES.has(review.outcome)) throw new Error('outcome is invalid.');
  if (!Array.isArray(review.findings)) throw new Error('findings must be an array.');
  if (review.summary !== null) stringField(review.summary, 'summary', LIMITS.summary);
  for (const finding of review.findings) {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) throw new Error('Each finding must be an object.');
    assertKeys(finding, new Set(['path', 'line', 'body', 'severity']), 'Finding');
    assertRequired(finding, ['path', 'line', 'body', 'severity'], 'Finding');
    stringField(finding.path, 'path', LIMITS.path);
    if (!Number.isInteger(finding.line) || finding.line <= 0) throw new Error('line must be a positive integer.');
    stringField(finding.body, 'body', LIMITS.body, { trim: true });
    if (finding.severity !== null && !SEVERITIES.has(finding.severity)) throw new Error('severity is invalid.');
  }
  if (!Array.isArray(review.prior_findings)) throw new Error('prior_findings must be an array.');
  for (const verdict of review.prior_findings) {
    if (!verdict || typeof verdict !== 'object' || Array.isArray(verdict)) throw new Error('Each prior finding must be an object.');
    assertKeys(verdict, new Set(['comment_id', 'verdict', 'reason']), 'Prior finding');
    assertRequired(verdict, ['comment_id', 'verdict', 'reason'], 'Prior finding');
    if (!Number.isSafeInteger(verdict.comment_id) || verdict.comment_id <= 0) throw new Error('comment_id must be a positive integer.');
    if (!VERDICTS.has(verdict.verdict)) throw new Error('verdict is invalid.');
    stringField(verdict.reason, 'reason', LIMITS.reason, { trim: true });
  }
}
function validateReview({ review, headSha, changedLines, noFindingsSummary = null }) {
  validateShape(review);
  const modelSummary = review.summary?.trim() || null;
  if (review.outcome === 'failed') {
    if (review.findings.length > 0 || review.prior_findings.length > 0) throw new Error('A failed review cannot include findings.');
    if (!modelSummary) throw new Error('A failed review must explain why it could not be completed.');
    throw new Error(`Automated review failed: ${modelSummary}`);
  }
  if (typeof headSha !== 'string' || !SHA.test(headSha)) throw new Error('headSha must be a 40-character hexadecimal SHA.');
  if (typeof review.head_sha !== 'string') throw new Error('A reviewed or skipped result requires head_sha.');
  if (review.head_sha !== headSha) throw new Error('Review output targets a stale PR head SHA.');
  if (!(changedLines instanceof Map)) throw new Error('changedLines must be a Map.');
  if (review.outcome === 'skipped') {
    if (review.findings.length > 0 || review.prior_findings.length > 0) throw new Error('A skipped review cannot include findings.');
    if (!modelSummary) throw new Error('A skipped review must explain why it was skipped.');
    return { comments: [], body: null, verdicts: [] };
  }
  const verdicts = [];
  const judged = new Set();
  for (const { comment_id: commentId, verdict, reason } of review.prior_findings) {
    if (judged.has(commentId)) continue;
    judged.add(commentId); verdicts.push({ commentId, verdict, reason: reason.trim() });
  }
  const seen = new Set(); const comments = [];
  for (const finding of review.findings) {
    const key = `${finding.path}\u0000${finding.line}\u0000${finding.body}`;
    if (seen.has(key) || !changedLines.get(finding.path)?.has(finding.line)) continue;
    seen.add(key); comments.push({ path: finding.path, line: finding.line, body: finding.body });
  }
  const summary = comments.length > 0 ? modelSummary : (modelSummary || noFindingsSummary);
  return { comments, body: summary && !comments.some(({ body }) => body === summary) ? summary : null, verdicts };
}
function loadReview(input) { try { return typeof input === 'string' ? JSON.parse(input) : input; } catch (error) { throw new Error(`Invalid review JSON: ${error.message}`); } }
function changedLinesFromFiles(files) {
  const changed = new Map();
  for (const file of files || []) {
    if (!file || typeof file.filename !== 'string' || typeof file.patch !== 'string') continue;
    const lines = new Set(); let newLine = 0; let inHunk = false;
    for (const line of file.patch.split('\n')) {
      if (line === '' || line === '\\ No newline at end of file') continue;
      const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) { newLine = Number(hunk[1]); inHunk = true; continue; }
      if (!inHunk) continue;
      if (line.startsWith('+')) { lines.add(newLine++); continue; }
      if (line.startsWith('-')) continue;
      if (line.startsWith(' ')) newLine++;
    }
    changed.set(file.filename, lines);
  }
  return changed;
}
function countAutomatedReviews(reviews, author = 'github-actions[bot]') {
  if (!Array.isArray(reviews)) return 0;
  return reviews.filter((review) => review?.user?.login === author && review?.submitted_at != null).length;
}
function formatReviewPatchIdMarker(patchId) {
  if (typeof patchId !== 'string' || !SHA.test(patchId)) return null;
  return `<!-- cez-review-patch-id: ${patchId.toLowerCase()} -->`;
}
function extractReviewPatchId(body) {
  if (typeof body !== 'string') return null;
  const match = body.match(/<!-- cez-review-patch-id: ([0-9a-f]{40}) -->/);
  return match ? match[1] : null;
}
function latestAutomatedReviewPatchId(reviews, author = 'github-actions[bot]') {
  if (!Array.isArray(reviews)) return null;
  const dated = reviews
    .filter((review) => review?.user?.login === author && review?.submitted_at != null)
    .sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at)));
  let latest = null;
  for (const review of dated) {
    const id = extractReviewPatchId(review.body);
    if (id) latest = id;
  }
  return latest;
}
function shouldSkipUnchangedPatch(currentPatchId, lastPatchId) {
  return typeof currentPatchId === 'string' && currentPatchId.length > 0 && currentPatchId === lastPatchId;
}
// Resolves to the number of inline threads the posted review opened: 0 when
// nothing was posted (no content, round cap, or a review already on this head).
async function postReview({ github, owner, repo, pullNumber, eventHeadSha, reviewedHeadSha, comments, body, maxRounds = 3, ignoreCap = false, patchId }) {
  if (comments.length === 0 && !body) return 0;
  if (!Number.isInteger(maxRounds) || maxRounds < 1) {
    throw new Error('AUTOMATED_REVIEW_ROUNDS must be a positive integer.');
  }
  await assertLiveHead({ github, owner, repo, pullNumber, eventHeadSha, reviewedHeadSha });
  const reviews = await github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number: pullNumber, per_page: 100 });
  if (!ignoreCap && countAutomatedReviews(reviews) >= maxRounds) return 0;
  if (reviews.some((review) => review?.user?.login === 'github-actions[bot]' && review.commit_id === reviewedHeadSha)) return 0;
  const marker = formatReviewPatchIdMarker(patchId);
  const postedBody = marker ? (body ? `${body}\n\n${marker}` : marker) : (body || '');
  await github.rest.pulls.createReview({ owner, repo, pull_number: pullNumber, commit_id: reviewedHeadSha, event: 'COMMENT', body: postedBody, comments: comments.map(({ path, line, body: commentBody }) => ({ path, line, side: 'RIGHT', body: commentBody })) });
  return comments.length;
}
async function assertLiveHead({ github, owner, repo, pullNumber, eventHeadSha, reviewedHeadSha = eventHeadSha }) {
  const { data: pull } = await github.rest.pulls.get({ owner, repo, pull_number: pullNumber });
  if (pull?.head?.sha !== eventHeadSha || pull.head.sha !== reviewedHeadSha) throw new Error('Refusing to post review: stale PR head SHA.');
}
const REVIEW_THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id isResolved comments(first: 1) { nodes { databaseId author { login } } } }
      }
    }
  }
}`;
async function listReviewThreads({ github, owner, repo, pullNumber }) {
  const threads = [];
  let cursor = null;
  do {
    const data = await github.graphql(REVIEW_THREADS_QUERY, { owner, repo, number: pullNumber, cursor });
    const page = data?.repository?.pullRequest?.reviewThreads;
    if (!page || !Array.isArray(page.nodes)) throw new Error('Could not read review threads.');
    for (const node of page.nodes) {
      const root = node?.comments?.nodes?.[0];
      threads.push({ id: node?.id, isResolved: node?.isResolved === true, rootCommentId: root?.databaseId ?? null, automated: AUTOMATED_AUTHORS.has(root?.author?.login) });
    }
    cursor = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return threads;
}
function countOpenAutomatedThreads(threads) {
  return threads.filter((thread) => thread.automated && !thread.isResolved).length;
}
// Only open threads this workflow started are touched: a human's thread is
// never replied to or resolved, and a verdict naming anything else is dropped.
async function applyVerdicts({ github, owner, repo, pullNumber, threads, verdicts }) {
  const byRoot = new Map(threads.filter((thread) => thread.automated && !thread.isResolved && typeof thread.id === 'string')
    .map((thread) => [thread.rootCommentId, thread]));
  const applied = { resolved: 0, unresolved: 0 };
  for (const { commentId, verdict, reason } of verdicts) {
    const thread = byRoot.get(commentId);
    if (!thread) continue;
    const label = verdict === 'addressed' ? 'Addressed' : 'Still unresolved';
    await github.rest.pulls.createReplyForReviewComment({ owner, repo, pull_number: pullNumber, comment_id: commentId, body: `${label}: ${reason}` });
    if (verdict === 'addressed') {
      await github.graphql('mutation($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } } }', { threadId: thread.id });
      thread.isResolved = true;
      applied.resolved += 1;
    } else {
      applied.unresolved += 1;
    }
  }
  return applied;
}
module.exports = {
  validateReview,
  loadReview,
  changedLinesFromFiles,
  countAutomatedReviews,
  postReview,
  assertLiveHead,
  listReviewThreads,
  countOpenAutomatedThreads,
  applyVerdicts,
  formatReviewPatchIdMarker,
  extractReviewPatchId,
  latestAutomatedReviewPatchId,
  shouldSkipUnchangedPatch,
};
