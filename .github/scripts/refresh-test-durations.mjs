import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { relative, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { fallbackDuration } from './ci-test-sequencer.mjs';

const execute = promisify(execFile);
const SAMPLE_COUNT = 3;
const PATCH_BUDGET_BYTES = 40000;
const manifests = { browser: '.github/cockpit-test-durations.json', vitest: '.github/test-durations.json' };

/** Read suite summaries, never individual tests. A retry must not count twice. */
export function parseDurations(log, inventory) {
  const paths = new Map(inventory.map(entry => [`${entry.project}\0${entry.reported}`, entry.file]));
  const result = {};
  const plain = log.replace(/\u001b\[[0-9;]*m|\^\[\[[0-9;]*m/g, '');
  for (const line of plain.split('\n')) {
    const match = line.match(/✓\s+\|?([\w-]+)\|?\s+(\S+)\s+\(\d+ tests?[^)]*\)\s+(\d+)ms/);
    if (!match) continue;
    const file = paths.get(`${match[1]}\0${match[2]}`);
    const duration = Number(match[3]);
    if (file && duration > 0 && !Object.hasOwn(result, file)) result[file] = duration;
  }
  return result;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function makeManifest(inventory, samples, kind) {
  if (samples.length < SAMPLE_COUNT) throw new Error('Need at least three measured eight-shard runs');
  if (new Set(samples.map(run => run.id)).size !== samples.length) throw new Error('Need distinct runs');
  const durationsMs = {};
  const estimatedFiles = [];
  for (const { file } of inventory) {
    const values = samples.map(run => run.durationsMs[file]).filter(value => Number.isFinite(value) && value > 0);
    if (values.length) durationsMs[file] = Math.round(median(values));
    else estimatedFiles.push(file);
  }
  if (!Object.keys(durationsMs).length) throw new Error('No current files were measured');
  const estimate = fallbackDuration(durationsMs);
  for (const file of estimatedFiles) durationsMs[file] = estimate;
  return {
    _provenance: {
      source: 'Successful CI eight-shard suite summaries on main or its merge queue',
      aggregation: 'Per-file median of available passed suite durations; milliseconds. Unmeasured current files use the measured upper quartile.',
      root: kind === 'browser' ? 'packages/web/e2e' : '.',
      runs: samples.map(({ id, headSha, jobs }) => ({ id, headSha, jobs })),
      estimatedFiles,
    },
    durationsMs: Object.fromEntries(Object.entries(durationsMs).sort(([a], [b]) => a.localeCompare(b))),
  };
}

export function changedFiles(previous, next) {
  const old = previous.durationsMs;
  const fresh = next.durationsMs;
  const inventory = [...new Set([...Object.keys(old), ...Object.keys(fresh)])]
    .filter(file => !Object.hasOwn(old, file) || !Object.hasOwn(fresh, file)).sort();
  const drift = Object.keys(fresh).filter(file => Object.hasOwn(old, file)
    && (!Number.isFinite(old[file]) || old[file] <= 0
      || (Math.abs(fresh[file] - old[file]) >= 5000 && Math.abs(fresh[file] - old[file]) / old[file] >= 0.25))).sort();
  // Inventory changes go first so small fluctuations cannot starve new files.
  return [...inventory, ...drift];
}

export function needsRefresh(previous, next) {
  return changedFiles(previous, next).length > 0;
}

export function manifestPatchBytes(previous, next) {
  const directory = mkdtempSync(join(tmpdir(), 'test-duration-patch-'));
  try {
    const paths = ['before.json', 'after.json'].map(file => join(directory, file));
    [previous, next].forEach((value, i) => writeFileSync(paths[i], typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`));
    const diff = spawnSync('git', ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3', '--', ...paths],
      { maxBuffer: 4 * 1024 * 1024 });
    if (![0, 1].includes(diff.status)) throw new Error(`Cannot measure manifest patch: ${diff.error?.message ?? diff.stderr}`);
    return diff.stdout.length;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Keep each generated manifest patch well below GitHub's omitted-patch boundary. */
export function boundedManifest(previous, next, baselineCommit, measure = manifestPatchBytes) {
  const pending = changedFiles(previous, next);
  for (let count = Math.min(100, pending.length); count > 0; count = Math.floor(count / 2)) {
    const updatedFiles = pending.slice(0, count);
    const durationsMs = { ...previous.durationsMs };
    const estimated = new Set(previous._provenance?.estimatedFiles ?? []);
    for (const file of updatedFiles) {
      estimated.delete(file);
      if (Object.hasOwn(next.durationsMs, file)) durationsMs[file] = next.durationsMs[file];
      else delete durationsMs[file];
      if (next._provenance.estimatedFiles.includes(file)) estimated.add(file);
    }
    const candidate = { _provenance: { ...next._provenance,
      aggregation: 'Only updatedFiles use these runs and their per-file medians (milliseconds); other weights retain the baselineCommit manifest. Removed paths are listed too.',
      baselineCommit, updatedFiles, remainingChanges: pending.length - count,
      estimatedFiles: [...estimated].sort(),
    }, durationsMs };
    if (measure(previous, candidate) <= PATCH_BUDGET_BYTES) return candidate;
  }
  return null;
}

export function trustedRun(run) {
  return (run.event === 'push' && run.head_branch === 'main')
    || (run.event === 'merge_group' && run.head_branch?.startsWith('gh-readonly-queue/main/'));
}

export function shardJobs(jobs, kind) {
  const prefix = kind === 'browser' ? 'Cockpit browser E2E' : 'Vitest';
  const selected = jobs.filter(job => new RegExp(`^${prefix} shard [1-8]/8$`).test(job.name));
  if (selected.length !== 8 || new Set(selected.map(job => job.name)).size !== 8
    || selected.some(job => job.conclusion !== 'success')) return [];
  return selected;
}

export async function collectSamples(runs, inventories, api) {
  const result = { browser: [], vitest: [] };
  for (const run of runs) {
    if (Object.values(result).every(samples => samples.length === SAMPLE_COUNT)) break;
    const { jobs } = await api(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
    for (const kind of Object.keys(result)) {
      if (result[kind].length === SAMPLE_COUNT) continue;
      const selected = shardJobs(jobs, kind);
      if (!selected.length) continue;
      const parts = await Promise.all(selected.map(async job =>
        parseDurations(await api(`/actions/jobs/${job.id}/logs`, true), inventories[kind])));
      // Successful proof-reuse jobs have no suite lines. Never turn that into a zero weight.
      if (parts.some(part => !Object.keys(part).length)) continue;
      result[kind].push({ id: run.id, headSha: run.head_sha, jobs: selected.map(job => job.id), durationsMs: Object.assign({}, ...parts) });
    }
  }
  return result;
}

export async function discoverInventory() {
  const { createVitest } = await import('vitest/node');
  const result = {};
  for (const kind of Object.keys(manifests)) {
    const options = kind === 'browser'
      ? { config: resolve('packages/web/e2e/vitest.config.ts'), watch: false }
      : { project: ['server', 'web', 'contract', 'api-client'], watch: false };
    const vitest = await createVitest('test', options);
    try {
      result[kind] = (await vitest.globTestSpecifications()).map(spec => ({
        project: spec.project.name,
        reported: relative(spec.project.config.root, spec.moduleId).replaceAll('\\', '/'),
        file: relative(vitest.config.root, spec.moduleId).replaceAll('\\', '/'),
      }));
    } finally {
      await vitest.close();
    }
  }
  return result;
}

export async function refresh({ api, inventories, runs, baselineCommit, read = readFileSync, write = writeFileSync }) {
  const samples = await collectSamples(runs, inventories, api);
  const changes = [];
  const skipped = [];
  for (const [kind, file] of Object.entries(manifests)) {
    if (samples[kind].length < SAMPLE_COUNT) {
      skipped.push(`${kind}: only ${samples[kind].length} complete runs; need three`);
      continue;
    }
    const next = makeManifest(inventories[kind], samples[kind], kind);
    const previousText = read(file, 'utf8');
    const previous = JSON.parse(previousText);
    if (!needsRefresh(previous, next)) continue;
    const bounded = boundedManifest(previous, next, baselineCommit, (_, candidate) => manifestPatchBytes(previousText, candidate));
    if (!bounded) {
      skipped.push(`${kind}: even one entry exceeds the ${PATCH_BUDGET_BYTES}-byte patch budget`);
      continue;
    }
    write(file, `${JSON.stringify(bounded, null, 2)}\n`);
    changes.push(file);
  }
  return { changes, skipped, runs: Object.fromEntries(Object.entries(samples).map(([kind, entries]) => [kind, entries.map(run => run.id)])) };
}

async function main() {
  const { stdout: repository } = await execute('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
  const api = async (endpoint, raw = false) => {
    const { stdout } = await execute('gh', ['api', '--allow-escape-sequences', `repos/${repository.trim()}${endpoint}`],
      { maxBuffer: 32 * 1024 * 1024, timeout: 90000 });
    return raw ? stdout : JSON.parse(stdout);
  };
  const { workflow_runs: runs } = await api('/actions/workflows/ci.yml/runs?status=success&per_page=100');
  const { stdout: baselineCommit } = await execute('git', ['rev-parse', 'HEAD']);
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const summary = await refresh({ api, inventories: await discoverInventory(), baselineCommit: baselineCommit.trim(),
    runs: runs.filter(run => trustedRun(run) && Date.parse(run.created_at) >= cutoff) });
  console.log(JSON.stringify(summary));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${summary.changes.length > 0}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Test duration refresh\n\n\x60\x60\x60json\n${JSON.stringify(summary, null, 2)}\n\x60\x60\x60\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
