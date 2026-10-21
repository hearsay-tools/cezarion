const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./fixtures/release-failure.json');
const {reportFailure} = require('./report-workflow-failure.cjs');
const {harness,nightly,stopped,TIME_LIMIT}=require('./fixtures/failure-harness.cjs');
test('Release fixture creates actionable issue and durable metadata comment, skipping dependent release',async()=>{
 const h=harness(); await reportFailure(h.options);
 assert.equal(h.state.issues.length,1);assert.equal(h.state.comments.length,1);
 assert.deepEqual(h.state.issues[0].labels,['area-ci']);
 assert.equal(h.state.issues[0].title,'[Task]: Investigate delegation-integration.test.ts failure');
 assert.match(h.state.issues[0].body,/Acceptance Criteria/);
 assert.match(h.state.comments[0].body,/34473233122.*attempts\/1/);
 assert.match(h.state.comments[0].body,/Run server and cockpit unit suites/);
 assert.match(h.state.comments[0].body,/AssertionError/);
 assert.match(h.state.comments[0].body,/verification/);
});
test('Nightly verification matches existing Release cause; publishing is separate',async()=>{
 const h=harness(); await reportFailure(h.options);nightly(h);await reportFailure(h.options);
 assert.equal(h.state.issues.length,1);assert.equal(h.state.comments.length,2);
 nightly(h,true);await reportFailure(h.options);assert.equal(h.state.issues.length,2);
 assert.match(h.state.comments.at(-1).body,/publishing/);
});
test('repeated delivery, retry after closure and a genuine closed recurrence are distinguished',async()=>{
 const h=harness();await reportFailure(h.options);await reportFailure(h.options);
 assert.equal(h.state.comments.length,1);
 h.state.issues[0].state='closed';await reportFailure(h.options);assert.equal(h.state.issues.length,1);
 h.state.run.run_attempt=2;h.options.event.workflow_run.run_attempt=2;
 await reportFailure(h.options);assert.equal(h.state.issues.length,2);assert.match(h.state.issues[1].body,/issues\/1/);
});
test('partial issue creation repairs its missing comment on retry',async()=>{
 const h=harness();h.state.failComment=true;await assert.rejects(reportFailure(h.options));
 assert.equal(h.state.issues.length,1);assert.equal(h.state.comments.length,0);
 await reportFailure(h.options);assert.equal(h.state.issues.length,1);assert.equal(h.state.comments.length,1);
});
test('missing logs still report metadata, isolate causes and never print API error text',async()=>{
 const h=harness();h.state.log=null;await reportFailure(h.options);
 assert.equal(h.state.issues.length,1);assert.match(h.state.comments[0].body,/unavailable/i);
 assert.doesNotMatch(h.messages.join('\n'),/secret/);
 h.state.run.id++;h.options.event.workflow_run.id++;await reportFailure(h.options);assert.equal(h.state.issues.length,2);
});
test('ignore success, skipped, unrelated workflows and foreign repositories without API calls',async()=>{
 for(const patch of [{conclusion:'success'},{conclusion:'skipped'},{name:'CI'},{path:'.github/workflows/ci.yml'},{head_repository:{full_name:'attacker/repo'}},{head_branch:'feature/not-release'}]) {
 const h=harness();Object.assign(h.options.event.workflow_run,patch);await reportFailure(h.options);assert.equal(h.calls.length,0);
 }
});
// Actions records a job stopped by `timeout-minutes` as `cancelled`, the same
// conclusion a person or a concurrency group leaves (hearsay-tools/cezarion#1272).
test('a job stopped at its time limit reports a timeout with the last output before the stop',async()=>{
 const h=harness();stopped(h);const result=await reportFailure(h.options);
 assert.equal(result.reported,1);assert.equal(h.state.issues.length,1);
 assert.equal(h.state.issues[0].title,'[Task]: Investigate verification timeout');
 assert.deepEqual(h.state.issues[0].labels,['area-ci']);
 assert.match(h.state.issues[0].body,/Verify before publishing exceeded the job time limit/);
 assert.match(h.state.comments[0].body,/exceeded the maximum execution time of 20m0s/);
 assert.match(h.state.comments[0].body,/keeps the claim across recovery/);
 assert.match(h.state.comments[0].body,/Failed step: Verify before publishing/);
});
test('a run cancelled by a person or by concurrency files nothing',async()=>{
 for(const annotation of ['The operation was canceled.','Canceling since a higher priority waiting request for nightly exists']) {
  const h=harness();stopped(h,annotation);const result=await reportFailure(h.options);
  assert.equal(result.reported,0);assert.equal(h.state.issues.length,0);assert.equal(h.state.comments.length,0);
  assert.ok(!h.calls.some(([route])=>route.startsWith('POST ')));
 }
});
test('the same timeout on a later night comments on the open issue',async()=>{
 const h=harness();stopped(h);await reportFailure(h.options);
 h.state.run.id++;h.options.event.workflow_run.id++;await reportFailure(h.options);
 assert.equal(h.state.issues.length,1);assert.equal(h.state.comments.length,2);
});
test('a timed-out job beside a failed one reports both',async()=>{
 const h=harness(), failed=h.state.jobs[0];
 h.state.jobs.push({...structuredClone(failed),id:failed.id+1,name:'Vitest shard 2/3',conclusion:'cancelled',
  steps:failed.steps.map(step=>step.conclusion==='failure'?{...step,conclusion:'cancelled'}:step)});
 h.state.annotations={[failed.id+1]:[{annotation_level:'failure',message:TIME_LIMIT}]};
 await reportFailure(h.options);
 assert.deepEqual(h.state.issues.map(issue=>issue.title).sort(),['[Task]: Investigate delegation-integration.test.ts failure','[Task]: Investigate verification timeout']);
});
test('metadata and issue API failures propagate so workflow can fail visibly',async()=>{
 for(const flag of ['failRead','failCreate']) {const h=harness();h.state[flag]=true;await assert.rejects(reportFailure(h.options));assert.equal(h.state.comments.length,0);}
});

