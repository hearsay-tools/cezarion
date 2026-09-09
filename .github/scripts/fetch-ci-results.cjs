'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const VERIFICATION_JOB = 'Unit, build, E2E, and package';

function pickPullRequestRun(runs, headSha) {
  return (runs || []).find((run) => run.event === 'pull_request' &&
    (headSha === undefined || run.headSha === headSha)) || null;
}

function verificationJob(jobs) {
  const matches = (jobs || []).filter(job => job.name === VERIFICATION_JOB);
  if (matches.length > 1) throw new Error(`Ambiguous ci.yml verification job: ${VERIFICATION_JOB}`);
  return matches[0] || null;
}

function verificationJobs(jobs) {
  return (jobs || []).filter(job => job.name === VERIFICATION_JOB ||
    job.name === 'Typecheck, unit, build, and package' || /^Vitest shard \d+\/\d+$/.test(job.name));
}

function verificationComplete(job) {
  return job?.status === 'completed' && typeof job.conclusion === 'string' && job.conclusion.length > 0;
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

function collectCiResults({ gh, repo, headSha, requireSuccess = false }) {
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

const DEFAULT_WAIT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_WAIT_POLL_MS = 15_000;

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

function waitForCiRun({
  gh,
  repo,
  headSha,
  now = Date.now,
  sleep = defaultSleep,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_WAIT_POLL_MS,
}) {
  const deadline = now() + timeoutMs;
  while (true) {
    const run = pickPullRequestRun(listCiRuns(gh, repo, headSha), headSha);
    const verification = run && verificationJob(listRunJobs(gh, repo, run));
    if (verification?.status === 'completed') {
      if (verification.conclusion === 'success') return run;
      throw new Error(`ci.yml verification did not succeed for ${headSha}: ${verification.conclusion || 'missing conclusion'}`);
    }
    if (now() >= deadline) {
      throw new Error(`Timed out waiting for ci.yml pull_request verification for ${headSha}`);
    }
    sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--wait') {
      parsed.wait = true;
      continue;
    }
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
  if (!parsed.repo || !parsed.headSha || (!parsed.wait && !parsed.out)) {
    throw new Error('Usage: fetch-ci-results.cjs --repo owner/name --head-sha SHA (--out path | --wait)');
  }
  return parsed;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const gh = (argv) => execFileSync('gh', argv, { encoding: 'utf8' });
  if (args.wait) {
    waitForCiRun({ gh, repo: args.repo, headSha: args.headSha });
  } else {
    writeCiResults({
      out: args.out,
      result: collectCiResults({ gh, repo: args.repo, headSha: args.headSha, requireSuccess: args.requireSuccess }),
    });
  }
}

module.exports = {
  parseArgs,
  resolveCiResults,
  renderCiResults,
  collectCiResults,
  writeCiResults,
  waitForCiRun,
};
