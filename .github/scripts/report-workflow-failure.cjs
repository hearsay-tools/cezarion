const {causesForStep} = require('./failure-diagnostics.cjs');
const {createFailureWriter} = require('./failure-issue-writer.cjs');
const LOG_LIMIT = 2 * 1024 * 1024;
// Oversized single logs are unrecoverable per-job evidence gaps; the sweep
// records this code without failing, everything else stays a coverage problem.
const gapError = message => Object.assign(new Error(message), {code: 'log-size'});
const PATHS = {Release:'.github/workflows/release.yml',Nightly:'.github/workflows/nightly.yml'};

function eligible(run, owner, repo) {
  return run && run.status === 'completed' && run.conclusion === 'failure'
    && PATHS[run.name] && run.path === PATHS[run.name]
    && run.head_repository?.full_name === `${owner}/${repo}`
    && (run.head_branch === 'main' || (run.name === 'Release' && /^release\/.+/.test(run.head_branch)));
}
function validateRun(run) {
  if (!Number.isSafeInteger(run.id) || run.id < 1 || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1
      || !/^[a-f0-9]{40}$/i.test(run.head_sha) || !Number.isFinite(Date.parse(run.created_at))) {
    throw new Error('Invalid failure run metadata');
  }
}
async function downloadLog(github, args, fetchImpl) {
  // Ask GitHub for the signed URL without forwarding the reporting token to
  // blob storage. Production redirects are streamed with a strict byte cap.
  const response = await github.request('GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs', {...args,request:{redirect:'manual'}});
  const location = response.headers?.location;
  if (!location) {
    if (typeof response.data !== 'string') throw new Error('Unexpected log payload');
    if (Buffer.byteLength(response.data) > LOG_LIMIT) throw gapError('Log exceeds download limit');
    return response.data;
  }
  const url = new URL(location);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid log URL');
  const logResponse = await fetchImpl(url, {redirect:'error',signal:AbortSignal.timeout(30_000)});
  if (!logResponse.ok || !logResponse.body) {
    const error = new Error('Unavailable log');
    // 404/410 mean the log is already gone or expired: unrecoverable, while
    // any other status is a transient storage failure and stays a problem.
    if (logResponse.status === 404 || logResponse.status === 410) error.code = 'logs-unavailable';
    throw error;
  }
  const reader=logResponse.body.getReader(), chunks=[];
  let bytes=0;
  try {
    while (true) {
      const {done,value}=await reader.read(); if(done)break;
      bytes+=value.byteLength;
      if(bytes>LOG_LIMIT) throw gapError('Log exceeds download limit');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString('utf8');
}
// The workflow's GLOBAL concurrency group is the cross-process lock. Do not
// call this writer from a different workflow unless it uses the same group.
async function reportFailure({github,owner,repo,event,log=()=>{},fetchImpl=fetch}) {
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) throw new Error('Invalid repository');
  const source=event.workflow_run;
  if (event.action !== 'completed' || !eligible(source,owner,repo)) return {reported:0};
  validateRun(source);
  const base={owner,repo};
  const {data:run}=await github.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}', {...base,run_id:source.id,attempt_number:source.run_attempt});
  if (!eligible(run,owner,repo) || run.id!==source.id || run.run_attempt!==source.run_attempt) throw new Error('Failure attempt metadata changed');
  validateRun(run);
  const jobs=await github.paginate('GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs',{...base,run_id:run.id,attempt_number:run.run_attempt,per_page:100});
  const writer=await createFailureWriter({github,owner,repo,log});
  let reported=0;
  const failed=jobs.filter(job=>job.conclusion==='failure' || job.conclusion==='timed_out');
  if(!failed.length) throw new Error('Failed run has no failed jobs; inspect Actions metadata');
  for(const job of failed) {
    if(!Number.isSafeInteger(job.id) || job.id < 1) throw new Error('Invalid failed job');
    let jobLog='';
    try {jobLog=await downloadLog(github,{...base,job_id:job.id},fetchImpl);}
    catch {log(`Job ${job.id}: logs unavailable, expired or above the download limit; reporting metadata.`);}
    const steps=(job.steps || []).filter(step=>step.conclusion==='failure' || step.conclusion==='timed_out');
    if(!steps.length) steps.push({number:0,name:'Job failed before a step was recorded',started_at:job.started_at,completed_at:job.completed_at});
    for(const step of steps) {
      if(!Number.isSafeInteger(step.number) || step.number<0) throw new Error('Invalid failed step');
      const causes=causesForStep({run,job,step,log:jobLog});
      const results=await writer.reportStep({run,job,step,causes});
      reported+=results.filter(result=>result.reported).length;
    }
  }
  return {reported};
}
module.exports={reportFailure,downloadLog};
