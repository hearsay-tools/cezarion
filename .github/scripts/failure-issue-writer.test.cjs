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
  return writerModule.createFailureWriter({...h.options,since:h.state.run.created_at,...limits});
}
// The 2026-11-12 browser shard log line: one per job, each with its own request ID and time.
const rateLimited=(id,at)=>`##[error]API rate limit exceeded for installation. If you reach out to GitHub Support for help, please include the request ID ${id} and timestamp ${at} UTC. For more on scraping GitHub and how it may affect your rights, please review our Terms of Service.`;
const issueReads=h=>h.calls.filter(([route])=>route==='GET /repos/{owner}/{repo}/issues').map(([,args])=>({state:args.state,since:args.since}));
const commentReads=h=>h.calls.filter(([route])=>route==='GET /repos/{owner}/{repo}/issues/{issue_number}/comments').map(([,args])=>args.issue_number);
const before=run=>new Date(Date.parse(run.created_at)-24*60*60*1000).toISOString();

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

test('a bounded writer reads open issues and issues updated since the run, not every issue',async()=>{
  const h=harness();await (await create(h)).reportStep(input(h));
  // An older open owner of the same cause: last updated a day before the next run.
  h.state.issues[0].updated_at=before(h.state.run);h.state.run.id=123;h.calls.length=0;
  const result=await (await create(h)).reportStep(input(h));
  assert.equal(result[0].reported,true);assert.equal(result[0].issue.number,1);
  assert.deepEqual(issueReads(h),[{state:'open',since:undefined},{state:'all',since:h.state.run.created_at}]);
  // Its comments cannot hold this run's occurrence, so they are not read.
  assert.deepEqual(commentReads(h),[]);
  assert.equal(h.state.issues.length,1);assert.equal(h.state.comments.length,2);
});

test('an occurrence on an issue updated since the run is found again',async()=>{
  const h=harness();await (await create(h)).reportStep(input(h));
  h.state.issues[0].state='closed';h.calls.length=0;
  const replay=await (await create(h)).reportStep(input(h));
  assert.equal(replay[0].reported,false);assert.equal(replay[0].issue.number,1);
  assert.deepEqual(commentReads(h),[1]);
  assert.equal(h.state.issues.length,1);assert.equal(h.state.comments.length,1);
});

test('a recurrence links an old closed report found through search, or no link when search fails',async()=>{
  for(const failSearch of [false,true]) {
    const h=harness();await (await create(h)).reportStep(input(h));
    Object.assign(h.state.issues[0],{state:'closed',updated_at:before(h.state.run)});
    h.state.run.id=123;h.state.failSearch=failSearch;
    const [result]=await (await create(h)).reportStep(input(h));
    assert.equal(result.reported,true);assert.equal(result.issue.number,2);
    const search=h.calls.find(([route])=>route==='GET /search/issues');
    assert.match(search[1].q,new RegExp(`^repo:hearsay-tools/cezarion is:issue is:closed ${result.cause.signature}$`));
    if(failSearch) {
      assert.doesNotMatch(h.state.issues[1].body,/Previous closed report/);
      assert.ok(h.messages.includes('Could not search for a previous closed report; the new issue has no previous-report link.'));
      assert.doesNotMatch(h.messages.join('\n'),/secret/);
    } else assert.match(h.state.issues[1].body,/\[Previous closed report\]\(https:\/\/github\.com\/hearsay-tools\/cezarion\/issues\/1\)/);
  }
});

test('GitHub API rate-limit errors are logged, never filed',async()=>{
  const h=harness(), writer=await create(h);
  const results=await writer.reportStep(input(h,rateLimited('D078:25955F:A505FA:204CE77:6AF6013F','2026-11-12 18:11:11')));
  assert.deepEqual(results,[]);assert.equal(h.state.issues.length,0);assert.equal(h.state.comments.length,0);
  assert.match(h.messages.at(-1),/job \d+, step 8: hit the GitHub API rate limit; no issue filed for this transient cause\.$/);
  const secondary=await writer.reportStep(input(h,'##[error]You have exceeded a secondary rate limit. Please wait a few minutes before you try again.'));
  assert.deepEqual(secondary,[]);assert.equal(h.state.issues.length,0);
});

test('a test that fails on rate-limit text still reports',async()=>{
  const h=harness();
  const [result]=await (await create(h)).reportStep(input(h,'FAIL src/a.test.ts > maps errors\nAssertionError: expected API rate limit exceeded to be mapped'));
  assert.equal(result.reported,true);assert.equal(result.cause.kind,'test');assert.equal(h.state.issues.length,1);
});

// A cause whose signature changed (the GitHub request sentence normalization)
// is one identity under both signatures. Seeds: what the earlier writer, or
// this one, left; replays: what a rerun of the reporter sees.
const requestLog='##[error]Resource not accessible by integration. If you reach out to GitHub Support for help, please include the request ID 08C0:1C9592:4FCCB:842A3:6AF6010B and timestamp 2026-11-12 18:10:19 UTC.';
function legacyInput(h) {
  const current=input(h,requestLog), [{legacySignatures,...cause}]=current.causes;
  return {...current,causes:[{...cause,signature:legacySignatures[0]}]};
}
const seeds={
  'old complete report':async h=>{await (await create(h)).reportStep(legacyInput(h));},
  'old reservation with a failed comment':async h=>{h.state.failComment=true;await assert.rejects((await create(h)).reportStep(legacyInput(h)),/comment secret/);},
  'new report':async h=>{await (await create(h)).reportStep(input(h,requestLog));},
};
const replays={
  'replay with logs':['logs'],
  'replay without logs':['none'],
  'repeated replay':['logs','none','logs','none'],
  'repeated replay, logs last':['none','logs','none','logs'],
};
for(const [seedName,seed] of Object.entries(seeds)) for(const [replayName,sequence] of Object.entries(replays)) {
  test(`${seedName}, ${replayName}: one issue and one occurrence comment`,async()=>{
    const h=harness();await seed(h);
    for(const logs of sequence) await (await create(h)).reportStep(input(h,logs==='logs'?requestLog:''));
    assert.equal(h.state.issues.length,1);
    const step=h.state.jobs[0].steps.find(entry=>entry.conclusion==='failure').number;
    const occurrence=new RegExp(`cez-failure-occurrence:v1:${h.state.run.id}:${h.state.run.run_attempt}:${h.state.jobs[0].id}:${step}:`);
    assert.equal(h.state.comments.filter(comment=>occurrence.test(comment.body)).length,1);
    // Once a run's logs name the current signature, later runs find the owner
    // by it in the body. A replay without logs cannot know it.
    if(seedName==='new report' || sequence.includes('logs')) assert.ok(h.state.issues[0].body.includes(`cez-failure-signature:v1:${input(h,requestLog).causes[0].signature}`));
  });
}

test('a quota error before an independent error still reports the independent error',async()=>{
  const h=harness();
  const [result,...rest]=await (await create(h)).reportStep(input(h,rateLimited('08C0:1C9592:4FCCB:842A3:6AF6010B','2026-11-12 18:10:19')+'\nTypeError: build failed'));
  assert.equal(rest.length,0);assert.equal(result.reported,true);assert.match(h.state.issues[0].body,/TypeError: build failed/);
});
