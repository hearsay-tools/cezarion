const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./fixtures/release-failure.json');
const { causesForStep, sanitize, hash, isQuotaCause } = require('./failure-diagnostics.cjs');
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
test('missing or unrecognizable logs isolate uncertain failures by occurrence', () => {
  const a = release(); a.log = '';
  const one = causesForStep(a)[0];
  assert.match(one.excerpt, /unavailable|recognizable/i);
  assert.notEqual(one.signature, causesForStep({...a,run:{...a.run,id:999}})[0].signature);
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

test('GitHub request IDs and timestamps do not split one error into many causes',()=>{
 // hearsay-tools/squawk#3416 to hearsay-tools/squawk#3423: eight shards, one error, eight signatures.
 const line=(id,at)=>`##[error]API rate limit exceeded for installation. If you reach out to GitHub Support for help, please include the request ID ${id} and timestamp ${at}. For more on scraping GitHub, review our Terms of Service.`;
 const causes=[['D078:25955F:A505FA:204CE77:6AF6013F','2026-11-12 18:11:11 UTC'],['08C0:1C9592:4FCCB:842A3:6AF6010B','2026-11-12 18:10:19 UTC'],['1440:4495E:83B2DE:1A20552:6AF6012D','2026-11-12 18:10:53 UTC']]
  .map(([id,at])=>causesForStep({run:{id:1,run_attempt:1},job:{id:2},step:{number:5,name:'Set up Node.js'},log:line(id,at)})[0]);
 assert.equal(new Set(causes.map(cause=>cause.signature)).size,1);
 assert.equal(causes[0].failureIdentity,'##[error]API rate limit exceeded for installation. If you reach out to GitHub Support for help, please include the request ID <request-id> and timestamp <timestamp>. For more on scraping GitHub, review our Terms of Service.');
 const other=causesForStep({run:{id:1,run_attempt:1},job:{id:2},step:{number:5,name:'Set up Node.js'},log:'##[error]Unable to find Node version 24.21.0 for platform linux'})[0];
 assert.notEqual(other.signature,causes[0].signature);
});

test('timestamps outside the GitHub request sentence still identify tests',()=>{
 const log='FAIL src/a.test.ts > formats 2026-11-12T18:10:53Z\nAssertionError: expected format\nFAIL src/a.test.ts > formats 2026-11-13T18:10:53Z\nAssertionError: expected format';
 const causes=causesForStep({run:{id:1,run_attempt:1},job:{id:2},step:{number:5,name:'Run unit tests'},log});
 assert.equal(causes.length,2);assert.notEqual(causes[0].signature,causes[1].signature);
 assert.ok(causes.every(cause=>!cause.legacySignatures));
});
test('a GitHub quota error never hides an independent error in the same step',()=>{
 const step={number:5,name:'Build application'};
 const log='##[error]API rate limit exceeded for installation. If you reach out to GitHub Support for help, please include the request ID 08C0:1C9592:4FCCB:842A3:6AF6010B and timestamp 2026-11-12 18:10:19 UTC.\nTypeError: build failed';
 const [cause,...rest]=causesForStep({run:{id:1,run_attempt:1},job:{id:2},step,log});
 assert.equal(rest.length,0);assert.equal(cause.failureIdentity,'TypeError: build failed');assert.equal(isQuotaCause(cause),false);
 const [quota]=causesForStep({run:{id:1,run_attempt:1},job:{id:2},step,log:log.split('\n')[0]});
 assert.equal(isQuotaCause(quota),true);
});
test('a cause whose GitHub request sentence was normalized keeps its earlier signature',()=>{
 const step={number:5,name:'Publish'}, log='##[error]Resource not accessible by integration. If you reach out to GitHub Support for help, please include the request ID 08C0:1C9592:4FCCB:842A3:6AF6010B and timestamp 2026-11-12 18:10:19 UTC.';
 const [cause]=causesForStep({run:{id:1,run_attempt:1},job:{id:2},step,log});
 assert.deepEqual(cause.legacySignatures,[hash(`publishing:Publish:${log}`)]);
 assert.notEqual(cause.signature,cause.legacySignatures[0]);
});
