const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');
const {harness} = require('./fixtures/failure-harness.cjs');
const workflowPath=path.resolve(__dirname,'../workflows/report-workflow-failure.yml');
const workflow=()=>yaml.parse(fs.readFileSync(workflowPath,'utf8'));
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
async function execute(h) {
 const w=workflow(), script=w.jobs.report.steps.find(step=>step.uses?.startsWith('actions/github-script@')).with.script;
 const summary=[],errors=[];
 const core={info:()=>{},setFailed:m=>errors.push(m),summary:{addRaw:m=>{summary.push(m);return core.summary;},write:async()=>{}}};
 await new AsyncFunction('require','github','context','core',script)(p=>require(path.resolve(__dirname,'../..',p)),h.options.github,{repo:{owner:'hearsay-tools',repo:'cezarion'},payload:h.options.event},core);
 return {errors,summary};
}
test('completion consumer scopes trigger, credentials and checkout to trusted code',()=>{
 const w=workflow();assert.deepEqual(w.on.workflow_run,{workflows:['Release','Nightly'],types:['completed']});
 assert.deepEqual(w.permissions,{});assert.deepEqual(w.jobs.report.permissions,{actions:'read',contents:'read',issues:'write'});
 const checkout=w.jobs.report.steps.find(s=>s.uses?.startsWith('actions/checkout@'));
 assert.equal(checkout.with.ref,'${{ github.sha }}');assert.equal(checkout.with['persist-credentials'],false);
 assert.equal(w.concurrency['cancel-in-progress'],false);assert.equal(w.concurrency.queue,'max');
 assert.doesNotMatch(w.concurrency.group,/\$\{\{/,'every reporter must share one lock across workflows and causes');
});
test('workflow entrypoint reports API errors without echoing response or credentials',async()=>{
 const h=harness();h.state.failCreate=true;const result=await execute(h);
 assert.equal(result.errors.length,1);assert.match(result.summary.join(''),/failed/i);assert.doesNotMatch(JSON.stringify(result),/secret/);
});
test('concurrent completion jobs serialized by declared Actions group create one occurrence',async()=>{
 const w=workflow();assert.equal(w.concurrency.queue,'max');assert.equal(w.concurrency['cancel-in-progress'],false);
 const h=harness();let lock=Promise.resolve();
 // Model Actions' single running writer, retaining pending jobs. This exercises
 // the real entrypoint twice against persisted API state, not an in-memory lock
 // that would disappear between GitHub runners.
 const enqueue=()=>{const next=lock.then(()=>execute(h));lock=next;return next;};
 const results=await Promise.all([enqueue(),enqueue(),enqueue()]);
 assert.ok(results.every(r=>r.errors.length===0));assert.equal(h.state.issues.length,1);assert.equal(h.state.comments.length,1);
});
