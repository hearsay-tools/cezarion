const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./fixtures/release-failure.json');
const { causesForStep, sanitize, isQuotaCause } = require('./failure-diagnostics.cjs');
const release = () => ({run: fixture.run, job: fixture.jobs[0], step: fixture.jobs[0].steps.find(s => s.conclusion === 'failure'), log: fixture.log});

test('real Release test failure matches Nightly despite different job and step names', () => {
  const input = release();
  const a = causesForStep(input);
  const b = causesForStep({...input, run: {...input.run, name: 'Nightly'}, job: {...input.job, name:'Publish nightly to npm'}, step:{...input.step, name:'Verify before publishing'}});
  assert.equal(a.length, 1);
  assert.match(a[0].title, /delegation-integration.test.ts/);
  assert.equal(a[0].signature, b[0].signature);
  assert.equal(a[0].stage, 'verification');
  assert.match(a[0].excerpt, /AssertionError/);
});
test('a step stopped at the job time limit is one timeout cause per stage and step', () => {
  const input = release(), timeout = 'The job has exceeded the maximum execution time of 20m0s';
  const a = causesForStep({...input, job: {...input.job, timeout}});
  const b = causesForStep({...input, run: {...input.run, id: 999, name: 'Nightly'}, job: {...input.job, name: 'Vitest shard 2/3', timeout}, log: ''});
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, 'timeout');
  assert.equal(a[0].stage, 'verification');
  assert.equal(a[0].title, 'Run server and cockpit unit suites exceeded the job time limit');
  assert.equal(a[0].signature, b[0].signature);
  assert.notEqual(a[0].signature, causesForStep(input)[0].signature);
  assert.match(a[0].excerpt, /20m0s/);
  assert.match(b[0].excerpt, /20m0s/);
});
test('different tests in one step remain distinct and repeated identical FAIL lines collapse', () => {
  const a = release();
  a.log = 'FAIL src/a.test.ts > handles empty input\nError: bad\nFAIL src/a.test.ts > handles duplicates\nError: bad\nFAIL src/a.test.ts > handles empty input';
  const causes = causesForStep(a);
  assert.equal(causes.length,2);
  assert.notEqual(causes[0].signature, causes[1].signature);
});
// Each run of one unrecognized failure once filed its own issue (hearsay-tools/squawk#1447).
test('an unrecognized failure keeps one signature per workflow, job and step across runs and shards', () => {
  const a = release(); a.log = ''; a.job = {...a.job, name: 'Vitest shard 4/8'};
  const one = causesForStep(a)[0];
  assert.match(one.excerpt, /unavailable|recognizable/i);
  assert.equal(one.signature, causesForStep({...a,run:{...a.run,id:999,run_attempt:2},job:{...a.job,id:7,name:'Vitest shard 2/8'},log:'exit 1'})[0].signature);
  for (const other of [{step:{...a.step,name:'Run unit tests'}}, {job:{...a.job,name:'Dependency audit'}}, {run:{...a.run,name:'Nightly'}}]) {
    assert.notEqual(one.signature, causesForStep({...a,...other})[0].signature);
  }
});
// hearsay-tools/squawk#3335 filed the 24-hour limit of release-plan.cjs as a setup failure.
test('a release-plan refusal in the Release workflow is no cause; other lines and workflows still are', () => {
  const a = release();
  a.step = {...a.step, name:'Plan the release', started_at:'2026-09-10T11:50:00Z', completed_at:'2026-09-10T11:50:01Z'};
  const at = line => ({...a, log: `${fixture.log}\n2026-09-10T11:50:00Z ${line}`});
  for (const line of ['Error: Release refused: the last stable release was published 2026-11-11T18:15:31.289Z.', 'Error: Release refused:', 'Error: Promotion refused:', 'Error: Staging refused: the candidate commit publishes x']) {
    assert.deepEqual(causesForStep(at(line)), [], line);
  }
  assert.equal(causesForStep(at('Error: connect: connection refused'))[0].failureIdentity, 'Error: connect: connection refused');
  assert.match(causesForStep({...at('Error: Release refused:'), run: {...a.run, name: 'Nightly'}})[0].failureIdentity, /Release refused/);
});
test('publishing error differs from verification and ignores unrelated timestamped steps', () => {
  const a = release(); a.step = {...a.step, name:'Publish nightly',started_at:'2026-09-10T12:00:00Z',completed_at:'2026-09-10T12:01:00Z'};
  a.log = fixture.log + '\n2026-09-10T12:00:30Z npm error code E403\n2026-09-10T12:00:31Z npm error Forbidden';
  const c=causesForStep(a)[0]; assert.equal(c.stage,'publishing'); assert.doesNotMatch(c.excerpt,/delegation/);
});
test('diagnostics neutralize mentions, HTML, commands and credentials and bound output', () => {
  const text = sanitize('Authorization: Bearer secret-value\nTOKEN=secret-value\nhttps://user:pass@example.com/a?token=secret-value\nghp_'+'a'.repeat(36)+'\n-----BEGIN PRIVATE KEY-----\nprivate-secret\n-----END PRIVATE KEY-----\n@owner <script> ` ``` ::error::run $(touch /tmp/no)\n'+'x'.repeat(8000));
  assert.doesNotMatch(text,/secret-value|private-secret|ghp_|@owner|<script>|::error::/);
  assert.ok(text.length <= 4000);
});
test('quoted credential keys are redacted from JSON diagnostics',()=>{
 for(const key of ['token','api_key','access_token','client_secret','password']) {
   assert.doesNotMatch(sanitize(`"${key}": "a-short-private-value"`),/a-short-private-value/);
 }
});
test('long distinct test paths retain separate identities even when display redaction shortens them',()=>{
 const a=release(), b=release();
 a.log='FAIL src/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.test.ts > works\nError: bad';
 b.log='FAIL src/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.test.ts > works\nError: bad';
 assert.notEqual(causesForStep(a)[0].signature,causesForStep(b)[0].signature);
});
test('different diagnostics in the same test do not claim one shared cause',()=>{
 const a=release(),b=release();a.log='FAIL src/a.test.ts > works\nTypeError: cannot read property';b.log='FAIL src/a.test.ts > works\nAssertionError: expected 1 to equal 2';
 assert.notEqual(causesForStep(a)[0].signature,causesForStep(b)[0].signature);
});
test('test diagnoses expose full internal identity without changing v1 signatures',()=>{
 const a=release();a.log='FAIL src/a.test.ts > works\nError: bad';
 const cause=causesForStep(a)[0];
 assert.equal(cause.kind,'test');
 assert.equal(cause.testIdentity,'src/a.test.ts > works');
 assert.equal(cause.testFile,'src/a.test.ts');
 assert.equal(cause.hasTestName,true);
 assert.equal(cause.hasDiagnostic,true);
 assert.equal(cause.failureIdentity,'test:src/a.test.ts > works:Error: bad');
 assert.equal(cause.signature,'d4797b81a9bda7af004af4674dde129eafdb5f71df59add3ad3d2112d20a5f88');
});
test('test diagnoses expose missing names and diagnostics without changing rendered output',()=>{
 const named=release();named.log='FAIL src/a.test.ts > works';
 const namedCause=causesForStep(named)[0];
 assert.equal(namedCause.title,'src/a.test.ts › works');
 assert.equal(namedCause.hasTestName,true);
 assert.equal(namedCause.hasDiagnostic,false);
 const unnamed=release();unnamed.log='FAIL src/a.test.ts\nError: bad';
 const unnamedCause=causesForStep(unnamed)[0];
 assert.equal(unnamedCause.title,'src/a.test.ts');
 assert.equal(unnamedCause.hasTestName,false);
 assert.equal(unnamedCause.hasDiagnostic,true);
});
test('structured identity is untruncated while rendered test titles stay bounded',()=>{
 const a=release(), testFile=`src/${'a'.repeat(4200)}.test.ts`;
 a.log=`FAIL ${testFile} > works\nError: bad`;
 const cause=causesForStep(a)[0];
 assert.equal(cause.testIdentity,`${testFile} > works`);
 assert.equal(cause.testFile,testFile);
 assert.ok(cause.title.length<=180);
 assert.doesNotMatch(cause.title,/a{4000}/);
});
test('generic and unknown diagnoses expose conservative source identities',()=>{
 const error=release();error.log='TypeError: cannot open 0x123 after 14ms';
 const diagnosed=causesForStep(error)[0];
 assert.equal(diagnosed.kind,'error');
 assert.equal(diagnosed.failureIdentity,'TypeError: cannot open <address> after <duration>');
 assert.equal(diagnosed.signature,'8ed1686950e781321d61b07e444bfea33b77a99c2938559c2bc41433398ed783');
 const unknown=release();unknown.log='';
 assert.equal(causesForStep(unknown)[0].kind,'unknown');
 assert.equal(causesForStep(unknown)[0].failureIdentity,undefined);
});
test('unrecognized failure keeps bounded evidence after Actions logs expire',()=>{
 const a=release();a.log='src/index.ts(12,3): error TS2307: Cannot find module x';
 assert.match(causesForStep(a)[0].excerpt,/TS2307: Cannot find module x/);
});
test('multiline and camelCase credential assignments are redacted',()=>{
 for(const input of ['"token":\n  "a-short-private-value"','accessToken = "a-short-private-value"']) assert.doesNotMatch(sanitize(input),/a-short-private-value/);
});
test('excerpt boundaries cannot expose private key tails',()=>{
 const a=release();a.log='-----BEGIN PRIVATE KEY-----\n'+'a'.repeat(64)+'\n'+('b'.repeat(64)+'\n').repeat(40)+'short-private-fragment\n-----END PRIVATE KEY-----';
 assert.doesNotMatch(causesForStep(a)[0].excerpt,/short-private-fragment/);
});

