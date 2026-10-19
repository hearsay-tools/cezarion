'use strict';

const { join } = require('node:path');
const { mkdirSync } = require('node:fs');
const { decide, snapshotKey, VERSION } = require('./merge-recommendation-policy.cjs');
const COMMENT = '<!-- cez-merge-recommendation:v1 -->';
const SUMMARY = '<!-- cez-merge-trial:v1 -->';
const RECORD = '<!-- cez-merge-record:v1:';
const LABELS = { recommend: 'Recommend', 'human-review': 'Human review required', pending: 'Pending or blocked' };
const escape = value => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/@/g, '&#64;').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
const encode = value => `${RECORD}${Buffer.from(JSON.stringify(value)).toString('base64url')} -->`;

function decode(body, marker) {
  if (typeof body !== 'string' || !body.startsWith(`${marker}\n`) || body.length > 65000) throw new Error('Invalid trial marker.');
  const matches = [...body.matchAll(/<!-- cez-merge-record:v1:([A-Za-z0-9_-]+) -->/g)];
  if (matches.length !== 1) throw new Error('Invalid trial record.');
  return JSON.parse(Buffer.from(matches[0][1], 'base64url').toString('utf8'));
}
function readComment(body) { return decode(body, COMMENT); }
function parseSummary(body) {
  const value = decode(body, SUMMARY);
  if (!Array.isArray(value.records) || value.records.length > 100 || value.records.some(r => !Number.isSafeInteger(r.number) || r.number < 1 || !LABELS[r.decision])) throw new Error('Invalid summary records.');
  if (new Set(value.records.map(r => r.number)).size !== value.records.length) throw new Error('Duplicate summary record.');
  return value;
}

function cohortRecord(s, result) {
  const reason = result.reason || result.rules?.filter(r => !r.passed).map(r => r.id).join(', ') || 'Both evaluators and all deterministic gates agree.';
  return { number: s.number, head: s.headSha, base: s.baseSha, policy: VERSION,
    decision: result.decision, reason: reason.slice(0, 160), state: s.state,
    disagreement: result.disagreement === true };
}

function renderComment(s, result, summaryNumber) {
  const record = { cohort: cohortRecord(s, result), key: snapshotKey(s), decision: result.decision, assessor: result.assessor || null, challenger: result.challenger || null };
  const lines = [COMMENT, '', `**Merge recommendation trial: ${LABELS[result.decision]}**`, '',
    result.reason ? escape(result.reason) : 'The deterministic criteria below determine this result.', '',
    `Head: \`${s.headSha || 'unknown'}\` · Base: \`${s.baseSha || 'unknown'}\``,
    `Policy: v${VERSION} at \`${s.policyCommit || 'unknown'}\` · [Trial summary](https://github.com/${s.repository}/issues/${summaryNumber})`, '',
    '| Criterion | Result | Evidence |', '| --- | --- | --- |'];
  for (const rule of result.rules || []) lines.push(`| ${escape(rule.id)} | ${rule.passed ? 'Pass' : 'Hold'} | ${escape(rule.reason)} |`);
  for (const [label, judgment] of [['Assessor', result.assessor], ['Independent challenge', result.challenger]]) {
    if (!judgment) continue;
    lines.push('', `**${label}:** ${escape(judgment.reason)}`, '', `Established intent: ${escape(judgment.intent)}`);
    for (const e of judgment.evidence) lines.push(`- \`${escape(e.path)}\`: ${escape(e.reason)}`);
  }
  lines.push('', 'This assessment applies only to the revision above. It does not merge or approve the PR.', '', encode(record));
  return lines.join('\n');
}

