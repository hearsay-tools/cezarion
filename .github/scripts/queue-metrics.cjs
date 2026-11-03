'use strict';
// Read-only merge-queue pilot metrics, run by hand with `gh` auth.
// Spec: .ai/specs/2026-11-03-speculative-merge-queue.md § Rollout step 4 and § Owner decisions Q3.
const { execFile } = require('node:child_process');
const { parseArgs } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { REQUIRED_QUEUE_JOBS, successfulJobs } = require('./queue-ci-proof.cjs');

const PROOF_JOB = 'Verify exact queue CI evidence';
// On a main push, Typecheck runs only when the queue proof did not verify.
const FALLBACK_JOB = 'Typecheck';
const REUSE_STEP = 'Reuse verified native PR suite';
// Q3: failure rate above 30%, or runner-minutes per merge above 128 × 1.4.
const LIMITS = { failureRate: 0.3, runnerMinutesPerMerge: 179 };
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);
const DAY = 86400000;
const LIST_CAP = 1000;
const CONCURRENCY = 8;

const QUEUE_PRS_QUERY = `query($q: String!, $endCursor: String) {
  search(query: $q, type: ISSUE, first: 50, after: $endCursor) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { number mergedAt
      timelineItems(last: 100, itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT]) { nodes { ... on AddedToMergeQueueEvent { createdAt } } } } }
  }
}`;

const iso = ms => new Date(ms).toISOString().replace('.000Z', 'Z');

function parseTime(value, endOfDay) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const start = Date.parse(`${value}T00:00:00Z`);
    if (Number.isFinite(start) && iso(start).startsWith(value)) return endOfDay ? start + DAY : start;
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
    const at = Date.parse(value);
    if (Number.isFinite(at) && iso(at) === value) return at;
  }
  throw new Error(`Invalid time ${JSON.stringify(value)}: use YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ (UTC)`);
}

function parseOptions(argv, now) {
  const { values } = parseArgs({ args: argv, options: {
    from: { type: 'string' }, to: { type: 'string' }, repo: { type: 'string' },
    json: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) return { help: true };
  if (values.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(values.repo)) throw new Error('--repo must be OWNER/REPO');
  const to = values.to === undefined ? Math.floor(now / 1000) * 1000 : parseTime(values.to, true);
  const from = values.from === undefined ? to - 7 * DAY : parseTime(values.from, false);
  if (from >= to) throw new Error('--from must be before --to');
  return { from, to, repo: values.repo, json: Boolean(values.json) };
}

// ---- Reading (gh api, GET only) ----

// Every call is a GET, so a server error is safe to retry.
function client(gh, { retries = 3, wait = attempt => delay(1000 * attempt) } = {}) {
  async function call(args) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await gh(['api', ...args]);
      } catch (error) {
        if (attempt > retries || !/HTTP 5\d\d/.test(error.message)) throw error;
        await wait(attempt);
      }
    }
  }
  const json = async args => JSON.parse(await call(args));
  const text = async args => (await call(args)).trim();
  async function list(endpoint, key) {
    const rows = [];
    for (let page = 1; ; page++) {
      const data = await json([`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`]);
      const batch = key ? data?.[key] : data;
      if (!Array.isArray(batch)) throw new Error(`Unexpected response from ${endpoint}`);
      if (key && data.total_count > LIST_CAP) throw new Error(`${endpoint} lists ${data.total_count} items; the API returns at most ${LIST_CAP}. Narrow the window.`);
      rows.push(...batch);
      if (batch.length < 100 || (key && rows.length >= data.total_count)) return rows;
    }
  }
  return { json, text, list };
}

