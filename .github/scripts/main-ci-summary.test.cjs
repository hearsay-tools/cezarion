const test = require('node:test');
const assert = require('node:assert/strict');
const {reportFailure} = require('./report-workflow-failure.cjs');
const {harness} = require('./fixtures/failure-harness.cjs');

function mainCi() {
  const h=harness();
  Object.assign(h.state.run,{name:'CI',path:'.github/workflows/ci.yml',event:'push'});
  h.options.event.workflow_run=structuredClone(h.state.run);
  h.state.log=' FAIL  server  src/ci-wait/controller.test.ts > rejects oversized input\nError: read ECONNRESET\n FAIL  server  src/ci-wait/mcp.test.ts > schedule instructions\nAssertionError: unexpected context';
  return h;
}
const summaries=h=>h.state.issues.filter(i=>i.body.includes('<!-- cez-main-ci-attempt:v1:'));
const routed=h=>h.calls.filter(([route])=>route.endsWith('/labels')).map(([,args])=>args.issue_number);

test('two different failures save both reports before routing one complete attempt summary',async()=>{
  const h=mainCi(), request=h.options.github.request;
  h.options.github.request=async(route,args)=>{
    if(route.endsWith('/labels')) {
      const summary=h.state.issues.find(i=>i.number===args.issue_number);
      assert.ok(summary.body.includes('<!-- cez-main-ci-attempt:v1:hearsay-tools/cezarion:34473233122:1 -->'), 'route an attempt summary, never an individual failure');
      const reports=h.state.issues.filter(i=>i!==summary);
      assert.equal(reports.length,2);
      for(const report of reports) {
        assert.ok(summary.body.includes(`https://github.com/hearsay-tools/cezarion/issues/${report.number}`));
        assert.ok(h.state.comments.some(c=>c.issue_number===report.number),'occurrence committed before routing');
      }
      assert.ok(summary.body.includes(h.state.run.head_sha));
    }
    return request(route,args);
  };
  await reportFailure(h.options);
  assert.equal(summaries(h).length,1);
  assert.deepEqual(routed(h),[3]);
});

test('failure while saving a later occurrence routes nothing; retry completes the summary',async()=>{
  const h=mainCi(), request=h.options.github.request;let comments=0;
  h.options.github.request=async(route,args)=>{
    if(route.endsWith('/comments') && route.startsWith('POST') && ++comments===2) throw new Error('interrupted second occurrence');
    return request(route,args);
  };
  await assert.rejects(reportFailure(h.options),/second occurrence/);
  assert.deepEqual(routed(h),[]);
  assert.equal(summaries(h).length,0);
  await reportFailure(h.options);
  assert.equal(summaries(h).length,1);
  assert.equal(h.state.comments.length,2);
  assert.deepEqual(routed(h),[3]);
});

test('lost summary-create response and label failure recover from committed issues without duplicate evidence',async()=>{
  const h=mainCi(), request=h.options.github.request;let interrupted=false;
  h.options.github.request=async(route,args)=>{
    const result=await request(route,args);
    if(route==='POST /repos/{owner}/{repo}/issues' && args.body.includes('cez-main-ci-attempt:') && !interrupted) {
      interrupted=true;throw new Error('response lost after commit');
    }
    return result;
  };
  await assert.rejects(reportFailure(h.options),/response lost/);
  assert.equal(summaries(h).length,1);
  assert.equal(h.state.comments.length,2);
  assert.deepEqual(routed(h),[]);
  h.state.failLabel=true;
  await assert.rejects(reportFailure(h.options));
  await reportFailure(h.options);
  await reportFailure(h.options);
  assert.equal(h.state.issues.length,3);
  assert.equal(h.state.comments.length,2);
  assert.ok(routed(h).every(n=>n===3));
});