function renderSummary({ repository = 'hearsay-tools/cezarion', records, coverage = 'Not started.', observedAt = new Date().toISOString() }) {
  let kept = [...records].slice(-100);
  while (true) {
    const counts = { recommend: 0, 'human-review': 0, pending: 0 };
    for (const r of kept) counts[r.decision]++;
    const lines = [SUMMARY, '', '# Merge recommendation trial', '',
      'Recommendation only. Actual merging remains a human decision. Model agreement and eventual merges are not accuracy measurements and never enable merging.', '',
      `Updated: ${escape(observedAt)}. Coverage: ${escape(coverage)}`, '',
      `Retained cohort: **${kept.length} PRs** · **${counts.recommend} recommended** · **${counts['human-review']} require human review** · **${counts.pending} pending/blocked**.`,
      'Counts describe the latest assessment of each retained PR (up to 100), not lifetime totals or separate revisions. Older records may be evicted to keep the issue bounded.', '',
      '| PR | Assessment | Observed state | Reason |', '| --- | --- | --- | --- |'];
    for (const r of [...kept].reverse()) {
      lines.push(`| [${repository}#${r.number}](https://github.com/${repository}/pull/${r.number}${r.commentId ? `#issuecomment-${r.commentId}` : ''}) | ${LABELS[r.decision]}${r.disagreement ? ' — evaluators disagreed' : ''} | ${escape(r.state)} | ${escape(r.reason).slice(0, 180)} |`);
      for (const warning of r.warnings || []) lines.push(`| ↳ | Warning signal | | ${escape(warning)} |`);
    }
    lines.push('', 'Linked follow-ups and open closing issues are investigation signals; they do not prove a recommendation was wrong. Unobserved follow-ups remain unknown.', '',
      encode({ version: 1, records: kept }));
    const body = lines.join('\n');
    if (Buffer.byteLength(body) < 55000) return body;
    if (!kept.length) throw new Error('Summary metadata too large.');
    kept = kept.slice(1);
  }
}

async function publishBatch({ gh, repository, summaryNumber, actor, snapshots, primary, challenge, refresh, coverage = 'Bounded scan.', warnings = {} }) {
  const prefix = `repos/${repository}`;
  const issue = await gh.api('GET', `${prefix}/issues/${summaryNumber}`);
  if (issue.pull_request || issue.user?.id !== actor.id || issue.state !== 'open') throw new Error('Trial summary must be an open issue owned by the authenticated writer.');
  const state = parseSummary(issue.body), records = new Map(state.records.map(r => [r.number, r]));
  const assess = values => {
    if (!Array.isArray(values) || values.length > 25) throw new Error('Invalid assessment batch.');
    const map = new Map();
    for (const value of values) {
      if (map.has(value?.key)) throw new Error('Duplicate assessment key.');
      map.set(value?.key, value);
    }
    return map;
  };
  const first = assess(primary), second = assess(challenge);
  let reserved = false;
  for (const s of snapshots) {
    if (records.has(s.number) || s.draft || s.state !== 'open') continue;
    records.set(s.number, cohortRecord(s, { decision: 'pending', reason: 'Publication not yet confirmed; the next scan will reconcile.' }));
    reserved = true;
  }
  // Persist identities before any PR comment. A final-write failure followed by
  // PR closure must still leave a discoverable cohort member for the next scan.
  if (reserved) await gh.api('PATCH', `${prefix}/issues/${summaryNumber}`, {
    body: renderSummary({ repository, records: [...records.values()], coverage }),
  });
  for (const old of snapshots) {
    const comments = await gh.pages(`${prefix}/issues/${old.number}/comments`);
    const s = await refresh(old);
    const own = comments.filter(c => c.user?.id === actor.id && c.body?.startsWith(`${COMMENT}\n`)).sort((a, b) => b.id - a.id)[0];
    const previousRecord = records.get(s.number);
    let previous = null;
    try { if (own) previous = readComment(own.body); } catch { /* never reuse malformed evidence */ }
    if (['merged', 'closed'].includes(s.state) && previousRecord) {
      const recovered = previous?.cohort;
      const record = recovered?.number === s.number && LABELS[recovered.decision]
        ? { ...recovered, commentId: own.id } : previousRecord;
      records.set(s.number, { ...record, state: s.state, warnings: warnings[s.number] || previousRecord.warnings });
      continue;
    }
    // Do not create noise on unfinished drafts; do revoke an earlier ready verdict.
    if (s.draft && !own) continue;
    const key = snapshotKey(s);
    const result = decide(s, first.get(key) || previous?.assessor, second.get(key) || previous?.challenger);
    if (s.headSha !== old.headSha || s.baseSha !== old.baseSha || s.policyCommit !== old.policyCommit) {
      Object.assign(result, { decision: 'pending', reason: 'The PR revision changed during assessment; a fresh assessment is required.' });
    }
    const body = renderComment(s, result, summaryNumber);
    let comment = own;
    if (!own) comment = await gh.api('POST', `${prefix}/issues/${s.number}/comments`, { body });
    else if (own.body !== body) comment = await gh.api('PATCH', `${prefix}/issues/comments/${own.id}`, { body });
    records.delete(s.number);
    records.set(s.number, { ...cohortRecord(s, result), commentId: comment.id, warnings: warnings[s.number] || [] });
  }
  const body = renderSummary({ repository, records: [...records.values()], coverage });
  await gh.api('PATCH', `${prefix}/issues/${summaryNumber}`, { body });
  return { published: snapshots.length, summaryUrl: `https://github.com/${repository}/issues/${summaryNumber}` };
}

// SQLite provides an OS-released cross-process mutex without a stale lockfile
// recovery protocol. The file holds no application state and can be deleted.
async function withLock(commonGitDir, work) {
  const { DatabaseSync } = require('node:sqlite');
  mkdirSync(commonGitDir, { recursive: true });
  const db = new DatabaseSync(join(commonGitDir, 'cezar-merge-recommendations-lock.db'));
  try {
    try { db.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;'); }
    catch { throw new Error('Another merge recommendation publisher is active.'); }
    return await work();
  } finally {
    try { db.exec('ROLLBACK;'); } catch { /* no transaction acquired */ }
    db.close();
  }
}

module.exports = { COMMENT, SUMMARY, readComment, parseSummary, renderComment, renderSummary, publishBatch, withLock };