async function mapLimit(items, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; results[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return results;
}

const trimJob = job => ({ id: job.id, name: job.name, run_attempt: job.run_attempt, status: job.status,
  conclusion: job.conclusion, started_at: job.started_at, completed_at: job.completed_at, labels: job.labels ?? [],
  steps: (job.steps ?? []).filter(step => step.name === REUSE_STEP).map(step => ({ name: step.name, conclusion: step.conclusion })) });
const trimRun = run => ({ id: run.id, run_attempt: run.run_attempt, event: run.event, head_sha: run.head_sha,
  head_branch: run.head_branch, status: run.status, conclusion: run.conclusion, created_at: run.created_at,
  run_started_at: run.run_started_at, updated_at: run.updated_at, html_url: run.html_url });

const inWindow = (at, { from, to }) => { const ms = Date.parse(at); return ms >= from && ms < to; };

// The runs list and the search return at most LIST_CAP results per query, so each query covers one UTC day.
// Date bounds are inclusive, so a result on a day boundary comes back twice.
function dayChunks({ from, to }) {
  const chunks = [];
  for (let start = from; start < to;) {
    const end = Math.min(to, (Math.floor(start / DAY) + 1) * DAY);
    chunks.push({ from: start, to: end });
    start = end;
  }
  return chunks;
}

async function readByDay(window, readDay, key) {
  const unique = new Map();
  for (const rows of await mapLimit(dayChunks(window), readDay)) for (const row of rows) unique.set(row[key], row);
  return [...unique.values()];
}

async function readRuns(api, repo, window, event) {
  const branch = event === 'push' ? '&branch=main' : '';
  const runs = await readByDay(window, day => api.list(
    `repos/${repo}/actions/workflows/ci.yml/runs?event=${event}${branch}&created=${iso(day.from)}..${iso(day.to)}&exclude_pull_requests=true`,
    'workflow_runs'), 'id');
  return runs.filter(run => inWindow(run.created_at, window)).map(trimRun);
}

const readJobs = async (api, repo, runId) =>
  (await api.list(`repos/${repo}/actions/runs/${runId}/jobs?filter=all`, 'jobs')).map(trimJob);

async function readMergedDay(api, repo, day) {
  const q = `repo:${repo} is:pr is:merged base:main merged:${iso(day.from)}..${iso(day.to)}`;
  const prs = [];
  let cursor;
  do {
    const args = ['graphql', '-f', `query=${QUEUE_PRS_QUERY}`, '-f', `q=${q}`, ...(cursor ? ['-f', `endCursor=${cursor}`] : [])];
    const { search } = (await api.json(args)).data;
    if (search.issueCount > LIST_CAP) throw new Error(`Search finds ${search.issueCount} merged PRs; it returns at most ${LIST_CAP}. Narrow the window.`);
    prs.push(...search.nodes.map(pr => ({ number: pr.number, mergedAt: pr.mergedAt,
      enqueuedAt: pr.timelineItems.nodes.map(node => node.createdAt) })));
    cursor = search.pageInfo.hasNextPage ? search.pageInfo.endCursor : undefined;
  } while (cursor);
  return prs;
}

async function readQueueMerges(api, repo, window) {
  const prs = await readByDay(window, day => readMergedDay(api, repo, day), 'number');
  return prs.filter(pr => inWindow(pr.mergedAt, window));
}

const groupBase = branch => /^gh-readonly-queue\/main\/pr-\d+-([0-9a-f]{40})$/.exec(branch ?? '')?.[1];

// A group base is on main when main is identical to it or ahead of it. A base GitHub no longer knows is not.
async function readOnMain(api, repo, bases) {
  const onMain = {};
  await mapLimit([...new Set(bases)], async base => {
    try {
      onMain[base] = ['identical', 'ahead'].includes(await api.text([`repos/${repo}/compare/${base}...main`, '--jq', '.status']));
    } catch (error) {
      if (!/HTTP (404|422)/.test(error.message)) throw error;
      onMain[base] = false;
    }
  });
  return onMain;
}

const proofJob = jobs => jobs.find(job => job.name === PROOF_JOB);
function isFallback(jobs) {
  const fallbackJob = jobs.find(job => job.name === FALLBACK_JOB);
  return proofJob(jobs)?.conclusion !== 'success' || (fallbackJob !== undefined && fallbackJob.conclusion !== 'skipped');
}

async function readProofEvidence(api, repo, push, queueJobs) {
  const runs = (await api.list(`repos/${repo}/actions/workflows/ci.yml/runs?event=merge_group&head_sha=${push.run.head_sha}`, 'workflow_runs')).map(trimRun);
  const newest = runs.reduce((latest, run) => (!latest || run.id > latest.id ? run : latest), null);
  const jobs = newest ? queueJobs[newest.id] ?? await readJobs(api, repo, newest.id) : [];
  return { queueRun: newest, queueJobs: jobs };
}

async function readAll({ gh, repo, from, to, wait }) {
  const api = client(gh, { wait });
  const window = { from, to };
  const [queueRuns, pushRuns, merges] = await Promise.all([
    readRuns(api, repo, window, 'merge_group'), readRuns(api, repo, window, 'push'), readQueueMerges(api, repo, window)]);
  const completedQueue = queueRuns.filter(run => run.status === 'completed');
  const completedPush = pushRuns.filter(run => run.status === 'completed');
  const queueJobs = {};
  await mapLimit(completedQueue, async run => { queueJobs[run.id] = await readJobs(api, repo, run.id); });
  const pushes = await mapLimit(completedPush, async run => ({ run, jobs: await readJobs(api, repo, run.id) }));
  await mapLimit(pushes.filter(push => isFallback(push.jobs)), async push => {
    push.evidence = await readProofEvidence(api, repo, push, queueJobs);
  });
  const onMain = await readOnMain(api, repo, completedQueue.map(run => groupBase(run.head_branch)).filter(Boolean));
  return { repo, from: iso(from), to: iso(to), queueRuns, queueJobs, pushes, merges, onMain };
}

// ---- Computing (pure) ----

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  return sorted[low] + (sorted[Math.ceil(index)] - sorted[low]) * (index - low);
}

