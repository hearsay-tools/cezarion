const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./fixtures/release-failure.json');
const {reportFailure} = require('./report-workflow-failure.cjs');
const {harness,nightly}=require('./fixtures/failure-harness.cjs');
test('Release fixture creates actionable issue and durable metadata comment, skipping dependent release',async()=>{
 const h=harness(); await reportFailure(h.options);
 assert.equal(h.state.issues.length,1);assert.equal(h.state.comments.length,1);
 assert.deepEqual(h.state.issues[0].labels,['area-ci']);
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
test('ignore success, cancellation, skipped, unrelated workflows and foreign repositories without API calls',async()=>{
 for(const patch of [{conclusion:'success'},{conclusion:'cancelled'},{conclusion:'skipped'},{name:'CI'},{path:'.github/workflows/ci.yml'},{head_repository:{full_name:'attacker/repo'}},{head_branch:'feature/not-release'}]) {
 const h=harness();Object.assign(h.options.event.workflow_run,patch);await reportFailure(h.options);assert.equal(h.calls.length,0);
 }
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
