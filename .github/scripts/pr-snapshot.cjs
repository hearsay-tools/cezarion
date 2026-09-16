'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pickPullRequestRun } = require('./fetch-ci-results.cjs');
const positive = n => Number.isSafeInteger(n) && n > 0;
const successful = job => job?.status === 'completed' && job.conclusion === 'success';

// Resolve every publishing decision from GitHub, never from artifact metadata.
// Return null for old-base runs without preparation: the introducing PR still
// verifies using the installed target workflow, before the publisher is installed.
async function resolveSnapshot({ github, owner, repo, trigger }) {
  const repository = `${owner}/${repo}`;
  const get = async (route, args = {}) => (await github.request(`GET /repos/{owner}/{repo}/${route}`, { owner, repo, ...args })).data;
  const list = (route, args = {}) => github.paginate(`GET /repos/{owner}/{repo}/${route}`, { owner, repo, per_page: 100, ...args });
  if (!positive(trigger?.id) || !positive(trigger?.run_attempt)) return null;
  const run = await get('actions/runs/{run_id}', { run_id: trigger.id });
  if (run.id !== trigger.id || run.run_attempt !== trigger.run_attempt || run.head_sha !== trigger.head_sha ||
      run.path !== '.github/workflows/ci.yml' || run.event !== 'pull_request_target' || !successful(run) ||
      !positive(run.run_number) || !/^[a-f0-9]{40}$/.test(run.head_sha || '') ||
      run.head_repository?.full_name !== repository) return null;
  const pulls = await list('pulls', { state: 'open', head: `${owner}:${run.head_branch}` });
  const matches = pulls.filter(p => p.head?.sha === run.head_sha && p.head?.ref === run.head_branch &&
    p.head?.repo?.full_name === repository && p.base?.repo?.full_name === repository &&
    ['main', 'develop'].includes(p.base?.ref) && p.state === 'open');
  if (matches.length !== 1 || !positive(matches[0].number)) return null;
  const pull = await get('pulls/{pull_number}', { pull_number: matches[0].number });
  if (pull.number !== matches[0].number || pull.state !== 'open' || pull.head?.sha !== run.head_sha ||
      pull.head?.repo?.full_name !== repository || pull.base?.repo?.full_name !== repository ||
      !['main', 'develop'].includes(pull.base?.ref)) return null;
  const runs = await list('actions/workflows/{workflow_id}/runs', { workflow_id: 'ci.yml', head_sha: run.head_sha });
  const selected = pickPullRequestRun(runs.map(r => ({ ...r, databaseId: r.id, headSha: r.head_sha })), run.head_sha);
  if (selected?.id !== run.id || selected.run_attempt !== run.run_attempt) return null;
  const jobs = await list('actions/runs/{run_id}/attempts/{attempt_number}/jobs', { run_id: run.id, attempt_number: run.run_attempt });
  for (const name of ['Unit, build, E2E, and package', 'Prepare PR snapshot archives']) {
    const matching = jobs.filter(j => j.name === name);
    if (matching.length !== 1 || !successful(matching[0])) return null;
  }
  const artifacts = (await list('actions/runs/{run_id}/artifacts', { run_id: run.id }))
    .filter(a => a.name === `pr-snapshot-${run.run_attempt}`);
  if (artifacts.length !== 1 || artifacts[0].expired || !positive(artifacts[0].id)) return null;
  return { pr: pull.number, head: run.head_sha, runId: run.id, runNumber: run.run_number, attempt: run.run_attempt, artifactId: artifacts[0].id };
}

// #371: inspect the entire stream, including data after zero blocks. GNU tar
// and npm disagree on archive termination and path aliases. Only canonical,
// unique, regular-file/directory paths are accepted; publishing repacks those
// files using the same GNU reader, never handing npm the original byte stream.
function validateArchives({ artifacts, manifests, plan }) {
  if (![plan.pr, plan.runNumber, plan.attempt].every(positive)) throw new Error('Invalid snapshot identity');
  const keys = Object.keys(manifests).filter(key => manifests[key].private !== true);
  const files = fs.readdirSync(artifacts).sort();
  if (JSON.stringify(files) !== JSON.stringify(keys.map(key => `${key}.tgz`).sort())) throw new Error('Unexpected snapshot archive set');
  const suffix = `-pr${plan.pr}.${plan.runNumber}${plan.attempt > 1 ? `.${plan.attempt}` : ''}`;
  const entries = keys.map(key => {
    const file = path.resolve(artifacts, `${key}.tgz`);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 100 * 1024 * 1024) throw new Error('Invalid archive file');
    const options = { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30_000 };
    const members = execFileSync('tar', ['--ignore-zeros', '-tzf', file], options).trim().split('\n');
    if (new Set(members).size !== members.length || members.filter(p => p === 'package/package.json').length !== 1 ||
        members.some(p => !p.startsWith('package/') || /[\\\x00-\x1f\x7f]/.test(p) ||
          p.replace(/\/$/, '').split('/').some(part => !part || part === '.' || part === '..'))) throw new Error('Invalid archive members');
    const types = execFileSync('tar', ['--ignore-zeros', '-tvzf', file], options).trim().split('\n');
    if (types.some(line => !/^[d-]/.test(line))) throw new Error('Invalid archive entry type');
    const pkg = JSON.parse(execFileSync('tar', ['--ignore-zeros', '-xOzf', file, 'package/package.json'], options));
    if (pkg.name !== manifests[key].name || pkg.private === true ||
        typeof pkg.version !== 'string' || !pkg.version.endsWith(suffix) ||
        !/^\d+\.\d+\.\d+$/.test(pkg.version.slice(0, -suffix.length))) throw new Error('Unexpected snapshot package identity');
    if (pkg.publishConfig && Object.entries(pkg.publishConfig).some(([k, v]) => k !== 'access' || v !== 'public')) throw new Error('Unsafe publishConfig');
    return { key, file, pkg };
  });
  const version = entries[0]?.pkg.version;
  if (!version || entries.some(e => e.pkg.version !== version)) throw new Error('Snapshot versions differ');
  const service = entries.find(e => e.key === 'cezar');
  const alias = entries.find(e => e.key === 'alias');
  if (!service || !alias || alias.pkg.dependencies?.[service.pkg.name] !== version) throw new Error('Alias must pin the service snapshot');
  for (const { pkg } of entries) {
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const sibling of Object.values(manifests)) {
        if (pkg[section]?.[sibling.name] !== undefined && pkg[section][sibling.name] !== version) throw new Error('Unpinned snapshot dependency');
      }
    }
  }
  return entries;
}

function publishArchives({ entries, plan, dryRun, execute = execFileSync }) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'trusted-snapshot-publish-'));
  try {
    for (const entry of entries) {
      const contents = path.join(cwd, entry.key);
      fs.mkdirSync(contents);
      const options = { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 };
      execFileSync('tar', ['--ignore-zeros', '-xzf', entry.file, '--no-same-owner',
        '--no-same-permissions', '-C', contents], options);
      const canonical = path.join(cwd, `${entry.key}.tgz`);
      execFileSync('tar', ['-czf', canonical, '--format=posix', '-C', contents, 'package'], options);
      execute('npm', ['publish', canonical, '--ignore-scripts', '--registry=https://registry.npmjs.org',
        '--access=public', `--tag=pr-${plan.pr}`, ...(dryRun ? ['--dry-run'] : ['--provenance'])],
      { cwd, stdio: 'inherit' });
    }
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

module.exports = { resolveSnapshot, validateArchives, publishArchives };