test('job log downloads omit credentials, enforce byte cap and reject redirects',async()=>{
 const {downloadLog}=require('./report-workflow-failure.cjs');
 const github={request:async(route,args)=>{assert.equal(args.request.redirect,'manual');return {headers:{location:'https://logs.example.test/signed?sig=value'}};}};
 let cancelled=false;
 const fetchImpl=async(url,options)=>{
   assert.equal(options.redirect,'error');assert.equal(options.headers,undefined);
   return {ok:true,body:{getReader:()=>({read:async()=>({done:false,value:new Uint8Array(2*1024*1024+1)}),cancel:async()=>{cancelled=true;}})}};
 };
 await assert.rejects(downloadLog(github,{},fetchImpl),/limit/);assert.equal(cancelled,true);
});
test('changed log availability on duplicate delivery does not create a second report',async()=>{
 const h=harness();h.state.log=null;await reportFailure(h.options);h.state.log=fixture.log;
 await reportFailure(h.options);assert.equal(h.state.issues.length,1);assert.equal(h.state.comments.length,1);
});
test('a lost response after a persisted comment is safe to retry',async()=>{
 const h=harness(), original=h.options.github.request;let lose=true;
 h.options.github.request=async(route,args)=>{const result=await original(route,args);if(lose && route.startsWith('POST ') && route.endsWith('/comments')){lose=false;throw new Error('connection lost');}return result;};
 await assert.rejects(reportFailure(h.options));await reportFailure(h.options);
 assert.equal(h.state.issues.length,1);assert.equal(h.state.comments.length,1);
});
test('Release maintenance branch is eligible and a failed job without steps still reports',async()=>{
 const h=harness();h.state.run.head_branch='release/0.9.x';h.options.event.workflow_run.head_branch='release/0.9.x';h.state.jobs[0].steps=[];
 await reportFailure(h.options);assert.equal(h.state.issues.length,1);assert.match(h.state.comments[0].body,/before a step was recorded/);
});
test('same run event keeps exact historical attempt even when latest run has moved on',async()=>{
 const h=harness();await reportFailure(h.options);
 assert.ok(h.calls.some(([r,a])=>r.endsWith('/attempts/{attempt_number}') && a.attempt_number===1));
 assert.ok(!h.calls.some(([r])=>r.endsWith('/runs/{run_id}')));
});
test('JSON credentials in diagnostic context never persist to GitHub',async()=>{
 const h=harness();h.state.log='FAIL src/security.test.ts > checks output\nError: failed\n"token": "a-short-private-value"\n"api_key": "another-private-value"';
 await reportFailure(h.options);assert.equal(h.state.comments.length,1);
 assert.doesNotMatch(JSON.stringify(h.state.issues)+JSON.stringify(h.state.comments),/a-short-private-value|another-private-value/);
});
test('two distinct long test paths in one job create separate reports',async()=>{
 const h=harness();h.state.log='FAIL src/server/very-long-component-integration-alpha.test.ts > handles input\nError: bad\nFAIL src/server/very-long-component-integration-bravo.test.ts > handles input\nError: bad';
 await reportFailure(h.options);assert.equal(h.state.issues.length,2);assert.equal(h.state.comments.length,2);
});
test('repairing an unknown reservation keeps available diagnostic evidence',async()=>{
 const h=harness();h.state.log='src/index.ts(12,3): error TS2307: Cannot find module x';h.state.failComment=true;
 await assert.rejects(reportFailure(h.options));await reportFailure(h.options);
 assert.equal(h.state.issues.length,1);assert.match(h.state.comments[0].body,/TS2307/);
});
function mainCi(h, patch={}) {
 Object.assign(h.state.run,{name:'CI',path:'.github/workflows/ci.yml',head_branch:'main',event:'push'},patch);
 h.options.event.workflow_run=structuredClone(h.state.run);
}
test('main push CI routes only after evidence and repairs routing after retry',async()=>{
 const h=harness();mainCi(h);h.state.failComment=true;
 await assert.rejects(reportFailure(h.options));
 assert.ok(!h.calls.some(([route])=>route.endsWith('/labels')));
 await reportFailure(h.options);
 const comment=h.calls.findLastIndex(([route])=>route==='POST /repos/{owner}/{repo}/issues/{issue_number}/comments');
 const label=h.calls.findLastIndex(([route])=>route==='POST /repos/{owner}/{repo}/issues/{issue_number}/labels');
 assert.ok(label>comment);assert.deepEqual(h.calls[label][1].labels,['main-ci-failure']);
 assert.match(h.state.issues[0].body,/workflow run/);
});
test('CI accepts only same-repository main pushes',async()=>{
 for(const patch of [{event:'pull_request_target'},{event:'workflow_dispatch'},{event:undefined},{head_branch:'release/x'},{head_repository:{full_name:'foreign/repo'}}]) {
  const h=harness();mainCi(h,patch);await reportFailure(h.options);assert.equal(h.calls.length,0);
 }
});
test('cancelled main CI retains completed failed jobs but ignores cancellation alone',async()=>{
 const h=harness();mainCi(h,{conclusion:'cancelled'});await reportFailure(h.options);
 assert.ok(h.state.issues.length>0);
 const empty=harness();mainCi(empty,{conclusion:'cancelled'});empty.state.jobs=[];
 await reportFailure(empty.options);assert.equal(empty.state.issues.length,0);
});
// A newer main push cancels the run; the `always()` gate then starts, reads
// its cancelled needs and fails (hearsay-tools/cezarion#1442).
test('cancelled main CI ignores failures that start after the cancellation',async()=>{
 const h=harness(), failed=h.state.jobs[0];mainCi(h,{conclusion:'cancelled'});
 const cancelled={...structuredClone(failed),id:failed.id+1,name:'Vitest shard 1/3',conclusion:'cancelled',
  started_at:'2026-09-10T11:50:00Z',completed_at:'2026-09-10T11:54:00Z',
  steps:failed.steps.map(step=>step.conclusion==='failure'?{...step,conclusion:'cancelled'}:step)};
 const gate={...structuredClone(failed),id:failed.id+2,name:'Unit, build, E2E, and package',
  started_at:'2026-09-10T11:54:05Z',completed_at:'2026-09-10T11:54:09Z',
  steps:[{number:2,name:'Require every verification job',conclusion:'failure',started_at:'2026-09-10T11:54:06Z',completed_at:'2026-09-10T11:54:06Z'}]};
 h.state.jobs.push(cancelled,gate);h.state.annotations={[cancelled.id]:[{annotation_level:'failure',message:'The operation was canceled.'}]};
 const result=await reportFailure(h.options);
 assert.equal(result.reported,1);
 assert.deepEqual(h.state.issues.map(issue=>issue.title),['[Task]: Investigate delegation-integration.test.ts failure']);
 assert.ok(!h.state.comments.some(comment=>/Require every verification job/.test(comment.body)));
 h.state.jobs=[cancelled,gate];h.state.run.id++;h.options.event.workflow_run.id++;
 assert.equal((await reportFailure(h.options)).reported,0);assert.equal(h.state.issues.length,1);
});
test('a time limit is not the cancellation: a later failure still reports',async()=>{
 const h=harness(), failed=h.state.jobs[0];mainCi(h,{conclusion:'cancelled'});
 h.state.jobs.unshift({...structuredClone(failed),id:failed.id+1,name:'Vitest shard 2/3',conclusion:'cancelled',
  started_at:'2026-09-10T11:40:00Z',completed_at:'2026-09-10T11:45:00Z',
  steps:failed.steps.map(step=>step.conclusion==='failure'?{...step,conclusion:'cancelled'}:step)});
 h.state.annotations={[failed.id+1]:[{annotation_level:'failure',message:TIME_LIMIT}]};
 assert.equal((await reportFailure(h.options)).reported,2);
});

test('routing failure retries without duplicating saved evidence or routing closed reports',async()=>{
 const h=harness();mainCi(h);h.state.failLabel=true;
 await assert.rejects(reportFailure(h.options));
 assert.equal(h.state.comments.length,1);
 await reportFailure(h.options);assert.equal(h.state.comments.length,1);
 const count=h.calls.filter(([route])=>route.endsWith('/labels')).length;
 assert.equal(count,2);
 h.state.issues[0].state='closed';await reportFailure(h.options);
 assert.equal(h.calls.filter(([route])=>route.endsWith('/labels')).length,count);
});
