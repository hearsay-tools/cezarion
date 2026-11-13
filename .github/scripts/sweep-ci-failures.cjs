const {createSweepApi}=require('./ci-sweep-api.cjs');
const {collectSweep}=require('./ci-sweep-collect.cjs');
const {classifyPatterns}=require('./ci-sweep-patterns.cjs');
const {reportPatterns}=require('./ci-sweep-report.cjs');
const {isQuotaCause}=require('./failure-diagnostics.cjs');
const DAY=24*60*60*1000;
const iso=ms=>new Date(ms).toISOString().replace('.000Z','Z');
function parseUtc(value) {
  if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value))return NaN;
  const time=Date.parse(value);
  return Number.isFinite(time)&&iso(time)===value?time:NaN;
}
async function sweepCiFailures({github,owner,repo,start='',end='',now=Date.now,limits,fetchImpl}) {
  const api=createSweepApi({github,now,limits,fetchImpl});
  const {manifest}=api, launched=Math.floor(now()/1000)*1000;
  manifest.selection='original-run-created-at';manifest.patterns=0;manifest.replay=[];
  if(!/^[\w.-]+$/.test(owner)||!/^[\w.-]+$/.test(repo)) {api.problem('invalid-repository');return manifest;}
  const manual=Boolean(start||end);
  const first=manual?parseUtc(start):launched-14*DAY,last=manual?parseUtc(end):launched;
  if(!Number.isFinite(first)||!Number.isFinite(last)||first>last||last-first>14*DAY||first<launched-90*DAY||last>launched) {
    api.problem('invalid-window');return manifest;
  }
  manifest.start=iso(first);manifest.end=iso(last);
  try {
    const collected=await collectSweep({api,owner,repo,start:manifest.start,end:manifest.end});
    // GitHub quota errors are never filed. Count every one here, before the
    // recurrence threshold and before any issue read, so the summary shows them.
    const quota=collected.occurrences.filter(occurrence=>isQuotaCause(occurrence.cause));
    manifest.suppressed={occurrences:quota.length,runs:[...new Set(quota.map(occurrence=>occurrence.run.id))].sort((a,b)=>a-b)};
    // A quota step with another error is classified by that error, as the
    // writer reports it for an unrecorded step; `sourceCause` lets the writer
    // make that choice from the step's records. Quota-only steps drop out.
    const classifiable=collected.occurrences.flatMap(occurrence=>!isQuotaCause(occurrence.cause) ? [occurrence]
      : occurrence.cause.independentCause ? [{...occurrence,cause:occurrence.cause.independentCause,sourceCause:occurrence.cause}] : []);
    const patterns=classifyPatterns({...collected,occurrences:classifiable,owner,repo});
    manifest.patterns=patterns.length;
    await reportPatterns({api,owner,repo,patterns,start:manifest.start,end:manifest.end});
  } catch {api.problem('sweep-incomplete');}
  try {api.checkTime();} catch { /* fixed deadline problem is already recorded */ }
  if(!manifest.complete)manifest.replay=[{start:manifest.start,end:manifest.end}];
  return manifest;
}
module.exports={sweepCiFailures};
