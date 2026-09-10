const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const yaml=require('yaml');
const {harness}=require('./fixtures/sweep-harness.cjs');
const workflowPath=path.resolve(__dirname,'../workflows/sweep-ci-failures.yml');
function workflow(){assert.equal(fs.existsSync(workflowPath),true,'scheduled workflow implemented');return yaml.parse(fs.readFileSync(workflowPath,'utf8'));}
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
async function execute(h,inputs={}) {
 const w=workflow(),step=w.jobs.sweep.steps.find(s=>s.uses?.startsWith('actions/github-script@'));
 const written={},summary=[],errors=[];
 const core={info:()=>{},setFailed:m=>errors.push(m),summary:{addRaw:m=>{summary.push(m);return core.summary;},write:async()=>{}}};
 const fakeRequire=p=>p==='node:fs'?{writeFileSync:(name,body)=>{written[name]=body;}}:require(path.resolve(__dirname,'../..',p));
 await new AsyncFunction('require','github','context','core',step.with.script)(fakeRequire,h.github,{repo:{owner:'hearsay-tools',repo:'cezarion'},payload:{inputs}},core);
 return {written,summary,errors};
}
test('scheduled/manual workflow uses trusted checkout and the immediate reporter concurrency lock',()=>{
 const w=workflow(),immediate=yaml.parse(fs.readFileSync(path.resolve(__dirname,'../workflows/report-workflow-failure.yml'),'utf8'));
 assert.deepEqual(w.on.schedule,[{cron:'23 4 * * *'}]);assert.ok(w.on.workflow_dispatch.inputs.start);assert.ok(w.on.workflow_dispatch.inputs.end);
 assert.deepEqual(w.permissions,{});assert.deepEqual(w.jobs.sweep.permissions,{actions:'read',contents:'read',issues:'write'});
 assert.deepEqual(w.concurrency,immediate.concurrency);
 const checkout=w.jobs.sweep.steps.find(s=>s.uses?.startsWith('actions/checkout@'));
 assert.equal(checkout.with.ref,'${{ github.sha }}');assert.equal(checkout.with['persist-credentials'],false);
 assert.match(w.jobs.sweep.if,/github\.ref.*github\.event\.repository\.default_branch/);
 const artifact=w.jobs.sweep.steps.find(s=>s.uses?.startsWith('actions/upload-artifact@'));
 assert.equal(artifact.if,'always()');assert.equal(artifact.with['retention-days'],90);
});
test('entrypoint writes safe coverage and fails for incomplete collection',async()=>{
 const h=harness();h.github.request=async()=>{throw Object.assign(new Error('Authorization: private raw response'),{status:429});};
 const result=await execute(h);assert.equal(result.errors.length,1);
 const manifest=JSON.parse(result.written['ci-sweep-coverage.json']);assert.equal(manifest.complete,false);assert.ok(manifest.problems.length);
 assert.doesNotMatch(JSON.stringify(result),/private raw|Authorization/);assert.match(result.summary.join(''),/incomplete/i);
});
test('entrypoint rejects arbitrary manual input without printing it or making requests',async()=>{
 const h=harness();const result=await execute(h,{start:'$(echo private-input)',end:'2026-09-09T00:00:00Z'});
 assert.equal(result.errors.length,1);assert.equal(h.calls.length,0);assert.doesNotMatch(JSON.stringify(result),/private-input/);
});
test('empty successful scan still produces a coverage artifact and summary',async()=>{
 const h=harness();h.state.runs=[];const result=await execute(h);
 assert.equal(result.errors.length,0);assert.equal(JSON.parse(result.written['ci-sweep-coverage.json']).complete,true);assert.match(result.summary.join(''),/complete/i);
});
