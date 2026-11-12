'use strict';
// Read-only merge-queue pilot metrics, run by hand with `gh` auth.
// Spec: .ai/specs/2026-11-03-speculative-merge-queue.md § Rollout step 4 and § Owner decisions Q3.
const { execFile } = require('node:child_process');
const { parseArgs } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { requiredQueueJobs, REQUIRED_QUEUE_JOBS, successfulJobs } = require('./queue-ci-proof.cjs');

const PROOF_JOB = 'Verify exact queue CI evidence';
// On a main push, Typecheck runs only when the queue proof did not verify.
const FALLBACK_JOB = 'Typecheck';
const REUSE_STEP = 'Reuse verified native PR suite';
// Q3: failure rate above 30%, or runner-minutes per merge more than 40% above the serial baseline of 128.
const LIMITS = { failureRate: 0.3, runnerMinutesPerMerge: 128 * 1.4 };
// Spec § Rollout, "How the failure rate is counted".
const FAILED = new Set(['failure', 'cancelled', 'timed_out']);
const REMOVAL_BATCH = 25;
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
  let stopped;
  async function call(args) {
    for (let attempt = 1; ; attempt++) {
      if (stopped) throw stopped;
      try {
        return await gh(['api', ...args]);
      } catch (error) {
        if (attempt > retries || !/HTTP 5\d\d/.test(error.message)) throw error;
        await wait(attempt);
      }
    }
  }
  const json = async args => JSON.parse(await call(args));
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
  // After the first failure, no read starts: the report is lost anyway.
  const stop = error => { stopped ??= error; };
  return { json, list, stop };
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

function groupRef(branch) {
  const match = /^gh-readonly-queue\/main\/pr-(\d+)-([0-9a-f]{40})$/.exec(branch ?? '');
  return match ? { pr: Number(match[1]), base: match[2] } : undefined;
}

// The queue removals of each PR from the window start on. A run's removal comes after the run starts.
const removalsQuery = numbers => `query($owner: String!, $name: String!, $since: DateTime!) {
  repository(owner: $owner, name: $name) {${numbers.map(number => `
    pr${number}: pullRequest(number: ${number}) {
      timelineItems(first: 100, since: $since, itemTypes: [REMOVED_FROM_MERGE_QUEUE_EVENT]) {
        pageInfo { hasNextPage } nodes { ... on RemovedFromMergeQueueEvent { createdAt reason } } } }`).join('')}
  }
}`;

async function readRemovals(api, repo, window, numbers) {
  const [owner, name] = repo.split('/');
  const batches = [];
  for (let i = 0; i < numbers.length; i += REMOVAL_BATCH) batches.push(numbers.slice(i, i + REMOVAL_BATCH));
  const removals = {};
  await mapLimit(batches, async batch => {
    const { repository } = (await api.json(['graphql', '-f', `query=${removalsQuery(batch)}`,
      '-f', `owner=${owner}`, '-f', `name=${name}`, '-f', `since=${iso(window.from)}`])).data;
    for (const number of batch) {
      const items = repository[`pr${number}`].timelineItems;
      if (items.pageInfo.hasNextPage) throw new Error(`PR ${number} has more than 100 queue removals in the window. Narrow the window.`);
      removals[number] = items.nodes.map(node => ({ createdAt: node.createdAt, reason: node.reason }));
    }
  });
  return removals;
}

// filter=all lists the jobs of every attempt; the run's latest attempt produced its outcome.
const attemptJobs = push => push.jobs.filter(job => job.run_attempt === push.run.run_attempt);
const proofJob = push => attemptJobs(push).find(job => job.name === PROOF_JOB);
// A cancelled run skips Typecheck even when the proof did not verify, and then no fallback ran.
function isFallback(push) {
  const fallbackJob = attemptJobs(push).find(job => job.name === FALLBACK_JOB);
  return fallbackJob !== undefined && fallbackJob.conclusion !== 'skipped';
}

// The proof read the newest exact queue run that existed when it ran; a later run was not its evidence.
function evidenceRun(runs, proof) {
  const done = Date.parse(proof?.completed_at);
  const seen = Number.isFinite(done) ? runs.filter(run => Date.parse(run.created_at) <= done) : runs;
  return seen.reduce((latest, run) => (!latest || run.id > latest.id ? run : latest), null);
}

// A run's fields describe its latest attempt. A re-run run also gets each attempt, so a decision made
// before a re-run can be read against the attempt that existed then.
async function readAttempts(api, repo, run) {
  if (!(run?.run_attempt > 1)) return undefined;
  return mapLimit(Array.from({ length: run.run_attempt }, (_, i) => i + 1),
    async attempt => trimRun(await api.json([`repos/${repo}/actions/runs/${run.id}/attempts/${attempt}`])));
}

