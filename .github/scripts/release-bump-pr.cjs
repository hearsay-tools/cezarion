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

// Version stamps only: same JSON shape, differing leaves must both look like
// semver (optionally caret). Blocks added scripts/deps/keys and non-version edits.
const VERSION_VALUE_RE = /^\^?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function onlyVersionValueChanges(before, after) {
  if (Object.is(before, after)) return true;
  if (typeof before !== typeof after || before === null || after === null) return false;
  if (typeof before === 'string') {
    return VERSION_VALUE_RE.test(before) && VERSION_VALUE_RE.test(after);
  }
  if (typeof before !== 'object') return false;
  if (Array.isArray(before)) {
    if (!Array.isArray(after) || before.length !== after.length) return false;
    return before.every((value, index) => onlyVersionValueChanges(value, after[index]));
  }
  if (Array.isArray(after)) return false;
  const beforeKeys = Object.keys(before).sort();
  const afterKeys = Object.keys(after).sort();
  if (beforeKeys.length !== afterKeys.length) return false;
  if (beforeKeys.some((key, index) => key !== afterKeys[index])) return false;
  return beforeKeys.every((key) => onlyVersionValueChanges(before[key], after[key]));
}

function readRepoJsonFile({ repository, path: filePath, ref, env = process.env } = {}) {
  const out = execFileSync(
    'gh',
    ['api', `/repos/${repository}/contents/${filePath}?ref=${ref}`, '--jq', '.content'],
    { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
  if (!out) throw new Error(`empty content for ${filePath}@${ref}`);
  return JSON.parse(Buffer.from(out, 'base64').toString('utf8'));
}

function filesAreVersionStampsOnly({ repository, files, baseRef, headRef, env = process.env } = {}) {
  if (!repository || !baseRef || !headRef || !isManifestOnlyFiles(files)) return false;
  try {
    return files.every((filePath) => {
      const before = readRepoJsonFile({ repository, path: filePath, ref: baseRef, env });
      const after = readRepoJsonFile({ repository, path: filePath, ref: headRef, env });
      return onlyVersionValueChanges(before, after);
    });
  } catch {
    return false;
  }
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

function headShasMatch(expected, live) {
  return typeof expected === 'string'
    && typeof live === 'string'
    && /^[a-f0-9]{40}$/i.test(expected)
    && expected.toLowerCase() === live.toLowerCase();
}

// CI / review classify entry: EVENT_NAME, HEAD_REF, PR_AUTHOR, EXPECTED_HEAD_SHA,
// LIVE_HEAD_SHA, BASE_SHA, and PR_FILES with PR_FILES_OK=1 (successful full list).
// Then compare base/head JSON so only version-shaped leaves may change.
// Fail-closed to bump_pr=false on any missing/mismatched input.
function classifyFromEnv(env = process.env, deps = {}) {
  const stampsOnly = deps.filesAreVersionStampsOnly || filesAreVersionStampsOnly;
  if (env.EVENT_NAME !== 'pull_request' && env.EVENT_NAME !== 'pull_request_target') {
    return false;
  }
  const headRef = env.HEAD_REF || '';
  const prAuthor = env.PR_AUTHOR || '';
  if (!headRef.startsWith('release/v') || prAuthor !== 'github-actions[bot]') {
    return false;
  }
  if (!headShasMatch(env.EXPECTED_HEAD_SHA, env.LIVE_HEAD_SHA)) {
    return false;
  }
  if (env.PR_FILES_OK !== '1' || typeof env.PR_FILES !== 'string') {
    return false;
  }
  const files = env.PR_FILES.split('\n').map((line) => line.trim()).filter(Boolean);
  if (!isBotReleaseBumpPr({ headRef, prAuthor, files })) return false;
  const baseRef = env.BASE_SHA || '';
  const headSha = env.EXPECTED_HEAD_SHA || '';
  if (!/^[a-f0-9]{40}$/i.test(baseRef) || !env.GITHUB_REPOSITORY) return false;
  return stampsOnly({
    repository: env.GITHUB_REPOSITORY,
    files,
    baseRef,
    headRef: headSha,
    env,
  });
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
  onlyVersionValueChanges,
  filesAreVersionStampsOnly,
  headShasMatch,
  listPullFilesViaGh,
  classifyFromEnv,
  writeGithubOutput,
};
