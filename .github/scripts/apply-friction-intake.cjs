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

function assertTriggerMatches(issueNumber, input) {
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0 || input?.issue?.number !== issueNumber) throw new Error('Friction artifact issue does not match the triggering issue.');
}

function desiredLabels(result) {
  return [`friction-${result.category}`, HANDLING[result.handling].label];
}

async function ensureLabels(github, repo, names) {
  for (const name of names) await ensureLabel(github, repo, LABELS.find(l => l.name === name));
}

// Failure revocation is independent of title/body freshness. Queued runs
// are serialized by issue; a different route may still have been applied
// by a maintainer, so preserve it rather than revoke a newer decision.
// Returns 'superseded' when the live labels no longer match the captured
// snapshot, null when revocation may proceed.
function revocationStatus(input, names) {
  const captured = input.issue.managedLabels;
  if (!Array.isArray(captured) || captured.some(name => !managed.has(name))) throw new Error('Missing managed-label snapshot for failure revocation.');
  const actual = names.filter(name => managed.has(name));
  if (actual.length !== captured.length || actual.some(name => !captured.includes(name))) return 'superseded';
  return null;
}

function staleSinceCapture(current, latest) {
  return latest.state !== current.state || latest.title !== current.title || (latest.body ?? '') !== (current.body ?? '');
}

function managedDrift(names, latest) {
  const latestManaged = namesOf(latest).filter(name => managed.has(name));
  const currentManaged = names.filter(name => managed.has(name));
  return latestManaged.length !== currentManaged.length || latestManaged.some(name => !currentManaged.includes(name));
}

// Re-fetch the issue and reject a decision captured against a stale or
// superseded view. Returns 'stale', 'superseded', or null to continue, and
// refreshes `names` in place with the latest labels when the decision stands.
async function recheckStatus({ github, repo, issueNumber, current, names, result }) {
  const { data: latest } = await github.rest.issues.get({ ...repo, issue_number: issueNumber });
  if (result && (staleSinceCapture(current, latest) || !namesOf(latest).includes('friction'))) return 'stale';
  if (managedDrift(names, latest)) return 'superseded';
  names.splice(0, names.length, ...namesOf(latest));
  return null;
}

// Resolves the eligible branch: validates the classification (or guards the
// failure revocation), applies its labels, then re-checks freshness. Returns
// { desired, status, validated } with status 'stale' | 'superseded' | null.
async function resolveEligible({ github, repo, issueNumber, current, names, input }) {
  let result = null;
  try { result = validateClassification(input.classification); } catch { /* revoke the captured route below */ }
  if (result) {
    if (current.title !== input.issue.title || (current.body ?? '') !== (input.issue.body ?? '')) return { desired: [], status: 'stale', validated: true };
    const desired = desiredLabels(result);
    await ensureLabels(github, repo, desired);
    return { desired, status: await recheckStatus({ github, repo, issueNumber, current, names, result }), validated: true };
  }
  const status = revocationStatus(input, names);
  if (status) return { desired: [], status, validated: false };
  return { desired: [], status: await recheckStatus({ github, repo, issueNumber, current, names, result }), validated: false };
}

async function removeObsoleteLabels(github, repo, issueNumber, names, desired) {
  // Remove obsolete managed labels before exposing the new route. Do not send
  // a wholesale label replacement that could drop concurrent unrelated labels.
  for (const name of names.filter(n => managed.has(n) && !desired.includes(n))) {
    try {
      await github.rest.issues.removeLabel({ ...repo, issue_number: issueNumber, name });
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
}

async function applyClassification({ github, repo, issueNumber, input }) {
  assertTriggerMatches(issueNumber, input);
  const { data: current } = await github.rest.issues.get({ ...repo, issue_number: issueNumber });
  if (current.pull_request) return { status: 'skipped' };
  const names = namesOf(current);
  const eligible = current.state === 'open' && names.includes('friction');
  let desired = [];
  let validated = false;
  if (eligible) {
    const resolved = await resolveEligible({ github, repo, issueNumber, current, names, input });
    if (resolved.status) return { status: resolved.status };
    desired = resolved.desired;
    validated = resolved.validated;
  }
  await removeObsoleteLabels(github, repo, issueNumber, names, desired);
  const missing = desired.filter(n => !names.includes(n));
  if (missing.length > 0) await github.rest.issues.addLabels({ ...repo, issue_number: issueNumber, labels: missing });
  return { status: eligible && validated ? 'applied' : 'cleared', labels: desired };
}

module.exports = { applyClassification, ensureLabel, namesOf };
