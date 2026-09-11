const {downloadLog} = require('./report-workflow-failure.cjs');
// Sized so the default 14-day window completes: a full window costs roughly
// one jobs request per attempt plus one request per failed-job log (~1,250 at
// observed peak), leaving the 1,500-request budget as the binding global bound.
const DEFAULT_LIMITS = Object.freeze({requests:1500,attempts:20,logs:400,logBytes:50*1024*1024,issues:10,occurrences:100,durationMs:12*60*1000});
// Missing (404), expired (410) and oversized source logs are unrecoverable
// per-job evidence gaps: they are listed in the coverage artifact and
// rechecked by the next overlapping sweep, but they never fail the job on
// their own. Transport failures, non-OK signed-URL responses and invalid
// URLs are recorded as logs-fetch-failed and keep coverage incomplete. Caps,
// read failures on metadata and rate limits remain fatal coverage problems.
const GAPS = new Set(['logs-unavailable','log-size']);
class SweepError extends Error {
  constructor(code) { super(code); this.code=code; }
}
// This manifest is safe to publish. Never copy arbitrary metadata/API errors here.
function createSweepApi({github,now=Date.now,limits={},fetchImpl=fetch}) {
  const caps={...DEFAULT_LIMITS,...limits}, started=now();
  const manifest={version:1,complete:true,requests:0,logs:0,downloadedBytes:0,intervals:[],processed:{runs:[],attempts:[],jobs:[]},problems:[],reports:{issues:0,occurrences:0},reporterFailures:0};
  let stopped;
  function problem(code,ids={}) {
    if(!GAPS.has(code))manifest.complete=false;
    const entry={code};
    for(const key of ['runId','attempt','jobId','issueNumber']) if(Number.isSafeInteger(ids[key]) && ids[key]>=0)entry[key]=ids[key];
    if(!manifest.problems.some(p=>JSON.stringify(p)===JSON.stringify(entry)))manifest.problems.push(entry);
  }
  function stop(code) { stopped=code;problem(code);throw new SweepError(code); }
  function checkTime() {
    if(now()-started>=caps.durationMs)stop('time-limit');
  }
  function check() {
    if(stopped)throw new SweepError(stopped);
    if(now()-started>=caps.durationMs)stop('time-limit');
    if(manifest.requests>=caps.requests)stop('request-limit');
  }
  async function request(route,args={}) {
    check();manifest.requests++;
    try {
      const response=await github.request(route,{...args,request:{...args.request,timeout:Math.max(1,Math.min(30_000,caps.durationMs-(now()-started))),retries:0}});
      if(now()-started>=caps.durationMs)stop('time-limit');
      return response;
    } catch(error) {
      if(error instanceof SweepError)throw error;
      if(error?.status===403 || error?.status===429)stop('rate-limit');
      // Log absence (404 gone or 410 expired) gets its own problem at the
      // download boundary; transport failures on the log route are not gaps.
      if(route.endsWith('/logs'))throw new SweepError(error.status===404 || error.status===410 ? 'logs-unavailable' : 'logs-fetch-failed');
      const code=route.startsWith('GET ') ? 'api-read' : 'api-write';
      problem(code);throw new SweepError(code);
    }
  }
  async function paginate(route,args={}) {
    const all=[],seen=new Set();let expected;
    function gap() {problem('pagination-gap');throw new SweepError('pagination-gap');}
    for(let page=1;;page++) {
      const response=await request(route,{...args,per_page:100,page});
      const data=response.data;
      const rows=Array.isArray(data) ? data : data?.jobs ?? data?.workflow_runs ?? data?.workflows;
      if(!Array.isArray(rows)) {problem('invalid-page');throw new SweepError('invalid-page');}
      if(data?.total_count!==undefined) {
        if(!Number.isSafeInteger(data.total_count)||data.total_count<0)gap();
        if(expected!==undefined && expected!==data.total_count)gap();
        expected=data.total_count;
      }
      const before=all.length;
      for(const row of rows) {
        if(!row || typeof row!=='object' || Array.isArray(row)) {problem('invalid-page');throw new SweepError('invalid-page');}
        const key=row.id ?? row.number ?? row.name;
        if(key!==undefined) {if(seen.has(key))continue;seen.add(key);}
        all.push(row);
      }
      const next=/(?:^|,)\s*<[^>]+>;\s*rel="next"/.test(response.headers?.link || '');
      if(expected!==undefined) {
        if(all.length===expected && !next)return all;
        if(all.length>expected || all.length===before)gap();
      } else {
        if(rows.length && all.length===before)gap();
        if(rows.length<100 && !next)return all;
      }
    }
  }
  function countBytes(bytes) {
    manifest.downloadedBytes+=bytes;
    if(manifest.downloadedBytes>caps.logBytes) {problem('log-byte-limit');throw new SweepError('log-byte-limit');}
    if(now()-started>=caps.durationMs)stop('time-limit');
  }
  async function log(args) {
    if(manifest.logs>=caps.logs) {problem('log-count-limit',{jobId:args.job_id});return null;}
    if(manifest.downloadedBytes>=caps.logBytes) {problem('log-byte-limit',{jobId:args.job_id});return null;}
    manifest.logs++;
    try {
      return await downloadLog({request:async(route,params)=>{
        const response=await request(route,params);
        if(!response.headers?.location && typeof response.data==='string')countBytes(Buffer.byteLength(response.data));
        return response;
      }},args,async(url,options)=>{
        checkTime();
        const remaining=Math.max(1,Math.ceil(caps.durationMs-(now()-started)));
        const signal=AbortSignal.any([options.signal,AbortSignal.timeout(remaining)]);
        const response=await fetchImpl(url,{...options,signal});
        if(!response.body)return response;
        const reader=response.body.getReader();
        // Stream into the existing per-log limiter while enforcing total bytes.
        const body=new ReadableStream({
          async pull(controller) {
            try {
              const {done,value}=await reader.read();
              if(done)controller.close();
              else {countBytes(value.byteLength);controller.enqueue(value);}
            } catch(error) {await reader.cancel().catch(()=>{});controller.error(error);}
          },
          cancel:()=>reader.cancel(),
        });
        // downloadLog classifies 404/410 signed-URL responses as gaps, so the
        // status must survive the wrapper.
        return {ok:response.ok,status:response.status,body};
      });
    } catch(error) {
      try {checkTime();} catch { /* deadline is recorded by checkTime */ }
      // downloadLog tags only unrecoverable gaps; anything else (network
      // errors, timeouts, non-OK responses, invalid URLs) stays incomplete.
      problem(error instanceof SweepError ? error.code : GAPS.has(error?.code) ? error.code : 'logs-fetch-failed',{jobId:args.job_id});
      return null;
    }
  }
  return {request,paginate,downloadLog:log,manifest,limits:caps,problem,checkTime,get stopped(){return Boolean(stopped);}};
}
module.exports={createSweepApi,DEFAULT_LIMITS,SweepError};
