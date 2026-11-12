'use strict';

// Files flake reports for merge-queue shards that passed only on their rerun (docs/sdlc/ci.md
// § Flake reports from the merge queue; hearsay-tools/cezarion#3291). report-queue-flakes.yml
// runs it from trusted default-branch code after a merge-group CI run. It reads step
// conclusions from the Actions API, the shard's failed-file artifact as untrusted bytes, and
// the merge group's tree through the Git API. It never checks out or runs queued code.
const path = require('node:path');
const { readList, parseNames, MAX_ARCHIVE_BYTES } = require('./queue-flake-artifact.cjs');

const LABEL = 'flake-report';
const CONFIRM_LABEL = 'flaky-test';
const BOT = 'github-actions[bot]';
const MAX_NAMES = 50;
// The jobs API reports a failed `continue-on-error` step as `success`, so the first test step's
// own conclusion cannot show its failure. ci.yml runs the rerun step only when the first step's
// outcome is `failure`, so a rerun step that concluded `success` is the flake.
const SHARD_KINDS = [
  {
    job: 'vitest', firstId: 'record', rerunId: 'rerun', title: 'Vitest shard',
    first: 'Run server and cockpit unit suites with Squeal recording',
    rerun: 'Rerun server and cockpit unit suites with Squeal recording',
    artifact: 'failed-test-files-vitest-shard-',
  },
  {
    job: 'cockpit-browser', firstId: 'e2e', rerunId: 'e2e-rerun', title: 'Cockpit browser E2E shard',
    first: 'Run cockpit browser E2E', rerun: 'Rerun cockpit browser E2E',
    artifact: 'failed-test-files-cockpit-browser-shard-',
  },
].map((kind) => ({ ...kind, pattern: new RegExp(`^${kind.title} (\\d{1,2})/(\\d{1,2})$`) }));
const MARK = {
  report: '<!-- cez-flake-report:v1 -->',
  occurrence: (key) => `<!-- cez-flake-occurrence:v1:${key} -->`,
  file: (name) => `<!-- cez-flake-file:v1:${name} -->`,
  shard: (flake) => `<!-- cez-flake-shard:v1:${flake.kind.job}:${flake.shard} -->`,
};
const NOTES = {
  absent: 'No failed-file list from this run attempt is available.',
  malformed: 'The failed-file list was malformed.',
  empty: 'The first run failed before any test file finished.',
  tree: 'The merge group\'s tree was too large to check the names against.',
  dropped: (count) => `${count} ${count === 1 ? 'name' : 'names'} dropped: not a test file in the merge group's tree.`,
  omitted: (count) => `${count} more names left out.`,
};

const visible = (message) => Object.assign(new Error(message), { visible: true });
const gone = () => Object.assign(new Error('Artifact gone'), { code: 'gone' });

function assertValidRepo(owner, repo) {
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) throw new Error('Invalid repository');
}

function eligible(run, owner, repo) {
  return run?.status === 'completed' && run.name === 'CI' && run.path === '.github/workflows/ci.yml'
    && run.event === 'merge_group' && run.head_repository?.full_name === `${owner}/${repo}`
    && /^gh-readonly-queue\//.test(run.head_branch ?? '');
}

function validateRun(run) {
  if (!Number.isSafeInteger(run.id) || run.id < 1 || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1
      || !/^[a-f0-9]{40}$/.test(run.head_sha) || !Number.isFinite(Date.parse(run.created_at))) {
    throw new Error('Invalid merge-group run metadata');
  }
}

function shardOf(job) {
  for (const kind of SHARD_KINDS) {
    const match = kind.pattern.exec(job.name ?? '');
    if (match) return { kind, shard: Number(match[1]), total: Number(match[2]) };
  }
  return null;
}

function findFlakes(jobs) {
  const flakes = [];
  for (const job of jobs) {
    const found = shardOf(job);
    if (!found || !Number.isSafeInteger(job.id) || job.id < 1) continue;
    const step = (name) => (job.steps ?? []).find((item) => item.name === name);
    const first = step(found.kind.first);
    if (first && first.conclusion !== 'skipped' && step(found.kind.rerun)?.conclusion === 'success') {
      flakes.push({ ...found, jobId: job.id, ran: [Date.parse(job.started_at), Date.parse(job.completed_at)], names: [], dropped: 0, notes: [] });
    }
  }
  return flakes;
}

async function requireLabels(github, base) {
  for (const name of [LABEL, CONFIRM_LABEL]) {
    try {
      await github.request('GET /repos/{owner}/{repo}/labels/{name}', { ...base, name });
    } catch (error) {
      if (error?.status === 404) throw visible(`The label \`${name}\` is missing. Create it, then rerun this job.`);
      throw error;
    }
  }
}

async function readCapped(body, limit) {
  const reader = body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw Object.assign(new Error('Archive above its limit'), { code: 'malformed' });
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}

