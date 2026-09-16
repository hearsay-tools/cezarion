'use strict';

// Shared shape for bot-authored release/v* version-bump PRs. Keep the path
// allowlist identical to release-finalization.cjs staging (packages/*/package.json,
// alias-cezarion/package.json, package-lock.json). Callers must pass the live PR
// file list — author + branch alone is not enough after a human push.

const { execFileSync } = require('node:child_process');
const { appendFileSync } = require('node:fs');

const RELEASE_BUMP_FILE_RE =
  /^(packages\/[^/]+\/package\.json|alias-cezarion\/package\.json|package-lock\.json)$/;

function isReleaseBumpFile(file) {
  return typeof file === 'string' && RELEASE_BUMP_FILE_RE.test(file);
}

function isManifestOnlyFiles(files) {
  return Array.isArray(files) && files.length > 0 && files.every(isReleaseBumpFile);
}

function isBotReleaseBumpPr({ headRef, prAuthor, files } = {}) {
  return typeof headRef === 'string'
    && headRef.startsWith('release/v')
    && prAuthor === 'github-actions[bot]'
    && isManifestOnlyFiles(files);
}

function listPullFilesViaGh({ repository, pullNumber, env = process.env } = {}) {
  if (!repository || !pullNumber) return [];
  const out = execFileSync(
    'gh',
    ['api', '--paginate', `/repos/${repository}/pulls/${pullNumber}/files`, '--jq', '.[].filename'],
    { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return out.split('\n').map((line) => line.trim()).filter(Boolean);
}

function writeGithubOutput(name, value, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) {
    process.stdout.write(`${name}=${value}\n`);
    return;
  }
  appendFileSync(outputPath, `${name}=${value}\n`);
}

// CI / review classify entry: EVENT_NAME, HEAD_REF, PR_AUTHOR, and either
// PR_FILES (newline-separated) or PR_NUMBER + GITHUB_REPOSITORY + GH_TOKEN to
// list files via gh. Fail-closed to bump_pr=false.
function classifyFromEnv(env = process.env) {
  if (env.EVENT_NAME !== 'pull_request' && env.EVENT_NAME !== 'pull_request_target') {
    return false;
  }
  const headRef = env.HEAD_REF || '';
  const prAuthor = env.PR_AUTHOR || '';
  if (!headRef.startsWith('release/v') || prAuthor !== 'github-actions[bot]') {
    return false;
  }
  let files = [];
  if (typeof env.PR_FILES === 'string') {
    files = env.PR_FILES.split('\n').map((line) => line.trim()).filter(Boolean);
  } else {
    try {
      files = listPullFilesViaGh({
        repository: env.GITHUB_REPOSITORY,
        pullNumber: env.PR_NUMBER,
        env,
      });
    } catch {
      return false;
    }
  }
  return isBotReleaseBumpPr({ headRef, prAuthor, files });
}

if (require.main === module) {
  const bump = classifyFromEnv();
  writeGithubOutput('bump_pr', bump ? 'true' : 'false');
}

module.exports = {
  RELEASE_BUMP_FILE_RE,
  isReleaseBumpFile,
  isManifestOnlyFiles,
  isBotReleaseBumpPr,
  listPullFilesViaGh,
  classifyFromEnv,
  writeGithubOutput,
};