const minutes = (start, end) => (Date.parse(end) - Date.parse(start)) / 60000;
const runnerKind = labels => (labels.some(label => label.startsWith('ubicloud-')) ? 'ubicloud'
  : labels.some(label => /^(ubuntu|windows|macos)-/.test(label)) ? 'hosted' : 'other');

// GitHub bills each job in whole minutes, rounded up.
function runnerMinutes(jobs) {
  const total = { hosted: 0, ubicloud: 0, other: 0 };
  for (const job of jobs) {
    if (!job.started_at || !job.completed_at || !job.labels.length) continue;
    total[runnerKind(job.labels)] += Math.ceil(Math.max(0, minutes(job.started_at, job.completed_at)));
  }
  return { ...total, all: total.hosted + total.ubicloud + total.other };
}

const reused = jobs => jobs.some(job => job.steps.some(step => step.name === REUSE_STEP && step.conclusion === 'success'));
const sumMinutes = list => list.reduce((sum, item) => {
  for (const key of Object.keys(sum)) sum[key] += item.minutes[key];
  return sum;
}, { hosted: 0, ubicloud: 0, other: 0, all: 0 });

function queueRunMetrics(raw) {
  const completed = raw.queueRuns.filter(run => run.status === 'completed');
  const runs = completed.map(run => {
    const jobs = raw.queueJobs[run.id] ?? [];
    const base = groupBase(run.head_branch);
    return { run, minutes: runnerMinutes(jobs), reused: reused(jobs), invalidated: base !== undefined && raw.onMain[base] === false };
  });
  const conclusions = {};
  for (const { run } of runs) conclusions[run.conclusion] = (conclusions[run.conclusion] ?? 0) + 1;
  const failed = runs.filter(({ run }) => FAILED.has(run.conclusion)).length;
  const success = runs.filter(({ run }) => run.conclusion === 'success');
  return {
    completed: runs.length, inFlight: raw.queueRuns.length - completed.length, conclusions, failed,
    failureRate: runs.length ? failed / runs.length : null,
    minutes: sumMinutes(runs),
    fullRunMinutesP50: percentile(success.filter(item => !item.reused).map(item => item.minutes.all), 0.5),
    reuseHits: runs.filter(item => item.reused).length,
    invalidated: { runs: runs.filter(item => item.invalidated).length, minutes: sumMinutes(runs.filter(item => item.invalidated)).all },
    wallP50: percentile(success.map(({ run }) => minutes(run.run_started_at, run.updated_at)), 0.5),
    wallP90: percentile(success.map(({ run }) => minutes(run.run_started_at, run.updated_at)), 0.9),
  };
}