async function readProofEvidence(api, repo, push, queueJobs) {
  const runs = (await api.list(`repos/${repo}/actions/workflows/ci.yml/runs?event=merge_group&head_sha=${push.run.head_sha}`, 'workflow_runs')).map(trimRun);
  const newest = evidenceRun(runs, proofJob(push));
  const jobs = newest ? queueJobs[newest.id] ?? await readJobs(api, repo, newest.id) : [];
  return { queueRun: newest, queueJobs: jobs, attempts: await readAttempts(api, repo, newest) };
}

async function readAll({ gh, repo, from, to, wait, now = Date.now() }) {
  const api = client(gh, { wait });
  try {
    return await readEvidence(api, repo, { from, to }, Math.min(now, to + DAY));
  } catch (error) {
    api.stop(error);
    throw error;
  }
}

// A replacement run starts while its PR is still queued, within hours of the run it invalidates.
// So the queue runs read for invalidation reach a day past the window, but not past now.
async function readEvidence(api, repo, window, lookahead) {
  const { from, to } = window;
  const [allQueueRuns, pushRuns, merges] = await Promise.all([
    readRuns(api, repo, { from, to: Math.max(to, lookahead) }, 'merge_group'), readRuns(api, repo, window, 'push'),
    readQueueMerges(api, repo, window)]);
  const queueRuns = allQueueRuns.filter(run => inWindow(run.created_at, window));
  const laterQueueRuns = allQueueRuns.filter(run => !inWindow(run.created_at, window));
  const completedQueue = queueRuns.filter(run => run.status === 'completed');
  const completedPush = pushRuns.filter(run => run.status === 'completed');
  const queueJobs = {};
  const attempts = {};
  await mapLimit(completedQueue, async run => {
    queueJobs[run.id] = await readJobs(api, repo, run.id);
    attempts[run.id] = await readAttempts(api, repo, run);
  });
  const pushes = await mapLimit(completedPush, async run => ({ run, jobs: await readJobs(api, repo, run.id) }));
  await mapLimit(pushes.filter(isFallback), async push => {
    push.evidence = await readProofEvidence(api, repo, push, queueJobs);
  });
  const queuePrs = [...new Set(queueRuns.map(run => groupRef(run.head_branch)?.pr).filter(Boolean))].sort((a, b) => a - b);
  const removals = await readRemovals(api, repo, window, queuePrs);
  return { repo, from: iso(from), to: iso(to), queueRuns, laterQueueRuns, queueJobs, attempts, pushes, merges, removals };
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

// A removal for the run's own checks, or the merge that ends its entry, keeps the run in the failure rate.
const keepsRun = reason => reason === 'merged' || reason === 'failed_checks' || /time[d_ ]?out/i.test(reason ?? '');

// Spec § Rollout, "How the failure rate is counted": the runs that count in neither term.
// Invalidated: a later run for the same PR on another base, with no removal of that PR between the two.
// Removed: the first removal of the run's PR after GitHub created the run is for another cause. A run belongs to
// its entry from creation, and run_started_at moves to the latest attempt when the run is re-run.
// The run as it stood at a moment: its latest attempt that had started by then, else its first attempt.
function attemptAt(run, attempts, at) {
  if (!attempts?.length || !Number.isFinite(at)) return run;
  const sorted = [...attempts].sort((a, b) => a.run_attempt - b.run_attempt);
  return sorted.filter(attempt => Date.parse(attempt.run_started_at) <= at).at(-1) ?? sorted[0];
}

// The queue removals of the run's PR from the run's creation on, oldest first. The first one ends the run's entry.
function entryRemovals(run, raw) {
  const ref = groupRef(run.head_branch);
  const started = Date.parse(run.created_at);
  return (ref ? raw.removals[ref.pr] ?? [] : []).map(removal => ({ at: Date.parse(removal.createdAt), reason: removal.reason }))
    .filter(removal => removal.at >= started).sort((a, b) => a.at - b.at);
}

function exclusion(run, raw) {
  const ref = groupRef(run.head_branch);
  if (!ref) return null;
  const started = Date.parse(run.created_at);
  const removals = entryRemovals(run, raw);
  const rebuilt = [...raw.queueRuns, ...(raw.laterQueueRuns ?? [])].some(other => {
    const otherRef = groupRef(other.head_branch);
    const at = Date.parse(other.created_at);
    return otherRef?.pr === ref.pr && otherRef.base !== ref.base && at > started && !removals.some(removal => removal.at < at);
  });
  if (rebuilt) return 'invalidated';
  return removals.length && !keepsRun(removals[0].reason) ? 'removed' : null;
}

function queueRunMetrics(raw) {
  const completed = raw.queueRuns.filter(run => run.status === 'completed');
  // Every attempt costs runner-minutes. The attempt that ran when the entry ended gives the outcome:
  // a re-run after the removal proves nothing for the entry (spec row 23).
  const runs = completed.map(run => {
    const jobs = raw.queueJobs[run.id] ?? [];
    const decided = attemptAt(run, raw.attempts?.[run.id], entryRemovals(run, raw)[0]?.at);
    return { run: decided, minutes: runnerMinutes(jobs), excluded: exclusion(run, raw),
      reused: reused(jobs.filter(job => job.run_attempt === decided.run_attempt)) };
  });
  const conclusions = {};
  for (const { run } of runs) conclusions[run.conclusion] = (conclusions[run.conclusion] ?? 0) + 1;
  const counted = runs.filter(item => !item.excluded);
  const failed = counted.filter(({ run }) => FAILED.has(run.conclusion)).length;
  const success = runs.filter(({ run }) => run.conclusion === 'success');
  const invalidated = runs.filter(item => item.excluded === 'invalidated');
  return {
    completed: runs.length, inFlight: raw.queueRuns.length - completed.length, conclusions,
    counted: counted.length, removed: runs.filter(item => item.excluded === 'removed').length, failed,
    failureRate: counted.length ? failed / counted.length : null,
    minutes: sumMinutes(runs),
    fullRunMinutesP50: percentile(success.filter(item => !item.reused).map(item => item.minutes.all), 0.5),
    reuseHits: runs.filter(item => item.reused).length,
    invalidated: { runs: invalidated.length, minutes: sumMinutes(invalidated).all },
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

// The proof at a main commit reads the roster of that commit's ci.yml, so a queue run from before
// a shard-count change is judged by the count its own Vitest shard jobs name.
function rosterOf(jobs) {
  const count = jobs.map(job => /^Vitest shard [1-9]\d?\/([1-9]\d?)$/.exec(job.name)?.[1]).find(Boolean);
  const roster = count ? requiredQueueJobs(Number(count)) : REQUIRED_QUEUE_JOBS;
  // Historical runs predate the split; keep their original proof roster.
  return jobs.some(job => job.name === 'Unit tests (package)' || job.name === 'Unit tests (scripts)') ? roster
    : roster.filter(name => !name.startsWith('Unit tests (')).map(name => name === 'Build and package' ? 'Unit, build, and package' : name);
}

// The proof's own reason is in its job summary, which the API does not return.
// This rebuilds it from the evidence queue-ci-proof.cjs reads.
function proofReason(push) {
  const proof = proofJob(push);
  if (!proof) return 'proof-job-missing';
  if (proof.conclusion !== 'success') return `proof-job-${proof.conclusion}`;
  const { queueJobs } = push.evidence ?? {};
  if (!push.evidence?.queueRun) return 'no-exact-queue-run';
  const queueRun = attemptAt(push.evidence.queueRun, push.evidence.attempts, Date.parse(proof.completed_at));
  if (queueRun.status !== 'completed' || Date.parse(queueRun.updated_at) > Date.parse(proof.completed_at)) return 'source-pending';
  if (queueRun.conclusion !== 'success') return 'source-not-successful';
  const attempt = queueJobs.filter(job => job.run_attempt === queueRun.run_attempt);
  if (!successfulJobs(attempt, rosterOf(attempt))) return 'incomplete-gate';
  return 'unexplained';
}

function pushMetrics(raw) {
  const reasons = {};
  const unexplained = [];
  const fallbacks = raw.pushes.filter(isFallback);
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
    `Queue failure rate: ${percent(queue.failureRate)} (${queue.failed} of ${queue.counted}; excluded: ${queue.invalidated.runs} invalidated, ${queue.removed} removed for another cause)`,
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
    const metrics = computeMetrics(await readAll({ gh, repo, from: options.from, to: options.to, wait, now }));
    stdout(options.json ? `${JSON.stringify(metrics, null, 2)}\n` : formatReport(metrics));
    return 0;
  } catch (error) {
    stderr(`queue-metrics: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; });

module.exports = { main, parseOptions, readAll, computeMetrics, formatReport, percentile, runnerMinutes, proofReason, evidenceRun,
  groupRef, LIMITS, PROOF_JOB, FALLBACK_JOB, REUSE_STEP };
