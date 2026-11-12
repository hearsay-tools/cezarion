'use strict';

// Warns in a `main` push run summary when the pushed commit has no refs/squeal/<sha>
// (docs/sdlc/ci.md § Squeal shared results; hearsay-tools/cezarion#3293). It never throws:
// publication stays outside the required checks, so this only reports.
async function squealRefWarning({ github, owner, repo, sha }) {
  if (!/^[0-9a-f]{40}$/.test(sha)) return { state: 'invalid', warning: `No Squeal ref check: \`${String(sha).slice(0, 80)}\` is not a commit SHA.` };
  try {
    await github.request('GET /repos/{owner}/{repo}/git/ref/{ref}', { owner, repo, ref: `squeal/${sha}` });
    return { state: 'present' };
  } catch (error) {
    if (error?.status === 404) {
      return { state: 'missing', warning: `Squeal shared results are missing: \`refs/squeal/${sha}\` does not exist. The queue run did not publish them, so developers' Squeal daemons import the nearest older ref. This does not block the merge.` };
    }
    return { state: 'unknown', warning: `Could not read \`refs/squeal/${sha}\` (HTTP ${Number.isInteger(error?.status) ? error.status : 'error'}), so its presence is unknown.` };
  }
}

module.exports = { squealRefWarning };
