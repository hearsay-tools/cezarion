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

// The configured identity comes from a repository variable, never PR content.
function isReleaseBot(prAuthor, releaseAppBotLogin) {
  return prAuthor === 'github-actions[bot]'
    || (typeof releaseAppBotLogin === 'string'
      && /^[a-z0-9][a-z0-9-]*\[bot\]$/.test(releaseAppBotLogin)
      && prAuthor === releaseAppBotLogin);
}

function isBotReleaseBumpPr({ headRef, prAuthor, files, releaseAppBotLogin } = {}) {
  return typeof headRef === 'string'
    && headRef.startsWith('release/v')
    && isReleaseBot(prAuthor, releaseAppBotLogin)
    && isManifestOnlyFiles(files);
}

// Release-generated stamps only: same JSON shape; changes only at version /
// dependency-map leaves; every changed leaf shares one old→new semver pair
// (optional caret). Blocks script/key adds and arbitrary field retargets.
const VERSION_VALUE_RE = /^(\^?)(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/;
const DEP_MAP_KEYS = new Set([
  'dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies',
]);

function parseVersionValue(value) {
  if (typeof value !== 'string') return null;
  const match = VERSION_VALUE_RE.exec(value);
  if (!match) return null;
  return { caret: match[1] === '^', version: match[2] };
}

function onlyVersionValueChanges(before, after, sharedPair) {
  const pair = sharedPair || { from: null, to: null };
  let sawChange = false;

  function acceptVersionChange(left, right) {
    const from = parseVersionValue(left);
    const to = parseVersionValue(right);
    if (!from || !to || from.caret !== to.caret || from.version === to.version) return false;
    if (!pair.from) {
      pair.from = from.version;
      pair.to = to.version;
    } else if (pair.from !== from.version || pair.to !== to.version) {
      return false;
    }
    sawChange = true;
    return true;
  }

  function walk(left, right, pathKind) {
    if (Object.is(left, right)) return true;
    if (typeof left !== typeof right || left === null || right === null) return false;
    if (typeof left === 'string') {
      if (
        pathKind === 'root-version'
        || pathKind === 'dep-map'
        || pathKind === 'lock-pkg-version'
        || pathKind === 'lock-pkg-deps'
      ) {
        return acceptVersionChange(left, right);
      }
      return false;
    }
    if (typeof left !== 'object') return false;
    if (Array.isArray(left)) {
      if (!Array.isArray(right) || left.length !== right.length) return false;
      return left.every((value, index) => walk(value, right[index], pathKind));
    }
    if (Array.isArray(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    if (leftKeys.some((key, index) => key !== rightKeys[index])) return false;
    return leftKeys.every((key) => {
      let nextKind = 'other';
      if (pathKind === 'root' && key === 'version') nextKind = 'root-version';
      else if (pathKind === 'root' && key === 'packages') nextKind = 'lock-pkg-map';
      else if (pathKind === 'root' && DEP_MAP_KEYS.has(key)) nextKind = 'dep-map';
      else if (pathKind === 'lock-pkg-map') nextKind = 'lock-pkg';
      else if (pathKind === 'lock-pkg' && key === 'version') nextKind = 'lock-pkg-version';
      else if (pathKind === 'lock-pkg' && DEP_MAP_KEYS.has(key) && key !== 'packages') nextKind = 'lock-pkg-deps';
      else if (pathKind === 'dep-map' || pathKind === 'lock-pkg-deps') nextKind = pathKind;
      if (nextKind === 'other') {
        return JSON.stringify(left[key]) === JSON.stringify(right[key]);
      }
      return walk(left[key], right[key], nextKind);
    });
  }

  if (!walk(before, after, 'root')) return false;
  if (sharedPair) return true;
  return sawChange && Boolean(pair.from && pair.to);
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

function filesAreVersionStampsOnly({
  repository,
  files,
  baseRef,
  headRef,
  env = process.env,
  readJsonFile = readRepoJsonFile,
} = {}) {
  if (!repository || !baseRef || !headRef || !isManifestOnlyFiles(files)) return false;
  try {
    const pair = { from: null, to: null };
    for (const filePath of files) {
      const before = readJsonFile({ repository, path: filePath, ref: baseRef, env });
      const after = readJsonFile({ repository, path: filePath, ref: headRef, env });
      if (!onlyVersionValueChanges(before, after, pair)) return false;
    }
    return Boolean(pair.from && pair.to && pair.from !== pair.to);
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
  if (!headRef.startsWith('release/v') || !isReleaseBot(prAuthor, env.RELEASE_APP_BOT_LOGIN)) {
    return false;
  }
  if (!headShasMatch(env.EXPECTED_HEAD_SHA, env.LIVE_HEAD_SHA)) {
    return false;
  }
  if (env.PR_FILES_OK !== '1' || typeof env.PR_FILES !== 'string') {
    return false;
  }
  const files = env.PR_FILES.split('\n').map((line) => line.trim()).filter(Boolean);
  if (!isBotReleaseBumpPr({ headRef, prAuthor, files, releaseAppBotLogin: env.RELEASE_APP_BOT_LOGIN })) return false;
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
