'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const VERIFICATION_JOB = 'Unit, build, E2E, and package';

function pickPullRequestRun(runs, headSha) {
  const candidates = (runs || []).filter((run) => ['pull_request', 'pull_request_target'].includes(run.event) &&
    (headSha === undefined || run.headSha === headSha))
    .sort((a, b) => b.databaseId - a.databaseId);
  // Once target CI exists it remains authoritative, including failure/cancellation.
  // Legacy fallback supports bases not yet migrated; never fall back past a target.
  return candidates.find((run) => run.event === 'pull_request_target') || candidates[0] || null;
}

function verificationJob(jobs) {
  const matches = (jobs || []).filter(job => job.name === VERIFICATION_JOB);
  if (matches.length > 1) throw new Error(`Ambiguous ci.yml verification job: ${VERIFICATION_JOB}`);
  return matches[0] || null;
}

function verificationJobs(jobs) {
  return (jobs || []).filter(job => job.name === VERIFICATION_JOB ||
    job.name === 'Typecheck, unit, build, and package' || job.name === 'Unit, build, and package' ||
    job.name === 'Typecheck' || /^Vitest shard \d+\/\d+$/.test(job.name));
}

function verificationComplete(job) {
  return job?.status === 'completed' && typeof job.conclusion === 'string' && job.conclusion.length > 0;
}

// GitHub's API occasionally answers one request with a 5xx or drops the connection
// while every CI job is green (hearsay-tools/cezarion#1020). Retry those transient
// failures a bounded number of times; 4xx answers (404, 401, ...) fail at once.
const GH_RETRY_DELAYS_MS = [2_000, 4_000, 8_000];

function ghErrorText(error) {
  return [error?.message, error?.stderr, error?.stdout]
    .map(part => (Buffer.isBuffer(part) ? part.toString('utf8') : part))
    .filter(part => typeof part === 'string')
    .join('\n');
}

function isTransientGhError(error) {
  const text = ghErrorText(error);
  if (/HTTP 5\d\d\b/.test(text)) return true;
  if (/HTTP 429\b/.test(text) || /secondary rate limit/i.test(text)) return true;
  if (/HTTP 4\d\d\b/.test(text)) return false;
  // `gh` is Go: its transport errors read `dial tcp …`, `lookup <host> …`, `write tcp …` rather
  // than Node's E-codes, so match Go's net-error shapes as a class, not one phrase at a time.
  return /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|\b(?:dial|read|write) tcp\b|\blookup \S+|no such host|name resolution|network is unreachable|broken pipe|connection reset|connection refused|timed? ?out|TLS handshake|unexpected EOF|stream error/i.test(text);
}

function withGhRetry(gh, sleep, delaysMs = GH_RETRY_DELAYS_MS) {
  return (argv) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return gh(argv);
      } catch (error) {
        if (!isTransientGhError(error)) throw error;
        if (attempt >= delaysMs.length) {
          const detail = ghErrorText(error).trim();
          throw new Error(`gh ${argv.join(' ')} failed after ${attempt + 1} attempts: ${detail}`, { cause: error });
        }
        process.stderr.write(`gh ${argv.join(' ')} failed transiently (attempt ${attempt + 1}); retrying in ${delaysMs[attempt]}ms\n`);
        sleep(delaysMs[attempt]);
      }
    }
  };
}

function listRunJobs(gh, repo, run) {
  const details = JSON.parse(gh(['run', 'view', String(run.databaseId), '--repo', repo, '--json', 'jobs']));
  if (!Array.isArray(details.jobs)) throw new Error('Invalid ci.yml jobs response');
  return details.jobs;
}

function failedJobsFrom(jobs) {
  const failed = [];
  for (const job of jobs || []) {
    if (job?.conclusion !== 'failure' && job?.conclusion !== 'timed_out') continue;
    failed.push({ name: job.name || 'unknown', conclusion: job.conclusion });
  }
  return failed;
}

function pendingResult(url) {
  return {
    status: 'pending',
    conclusion: null,
    url: url || null,
    failedJobs: [],
    failedLog: '',
  };
}

