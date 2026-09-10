const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./fixtures/release-failure.json');
const { causesForStep, sanitize } = require('./failure-diagnostics.cjs');
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