test('closed summary stays closed on replay; a new attempt reuses signatures and gets its own summary',async()=>{
  const h=mainCi();await reportFailure(h.options);
  const summary=summaries(h)[0];assert.ok(summary);
  summary.state='closed';h.calls.length=0;
  await reportFailure(h.options);
  assert.deepEqual(routed(h),[]);
  assert.equal(h.state.issues.length,3);
  h.state.run.run_attempt=2;h.options.event.workflow_run=structuredClone(h.state.run);
  await reportFailure(h.options);
  assert.equal(summaries(h).length,2);
  assert.equal(h.state.issues.length,4);
  assert.deepEqual(routed(h),[4]);
  assert.equal(h.state.comments.length,4);
});

test('cancelled attempt with no eligible failures creates no summary and no route',async()=>{
  const h=mainCi();h.state.jobs=[];
  h.state.run.conclusion='cancelled';h.options.event.workflow_run=structuredClone(h.state.run);
  await reportFailure(h.options);
  assert.equal(h.state.issues.length,0);assert.deepEqual(routed(h),[]);
});

test('an incomplete saved manifest is rejected rather than routing a subset of failures',async()=>{
  const h=mainCi();await reportFailure(h.options);
  const summary=summaries(h)[0];assert.ok(summary);
  summary.body=summary.body.replace('https://github.com/hearsay-tools/cezarion/issues/2','https://github.com/hearsay-tools/cezarion/issues/999');
  h.calls.length=0;
  await assert.rejects(reportFailure(h.options),/summary/i);
  assert.deepEqual(routed(h),[]);
});

test('a later failed job cannot leave an earlier report routed before the full attempt is saved',async()=>{
  const h=mainCi(), request=h.options.github.request;
  h.state.jobs.push({...structuredClone(h.state.jobs[0]),id:h.state.jobs[0].id+1});
  let comments=0;
  h.options.github.request=async(route,args)=>{
    if(route.endsWith('/comments') && route.startsWith('POST') && ++comments===3) throw new Error('later job interrupted');
    return request(route,args);
  };
  await assert.rejects(reportFailure(h.options),/later job/);
  assert.equal(h.state.comments.length,2);
  assert.deepEqual(routed(h),[]);
  await reportFailure(h.options);
  assert.equal(h.state.comments.length,4);
  assert.equal(summaries(h).length,1);
  assert.deepEqual(routed(h),[3]);
});

test('summary list includes closed reports whose saved occurrence belongs to this attempt',async()=>{
  const h=mainCi();await reportFailure(h.options);
  h.state.issues[0].state='closed';h.calls.length=0;
  await reportFailure(h.options);
  assert.deepEqual(routed(h),[3]);
  assert.ok(summaries(h)[0].body.includes('https://github.com/hearsay-tools/cezarion/issues/1'));
});

test('a manifest that exceeds the body limit fails before creating or routing a partial summary',async()=>{
  const {routeMainCiSummary}=require('./main-ci-summary.cjs');
  const h=mainCi();
  await assert.rejects(routeMainCiSummary({...h.options,run:h.state.run,issues:[],reports:Array.from({length:2000},(_,i)=>({number:i+1}))}),/limit/);
  assert.equal(h.state.issues.length,0);assert.deepEqual(routed(h),[]);
});

test('retry with expired logs retains the saved member list and deduplicates reports repeated across jobs',async()=>{
  const h=mainCi();
  h.state.jobs.push({...structuredClone(h.state.jobs[0]),id:h.state.jobs[0].id+1});
  await reportFailure(h.options);
  assert.equal(h.state.issues.length,3);
  assert.equal(h.state.comments.length,4);
  const saved=summaries(h)[0].body;
  assert.equal((saved.match(/^- \[hearsay-tools\/cezarion#/gm)||[]).length,2);
  h.state.log=null;await reportFailure(h.options);
  assert.equal(h.state.issues.length,3);assert.equal(h.state.comments.length,4);
  assert.equal(summaries(h)[0].body,saved);
});