function resolveCiResults(runs, details = {}) {
  const run = pickPullRequestRun(runs, details.headSha);
  const verification = run && verificationJob(details.jobs);
  if (!verificationComplete(verification)) return pendingResult(run && run.url);
  return {
    status: 'completed',
    conclusion: verification.conclusion,
    url: run.url || null,
    failedJobs: failedJobsFrom(verificationJobs(details.jobs)),
    failedLog: details.failedLog || '',
  };
}

function renderCiResults(result) {
  const lines = [
    '# CI verification results',
    '',
    'Scope: Unit, build, E2E, and package; npm publishing is not included.',
    '',
    `status: ${result.status}`,
    `conclusion: ${result.conclusion || ''}`,
    `url: ${result.url || ''}`,
  ];
  if (result.status === 'pending') {
    lines.push(
      '',
      'CI verification has not finished. Do not run the test suite; read this file instead of probing npm test.',
    );
    return `${lines.join('\n')}\n`;
  }
  if (result.failedJobs.length) {
    lines.push('', '## Failed jobs', '');
    for (const job of result.failedJobs) {
      lines.push(`### ${job.name}`, '', `conclusion: ${job.conclusion}`, '');
    }
  }
  if (result.failedLog) {
    lines.push('## Failed step log', '', '```', result.failedLog.replace(/```/g, "'''").trimEnd(), '```', '');
  }
  return `${lines.join('\n')}\n`;
}

function collectCiResults({ gh: rawGh, repo, headSha, requireSuccess = false, sleep = defaultSleep }) {
  const gh = withGhRetry(rawGh, sleep);
  const runs = listCiRuns(gh, repo, headSha);
  const run = pickPullRequestRun(runs, headSha);
  const jobs = run ? listRunJobs(gh, repo, run) : [];
  const result = resolveCiResults(runs, { jobs, headSha });
  if (requireSuccess && (result.status !== 'completed' || result.conclusion !== 'success')) {
    throw new Error(`ci.yml verification did not succeed for ${headSha}: ${result.conclusion || result.status}`);
  }
  if (result.status !== 'completed') return result;

  // A run-level log archive waits for publishing. Completed job logs are available
  // independently through the Actions job endpoint, including failed shards.
  const logs = [];
  for (const job of verificationJobs(jobs)) {
    if (job.status !== 'completed' || !failedJobsFrom([job]).length) continue;
    try {
      if (!Number.isSafeInteger(job.databaseId) || job.databaseId <= 0) throw new Error('Missing job id');
      logs.push(`${job.name}\n${gh(['api', `repos/${repo}/actions/jobs/${job.databaseId}/logs`])}`);
    } catch {
      logs.push(`${job.name}: failed-job log unavailable.`);
    }
  }
  return { ...result, failedLog: logs.join('\n') };
}

function writeCiResults({ out, result }) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, renderCiResults(result), 'utf8');
}

function listCiRuns(gh, repo, headSha) {
  return JSON.parse(
    gh([
      'run',
      'list',
      '--repo',
      repo,
      '--workflow',
      'ci.yml',
      '--commit',
      headSha,
      '--limit',
      '20',
      '--json',
      'databaseId,status,conclusion,url,event,headSha',
    ]),
  );
}

function defaultSleep(ms) {
  execFileSync('sleep', [String(ms / 1000)]);
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--require-success') {
      parsed.requireSuccess = true;
      continue;
    }
    const value = argv[i + 1];
    if (key === '--repo') parsed.repo = value;
    else if (key === '--head-sha') parsed.headSha = value;
    else if (key === '--out') parsed.out = value;
    else continue;
    i += 1;
  }
  if (!parsed.repo || !parsed.headSha || !parsed.out) {
    throw new Error('Usage: fetch-ci-results.cjs --repo owner/name --head-sha SHA --out path [--require-success]');
  }
  return parsed;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const gh = (argv) => execFileSync('gh', argv, { encoding: 'utf8' });
  writeCiResults({
    out: args.out,
    result: collectCiResults({ gh, repo: args.repo, headSha: args.headSha, requireSuccess: args.requireSuccess }),
  });
}

module.exports = {
  pickPullRequestRun,
  parseArgs,
  resolveCiResults,
  renderCiResults,
  collectCiResults,
  writeCiResults,
  isTransientGhError,
  withGhRetry,
};
