const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {run,job}=require('./fixtures/sweep-harness.cjs');
const impl=fs.existsSync(__dirname+'/ci-sweep-patterns.cjs')?require('./ci-sweep-patterns.cjs'):{};
const cause={kind:'test',signature:'a'.repeat(64),testIdentity:'packages/cezar/src/a.test.ts > handles input',testFile:'packages/cezar/src/a.test.ts',hasTestName:true,hasDiagnostic:true,failureIdentity:'test:packages/cezar/src/a.test.ts > handles input:AssertionError: expected receipt',title:'handles input',stage:'verification',excerpt:'AssertionError: expected receipt'};
const occurrence=id=>({run:run(id),job:job(id*10),step:job().steps[0],cause:{...cause}});
const success=o=>({run:{...o.run,run_attempt:2,conclusion:'success'},jobs:[{...o.job,id:o.job.id+1,conclusion:'success',steps:[{...o.step,conclusion:'success'}]}]});
function classify(occurrences,comparisons=[]) {
 assert.equal(typeof impl.classifyPatterns,'function','pattern classifier implemented');
 return impl.classifyPatterns({occurrences,attempts:[...occurrences.map(o=>({run:o.run,jobs:[o.job]})),...comparisons],owner:'hearsay-tools',repo:'cezarion'});
}
test('two unrelated test failures plus unchanged-SHA passing retry qualify as possible flakiness',()=>{
 const a=occurrence(1),b=occurrence(2);const patterns=classify([a,b],[success(a)]);
 assert.equal(patterns.length,1);assert.equal(patterns[0].classification,'possible-test-flakiness');
 assert.deepEqual(patterns[0].counts,{failures:2,runs:2,shas:2,contexts:2});assert.equal(patterns[0].comparisons.length,1);
});
test('three independent failed runs qualify without claiming flakiness',()=>{
 const patterns=classify([1,2,3].map(occurrence));
 assert.equal(patterns.length,1);assert.equal(patterns[0].classification,'recurring-failure');assert.equal(patterns[0].comparisons.length,0);
});
test('isolated test retry, repeated commits in one PR, and one SHA across workflows do not qualify',()=>{
 const a=occurrence(1);assert.deepEqual(classify([a],[success(a)]),[]);
 const samePr=[1,2,3].map(id=>{const o=occurrence(id);o.run.pull_requests=[{number:1}];return o;});
 assert.deepEqual(classify(samePr,[success(samePr[0])]),[]);
 const sameSha=[1,2,3].map(id=>{const o=occurrence(id);o.run.head_sha=a.run.head_sha;return o;});assert.deepEqual(classify(sameSha),[]);
 const sameBranch=[1,2,3].map(id=>{const o=occurrence(id);o.run.pull_requests=[];o.run.head_branch='main';return o;});assert.deepEqual(classify(sameBranch),[]);
});
test('generic run success, skipped step, changed SHA and ambiguous jobs are not pass evidence',()=>{
 const a=occurrence(1),b=occurrence(2);
 for(const change of [p=>{p.jobs=[];},p=>{p.jobs[0].steps[0].conclusion='skipped';},p=>{p.run.head_sha='f'.repeat(40);},p=>{p.jobs.push({...p.jobs[0],id:99});},p=>{p.run.conclusion='failure';}]) {
  const passing=success(a);change(passing);assert.deepEqual(classify([a,b],[passing]),[]);
 }
});
test('ambiguous PR association does not strengthen independence',()=>{
 const all=[1,2,3].map(id=>{const o=occurrence(id);o.run.pull_requests=[{number:1},{number:id+10}];return o;});assert.deepEqual(classify(all),[]);
});
test('distinct diagnostic signatures remain separate even in the same test and step',()=>{
 const a=occurrence(1),b=occurrence(2);b.cause.signature='b'.repeat(64);
 assert.deepEqual(classify([a,b],[success(a)]),[]);
});
test('source occurrence identity prevents repeated pages and attempts from inflating counts',()=>{
 const a=occurrence(1),b=occurrence(2);const patterns=classify([a,a,{...a,cause:{...a.cause}},b],[success(a)]);
 assert.equal(patterns[0].counts.failures,2);
 assert.deepEqual(classify([a,{...a,run:{...a.run,run_attempt:2}},{...a,run:{...a.run,run_attempt:3}}]),[]);
});
test('unknown diagnostics never group, while recurring infrastructure errors qualify conservatively',()=>{
 const unknown=[1,2,3].map(id=>({...occurrence(id),cause:{...cause,kind:'unknown'}}));assert.deepEqual(classify(unknown),[]);
 const infra=[1,2,3].map(id=>({...occurrence(id),cause:{...cause,kind:'error',testIdentity:undefined}}));
 assert.equal(classify(infra)[0].classification,'recurring-failure');
 assert.deepEqual(classify(infra.slice(0,2),[success(infra[0])]),[]);
});
test('test patterns require both a complete test name and a concrete diagnostic',()=>{
 for(const patch of [{hasDiagnostic:false},{hasTestName:false}]) {
  const occurrences=[1,2,3].map(id=>{const o=occurrence(id);Object.assign(o.cause,patch);return o;});
  assert.deepEqual(classify(occurrences),[]);
 }
});
test('an attempt with rejected job metadata cannot establish an unambiguous passing retry',()=>{
 const a=occurrence(1),b=occurrence(2),passing=success(a);passing.complete=false;
 assert.deepEqual(classify([a,b],[passing]),[]);
});
