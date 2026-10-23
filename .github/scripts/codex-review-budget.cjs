// Loaded only from the trusted workflow revision, never from the PR merge tree.
function reviewMinutes(metadata) {
  const counts = [metadata?.additions, metadata?.deletions, metadata?.changed_files];
  if (!counts.every(value => Number.isSafeInteger(value) && value >= 0)) return 24;
  return metadata.additions + metadata.deletions >= 3000 || metadata.changed_files >= 50 ? 24 : 12;
}

async function selectBudget({ github, owner, repo, pullNumber, warn = () => {} }) {
  try {
    const { data } = await github.rest.pulls.get({ owner, repo, pull_number: pullNumber });
    return reviewMinutes(data);
  } catch {
    warn('PR sizing is unavailable; using the bounded 24-minute Codex review budget.');
    return 24;
  }
}

async function failureMessage({ github, owner, repo, runId, runAttempt, outputPresent = false }) {
  if (outputPresent) return 'Codex wrote review output, but publication failed. See the codex-review job; this is not a review rejection.';
  const rerun = `gh run rerun ${runId} --failed --repo ${owner}/${repo}`;
  try {
    // The attempt-specific endpoint prevents a prior timeout from blaming a
    // later provider failure. A generic failure outcome does not prove timeout.
    const jobs = await github.paginate('GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs', {
      owner, repo, run_id: runId, attempt_number: runAttempt, per_page: 100,
    });
    const candidates = jobs.filter(job => /(?:^| \/ )codex-review$/.test(job.name));
    if (candidates.length !== 1 || !Number.isSafeInteger(candidates[0].id) || candidates[0].id < 1) {
      throw new Error('No unique Codex job in this attempt');
    }
    // GitHub Actions job IDs are also their check-run IDs.
    const annotations = await github.paginate('GET /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations', {
      owner, repo, check_run_id: candidates[0].id, per_page: 100,
    });
    if (annotations.some(annotation => annotation.annotation_level === 'failure'
      && annotation.message.trim() === 'The action has timed out.')) {
      return `The review timed out; re-run failed jobs: ${rerun}`;
    }
    return `Codex review failed without publishable output. No action-timeout annotation was found. See the codex-review job. Retry command: ${rerun}`;
  } catch {
    // Diagnostics must never turn a provider failure into a passing verdict or
    // invent a timeout when GitHub evidence is absent or unavailable.
    return `Codex review failed; timeout evidence is unavailable. See the codex-review job. Retry command: ${rerun}`;
  }
}

module.exports = { reviewMinutes, selectBudget, failureMessage };