function mergeMetrics(raw) {
  const waits = [];
  const perDay = {};
  for (let day = Date.parse(raw.from.slice(0, 10)); day < Date.parse(raw.to); day += DAY) perDay[iso(day).slice(0, 10)] = 0;
  for (const pr of raw.merges) {
    const enqueued = pr.enqueuedAt.filter(at => at <= pr.mergedAt).sort().at(-1);
    if (!enqueued) continue;
    waits.push(minutes(enqueued, pr.mergedAt));
    perDay[pr.mergedAt.slice(0, 10)] += 1;
  }
  return { total: waits.length, perDay, enqueueP50: percentile(waits, 0.5), enqueueP90: percentile(waits, 0.9),
    enqueueMax: waits.length ? Math.max(...waits) : null };
}

// The proof's own reason is in its job summary, which the API does not return.
// This rebuilds it from the evidence queue-ci-proof.cjs reads.
function proofReason(push) {
  const proof = proofJob(push.jobs);
  if (!proof) return 'proof-job-missing';
  if (proof.conclusion !== 'success') return `proof-job-${proof.conclusion}`;
  const { queueRun, queueJobs } = push.evidence ?? {};
  if (!queueRun) return 'no-exact-queue-run';
  if (queueRun.status !== 'completed' || Date.parse(queueRun.updated_at) > Date.parse(proof.completed_at)) return 'source-pending';
  if (queueRun.conclusion !== 'success') return 'source-not-successful';
  if (!successfulJobs(queueJobs.filter(job => job.run_attempt === queueRun.run_attempt), REQUIRED_QUEUE_JOBS)) return 'incomplete-gate';
  return 'unexplained';
}

function pushMetrics(raw) {
  const reasons = {};
  const unexplained = [];
  const fallbacks = raw.pushes.filter(push => isFallback(push.jobs));
  for (const push of fallbacks) {
    const reason = proofReason(push);
    reasons[reason] = (reasons[reason] ?? 0) + 1;
    if (reason === 'unexplained') unexplained.push(push.run.html_url);
  }
  return { pushes: raw.pushes.length, fallbacks: fallbacks.length, reasons, unexplained };
}

function computeMetrics(raw) {
  const queue = queueRunMetrics(raw);
  const merges = mergeMetrics(raw);
  const perMerge = value => (merges.total ? value / merges.total : null);
  const runnerMinutesPerMerge = { hosted: perMerge(queue.minutes.hosted), ubicloud: perMerge(queue.minutes.ubicloud),
    other: perMerge(queue.minutes.other), all: perMerge(queue.minutes.all) };
  const verdict = (value, limit) => (value === null ? 'no data' : value > limit ? 'above limit: roll back' : 'within limit');
  return {
    repo: raw.repo, from: raw.from, to: raw.to, days: (Date.parse(raw.to) - Date.parse(raw.from)) / DAY,
    merges, queue, runnerMinutesPerMerge, invalidatedMinutesPerMerge: perMerge(queue.invalidated.minutes),
    mainPush: pushMetrics(raw),
    verdicts: {
      failureRate: { value: queue.failureRate, limit: LIMITS.failureRate, verdict: verdict(queue.failureRate, LIMITS.failureRate) },
      runnerMinutesPerMerge: { value: runnerMinutesPerMerge.all, limit: LIMITS.runnerMinutesPerMerge,
        verdict: verdict(runnerMinutesPerMerge.all, LIMITS.runnerMinutesPerMerge) },
    },
  };
}

// ---- Printing ----

const fixed = value => (value === null ? 'n/a' : value.toFixed(1));
const percent = value => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);
const counts = object => Object.entries(object).sort(([a], [b]) => a.localeCompare(b)).map(([key, n]) => `${key} ${n}`).join(', ') || 'none';

