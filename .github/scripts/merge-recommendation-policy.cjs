'use strict';

const { createHash } = require('node:crypto');
const VERSION = 1;
const REQUIRED = ['Unit, build, E2E, and package', 'Automated Code Review'];
const SHA = /^[a-f0-9]{40}$/;
const text = (s, max = 600) => typeof s === 'string' && s.trim().length > 0 && s.length <= max;
const integer = n => Number.isSafeInteger(n) && n >= 0;

function snapshotKey(s) {
  return createHash('sha256').update(JSON.stringify([
    s.repository, s.number, s.headSha, s.baseSha, s.policyCommit, s.policyVersion, s.diff,
  ])).digest('hex');
}

function fileKind(path) {
  if (typeof path !== 'string' || !/^[a-zA-Z0-9_./-]+$/.test(path)
    || path.split('/').some(p => !p || p === '..' || p === '.')) return null;
  if (/(?:^|\/)(?:AGENTS|CLAUDE|SKILL|SDLC|CODE_REVIEW|BACKWARD_COMPATIBILITY)\.md$/i.test(path)
    || /(?:^|\/)(?:sdlc|specs|plans|policies|skills|fixtures|__fixtures__|__snapshots__)(?:\/|$)/i.test(path)
    || /(?:generated|\.snap(?:\.|$))/i.test(path)) return null;
  if (path === 'README.md' || /^(?:docs\/|packages\/[^/]+\/docs\/)[^\n]+\.md$/.test(path)) return 'documentation';
  if (/^(?:packages\/|scripts\/|\.github\/scripts\/).+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)) return 'additive-tests';
  return null;
}

function gate(s) {
  const rules = [];
  const add = (id, passed, reason, severity = 'pending') => rules.push({ id, passed: passed === true, reason, severity });
  add('evidence', s?.complete === true && s.trusted === true && s.policyVersion === VERSION
    && SHA.test(s.headSha || '') && SHA.test(s.baseSha || '') && SHA.test(s.policyCommit || '')
    && text(s.diff, 1024 * 1024) && Array.isArray(s.files) && s.files.length > 0,
  'Complete diff and trusted versioned policy are required.');
  const files = Array.isArray(s?.files) ? s.files : [];
  const countsKnown = files.length > 0 && files.every(f => integer(f.additions) && integer(f.deletions));
  add('counts', countsKnown, 'Every file needs exact addition and deletion counts.');
  add('size', s?.sizeExceeded !== true && files.length <= 5 && (!countsKnown || files.reduce((sum, f) => sum + f.additions + f.deletions, 0) <= 150),
    'At most 5 files and 150 added/deleted lines, including tests and generated content.', 'human-review');
  add('surface', files.every(f => fileKind(f.path) && ['added', 'modified'].includes(f.status)
    && f.mode === '100644' && !f.modeChanged
    && (fileKind(f.path) !== 'additive-tests' || f.deletions === 0)),
  'Only ordinary Markdown corrections and additive tests; no policy, runtime, config, renames, deletions or special files.', 'human-review');
  add('target', s?.sameRepository === true && s.targetDefault === true,
    'Same-repository PR targeting the default branch.', 'human-review');
  add('open', s?.state === 'open' && s.draft === false, 'PR must be open and ready for review.');
  add('mergeable', s?.mergeable === true && s.mergeState === 'clean', 'GitHub must report a clean, mergeable PR.');
  add('reviews', s?.openThreads === 0 && [null, 'APPROVED'].includes(s.reviewDecision),
    'No unresolved review threads, requested changes or unmet review requirements.');
  const required = Array.isArray(s?.requiredChecks) ? s.requiredChecks : [];
  const checks = Array.isArray(s?.checks) ? s.checks : [];
  const requirementsKnown = REQUIRED.every(name => required.some(c => c.name === name))
    && required.every(c => text(c.name, 200) && Number.isSafeInteger(c.appId) && c.appId > 0);
  const latest = new Map();
  for (const c of checks) {
    if (c.headSha !== s.headSha || !Number.isSafeInteger(c.id)) continue;
    const key = `${c.name}:${c.appId}`;
    if (!latest.has(key) || latest.get(key).id < c.id) latest.set(key, c);
  }
  add('checks', requirementsKnown && required.every(c => {
    const check = latest.get(`${c.name}:${c.appId}`);
    return check?.status === 'completed' && check.conclusion === 'success';
  }), 'All required checks must succeed on this head from the configured GitHub Apps; skipped and neutral are insufficient.');
  const failing = rules.filter(r => !r.passed);
  return { decision: failing.some(r => r.severity === 'human-review') ? 'human-review' : failing.length ? 'pending' : 'candidate', rules };
}

function validateAssessment(s, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(k => !['key', 'decision', 'reason', 'intent', 'evidence'].includes(k))
    || value.key !== snapshotKey(s) || !['recommend', 'human-review', 'pending'].includes(value.decision)
    || !text(value.reason) || !text(value.intent) || !Array.isArray(value.evidence) || value.evidence.length > 5) {
    throw new Error('Invalid or stale assessment.');
  }
  const paths = new Set(s.files.map(f => f.path)), seen = new Set();
  for (const e of value.evidence) {
    if (!e || Object.keys(e).some(k => !['path', 'reason'].includes(k))
      || !paths.has(e.path) || seen.has(e.path) || !text(e.reason)) throw new Error('Invalid file evidence.');
    seen.add(e.path);
  }
  if (value.decision === 'recommend' && seen.size !== paths.size) throw new Error('A recommendation requires evidence for every changed file.');
  return value;
}

function decide(s, assessor, challenger) {
  const result = gate(s);
  if (result.decision !== 'candidate') return result;
  try { validateAssessment(s, assessor); }
  catch { return { ...result, decision: 'pending', reason: 'Missing, invalid or stale assessor output.' }; }
  if (assessor.decision !== 'recommend') return { ...result, decision: assessor.decision, reason: assessor.reason };
  try { validateAssessment(s, challenger); }
  catch { return { ...result, decision: 'pending', reason: 'Missing, invalid or stale independent challenge.' }; }
  return { ...result, decision: challenger.decision, reason: challenger.reason,
    disagreement: challenger.decision !== 'recommend', assessor, challenger };
}

module.exports = { VERSION, REQUIRED, snapshotKey, fileKind, gate, validateAssessment, decide };
