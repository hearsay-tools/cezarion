const {causesForStep}=require('./failure-diagnostics.cjs');
const REPORTERS=new Set(['.github/workflows/report-workflow-failure.yml','.github/workflows/sweep-ci-failures.yml']);
const failed=value=>value==='failure'||value==='timed_out';
const id=value=>Number.isSafeInteger(value)&&value>0;
const timestamp=value=>typeof value==='string' && Number.isFinite(Date.parse(value));
const validRun=run=>run && id(run.id) && id(run.run_attempt) && /^[a-f\d]{40}$/i.test(run.head_sha) && timestamp(run.created_at) && timestamp(run.updated_at) && (run.status!=='completed'||timestamp(run.run_started_at)) && typeof run.path==='string';
const iso=seconds=>new Date(seconds*1000).toISOString().replace('.000Z','Z');

async function collectSweep({api,owner,repo,start,end}) {
  const {manifest}=api, base={owner,repo}, runs=new Map();
  const lo=Math.floor(Date.parse(start)/1000),hi=Math.floor(Date.parse(end)/1000);
  if(!Number.isFinite(lo)||!Number.isFinite(hi)||lo>hi)throw new Error('invalid-window');
  manifest.start=iso(lo);manifest.end=iso(hi);
  const runsFromPage=data=> {
    if(!Number.isSafeInteger(data?.total_count)||data.total_count<0||!Array.isArray(data.workflow_runs))throw new Error('invalid-runs');
    return data.workflow_runs;
  };
  async function allRuns(args,data) {
    const rows=[...data.workflow_runs];
    const uniqueIds=()=>new Set(rows.filter(r=>id(r?.id)).map(r=>r.id)).size;
    for(let page=2;uniqueIds()<data.total_count;page++) {
      const before=uniqueIds();
      const {data:next}=await api.request('GET /repos/{owner}/{repo}/actions/runs',{...args,page});
      if(!Array.isArray(next?.workflow_runs)||!next.workflow_runs.length||next.total_count!==data.total_count)throw new Error('incomplete-runs');
      rows.push(...next.workflow_runs);
      if(uniqueIds()===before)throw new Error('incomplete-runs');
    }
    if(uniqueIds()!==data.total_count)throw new Error('incomplete-runs');
    return rows;
  }
  function acceptRuns(rows,first,last) {
    for(const run of rows) {
      if(!validRun(run)) {api.problem('invalid-run',{runId:run?.id});continue;}
      const created=Date.parse(run.created_at)/1000;
      if(created>=first && created<=last)runs.set(run.id,run);
    }
  }
  async function interval(first,last) {
    if(api.stopped)return;
    const coverage={start:iso(first),end:iso(last),complete:false};
    try {
      const args={...base,created:`${iso(first)}..${iso(last)}`,per_page:100,page:1};
      const data=(await api.request('GET /repos/{owner}/{repo}/actions/runs',args)).data;
      runsFromPage(data);
      if(data.total_count>=1000) {
        if(first===last) {manifest.intervals.push(coverage);api.problem('run-query-overflow');return;}
        const middle=Math.floor((first+last)/2);
        await interval(first,middle);await interval(middle+1,last);return;
      }
      acceptRuns(await allRuns(args,data),first,last);
      coverage.complete=true;
    } catch {api.problem('run-query-incomplete');}
    manifest.intervals.push(coverage);
  }
  await interval(lo,hi);
  const occurrences=[],attempts=[],seenJobs=new Set(),seenOccurrences=new Set();
  async function fetchAttempt(source,number) {
    try {
      // The list response is already a complete snapshot of the latest
      // attempt. Only historical attempts need another metadata request.
      const run=number===source.run_attempt ? source : (await api.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}',{...base,run_id:source.id,attempt_number:number})).data;
      if(!validRun(run)||run.id!==source.id||run.run_attempt!==number||run.path!==source.path||run.head_sha!==source.head_sha)throw new Error('invalid-attempt');
      return run;
    } catch {api.problem('attempt-unavailable',{runId:source.id,attempt:number});return null;}
  }
  async function loadJobs(run,number) {
    try {return await api.paginate('GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs',{...base,run_id:run.id,attempt_number:number});}
    catch {api.problem('jobs-unavailable',{runId:run.id,attempt:number});return null;}
  }
  function acceptJobs(run,number,jobs) {
    const validJobs=[];let complete=true;
    const badIdentity=job=>!id(job.id)||job.run_id!==run.id||!id(job.run_attempt)||typeof job.name!=='string';
    const badJobTime=job=>['success','failure','timed_out'].includes(job.conclusion) && (!timestamp(job.started_at)||!timestamp(job.completed_at)||Date.parse(job.completed_at)<Date.parse(job.started_at));
    const badStepsShape=job=>(job.steps!=null && !Array.isArray(job.steps)) || (Array.isArray(job.steps) && job.steps.some(step=>!step||typeof step!=='object'));
    const badStepTime=job=>(job.steps||[]).some(step=>['success','failure','timed_out'].includes(step.conclusion) && (!timestamp(step.started_at)||!timestamp(step.completed_at)||Date.parse(step.completed_at)<Date.parse(step.started_at)));
    for(const job of jobs) {
      if(badIdentity(job)) {complete=false;api.problem('invalid-job',{runId:run.id,attempt:number});continue;}
      // Some rerun responses include retained earlier jobs; their attempt
      // identity must not become success evidence for the current retry.
      if(job.run_attempt!==number) {complete=false;api.problem('job-attempt-mismatch',{runId:run.id,attempt:number,jobId:job.id});continue;}
      if(badJobTime(job)) {complete=false;api.problem('invalid-job-time',{jobId:job.id});continue;}
      if(badStepsShape(job)) {complete=false;api.problem('invalid-steps',{jobId:job.id});continue;}
      if(badStepTime(job)) {complete=false;api.problem('invalid-step-time',{jobId:job.id});continue;}
      if(validJobs.some(previous=>previous.id===job.id))continue;
      validJobs.push(job);
    }
    return {validJobs,complete};
  }
  function recordOccurrences(run,number,job,log) {
    let steps=(Array.isArray(job.steps)?job.steps:[]).filter(step=>failed(step.conclusion));
    const metadataOnly=!steps.length;
    if(metadataOnly)steps=[{number:0,name:'Job failed before a step was recorded',started_at:job.started_at,completed_at:job.completed_at}];
    for(const step of steps) {
      if(!Number.isSafeInteger(step.number)||step.number<0||typeof step.name!=='string') {api.problem('invalid-step',{runId:run.id,attempt:number,jobId:job.id});continue;}
      for(const cause of causesForStep({run,job,step,log:metadataOnly?'':log||''})) {
        const key=`${run.id}:${number}:${job.id}:${step.number}:${cause.failureIdentity||cause.signature}`;
        if(seenOccurrences.has(key))continue;
        seenOccurrences.add(key);occurrences.push({run,job,step,cause});
      }
    }
  }
  async function collectFailedJobs(run,number,validJobs) {
    for(const job of validJobs) {
      if(api.stopped)break;
      if(seenJobs.has(job.id))continue;
      seenJobs.add(job.id);manifest.processed.jobs.push(job.id);
      if(!failed(job.conclusion))continue;
      const log=await api.downloadLog({...base,job_id:job.id});
      recordOccurrences(run,number,job,log);
    }
  }
  async function collectAttempt(source,number,reporter) {
    const run=await fetchAttempt(source,number);
    if(!run)return;
    // Reporting machinery is skipped before the in-progress check: this
    // sweep's own attempt is always running during collection, and a queued
    // sibling reporter is not a coverage gap either.
    if(reporter) {
      manifest.processed.attempts.push({runId:run.id,attempt:number});
      if(failed(run.conclusion))manifest.reporterFailures++;
      return;
    }
    if(run.status!=='completed') {api.problem('attempt-in-progress',{runId:run.id,attempt:number});return;}
    if(['cancelled','skipped'].includes(run.conclusion))return;
    const jobs=await loadJobs(run,number);
    if(!jobs)return;
    const accepted=acceptJobs(run,number,jobs);
    attempts.push({run,jobs:accepted.validJobs,complete:accepted.complete});
    manifest.processed.attempts.push({runId:run.id,attempt:number});
    await collectFailedJobs(run,number,accepted.validJobs);
  }
  async function collectAttempts(source,reporter) {
    for(let number=1;number<=Math.min(source.run_attempt,api.limits.attempts);number++) {
      if(api.stopped)break;
      await collectAttempt(source,number,reporter);
    }
  }
  for(const source of [...runs.values()].sort((a,b)=>a.id-b.id)) {
    if(api.stopped)break;
    manifest.processed.runs.push(source.id);
    const reporter=REPORTERS.has(source.path.split('@')[0]);
    if(source.run_attempt>api.limits.attempts)api.problem('attempt-limit',{runId:source.id});
    await collectAttempts(source,reporter);
  }
  return {occurrences,attempts};
}
module.exports={collectSweep};