function formatReport(m) {
  const { queue, merges, mainPush, verdicts } = m;
  const split = (value, show = fixed) => `hosted ${show(value.hosted)}, Ubicloud ${show(value.ubicloud)}${value.other ? `, other ${show(value.other)}` : ''}`;
  const lines = [
    `Merge-queue pilot metrics for ${m.repo}, ${m.from} to ${m.to} (${m.days.toFixed(2)} days, UTC)`,
    `Merges per day: ${Object.entries(merges.perDay).map(([day, n]) => `${day} ${n}`).join(', ')} (total ${merges.total})`,
    `Enqueue to merge (last enqueue): p50 ${fixed(merges.enqueueP50)} min, p90 ${fixed(merges.enqueueP90)} min, max ${fixed(merges.enqueueMax)} min`,
    `Queue runs: ${queue.completed} completed (${counts(queue.conclusions)}), ${queue.inFlight} in flight not counted`,
    `Queue failure rate: ${percent(queue.failureRate)} (${queue.failed} of ${queue.completed})`,
    `Runner-minutes: ${queue.minutes.all} (${split(queue.minutes, String)})`,
    `Runner-minutes per merge: ${fixed(m.runnerMinutesPerMerge.all)} (${split(m.runnerMinutesPerMerge)})`,
    `Runner-minutes per full run: p50 ${fixed(queue.fullRunMinutesP50)} (successful runs without native-suite reuse)`,
    `Native-suite reuse hits: ${queue.reuseHits} of ${queue.completed} runs`,
    `Invalidated runs: ${queue.invalidated.runs}, ${queue.invalidated.minutes} runner-min (${fixed(m.invalidatedMinutesPerMerge)} per merge)`,
    `Queue-run wall (successful runs): p50 ${fixed(queue.wallP50)} min, p90 ${fixed(queue.wallP90)} min`,
    `Main-push proof fallbacks: ${mainPush.fallbacks} of ${mainPush.pushes} pushes; reasons: ${counts(mainPush.reasons)}`,
    ...mainPush.unexplained.map(url => `  unexplained: read the "${PROOF_JOB}" job summary at ${url}`),
    `Verdict, queue failure rate: ${percent(verdicts.failureRate.value)} against ${percent(verdicts.failureRate.limit)}: ${verdicts.failureRate.verdict}`,
    `Verdict, runner-minutes per merge: ${fixed(verdicts.runnerMinutesPerMerge.value)} against ${verdicts.runnerMinutesPerMerge.limit}: ${verdicts.runnerMinutesPerMerge.verdict}`,
  ];
  if (Math.abs(m.days - 7) > 1e-9) lines.push(`Note: the rollback limits apply to a rolling 7 days; this window is ${m.days.toFixed(2)} days.`);
  return `${lines.join('\n')}\n`;
}

const USAGE = `Usage: node .github/scripts/queue-metrics.cjs [--from DATE] [--to DATE] [--repo OWNER/REPO] [--json]
Prints the merge-queue pilot metrics for a UTC window. It only reads, through gh api and gh repo view.
DATE is YYYY-MM-DD (--to includes that whole day) or YYYY-MM-DDTHH:MM:SSZ.
Defaults: the 7 days before now, in the current gh repository.
`;

const defaultGh = args => new Promise((resolve, reject) => {
  execFile('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error(`gh ${args[0]} ${args[1] ?? ''} failed: ${String(stderr).trim() || error.message}`));
    else resolve(stdout);
  });
});

async function main(argv, { gh = defaultGh, stdout = text => process.stdout.write(text),
  stderr = text => process.stderr.write(text), now = Date.now(), wait } = {}) {
  try {
    const options = parseOptions(argv, now);
    if (options.help) { stdout(USAGE); return 0; }
    const repo = options.repo ?? (await gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])).trim();
    const metrics = computeMetrics(await readAll({ gh, repo, from: options.from, to: options.to, wait }));
    stdout(options.json ? `${JSON.stringify(metrics, null, 2)}\n` : formatReport(metrics));
    return 0;
  } catch (error) {
    stderr(`queue-metrics: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; });

module.exports = { main, parseOptions, readAll, computeMetrics, formatReport, percentile, runnerMinutes, proofReason,
  groupBase, LIMITS, PROOF_JOB, FALLBACK_JOB, REUSE_STEP };