// Asks GitHub for the signed URL without forwarding the reporting token to blob storage.
async function downloadArchive(github, args, fetchImpl) {
  let response;
  try {
    response = await github.request('GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}', { ...args, archive_format: 'zip', request: { redirect: 'manual' } });
  } catch (error) {
    if (error?.status === 404 || error?.status === 410) throw gone();
    throw error;
  }
  const location = response.headers?.location;
  if (!location) throw new Error('No artifact download URL');
  const url = new URL(location);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid artifact URL');
  const blob = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (blob.status === 404 || blob.status === 410) throw gone();
  if (!blob.ok || !blob.body) throw new Error('Unavailable artifact');
  return readCapped(blob.body, MAX_ARCHIVE_BYTES);
}

// Every attempt of a run uploads under the same name with `overwrite: true`, and the artifact API
// names no attempt. Only an artifact created while the flaked job ran belongs to this attempt.
async function artifactFor(github, base, run, flake) {
  const name = `${flake.kind.artifact}${flake.shard}`;
  const [started, completed] = flake.ran;
  const artifacts = await github.paginate('GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts', { ...base, run_id: run.id, name, per_page: 100 });
  return artifacts.filter((item) => item.name === name && !item.expired && item.workflow_run?.id === run.id && Number.isSafeInteger(item.id)
    && Date.parse(item.created_at) >= started && Date.parse(item.created_at) <= completed)
    .sort((a, b) => b.id - a.id)[0];
}

async function readShardNames({ github, base, run, flake, fetchImpl }) {
  const artifact = await artifactFor(github, base, run, flake);
  if (!artifact) return flake.notes.push(NOTES.absent);
  if (artifact.size_in_bytes > MAX_ARCHIVE_BYTES) return flake.notes.push(NOTES.malformed);
  let text;
  try {
    text = readList(await downloadArchive(github, { ...base, artifact_id: artifact.id }, fetchImpl));
  } catch (error) {
    if (error.code === 'gone') return flake.notes.push(NOTES.absent);
    if (error.code === 'malformed') return flake.notes.push(NOTES.malformed);
    throw error;
  }
  const { names, dropped } = parseNames(text);
  Object.assign(flake, { names, dropped });
  if (!names.length && !dropped) flake.notes.push(NOTES.empty);
}

