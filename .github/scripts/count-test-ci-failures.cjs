// Read-only evidence collector. An annotation is evidence of failure, never of a pass.
const {execFileSync} = require('node:child_process');
const {parseArgs: nodeParseArgs} = require('node:util');
const DEFAULT_LIMITS = {maxRequests: 1500, durationMs: 12 * 60 * 1000};
const positiveId = value => Number.isSafeInteger(value) && value > 0;

function parseArgs(argv) {
  const {values, positionals} = nodeParseArgs({args: argv, allowPositionals: true, options: {
    repo: {type: 'string'}, runs: {type: 'string'}, since: {type: 'string'}, until: {type: 'string'}, help: {type: 'boolean'},
  }});
  if (values.help) return {help: true};
  if (positionals.length !== 1 || !/^[\w./-]+$/.test(positionals[0]) || positionals[0].startsWith('-')) throw new Error('Supply one literal test-file name or path');
  if (values.repo && !/^[\w.-]+\/[\w.-]+$/.test(values.repo)) throw new Error('--repo must be OWNER/REPO');
  const dateMode = values.since !== undefined || values.until !== undefined;
  if (dateMode) {
    const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().replace('.000Z', 'Z') === value;
    if (values.runs !== undefined || !validDate(values.since) || !validDate(values.until) || values.since > values.until) throw new Error('Use --runs N OR --since/--until with ordered UTC timestamps (YYYY-MM-DDTHH:mm:ssZ)');
  } else if (values.runs !== undefined && (!/^\d+$/.test(values.runs) || !positiveId(Number(values.runs)) || Number(values.runs) > 1000)) throw new Error('--runs must be 1..1000');
  return {testFile: positionals[0].replace(/^\.\//, ''), ...(values.repo ? {repo: values.repo} : {}), ...(dateMode ? {since: values.since, until: values.until} : {runs: Number(values.runs ?? 20)})};
}

function matchesFile(annotation, file) {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match file identities in the annotation path or title, not incidental stack frames.
  const token = new RegExp(`(?:^|[\\s/\\[\\]('"\\\\])${escaped}(?=$|[\\s:>\\])'"\\\\])`);
  return [annotation.path, annotation.title].some(value => typeof value === 'string' && token.test(value));
}

function scan(options, {request, now = Date.now, maxRequests = DEFAULT_LIMITS.maxRequests, durationMs = DEFAULT_LIMITS.durationMs}) {
  const started = now();
  const root = `/repos/${options.repo}`;
  const report = {repo: options.repo, testFile: options.testFile, selection: options.since ? {since: options.since, until: options.until} : {runs: options.runs}, complete: true, runsScanned: 0, failingRuns: 0, failingAttempts: 0, requests: 0, failures: [], problems: []};
  let stopped = false;
  function problem(message) { report.complete = false; report.problems.push(message); }
  function get(endpoint) {
    if (stopped || report.requests >= maxRequests || now() - started >= durationMs) {
      stopped = true;
      throw new Error('request or time limit reached');
    }
    report.requests++;
    const data = request(endpoint, Math.max(1, Math.min(30000, durationMs - (now() - started))));
    if (now() - started >= durationMs) {
      stopped = true;
      throw new Error('time limit reached');
    }
    return data;
  }
  // Count-based lists intentionally select the newest N, not all total_count runs.
  function pages(endpoint, key, limit = Infinity) {
    const rows = [];
    let total;
    for (let page = 1; rows.length < limit; page++) {
      const data = get(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const batch = key ? data?.[key] : data;
      if (!Array.isArray(batch)) throw new Error(`invalid page: ${endpoint}`);
      if (key) {
        if (!Number.isSafeInteger(data.total_count) || data.total_count < 0 || (total !== undefined && total !== data.total_count)) throw new Error(`unstable or missing total: ${endpoint}`);
        total = data.total_count;
      }
      rows.push(...batch);
      if (key && rows.length >= Math.min(total, limit)) break;
      if (batch.length < 100) {
        if (key && rows.length < Math.min(total, limit)) throw new Error(`missing page: ${endpoint}`);
        break;
      }
    }
    return {rows: rows.slice(0, limit), total};
  }
  let runs;
  try {
    const query = options.since ? `?created=${encodeURIComponent(`${options.since}..${options.until}`)}` : '';
    const listed = pages(`${root}/actions/workflows/ci.yml/runs${query}`, 'workflow_runs', options.runs ?? 1000);
    if (options.since && listed.total >= 1000) problem('GitHub date-query result cap reached; use a smaller date range');
    runs = listed.rows;
    if (new Set(runs.map(run => run.id)).size !== runs.length) problem('duplicate runs in listing; coverage may have shifted');
  } catch (error) { problem(`run listing: ${error.message}`); return report; }
  const seenRuns = new Set(), seenJobs = new Set();
  for (const source of runs) {
    if (stopped) break;
    if (!positiveId(source?.id) || !positiveId(source.run_attempt)) { problem('invalid run identity'); continue; }
    if (seenRuns.has(source.id)) continue;
    seenRuns.add(source.id);
    report.runsScanned++;
    try {
      for (let attempt = 1; attempt <= source.run_attempt; attempt++) {
        const metadata = attempt === source.run_attempt ? source : get(`${root}/actions/runs/${source.id}/attempts/${attempt}`);
        if (metadata.id !== source.id || metadata.run_attempt !== attempt) throw new Error(`invalid attempt ${attempt}`);
        if (metadata.status !== 'completed') problem(`run ${source.id} attempt ${attempt} is not completed`);
        const {rows: jobs} = pages(`${root}/actions/runs/${source.id}/attempts/${attempt}/jobs`, 'jobs');
        if (new Set(jobs.map(job => job?.id)).size !== jobs.length) problem(`duplicate jobs in run ${source.id} attempt ${attempt}`);
        for (const job of jobs) {
          if (!positiveId(job?.id) || job.run_id !== source.id || !positiveId(job.run_attempt) || job.run_attempt > attempt || typeof job.name !== 'string') throw new Error(`invalid job in attempt ${attempt}`);
          const key = `${source.id}:${job.run_attempt}:${job.id}`;
          if (seenJobs.has(key)) continue;
          seenJobs.add(key);
          if (job.status !== 'completed') problem(`job ${job.id} is not completed`);
          // Do not follow arbitrary URLs supplied by remote data.
          const prefix = `https://api.github.com${root}/check-runs/`;
          if (typeof job.check_run_url !== 'string' || !job.check_run_url.startsWith(prefix) || !/^\d+$/.test(job.check_run_url.slice(prefix.length))) throw new Error(`invalid check URL for job ${job.id}`);
          const checkPath = job.check_run_url.slice('https://api.github.com'.length);
          const check = get(checkPath);
          const count = check?.output?.annotations_count;
          if (!Number.isSafeInteger(count) || count < 0) throw new Error(`missing annotation count for job ${job.id}`);
          if (!count) continue;
          const {rows: annotations} = pages(`${checkPath}/annotations`);
          if (annotations.length !== count) throw new Error(`incomplete annotations for job ${job.id}`);
          for (const annotation of annotations) {
            if (annotation?.annotation_level !== 'failure' || !matchesFile(annotation, options.testFile)) continue;
            report.failures.push({runId: source.id, attempt: job.run_attempt, jobId: job.id, job: job.name, url: `https://github.com/${options.repo}/actions/runs/${source.id}/job/${job.id}`, title: annotation.title ?? '', path: annotation.path ?? '', message: annotation.message ?? ''});
          }
        }
      }
      const current = get(`${root}/actions/runs/${source.id}`);
      if (current.run_attempt !== source.run_attempt || current.status !== source.status || current.updated_at !== source.updated_at) problem(`run ${source.id} changed during collection; repeat the scan`);
    } catch (error) { problem(`run ${source.id}: ${error.message}`); }
  }
  report.failingRuns = new Set(report.failures.map(row => row.runId)).size;
  report.failingAttempts = new Set(report.failures.map(row => `${row.runId}:${row.attempt}`)).size;
  return report;
}

function formatReport(report) {
  return [
    `Observed annotated failures: ${report.testFile} in ${report.repo}`,
    `Selection: ${JSON.stringify(report.selection)}`,
    `Coverage: ${report.complete ? 'complete' : 'INCOMPLETE'} (${report.requests} API requests)`,
    ...report.failures.map(row => `Run ${row.runId}, attempt ${row.attempt}, job ${row.jobId} (${row.job})\n${row.url}\n${row.title}\n${row.path}\n${row.message}`),
    `${report.failingRuns} of ${report.runsScanned} runs scanned have matching failure annotations; ${report.failingAttempts} failing attempts; ${report.failures.length} matching annotations.`,
    'No matching annotation does not prove that a test ran or passed. This is not a pass rate.',
    ...report.problems.map(message => `INCOMPLETE: ${message}`),
  ].join('\n');
}

function main(argv, {gh = (args, timeout = 30000) => execFileSync('gh', args, {encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024}), stdout = text => process.stdout.write(text), stderr = text => process.stderr.write(text)} = {}) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      stdout('Usage: node .github/scripts/count-test-ci-failures.cjs <test-file> [--repo OWNER/REPO] [--runs N | --since YYYY-MM-DDTHH:mm:ssZ --until YYYY-MM-DDTHH:mm:ssZ]\nDefault: latest 20 ci.yml runs; all attempts. Read-only gh authentication required.\n');
      return 0;
    }
    options.repo ??= gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(options.repo)) throw new Error('Cannot resolve OWNER/REPO');
    const report = scan(options, {request: (endpoint, timeout) => {
      try { return JSON.parse(gh(['api', '--method', 'GET', endpoint], timeout)); }
      catch { throw new Error('GitHub request unavailable or invalid JSON'); }
    }});
    stdout(`${formatReport(report)}\n`);
    return report.complete ? 0 : 1;
  } catch (error) {
    // Do not print gh stderr: authentication diagnostics can contain private details.
    stderr(`CI failure scan failed: ${error instanceof SyntaxError ? 'invalid GitHub JSON' : error.code ? 'gh request failed' : error.message}\n`);
    return 1;
  }
}
module.exports = {scan, parseArgs, formatReport, matchesFile, main};
if (require.main === module) process.exitCode = main(process.argv.slice(2));
