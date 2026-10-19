'use strict';

const { HANDLING, LABELS, validateClassification } = require('./friction-policy.cjs');
const managed = new Set(LABELS.map(l => l.name));
const namesOf = issue => (issue.labels ?? []).map(l => typeof l === 'string' ? l : l.name);

async function ensureLabel(github, repo, label) {
  try {
    await github.rest.issues.getLabel({ ...repo, name: label.name });
  } catch (error) {
    if (error.status !== 404) throw error;
    try {
      await github.rest.issues.createLabel({ ...repo, ...label, description: label.description.slice(0, 100) });
    } catch (createError) {
      // Concurrent classifications may both find the label absent. Verify it
      // now exists; never treat an unrelated validation error as success.
      if (createError.status !== 422) throw createError;
      await github.rest.issues.getLabel({ ...repo, name: label.name });
    }
  }
}

async function applyClassification({ github, repo, issueNumber, input }) {
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0 || input?.issue?.number !== issueNumber) throw new Error('Friction artifact issue does not match the triggering issue.');
  const { data: current } = await github.rest.issues.get({ ...repo, issue_number: issueNumber });
  if (current.pull_request) return { status: 'skipped' };
  const names = namesOf(current);
  const eligible = current.state === 'open' && names.includes('friction');
  let desired = [];
  let result = null;
  if (eligible) {
    try { result = validateClassification(input.classification); } catch { /* revoke the captured route below */ }
    if (result) {
      if (current.title !== input.issue.title || (current.body ?? '') !== (input.issue.body ?? '')) return { status: 'stale' };
      desired = [`friction-${result.category}`, HANDLING[result.handling].label];
      for (const name of desired) await ensureLabel(github, repo, LABELS.find(l => l.name === name));
    } else {
      // Failure revocation is independent of title/body freshness. Queued runs
      // are serialized by issue; a different route may still have been applied
      // by a maintainer, so preserve it rather than revoke a newer decision.
      const captured = input.issue.managedLabels;
      if (!Array.isArray(captured) || captured.some(name => !managed.has(name))) throw new Error('Missing managed-label snapshot for failure revocation.');
      const actual = names.filter(name => managed.has(name));
      if (actual.length !== captured.length || actual.some(name => !captured.includes(name))) return { status: 'superseded' };
    }
    const { data: latest } = await github.rest.issues.get({ ...repo, issue_number: issueNumber });
    if (result && (latest.state !== current.state || latest.title !== current.title || (latest.body ?? '') !== (current.body ?? '') || !namesOf(latest).includes('friction'))) return { status: 'stale' };
    const latestManaged = namesOf(latest).filter(name => managed.has(name));
    const currentManaged = names.filter(name => managed.has(name));
    if (latestManaged.length !== currentManaged.length || latestManaged.some(name => !currentManaged.includes(name))) return { status: 'superseded' };
    names.splice(0, names.length, ...namesOf(latest));
  }
  // Remove obsolete managed labels before exposing the new route. Do not send
  // a wholesale label replacement that could drop concurrent unrelated labels.
  for (const name of names.filter(n => managed.has(n) && !desired.includes(n))) {
    try {
      await github.rest.issues.removeLabel({ ...repo, issue_number: issueNumber, name });
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  const missing = desired.filter(n => !names.includes(n));
  if (missing.length > 0) await github.rest.issues.addLabels({ ...repo, issue_number: issueNumber, labels: missing });
  return { status: eligible && result !== null ? 'applied' : 'cleared', labels: desired };
}

module.exports = { applyClassification, ensureLabel, namesOf };
