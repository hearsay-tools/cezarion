// Classification operates on raw structured identities; only report formatting
// may render them. No identity or diagnostic is copied into the coverage manifest.
function contextFor(run) {
  const source=run.head_repository?.full_name;
  if(typeof source!=='string'||!/^[\w.-]+\/[\w.-]+$/.test(source)||!Array.isArray(run.pull_requests))return null;
  if(run.pull_requests.length===1 && Number.isSafeInteger(run.pull_requests[0].number) && run.pull_requests[0].number>0)return `pr:${source}:${run.pull_requests[0].number}`;
  if(run.pull_requests.length===0 && typeof run.head_branch==='string' && run.head_branch)return `branch:${source}:${run.head_branch}`;
  return null;
}
function comparisonFor(occurrence,attempts) {
  const {run,job,step}=occurrence;
  const original=attempts.find(a=>a.run.id===run.id && a.run.run_attempt===run.run_attempt);
  if(!original || original.complete===false || original.jobs.filter(j=>j.name===job.name).length!==1)return null;
  if((job.steps||[]).filter(s=>s.number===step.number && s.name===step.name).length!==1)return null;
  for(const attempt of attempts) {
    if(attempt.complete===false || attempt.run.id!==run.id || attempt.run.head_sha!==run.head_sha || attempt.run.run_attempt<=run.run_attempt || attempt.run.conclusion!=='success')continue;
    const matches=attempt.jobs.filter(j=>j.name===job.name);
    if(matches.length!==1 || matches[0].conclusion!=='success')continue;
    const steps=(matches[0].steps||[]).filter(s=>s.number===step.number && s.name===step.name);
    if(steps.length===1 && steps[0].conclusion==='success')return {run:attempt.run,job:matches[0],step:steps[0],failedRunId:run.id,failedAttempt:run.run_attempt};
  }
  return null;
}
function classifyPatterns({occurrences,attempts}) {
  const groups=new Map(),seen=new Set();
  for(const o of occurrences) {
    if(o.cause.kind!=='test' && o.cause.kind!=='error')continue;
    if(o.cause.kind==='test' && (!o.cause.hasTestName || !o.cause.hasDiagnostic))continue;
    const identity=`${o.run.id}:${o.run.run_attempt}:${o.job.id}:${o.step.number}:${o.cause.failureIdentity}`;
    if(seen.has(identity))continue;
    seen.add(identity);
    if(!groups.has(o.cause.signature))groups.set(o.cause.signature,[]);
    groups.get(o.cause.signature).push(o);
  }
  const patterns=[];
  for(const group of groups.values()) {
    // Unknown change context cannot contribute toward an independence threshold.
    const independent=group.filter(o=>contextFor(o.run));
    const runs=new Set(independent.map(o=>o.run.id));
    const shas=new Set(independent.map(o=>o.run.head_sha));
    const contexts=new Set(independent.map(o=>contextFor(o.run)));
    if(shas.size<2||contexts.size<2)continue;
    const cause=group[0].cause;
    const comparisons=cause.kind==='test' && cause.testIdentity?.includes(' > ')
      ? independent.map(o=>comparisonFor(o,attempts)).filter(Boolean) : [];
    const uniqueComparisons=[...new Map(comparisons.map(p=>[`${p.run.id}:${p.run.run_attempt}:${p.job.id}:${p.step.number}:${p.failedAttempt}`,p])).values()];
    const classification=independent.length>=2 && uniqueComparisons.length ? 'possible-test-flakiness' : runs.size>=3 ? 'recurring-failure' : null;
    if(classification)patterns.push({cause,occurrences:group,comparisons:uniqueComparisons,classification,counts:{failures:group.length,runs:new Set(group.map(o=>o.run.id)).size,shas:new Set(group.map(o=>o.run.head_sha)).size,contexts:contexts.size}});
  }
  return patterns.sort((a,b)=>a.cause.signature.localeCompare(b.cause.signature));
}
module.exports={classifyPatterns};