test('timestamps in test names still identify tests',()=>{
 const log='FAIL src/a.test.ts > formats 2026-11-12T18:10:53Z\nAssertionError: expected format\nFAIL src/a.test.ts > formats 2026-11-13T18:10:53Z\nAssertionError: expected format';
 const causes=causesForStep({run:{id:1,run_attempt:1},job:{id:2},step:{number:5,name:'Run unit tests'},log});
 assert.equal(causes.length,2);assert.notEqual(causes[0].signature,causes[1].signature);
});
test('a step that chose a GitHub quota error carries its first other error for the writer',()=>{
 const step={number:5,name:'Build application'};
 const quota='##[error]API rate limit exceeded for installation. If you reach out to GitHub Support for help, please include the request ID 08C0:1C9592:4FCCB:842A3:6AF6010B and timestamp 2026-11-12 18:10:19 UTC.';
 // The v1 selection (first error) is unchanged, so its signature matches main.
 const [cause,...rest]=causesForStep({run:{id:1,run_attempt:1},job:{id:2},step,log:`${quota}\nTypeError: build failed`});
 assert.equal(rest.length,0);assert.equal(isQuotaCause(cause),true);
 assert.equal(cause.signature,causesForStep({run:{id:1,run_attempt:1},job:{id:2},step,log:quota})[0].signature);
 assert.equal(cause.independentCause.failureIdentity,'TypeError: build failed');assert.equal(isQuotaCause(cause.independentCause),false);
 assert.equal(causesForStep({run:{id:1,run_attempt:1},job:{id:2},step,log:quota})[0].independentCause,undefined);
 const [first]=causesForStep({run:{id:1,run_attempt:1},job:{id:2},step,log:`TypeError: build failed\n${quota}`});
 assert.equal(first.failureIdentity,'TypeError: build failed');assert.equal(first.independentCause,undefined);
});
test('non-quota signatures stay exactly as before quota filtering, so replays find existing reports',()=>{
 // Golden values computed on main before this change; a different value
 // would make every reporter replay miss its existing issue.
 const step={number:5,name:'Publish'};
 const [error]=causesForStep({run:{id:1,run_attempt:1},job:{id:2},step,log:'##[error]Resource not accessible by integration. If you reach out to GitHub Support for help, please include the request ID 08C0:1C9592:4FCCB:842A3:6AF6010B and timestamp 2026-11-12 18:10:19 UTC.'});
 assert.equal(error.signature,'74547ae640086bd81b68b625b1ac1e1a06c5923b9e435d627424f0bfa3d83c06');
 const [testCause]=causesForStep({run:{id:1,run_attempt:1},job:{id:2},step:{number:8,name:'Run unit tests'},log:'FAIL src/a.test.ts > formats 2026-11-12T18:10:53Z\nAssertionError: expected 0x1f after 12ms'});
 assert.equal(testCause.signature,'64a6c7691f8b8ac74558237bf32bf2a7a924d6f1a013cfe27fc55a4cdea0753e');
});
