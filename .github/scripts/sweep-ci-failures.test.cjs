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
