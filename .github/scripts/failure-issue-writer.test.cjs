const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fixture = require('./fixtures/release-failure.json');
const {causesForStep} = require('./failure-diagnostics.cjs');
const writerModule = fs.existsSync(__dirname + '/failure-issue-writer.cjs') ? require('./failure-issue-writer.cjs') : {};
const {harness} = require('./fixtures/failure-harness.cjs');

function input(h, log=h.state.log) {
  const job=h.state.jobs[0], step=job.steps.find(entry=>entry.conclusion==='failure');
  return {run:h.state.run,job,step,causes:causesForStep({run:h.state.run,job,step,log})};
}
async function create(h, limits={}) {
  assert.equal(typeof writerModule.createFailureWriter,'function','shared failure writer is implemented');
  return writerModule.createFailureWriter({...h.options,...limits});
}

test('factory exposes all non-PR issues and mutable cached comments',async()=>{
  const h=harness();
  h.state.issues.push({number:1,state:'open',title:'Existing remediation',body:'no failure marker'});
  h.state.issues.push({number:2,state:'open',title:'Pull request',body:'no failure marker',pull_request:{url:'example'}});
  h.state.comments.push({issue_number:1,body:'existing evidence'});
  const writer=await create(h);
  assert.deepEqual(writer.issues.map(issue=>issue.number),[1]);
  const comments=await writer.commentsFor(writer.issues[0]);comments.push({body:'cached update'});
  assert.equal((await writer.commentsFor(1)).at(-1).body,'cached update');
});

test('two writer instances deduplicate the same durable occurrence',async()=>{
  const h=harness();
  const first=await create(h);const created=await first.reportStep(input(h));
  const second=await create(h);const replayed=await second.reportStep(input(h));
  assert.equal(created.length,1);assert.equal(created[0].reported,true);
  assert.equal(replayed.length,1);assert.equal(replayed[0].reported,false);
  assert.equal(replayed[0].issue.number,created[0].issue.number);
  assert.equal(h.state.issues.length,1);assert.equal(h.state.comments.length,1);
});

test('a new occurrence after closure creates a linked recurrence',async()=>{
  const h=harness();const first=await create(h);await first.reportStep(input(h));
  h.state.issues[0].state='closed';h.state.run.id=123;h.state.run.run_attempt=2;
  const second=await create(h);const result=await second.reportStep(input(h));
  assert.equal(result[0].reported,true);assert.equal(result[0].issue.number,2);
  assert.match(h.state.issues[1].body,/issues\/1/);
  assert.equal(h.state.comments.length,2);
});

test('a create success followed by comment failure is repaired by a new writer',async()=>{
  const h=harness();h.state.failComment=true;
  const first=await create(h);await assert.rejects(first.reportStep(input(h)),/comment secret/);
  assert.equal(h.state.issues.length,1);assert.equal(h.state.comments.length,0);
  const second=await create(h);const repaired=await second.reportStep(input(h));
  assert.equal(repaired[0].issue.number,1);assert.equal(repaired[0].reported,true);
  assert.equal(h.state.issues.length,1);assert.equal(h.state.comments.length,1);
});

test('a second known cause in the same occurrence remains reportable',async()=>{
  const h=harness(), one='FAIL src/a.test.ts > works\nError: bad';
  const first=await create(h);await first.reportStep(input(h,one));
  const two=one+'\nFAIL src/b.test.ts > works\nError: worse';
  const second=await create(h);const results=await second.reportStep(input(h,two));
  assert.deepEqual(results.map(result=>result.reported),[false,true]);
  assert.equal(h.state.issues.length,2);assert.equal(h.state.comments.length,2);
});

test('an unknown reservation remains authoritative when logs later become available',async()=>{
  const h=harness();
  const first=await create(h);await first.reportStep(input(h,''));
  const second=await create(h);const results=await second.reportStep(input(h,'FAIL src/a.test.ts > works\nError: bad'));
  assert.equal(results.length,1);assert.equal(results[0].reported,false);
  assert.equal(results[0].cause.kind,'unknown');
  assert.equal(h.state.issues.length,1);assert.equal(h.state.comments.length,1);
});

test('write limits count only actual new issue and occurrence writes',async()=>{
  const h=harness();
  const capped=await create(h,{maxIssues:0,maxOccurrences:1});
  await assert.rejects(capped.reportStep(input(h)),error=>{assert.equal(error.code,'issue-limit');return true;});
  assert.equal(h.state.issues.length,0);

  const seed=await create(h);await seed.reportStep(input(h));
  const replay=await create(h,{maxIssues:0,maxOccurrences:0});
  const existing=await replay.reportStep(input(h));
  assert.equal(existing[0].reported,false);

  h.state.run.id=123;h.state.run.run_attempt=2;
  const occurrenceCapped=await create(h,{maxIssues:0,maxOccurrences:0});
  await assert.rejects(occurrenceCapped.reportStep(input(h)),error=>{assert.equal(error.code,'occurrence-limit');return true;});
  assert.equal(h.state.issues.length,1);assert.equal(h.state.comments.length,1);
});

test('exhausted occurrence quota prevents an empty issue reservation',async()=>{
  const h=harness();
  const capped=await create(h,{maxIssues:1,maxOccurrences:0});
  await assert.rejects(capped.reportStep(input(h)),error=>{assert.equal(error.code,'occurrence-limit');return true;});
  assert.equal(h.state.issues.length,0);assert.equal(h.state.comments.length,0);
});

test('custom labels and body factory apply only when creating an issue',async()=>{
  const h=harness(), received=[];const writer=await create(h);
  const [result]=await writer.reportStep({...input(h),labels:['area-web'],bodyFor:args=>{received.push(args);return `${args.signature}\n${args.occurrence}\ncustom`;}});
  assert.deepEqual(result.issue.labels,['area-web']);assert.match(result.issue.body,/custom/);
  assert.equal(received.length,1);assert.equal(received[0].cause.kind,'test');
  assert.doesNotMatch(result.issue.body,/testIdentity|failureIdentity/);
});
