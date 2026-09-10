const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {harness,run,job}=require('./fixtures/sweep-harness.cjs');
const {createSweepApi}=require('./ci-sweep-api.cjs');
const {causesForStep}=require('./failure-diagnostics.cjs');
const impl=fs.existsSync(__dirname+'/ci-sweep-report.cjs')?require('./ci-sweep-report.cjs'):{};
const start='2026-09-01T00:00:00Z',end='2026-09-10T00:00:00Z';
function pattern(h,ids=[1,2,3]) {
 const occurrences=ids.map(id=>{
  const r=run(id),j=job(id*10),step=j.steps[0];
  return {run:r,job:j,step,cause:{...causesForStep({run:r,job:j,step,log:h.state.logs.get(10)})[0],kind:'test',testFile:'packages/cezar/src/a.test.ts',testIdentity:'packages/cezar/src/a.test.ts > handles input'}};
 });
 return {cause:occurrences[0].cause,occurrences,comparisons:[],classification:'recurring-failure',counts:{failures:3,runs:3,shas:3,contexts:3}};
}
async function report(h,patterns=[pattern(h)],limits={}) {
 assert.equal(typeof impl.reportPatterns,'function','pattern reporting implemented');
 const api=createSweepApi({github:h.github,limits});
 await impl.reportPatterns({api,owner:'hearsay-tools',repo:'cezarion',patterns,start,end});
 return api.manifest;
}
test('qualifying pattern records evidence and counts once across overlapping sweeps',async()=>{
 const h=harness();let m=await report(h);
 assert.equal(h.state.issues.length,1);assert.deepEqual(h.state.issues[0].labels,['area-cezar']);
 assert.equal(h.state.comments.length,4);assert.equal(m.reports.occurrences,3);
 const summary=h.state.comments.find(c=>c.body.includes('cez-sweep-summary'));
 assert.match(summary.body,/3 failure occurrences/);assert.match(summary.body,/CI/);assert.match(summary.body,/does not establish flakiness/i);
 const before=h.calls.filter(([r])=>!r.startsWith('GET ')).length;
 m=await report(h);assert.equal(h.state.comments.length,4);assert.equal(m.reports.occurrences,0);
 assert.equal(h.calls.filter(([r])=>!r.startsWith('GET ')).length,before);
});
test('exact test identity plus linked evidence adopts existing remediation issue and preserves body',async()=>{
 const h=harness();h.state.issues=[{number:195,state:'open',title:'Existing repair',body:'Maintainer requirements remain intact.'}];
 h.state.comments=[{id:1,issue_number:195,body:'Test: handles input\nFile: packages/cezar/src/a.test.ts\nhttps://github.com/hearsay-tools/cezarion/actions/runs/1/attempts/1'}];
 await report(h);assert.equal(h.state.issues.length,1);assert.match(h.state.issues[0].body,/Maintainer requirements remain intact/);assert.match(h.state.issues[0].body,/cez-failure-signature/);
});
test('suite mention without exact test or corroborating occurrence does not adopt an unrelated issue',async()=>{
 const h=harness();h.state.issues=[{number:195,state:'open',body:'packages/cezar/src/a.test.ts has flaky tests'}];
 await report(h);assert.equal(h.state.issues.length,2);
});
test('ambiguous remediation owners are visible and create no duplicate report',async()=>{
 const h=harness();const body='packages/cezar/src/a.test.ts\nTest: handles input\nhttps://github.com/hearsay-tools/cezarion/actions/runs/1/attempts/1';
 h.state.issues=[{number:195,state:'open',body},{number:196,state:'open',body}];
 const m=await report(h);assert.equal(h.state.issues.length,2);assert.equal(h.state.comments.length,0);assert.equal(m.complete,false);assert.ok(m.problems.some(p=>p.code==='ambiguous-owner'));
});
test('closed reports receive no duplicate recurrence but later failures create a linked issue',async()=>{
 const h=harness();await report(h);h.state.issues[0].state='closed';
 await report(h);assert.equal(h.state.issues.length,1);
 await report(h,[pattern(h,[4,5,6])]);assert.equal(h.state.issues.length,2);assert.match(h.state.issues[1].body,/Previous closed report.*issues\/1/);
});
test('partial issue pagination aborts before any write and write failures are safe to replay',async()=>{
 const h=harness();const original=h.github.request;
 h.github.request=async(route,args)=>{
  if(route==='GET /repos/{owner}/{repo}/issues') {if(args.page===1)return {data:Array.from({length:100},(_,i)=>({number:i+1,state:'open',body:''}))};throw new Error('private read failure');}
  return original(route,args);
 };
 const m=await report(h);assert.equal(m.complete,false);assert.equal(h.calls.filter(([r])=>!r.startsWith('GET ')).length,0);
 const retry=harness(),request=retry.github.request;let once=true;
 retry.github.request=async(route,args)=>{const response=await request(route,args);if(route==='POST /repos/{owner}/{repo}/issues'&&once){once=false;throw new Error('secret lost response');}return response;};
 const failed=await report(retry);assert.equal(failed.complete,false);assert.doesNotMatch(JSON.stringify(failed),/secret/);
 await report(retry);assert.equal(retry.state.issues.length,1);assert.equal(retry.state.comments.length,4);
});
test('write volume bounds remain incomplete until replay records remaining occurrences',async()=>{
 const h=harness();const m=await report(h,undefined,{occurrences:1});assert.equal(m.complete,false);assert.equal(h.state.issues.length,1);assert.equal(h.state.comments.filter(c=>c.body.includes('cez-failure-occurrence')).length,1);
 await report(h);assert.equal(h.state.issues.length,1);assert.equal(h.state.comments.filter(c=>c.body.includes('cez-failure-occurrence')).length,3);
});
test('missing diagnosed area label falls back to area-ci',async()=>{
 const h=harness();h.state.labels=['area-ci'];await report(h);assert.deepEqual(h.state.issues[0].labels,['area-ci']);
});
test('immediate reporter and serialized sweep deliveries share durable occurrence history',async()=>{
 const h=harness();const source=run(1,{name:'Release',path:'.github/workflows/release.yml',head_branch:'main'});h.state.attempts.set('1:1',source);
 const api=createSweepApi({github:h.github});
 await require('./report-workflow-failure.cjs').reportFailure({github:api,owner:'hearsay-tools',repo:'cezarion',event:{action:'completed',workflow_run:source}});
 assert.equal(h.state.issues.length,1);assert.equal(h.state.comments.length,1);
 // Actions uses the same global queue for these invocations; each writer
 // instance reloads durable API state rather than sharing a JS lock.
 let queue=Promise.resolve();const enqueue=()=>{const result=queue.then(()=>report(h));queue=result;return result;};
 await Promise.all([enqueue(),enqueue()]);
 assert.equal(h.state.issues.length,1);assert.equal(h.state.comments.filter(c=>c.body.includes('cez-failure-occurrence')).length,3);
 assert.equal(h.state.comments.filter(c=>c.body.includes('cez-sweep-summary')).length,1);
 assert.deepEqual(h.state.issues[0].labels,['area-ci']);
});
test('longer filenames and test names cannot satisfy exact remediation identity',async()=>{
 for(const identity of ['packages/cezar/src/a.test.ts.backup\nTest: handles input','packages/cezar/src/a.test.ts\nTest: handles input with malformed headers']) {
  const h=harness();h.state.issues=[{number:195,state:'open',body:identity+'\nhttps://github.com/hearsay-tools/cezarion/actions/runs/1/attempts/1'}];
  const original=h.state.issues[0].body;await report(h);assert.equal(h.state.issues.length,2);assert.equal(h.state.issues[0].body,original);
 }
});
test('successful issue creation remains counted when its first evidence write fails',async()=>{
 const h=harness(),original=h.github.request;
 h.github.request=async(route,args)=>{if(route==='POST /repos/{owner}/{repo}/issues/{issue_number}/comments')throw new Error('temporary failure');return original(route,args);};
 const m=await report(h);assert.equal(m.complete,false);assert.equal(h.state.issues.length,1);assert.equal(m.reports.issues,1);
});
