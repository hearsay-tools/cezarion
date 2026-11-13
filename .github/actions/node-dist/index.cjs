'use strict';

// Installs an exact Node.js release into the layout that actions/setup-node's tool-cache
// lookup reads: <RUNNER_TOOL_CACHE>/node/<version>/<arch> plus <arch>.complete. With the
// version there, setup-node reports "Found in cache" and skips the actions/node-versions
// manifest, which it otherwise reads through the GitHub API with GITHUB_TOKEN.
// The archive is checked against the release's SHASUMS256.txt before it is unpacked.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DIST_URL = 'https://nodejs.org/dist';
// One retry for a stalled or broken download (hearsay-tools/cezarion#1214).
const ATTEMPTS = 2;
const ATTEMPT_TIMEOUT_MS = 60_000;

// The same match setup-node uses for a plain-text version file.
function parseVersion(text) {
  const raw = String(text);
  const version = raw.match(/^(?:node(js)?\s+)?v?(?<version>[^\s]+)$/m)?.groups?.version ?? raw.trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`needs an exact Node.js version such as 24.21.0, not '${version}'`);
  }
  return version;
}

function resolveVersion({ version, versionFile, workspace }) {
  if (version) return parseVersion(version);
  if (versionFile) return parseVersion(fs.readFileSync(path.join(workspace, versionFile), 'utf8'));
  throw new Error('set node-version or node-version-file');
}

// setup-node looks up translateArchToDistUrl(os.arch()); the archive names use the same arch.
function distArch(arch) {
  return arch === 'arm' ? 'armv7l' : arch;
}

function archiveName(version, platform, arch) {
  if (platform === 'win32') return `node-v${version}-win-${distArch(arch)}.zip`;
  if (platform === 'linux' || platform === 'darwin') return `node-v${version}-${platform}-${distArch(arch)}.tar.gz`;
  throw new Error(`no Node.js archive for platform ${platform}`);
}

function toolDir(toolCache, version, arch) {
  return path.join(toolCache, 'node', version, distArch(arch));
}

function expectedSha256(sums, file) {
  const line = sums.split('\n').find((entry) => entry.trim().endsWith(`  ${file}`));
  const hash = line?.trim().split(/\s+/)[0];
  if (!/^[0-9a-f]{64}$/.test(hash ?? '')) throw new Error(`SHASUMS256.txt has no entry for ${file}`);
  return hash;
}

async function fetchBytes(url, fetchImpl, timeoutMs) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`GET ${url} returned ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function withRetry(label, attempt, log) {
  for (let n = 1; ; n += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (n >= ATTEMPTS) throw error;
      log(`${label} failed (${error.message}); retrying once`);
    }
  }
}

async function download({ url, sha256, file, get, log }) {
  return withRetry(`Download of ${url}`, async () => {
    const bytes = await get(url);
    const actual = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actual !== sha256) throw new Error(`SHA-256 of ${url} is ${actual}, SHASUMS256.txt says ${sha256}`);
    fs.writeFileSync(file, bytes);
  }, log);
}

// Windows ships bsdtar as System32\tar.exe, which reads zip; Git's GNU tar on PATH does not.
function unpack(archive, destination, platform) {
  const tar = platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const read = platform === 'win32' ? '-xf' : '-xzf';
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  execFileSync(tar, [read, archive, '-C', destination, '--strip-components=1'], { stdio: 'inherit' });
}

async function install({
  version, platform = process.platform, arch = os.arch(), toolCache, tempDir,
  distUrl = DIST_URL, fetchImpl = fetch, timeoutMs = ATTEMPT_TIMEOUT_MS, log = console.log,
}) {
  const destination = toolDir(toolCache, version, arch);
  const marker = `${destination}.complete`;
  if (fs.existsSync(marker) && fs.existsSync(destination)) {
    log(`Node.js ${version} is already in the tool cache at ${destination}`);
    return destination;
  }
  const file = archiveName(version, platform, arch);
  const base = `${distUrl}/v${version}`;
  const get = (url) => fetchBytes(url, fetchImpl, timeoutMs);
  const sums = await withRetry(`Download of ${base}/SHASUMS256.txt`, () => get(`${base}/SHASUMS256.txt`), log);
  const archive = path.join(tempDir, file);
  await download({ url: `${base}/${file}`, sha256: expectedSha256(sums.toString('utf8'), file), file: archive, get, log });
  fs.rmSync(marker, { force: true });
  unpack(archive, destination, platform);
  fs.writeFileSync(marker, '');
  fs.rmSync(archive, { force: true });
  log(`Installed Node.js ${version} from ${base}/${file} (SHA-256 checked) into ${destination}`);
  return destination;
}

async function main(env = process.env) {
  if (!env.RUNNER_TOOL_CACHE) throw new Error('RUNNER_TOOL_CACHE is not set');
  const version = resolveVersion({
    version: env['INPUT_NODE-VERSION'],
    versionFile: env['INPUT_NODE-VERSION-FILE'],
    workspace: env.GITHUB_WORKSPACE || process.cwd(),
  });
  await install({ version, toolCache: env.RUNNER_TOOL_CACHE, tempDir: env.RUNNER_TEMP || os.tmpdir() });
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `node-version=${version}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.log(`::error::${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { ATTEMPTS, ATTEMPT_TIMEOUT_MS, archiveName, expectedSha256, install, main, parseVersion, resolveVersion, toolDir };