// Keeps the names that are regular files in the merge group's tree.
async function keepTreeNames({ github, base, run, flakes }) {
  if (flakes.some((flake) => flake.names.length)) {
    const { data } = await github.request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', { ...base, tree_sha: run.head_sha, recursive: '1' });
    const files = data.truncated ? null : new Set(data.tree
      .filter((entry) => entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755')).map((entry) => entry.path));
    for (const flake of flakes) {
      if (!flake.names.length) continue;
      if (!files) {
        flake.notes.push(NOTES.tree);
        flake.names = [];
        continue;
      }
      const kept = flake.names.filter((name) => files.has(name));
      flake.dropped += flake.names.length - kept.length;
      flake.names = kept;
    }
  }
  let room = MAX_NAMES;
  for (const flake of flakes) {
    if (flake.dropped) flake.notes.push(NOTES.dropped(flake.dropped));
    if (flake.names.length > room) flake.notes.push(NOTES.omitted(flake.names.length - room));
    flake.names = flake.names.slice(0, room);
    room -= flake.names.length;
  }
}

function details(base, run, flakes, names) {
  const repoUrl = `https://github.com/${base.owner}/${base.repo}`;
  const pr = /^gh-readonly-queue\/.+\/pr-(\d+)-[0-9a-f]{40}$/.exec(run.head_branch)?.[1];
  const rows = flakes.map((flake) => {
    const listed = flake.names.filter((name) => names.has(name));
    const cell = [listed.length ? listed.map((name) => `\`${name}\``).join('<br>') : 'No names.', ...flake.notes].join(' ');
    return `| [${flake.kind.title} ${flake.shard}/${flake.total}](${repoUrl}/actions/runs/${run.id}/job/${flake.jobId}) | ${cell} |`;
  });
  return [
    `- Merge group commit: [\`${run.head_sha.slice(0, 7)}\`](${repoUrl}/commit/${run.head_sha})`,
    ...(pr ? [`- Queued pull request: ${base.owner}/${base.repo}#${pr}`] : []),
    `- CI run: [${run.id}, attempt ${run.run_attempt}](${repoUrl}/actions/runs/${run.id}/attempts/${run.run_attempt})`,
    '',
    '| Shard | Test files that failed in the first run |',
    '| --- | --- |',
    ...rows,
  ];
}

const listReports = (github, base, query) => github.paginate('GET /repos/{owner}/{repo}/issues', { ...base, labels: LABEL, creator: BOT, per_page: 100, ...query });
const ours = (item) => item.user?.login === BOT && !item.pull_request && (item.body ?? '').includes(MARK.report);

const FILE_MARK = /<!-- cez-flake-file:v1:(\S+) -->/g;
const markedFiles = (text) => [...text.matchAll(FILE_MARK)].map((match) => match[1]);

// What earlier deliveries of this run attempt already wrote, on open and closed reports alike:
// the new report, if any, and every file and shard a comment of the attempt names. A report or
// comment updated after the run started is updated at or after `run.created_at`.
async function recordedWrites({ github, base, run, key }) {
  const recent = (await listReports(github, base, { state: 'all', since: run.created_at })).filter(ours);
  const created = recent.some((item) => item.body.includes(MARK.occurrence(key)));
  const commented = [];
  for (const issue of recent) {
    const comments = await github.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', { ...base, issue_number: issue.number, per_page: 100 });
    commented.push(...comments.filter((comment) => comment.user?.login === BOT && (comment.body ?? '').includes(MARK.occurrence(key))).map((comment) => comment.body));
  }
  return { created, names: new Set(commented.flatMap(markedFiles)), commented: commented.join('\n') };
}

async function addOccurrence({ github, base, run, key, issue, flakes, names }) {
  const shown = flakes.filter((flake) => flake.names.some((name) => names.has(name)));
  const body = [
    MARK.occurrence(key), ...[...names].map(MARK.file), ...shown.map(MARK.shard), '',
    'A later merge group flaked on test files this report names: they failed the first run and passed the whole-shard rerun.', '',
    ...details(base, run, shown, names),
  ].join('\n');
  await github.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { ...base, issue_number: issue.number, body });
  return 1;
}

async function fileReport({ github, base, run, key, flakes, left }) {
  const names = [...left];
  const title = names.length
    ? `Flaky test in the merge queue: ${path.posix.basename(names[0])}${names.length > 1 ? ` and ${names.length - 1} more` : ''}`
    : `Flaky merge-queue shard without test names: ${flakes.map((flake) => `${flake.kind.title} ${flake.shard}/${flake.total}`).join(', ')}`;
  const body = [
    MARK.report, MARK.occurrence(key), ...names.map(MARK.file), '',
    'A merge-queue shard failed its first test run and passed its whole-shard rerun, so the queue entry passed. A test that passes only on a rerun is flaky. See `docs/sdlc/ci.md` § Flake reports from the merge queue.', '',
    ...details(base, run, flakes, left), '',
    '### What to do', '',
    `This report starts no task. If the flake is real, add the \`${CONFIRM_LABEL}\` label: a Cezar automation then starts a task to fix or quarantine the test. A later merge group that flakes on a file this report names adds a comment here. Close the issue when the test is fixed or quarantined.`,
  ].join('\n');
  await github.request('POST /repos/{owner}/{repo}/issues', { ...base, title, body, labels: [LABEL] });
  return 1;
}

// A file an open report names gets one comment there per run attempt. Every other file, and
// every flaked shard without a name, goes into one new report for the run attempt. Comments
// come first, so a report for the attempt means every write of the attempt is done.
async function writeReports({ github, base, run, flakes }) {
  const key = `${base.owner}/${base.repo}:${run.id}:${run.run_attempt}`;
  const recorded = await recordedWrites({ github, base, run, key });
  if (recorded.created) return 0;
  const open = (await listReports(github, base, { state: 'open' })).filter(ours).sort((a, b) => a.number - b.number);
  const held = new Map();
  const left = new Set();
  for (const name of flakes.flatMap((flake) => flake.names)) {
    if (recorded.names.has(name)) continue;
    const issue = open.find((item) => item.body.includes(MARK.file(name)));
    if (!issue) left.add(name);
    else held.set(issue.number, { issue, names: (held.get(issue.number)?.names ?? new Set()).add(name) });
  }
  let reported = 0;
  for (const { issue, names } of held.values()) reported += await addOccurrence({ github, base, run, key, issue, flakes, names });
  // A shard that lost its names since an earlier delivery commented on it is already reported.
  const fresh = flakes.filter((flake) => flake.names.some((name) => left.has(name))
    || (!flake.names.length && !recorded.commented.includes(MARK.shard(flake))));
  if (fresh.length) reported += await fileReport({ github, base, run, key, flakes: fresh, left });
  return reported;
}

// The workflow's concurrency group is the issue-write lock for these markers.
async function reportQueueFlakes({ github, owner, repo, event, log = () => {}, fetchImpl = fetch }) {
  assertValidRepo(owner, repo);
  const run = event.workflow_run;
  if (event.action !== 'completed' || !eligible(run, owner, repo)) return { flakes: 0, reported: 0 };
  validateRun(run);
  const base = { owner, repo };
  const jobs = await github.paginate('GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs', { ...base, run_id: run.id, attempt_number: run.run_attempt, per_page: 100 });
  const flakes = findFlakes(jobs);
  if (!flakes.length) {
    log(`Run ${run.id} attempt ${run.run_attempt}: no shard passed only on its rerun.`);
    return { flakes: 0, reported: 0 };
  }
  await requireLabels(github, base);
  for (const flake of flakes) await readShardNames({ github, base, run, flake, fetchImpl });
  await keepTreeNames({ github, base, run, flakes });
  for (const flake of flakes) log(`${flake.kind.title} ${flake.shard}/${flake.total} passed only on its rerun: ${flake.names.length} test file(s) named.`);
  return { flakes: flakes.length, reported: await writeReports({ github, base, run, flakes }) };
}

module.exports = { reportQueueFlakes, MARK, SHARD_KINDS, LABEL, CONFIRM_LABEL };
