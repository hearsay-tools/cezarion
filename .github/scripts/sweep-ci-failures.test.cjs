const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {harness,run,job}=require('./fixtures/sweep-harness.cjs');
const impl=fs.existsSync(__dirname+'/sweep-ci-failures.cjs')?require('./sweep-ci-failures.cjs'):{};
const now=()=>Date.parse('2026-09-10T04:23:00Z');
function recurring(h) {
 h.state.runs=[run(1),run(2),run(3)];
 for(const r of h.state.runs){h.state.attempts.set(`${r.id}:1`,r);h.state.jobs.set(`${r.id}:1`,[job(r.id*10)]);h.state.logs.set(r.id*10,h.state.logs.get(10));}
}
async function sweep(h,extra={}) {
 assert.equal(typeof impl.sweepCiFailures,'function','sweep orchestration implemented');
 return impl.sweepCiFailures({github:h.github,owner:'hearsay-tools',repo:'cezarion',now,...extra});
}
test('full sweep reports recurring causes and replay leaves evidence unchanged',async()=>{
 const h=harness();recurring(h);const m=await sweep(h);
 assert.equal(m.complete,true);assert.equal(m.start,'2026-08-27T04:23:00Z');assert.equal(m.end,'2026-09-10T04:23:00Z');
 assert.equal(m.patterns,1);assert.equal(m.reports.issues,1);assert.equal(m.reports.occurrences,3);
 assert.doesNotMatch(JSON.stringify(m),/handles input|AssertionError|head_sha/);
 const repeat=await sweep(h);assert.equal(repeat.reports.occurrences,0);assert.equal(h.state.comments.length,4);
});
test('manual replay validates a paired bounded creation window before API calls',async()=>{
 for(const extra of [{start:'2026-09-01T00:00:00Z'},{start:'not UTC',end:'2026-09-09T00:00:00Z'},{start:'2026-08-01T00:00:00Z',end:'2026-09-09T00:00:00Z'},{start:'2026-01-01T00:00:00Z',end:'2026-01-02T00:00:00Z'},{start:'2026-09-11T00:00:00Z',end:'2026-09-12T00:00:00Z'},{start:'2026-09-09T00:00:00Z',end:'2026-09-08T00:00:00Z'}]) {
  const h=harness();const m=await sweep(h,extra);assert.equal(m.complete,false);assert.equal(h.calls.length,0);assert.equal(m.problems[0].code,'invalid-window');
 }
 const h=harness();assert.equal((await sweep(h,{start:'2026-09-01T00:00:00Z',end:'2026-09-02T00:00:00Z'})).complete,true);
});
test('isolated development failure creates no issue and unavailable logs stay recorded gaps',async()=>{
 const h=harness();assert.equal((await sweep(h)).patterns,0);assert.equal(h.state.issues.length,0);
 h.state.logs.clear();const m=await sweep(h);assert.equal(m.complete,true);assert.equal(h.state.issues.length,0);
 assert.deepEqual(m.replay,[]);assert.ok(m.problems.some(p=>p.code==='logs-unavailable'));
});
test('successful latest run comparison can establish possible flakiness across two PRs',async()=>{
 const h=harness();recurring(h);h.state.runs.pop();
 const source={...h.state.runs[0],run_attempt:2,conclusion:'success'};h.state.runs[0]=source;h.state.attempts.set('1:2',source);
 h.state.jobs.set('1:2',[job(11,{run_attempt:2,conclusion:'success',steps:[{number:3,name:'Run tests',conclusion:'success'}]})]);
 const m=await sweep(h);assert.equal(m.patterns,1);assert.equal(m.reports.occurrences,2);assert.match(h.state.comments.at(-1).body,/Possible test flakiness/);
});
test('recurring infrastructure diagnostics are collected and labeled without claiming flaky tests',async()=>{
 const h=harness();recurring(h);
 for(const id of [10,20,30])h.state.logs.set(id,'npm error EAI_AGAIN: registry lookup temporarily unavailable');
 const m=await sweep(h);assert.equal(m.complete,true);assert.equal(m.patterns,1);assert.deepEqual(h.state.issues[0].labels,['area-ci']);
 assert.match(h.state.comments.at(-1).body,/Recurring failure/);assert.doesNotMatch(h.state.comments.at(-1).body,/Possible test flakiness/);
});
test('distinct tests in one failed step produce separate pattern reports',async()=>{
 const h=harness();recurring(h);
 for(const id of [10,20,30])h.state.logs.set(id,'FAIL packages/cezar/src/a.test.ts > handles input\nAssertionError: expected receipt\nFAIL packages/cezar/src/a.test.ts > handles startup\nError: waitFor timed out');
 const m=await sweep(h);assert.equal(m.patterns,2);assert.equal(m.reports.issues,2);assert.equal(m.reports.occurrences,6);
 await sweep(h);assert.equal(h.state.issues.length,2);assert.equal(h.state.comments.length,8);
});
test('failed jobs without step metadata cannot infer a recurring cause from the whole job log',async()=>{
 const h=harness();recurring(h);
 for(const r of h.state.runs)h.state.jobs.set(`${r.id}:1`,[job(r.id*10,{steps:[]})]);
 const m=await sweep(h);assert.equal(m.patterns,0);assert.equal(h.state.issues.length,0);
});
test('test FAIL lines without a diagnostic or complete test name do not qualify for sweep reports',async()=>{
 for(const log of ['FAIL packages/cezar/src/a.test.ts > handles input','FAIL packages/cezar/src/a.test.ts\nAssertionError: expected receipt']) {
  const h=harness();recurring(h);for(const id of [10,20,30])h.state.logs.set(id,log);
  const m=await sweep(h);assert.equal(m.patterns,0);assert.equal(h.state.issues.length,0);
 }
});
test('two diagnostics for one test in one step remain distinct source occurrences',async()=>{
 const h=harness();recurring(h);
 const log='FAIL packages/cezar/src/a.test.ts > handles input\nAssertionError: first\nFAIL packages/cezar/src/a.test.ts > handles input\nTypeError: second';
 for(const id of [10,20,30])h.state.logs.set(id,log);
 const m=await sweep(h);assert.equal(m.patterns,2);assert.equal(m.reports.issues,2);assert.equal(m.reports.occurrences,6);
});
test('manual replay accepts an inclusive single-second creation window',async()=>{
 const h=harness();h.state.runs=[];
 const instant='2026-09-01T00:00:00Z';
 const m=await sweep(h,{start:instant,end:instant});
 assert.equal(m.complete,true);assert.equal(m.start,instant);assert.equal(m.end,instant);
 assert.ok(h.calls.length>0);
});
test('every GitHub quota failure is counted, even below the recurrence threshold, and none is filed',async()=>{
 const h=harness();recurring(h);
 // Each run's request ID differs, so each line has its own signature and no
 // pattern recurs.
 for(const [id,request,at] of [[10,'08C0:1C9592:4FCCB:842A3:6AF6010B','18:10:19'],[20,'1440:4495E:83B2DE:1A20552:6AF6012D','18:10:53'],[30,'D078:25955F:A505FA:204CE77:6AF6013F','18:11:11']])
  h.state.logs.set(id,`##[error]API rate limit exceeded for installation. If you reach out to GitHub Support for help, please include the request ID ${request} and timestamp 2026-11-12 ${at} UTC.`);
 const m=await sweep(h);
 assert.equal(m.complete,true);assert.equal(m.patterns,0);
 assert.deepEqual(m.suppressed,{occurrences:3,runs:[1,2,3]});
 assert.equal(h.state.issues.length,0);assert.equal(h.state.comments.length,0);
});
test('quota counts survive a failed issue read',async()=>{
 const h=harness();recurring(h);
 // Runs 1-3 recur and need an issue read; run 4 failed on the quota only.
 const quotaRun=run(4);h.state.runs.push(quotaRun);h.state.attempts.set('4:1',quotaRun);h.state.jobs.set('4:1',[job(40)]);
 h.state.logs.set(40,'##[error]API rate limit exceeded for installation.');
 const request=h.github.request;
 h.github.request=async(route,args)=>{if(route==='GET /repos/{owner}/{repo}/issues')throw Object.assign(new Error('read failed'),{status:500});return request(route,args);};
 const m=await sweep(h);
 assert.equal(m.complete,false);assert.deepEqual(m.suppressed,{occurrences:1,runs:[4]});
});
const QUOTA_THEN_ERROR='##[error]API rate limit exceeded for installation.\nTypeError: build failed';
test('quota steps with another error are classified by that error, and the quota is still counted',async()=>{
 const h=harness();recurring(h);for(const id of [10,20,30])h.state.logs.set(id,QUOTA_THEN_ERROR);
 const m=await sweep(h);
 assert.equal(m.complete,true);assert.equal(m.patterns,1);assert.deepEqual(m.suppressed,{occurrences:3,runs:[1,2,3]});
 assert.equal(h.state.issues.length,1);assert.match(h.state.issues[0].body,/TypeError: build failed/);assert.doesNotMatch(h.state.issues[0].body,/rate limit/i);
 assert.equal(m.reports.occurrences,3);
});
test('a step the pre-change reporter recorded under its quota cause keeps that report',async()=>{
 const {causesForStep}=require('./failure-diagnostics.cjs');
 const {defaultBodyFor,commentFor}=require('./failure-issue-writer.cjs');
 const h=harness();recurring(h);for(const id of [10,20,30])h.state.logs.set(id,QUOTA_THEN_ERROR);
 // Run 1 was reported by the pre-change reporter: main's selection, the quota line.
 const r=run(1),j=job(10),step=j.steps[0],runUrl=`https://github.com/hearsay-tools/cezarion/actions/runs/1/attempts/1`;
 const {independentCause,...quota}=causesForStep({run:r,job:j,step,log:QUOTA_THEN_ERROR})[0];
 assert.ok(independentCause);
 const signature=`<!-- cez-failure-signature:v1:${quota.signature} -->`,occurrence=`<!-- cez-failure-occurrence:v1:1:1:10:${step.number}:${quota.signature} -->`;
 h.state.issues.push({number:1,state:'open',title:'[Task]: Investigate verification failure',body:defaultBodyFor({cause:quota,runUrl,signature,occurrence})});
 h.state.comments.push({id:1,issue_number:1,body:commentFor({cause:quota,run:r,job:j,step,runUrl,jobUrl:'https://github.com/hearsay-tools/cezarion/actions/runs/1/job/10',occurrence})});
 const m=await sweep(h);
 assert.equal(m.complete,true);assert.equal(m.patterns,1);
 // Runs 2 and 3 file the TypeError; run 1 keeps its quota report untouched.
 assert.equal(h.state.issues.length,2);assert.match(h.state.issues[1].body,/TypeError: build failed/);
 assert.equal(m.reports.occurrences,2);
 assert.deepEqual(h.state.comments.filter(c=>c.issue_number===1).map(c=>c.id),[1]);
});
