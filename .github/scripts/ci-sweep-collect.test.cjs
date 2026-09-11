const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {createSweepApi}=require('./ci-sweep-api.cjs');
const {harness,run,job}=require('./fixtures/sweep-harness.cjs');
const moduleUnderTest=fs.existsSync(__dirname+'/ci-sweep-collect.cjs')?require('./ci-sweep-collect.cjs'):{};
async function collect(h,limits) {
 assert.equal(typeof moduleUnderTest.collectSweep,'function','collector implemented');
 const api=createSweepApi({github:h.github,limits});
 const result=await moduleUnderTest.collectSweep({api,owner:'hearsay-tools',repo:'cezarion',start:'2026-09-01T00:00:00Z',end:'2026-09-10T00:00:00Z'});
 return {...result,manifest:api.manifest};
}
test('successful latest runs retain failed historical attempts and successful comparisons',async()=>{
 const h=harness();h.state.runs[0]=run(1,{run_attempt:2,conclusion:'success'});
 h.state.attempts.set('1:2',h.state.runs[0]);h.state.jobs.set('1:2',[job(11,{run_attempt:2,conclusion:'success',steps:[{number:3,name:'Run tests',conclusion:'success'}]})]);
 const result=await collect(h);
 assert.equal(result.occurrences.length,1);assert.equal(result.occurrences[0].run.run_attempt,1);assert.equal(result.attempts.length,2);
 assert.equal(result.manifest.complete,true);
});
test('all workflow paths and paginated jobs are scanned even for successful run conclusion',async()=>{
 const h=harness();h.state.runs[0]=run(1,{name:'Other build',path:'.github/workflows/other.yml',conclusion:'success'});h.state.attempts.set('1:1',h.state.runs[0]);
 h.state.jobs.set('1:1',[...Array.from({length:100},(_,i)=>job(100+i,{run_id:1,conclusion:'success'})),job()]);
 const result=await collect(h);assert.equal(result.occurrences.length,1);
 assert.ok(h.calls.some(([route,args])=>route.endsWith('/jobs') && args.page===2));
});
test('cancelled attempts and skipped jobs never contribute failure occurrences',async()=>{
 const h=harness();h.state.runs.push(run(2,{conclusion:'cancelled'}));h.state.attempts.set('2:1',run(2,{conclusion:'cancelled'}));h.state.jobs.set('2:1',[job(20)]);
 h.state.jobs.set('1:1',[job(10,{conclusion:'skipped'}),job(11,{conclusion:'cancelled'})]);
 const result=await collect(h);assert.equal(result.occurrences.length,0);
 assert.equal(h.calls.filter(([r])=>r.endsWith('/logs')).length,0);
});
test('reporting machinery is excluded but failures surface in operational summary',async()=>{
 const h=harness();h.state.runs[0]=run(1,{path:'.github/workflows/report-workflow-failure.yml'});
 const result=await collect(h);assert.equal(result.occurrences.length,0);assert.equal(result.manifest.reporterFailures,1);
});
test('the running sweep attempt is reporting machinery, never a coverage gap',async()=>{
 const h=harness();
 h.state.runs=[
  run(3,{name:'Sweep Recurring CI Failures',path:'.github/workflows/sweep-ci-failures.yml',status:'in_progress',conclusion:null}),
  h.state.runs[0],
 ];
 h.state.attempts.set('3:1',h.state.runs[0]);
 const result=await collect(h);
 assert.equal(result.occurrences.length,1);assert.equal(result.manifest.complete,true);
 assert.ok(!result.manifest.problems.some(p=>p.code==='attempt-in-progress'));
});
test('a default 14-day volume of failed jobs completes inside the log budget',async()=>{
 const h=harness();
 h.state.runs=Array.from({length:150},(_,i)=>run(i+1));
 for(const r of h.state.runs){h.state.attempts.set(`${r.id}:1`,r);h.state.jobs.set(`${r.id}:1`,[job(r.id*10)]);h.state.logs.set(r.id*10,h.state.logs.get(10));}
 const result=await collect(h);
 assert.equal(result.occurrences.length,150);assert.equal(result.manifest.complete,true);
 assert.ok(!result.manifest.problems.some(p=>p.code==='log-count-limit'));
});
test('expired logs remain recorded evidence gaps without failing the classified sweep',async()=>{
 const h=harness();h.state.logs.clear();
 const result=await collect(h);
 assert.equal(result.occurrences.length,1);assert.equal(result.manifest.complete,true);
 assert.ok(result.manifest.problems.some(p=>p.code==='logs-unavailable' && p.jobId===10));
});
test('second-page runs are discovered and duplicate job rows are counted once',async()=>{
 const h=harness();h.state.runs=Array.from({length:101},(_,i)=>run(i+1));
 for(const r of h.state.runs){h.state.attempts.set(`${r.id}:1`,r);h.state.jobs.set(`${r.id}:1`,[]);}
 h.state.jobs.set('101:1',[job(1010),job(1010)]);h.state.logs.set(1010,h.state.logs.get(10));
 const result=await collect(h);assert.equal(result.occurrences.length,1);assert.equal(result.occurrences[0].run.id,101);
});
test('search truncation splits the window and refuses unenumerable one-second buckets',async()=>{
 const h=harness(),original=h.github.request;
 h.github.request=async(route,args)=>route.endsWith('/actions/runs')?{data:{total_count:1000,workflow_runs:[]}}:original(route,args);
 const result=await collect(h,{requests:70});
 assert.equal(result.manifest.complete,false);assert.ok(result.manifest.problems.some(p=>p.code==='run-query-overflow'||p.code==='request-limit'));
 assert.ok(h.calls.length===0); // fixture delegation is unnecessary for overflowing run queries
});
test('missing attempt metadata and logs leave explicit gaps while independent runs still scan',async()=>{
 const h=harness();h.state.runs.push(run(2,{run_attempt:2}));h.state.logs.clear();
 const result=await collect(h);assert.equal(result.manifest.complete,false);assert.equal(result.occurrences.length,1);
 assert.ok(result.manifest.problems.some(p=>p.code==='attempt-unavailable' && p.runId===2));
 assert.ok(result.manifest.problems.some(p=>p.code==='logs-unavailable' && p.jobId===10));
 assert.doesNotMatch(JSON.stringify(result.manifest),/private|signed URL/);
});
test('attempt and request limits mark incomplete coverage rather than successful early exit',async()=>{
 const h=harness();h.state.runs[0]=run(1,{run_attempt:21});
 const result=await collect(h,{attempts:1});assert.equal(result.manifest.complete,false);
 assert.ok(result.manifest.problems.some(p=>p.code==='attempt-limit' && p.runId===1));
 const limited=await collect(h,{requests:1});assert.equal(limited.manifest.complete,false);
});
test('latest run-list metadata avoids redundant attempt requests within the bounded default budget',async()=>{
 const h=harness();const result=await collect(h,{requests:3});
 assert.equal(result.manifest.complete,true);assert.equal(result.occurrences.length,1);
 assert.equal(h.calls.filter(([r])=>r.endsWith('/attempts/{attempt_number}')).length,0);
});
test('duplicate run pages cannot hide a missing run while claiming complete coverage',async()=>{
 const h=harness(),original=h.github.request;h.state.runs=Array.from({length:101},(_,i)=>run(i+1));
 h.github.request=async(route,args)=>{
  if(route.endsWith('/actions/runs') && args.page===2)return {data:{total_count:101,workflow_runs:[run(100)]}};
  return original(route,args);
 };
 const result=await collect(h);assert.equal(result.manifest.complete,false);assert.ok(result.manifest.problems.some(p=>p.code==='run-query-incomplete'));
});
test('historical failures of the reporter remain visible after a successful retry',async()=>{
 const h=harness();const source=run(1,{path:'.github/workflows/report-workflow-failure.yml',run_attempt:2,conclusion:'success'});
 h.state.runs=[source];h.state.attempts.set('1:1',{...source,run_attempt:1,conclusion:'failure'});
 const result=await collect(h);assert.equal(result.occurrences.length,0);assert.equal(result.manifest.reporterFailures,1);assert.equal(result.manifest.processed.attempts.length,2);
});
test('mismatched historical SHA and malformed completed source timestamps are rejected',async()=>{
 const h=harness();h.state.runs=[run(1,{run_attempt:2,conclusion:'success'})];h.state.attempts.set('1:1',run(1,{head_sha:'f'.repeat(40)}));
 let result=await collect(h);assert.equal(result.occurrences.length,0);assert.equal(result.manifest.complete,false);
 const bad=harness();bad.state.runs=[run(1,{run_started_at:'not a timestamp'})];result=await collect(bad);assert.equal(result.occurrences.length,0);assert.equal(result.manifest.complete,false);
});
test('missing job source identity and invalid failure timestamps cannot enter evidence',async()=>{
 for(const change of [j=>{delete j.run_id;},j=>{delete j.run_attempt;},j=>{j.started_at='bad';},j=>{j.steps[0].started_at='bad';}]) {
  const h=harness();const j=job();change(j);h.state.jobs.set('1:1',[j]);const result=await collect(h);
  assert.equal(result.occurrences.length,0);assert.equal(result.manifest.complete,false);
 }
});
test('malformed steps do not abort independent run collection',async()=>{
 const h=harness();h.state.jobs.set('1:1',[{...job(),steps:{invalid:true}}]);
 h.state.runs.push(run(2));h.state.jobs.set('2:1',[job(20)]);h.state.logs.set(20,h.state.logs.get(10));
 const result=await collect(h);assert.equal(result.manifest.complete,false);assert.equal(result.occurrences.length,1);assert.equal(result.occurrences[0].run.id,2);
});
