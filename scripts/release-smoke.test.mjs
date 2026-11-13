import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { INSTALL_WAIT_MS, PUBLISH_WAIT_MS, bootEnv, cockpitAsset, failureLine, parseArgs, registryInstall, run } from './release-smoke.mjs';

const { causesForStep, sanitize } = createRequire(import.meta.url)('../.github/scripts/failure-diagnostics.cjs');

test('the smoke takes a package, an exact version and an optional upgrade source', () => {
  assert.deepEqual(parseArgs(['--package', '@hearsay-tools/squawk', '--version', '1.2.1-rc.1']),
    { name: '@hearsay-tools/squawk', version: '1.2.1-rc.1', upgradeFrom: undefined });
  assert.deepEqual(parseArgs(['--package', 'cezarion', '--version', '1.2.1', '--upgrade-from', '1.2.0']),
    { name: 'cezarion', version: '1.2.1', upgradeFrom: '1.2.0' });
  assert.throws(() => parseArgs(['--package', 'cezarion']), /--version is required/);
  assert.throws(() => parseArgs(['--package', 'cezarion', '--version', 'latest']), /Invalid version/);
  assert.throws(() => parseArgs(['--package', 'x; rm -rf /', '--version', '1.0.0']), /Invalid package name/);
  assert.throws(() => parseArgs(['--tag', 'next']), /Usage/);
});

test('the cockpit check needs the module script a built cockpit page loads', () => {
  assert.equal(cockpitAsset('<script type="module" crossorigin src="/assets/index-AbC123.js"></script>'), '/assets/index-AbC123.js');
  assert.equal(cockpitAsset('<html><body>Build the cockpit first</body></html>'), null);
});

test('no ambient product setting reaches the booted package', () => {
  const env = bootEnv({ PATH: '/bin', CEZ_PREVIEW: '1', hsq_task_id: 'x', HSQ_HOME: '/real' }, '/tmp/h');
  assert.equal(env.PATH, '/bin');
  assert.equal(env.CEZ_PREVIEW, undefined);
  assert.equal(env.hsq_task_id, undefined);
  assert.equal(env.HSQ_HOME, '/tmp/h/product');
  assert.equal(env.CEZ_HOME, '/tmp/h/product');
  assert.equal(env.HOME, '/tmp/h/user');
  assert.equal(env.HSQ_DRY_RUN, '1');
});

// A fake npm on a fake clock: `npm view` shows the version from `visibleAt` on, and
// `npm install` fails until `installableAt`.
function fakeRegistry({ visibleAt = 0, installableAt = visibleAt, version = '1.2.1' } = {}) {
  const calls = [];
  let now = 0;
  const notFound = () => Object.assign(new Error('Command failed: npm'), { stderr: `npm error code E404\nnpm error 404 No match found for version ${version}\n` });
  return {
    calls, logs: [], get now() { return now; },
    options() {
      return {
        now: () => now, sleep: async ms => { now += ms; }, log: line => this.logs.push(line),
        exec: (args, { timeout } = {}) => {
          calls.push({ at: now, command: args[0], args, timeout });
          if (args[0] === 'view') { if (now < visibleAt) throw notFound(); return `${version}\n`; }
          if (now < installableAt) throw Object.assign(new Error('Command failed: npm install'), { stderr: '', status: 1, signal: null });
          return null;
        },
      };
    },
  };
}

test('the smoke install waits until the registry serves a version npm is still processing', async t => {
  const prefix = mkdtempSync(join(tmpdir(), 'release-smoke-test-'));
  t.after(() => rmSync(prefix, { recursive: true, force: true }));
  // The 2026-11-13 nightly appeared 6 min 12 s after npm publish returned.
  const registry = fakeRegistry({ visibleAt: 372_000 });
  await registryInstall(prefix, 'fake@1.2.1', registry.options());
  const installs = registry.calls.filter(call => call.command === 'install');
  assert.equal(installs.length, 1);
  assert.ok(installs[0].at >= 372_000);
  assert.ok(installs[0].args.includes('--prefer-online') && installs[0].args.includes('fake@1.2.1'));
  assert.ok(registry.calls.filter(call => call.command === 'view').every(call => call.args.includes('--prefer-online')));
  assert.match(registry.logs[0], /fake@1\.2\.1 is not on the registry \(attempt 1, 0 s elapsed\): 404 No match found/);
  assert.match(registry.logs.at(-1), /the registry serves fake@1\.2\.1/);
});

test('npm view must print the exact version before the install starts', async t => {
  const prefix = mkdtempSync(join(tmpdir(), 'release-smoke-test-'));
  t.after(() => rmSync(prefix, { recursive: true, force: true }));
  const registry = fakeRegistry();
  const options = registry.options();
  let views = 0;
  const exec = (args, more) => (args[0] === 'view' && ++views < 3 ? '' : options.exec(args, more));
  await registryInstall(prefix, 'fake@1.2.1', { ...options, exec });
  assert.equal(views, 3);
  assert.equal(registry.now, 30_000);
});

test('a version the registry never serves fails at the publish bound without an install', async t => {
  const prefix = mkdtempSync(join(tmpdir(), 'release-smoke-test-'));
  t.after(() => rmSync(prefix, { recursive: true, force: true }));
  const registry = fakeRegistry({ visibleAt: Infinity });
  await assert.rejects(registryInstall(prefix, 'fake@1.2.1', registry.options()),
    new RegExp(`fake@1\\.2\\.1 is not on the registry after ${PUBLISH_WAIT_MS / 1000} s`));
  assert.equal(registry.now, PUBLISH_WAIT_MS);
  assert.equal(registry.calls.filter(call => call.command === 'install').length, 0);
});

test('an install that keeps failing once the version is visible stops at the shorter install bound', async t => {
  const prefix = mkdtempSync(join(tmpdir(), 'release-smoke-test-'));
  t.after(() => rmSync(prefix, { recursive: true, force: true }));
  const registry = fakeRegistry({ installableAt: Infinity });
  await assert.rejects(registryInstall(prefix, 'fake@1.2.1', registry.options()),
    new RegExp(`fake@1\\.2\\.1 did not install after ${INSTALL_WAIT_MS / 1000} s`));
  assert.equal(registry.now, INSTALL_WAIT_MS);
  assert.equal(registry.calls.filter(call => call.command === 'view').length, 1);
});

test('each npm call is bounded by what is left of its phase, and never by less than one poll', async t => {
  const prefix = mkdtempSync(join(tmpdir(), 'release-smoke-test-'));
  t.after(() => rmSync(prefix, { recursive: true, force: true }));
  const registry = fakeRegistry({ visibleAt: 60_000, installableAt: Infinity });
  await assert.rejects(registryInstall(prefix, 'fake@1.2.1', registry.options()), /did not install/);
  const views = registry.calls.filter(call => call.command === 'view');
  assert.deepEqual(views.map(call => call.timeout), [0, 15_000, 30_000, 45_000, 60_000].map(at => PUBLISH_WAIT_MS - at));
  const installs = registry.calls.filter(call => call.command === 'install');
  assert.equal(installs[0].timeout, INSTALL_WAIT_MS);
  assert.ok(installs.every(call => call.timeout >= 15_000), 'a 0 timeout would mean no limit');
  assert.equal(installs.at(-1).timeout, 15_000, 'the attempt at the deadline still gets one poll interval');
});

test('an npm attempt that takes time before it fails still gets only what is left, and the pause stops at the bound', async t => {
  const prefix = mkdtempSync(join(tmpdir(), 'release-smoke-test-'));
  t.after(() => rmSync(prefix, { recursive: true, force: true }));
  // Each `npm view` runs 50 s and fails: attempts start 65 s apart, and the 14th ends 5 s before the bound.
  let now = 0;
  const views = [], pauses = [];
  const options = {
    now: () => now, log: () => {},
    sleep: async ms => { pauses.push({ at: now, ms }); now += ms; },
    exec: (args, { timeout }) => {
      views.push({ at: now, timeout });
      now += 50_000;
      throw Object.assign(new Error('Command failed: npm view'), { stderr: 'npm error 404 No match found\n' });
    },
  };
  await assert.rejects(registryInstall(prefix, 'fake@1.2.1', options), /is not on the registry after 950 s \(15 attempts\)/);
  assert.deepEqual(views.map(v => v.timeout), views.map(v => Math.max(PUBLISH_WAIT_MS - v.at, 15_000)));
  assert.ok(pauses.every(p => p.at + p.ms <= PUBLISH_WAIT_MS), 'no pause runs past the bound');
  assert.deepEqual(pauses.at(-1), { at: 895_000, ms: 5_000 }, 'the last pause is cut to what is left');
  assert.deepEqual(views.at(-1), { at: PUBLISH_WAIT_MS, timeout: 15_000 }, 'the attempt at the bound gets one poll interval');
});

test('the CI failure filer reads the failure the smoke ends on, not a wait line before it', async t => {
  const prefix = mkdtempSync(join(tmpdir(), 'release-smoke-test-'));
  t.after(() => rmSync(prefix, { recursive: true, force: true }));
  const registry = fakeRegistry({ visibleAt: 30_000 });
  await registryInstall(prefix, 'fake@1.2.1', registry.options());
  const failure = failureLine(new Error('The booted server registered no project'));
  const log = [...registry.logs, failure, '##[error]Process completed with exit code 1.'].join('\n');
  const causes = causesForStep({ run: { id: 1, run_attempt: 1 }, job: { id: 2 }, step: { number: 5, name: 'Clean install, boot and cockpit' }, log });
  assert.deepEqual(causes.map(cause => cause.title), [failure]);
});

// The filer's causes for a failed smoke step whose log is `lines`.
const filed = lines => causesForStep({ run: { id: 1, run_attempt: 1 }, job: { id: 2 }, step: { number: 5, name: 'Clean install, boot and cockpit' },
  log: [...lines, '##[error]Process completed with exit code 1.'].join('\n') }).map(cause => cause.title);

test("npm's own output from a failed install attempt cannot become the filed cause of a later failure", async t => {
  const prefix = mkdtempSync(join(tmpdir(), 'release-smoke-test-'));
  t.after(() => rmSync(prefix, { recursive: true, force: true }));
  const registry = fakeRegistry();
  const options = registry.options();
  let installs = 0;
  // The 2026-11-13 nightly's npm output, then an EPERM line, then a successful second attempt.
  const exec = (args, more) => {
    if (args[0] !== 'install') return options.exec(args, more);
    assert.equal(more.quiet, true, 'npm install output is captured, not inherited');
    if (++installs > 1) return 'added 1 package in 1s\n';
    throw Object.assign(new Error('Command failed: npm install'), { status: 1, signal: null, stderr:
      'npm error code ETARGET\nnpm error notarget No matching version found for fake@1.2.1.\nnpm error Error: EPERM: operation not permitted\n' });
  };
  await registryInstall(prefix, 'fake@1.2.1', { ...options, exec });
  assert.ok(registry.logs.some(line => line === 'release-smoke: npm: notarget No matching version found for fake@1.2.1.'));
  assert.ok(registry.logs.some(line => line === 'release-smoke: npm: Error - EPERM: operation not permitted'));
  assert.ok(registry.logs.includes('release-smoke: npm: added 1 package in 1s'));
  const failure = failureLine(new Error('The booted server registered no project'));
  assert.deepEqual(filed([...registry.logs, failure]), [sanitize(failure)]);
});

test('no quoted child output matches a filer selector anywhere in its line', async t => {
  const prefix = mkdtempSync(join(tmpdir(), 'release-smoke-test-'));
  t.after(() => rmSync(prefix, { recursive: true, force: true }));
  const hostile = [
    'npm error npm error notarget missing',
    '\x1b[31mnpm error\x1b[39m notarget missing',
    'see npm error code E404 and npm ERR! here',
    'npm error Error: EPERM: operation not permitted',
    'TypeError: x is not a function',
    'note ##[error]injected annotation',
    ' FAIL  src/a.test.ts > works',
  ];
  const registry = fakeRegistry();
  const options = registry.options();
  let installs = 0;
  const exec = (args, more) => {
    if (args[0] !== 'install') return options.exec(args, more);
    if (++installs > 1) return 'added 1 package in 1s\n';
    throw Object.assign(new Error('Command failed: npm install'), { status: 1, signal: null, stderr: hostile.join('\n') });
  };
  await registryInstall(prefix, 'fake@1.2.1', { ...options, exec });
  assert.ok(registry.logs.includes('release-smoke: npm: notarget missing'), 'nested and coloured npm prefixes are dropped');
  const failure = failureLine(new Error('The booted server registered no project'));
  assert.deepEqual(filed([...registry.logs, failure]), [sanitize(failure)]);
});

test('a child process failure ends on a line the filer reads, not on its `Command failed` wrapper', async t => {
  const prefix = mkdtempSync(join(tmpdir(), 'release-smoke-test-'));
  t.after(() => rmSync(prefix, { recursive: true, force: true }));
  // npm install writes to the inherited stdio, so its error carries no stderr text.
  const registry = fakeRegistry({ installableAt: Infinity });
  const error = await registryInstall(prefix, 'fake@1.2.1', registry.options()).then(() => assert.fail('the install must fail'), caught => caught);
  const install = failureLine(error);
  assert.match(install, /^release-smoke: Error: fake@1\.2\.1 did not install after 300 s \(\d+ attempts\): npm install ended with code 1$/);
  assert.deepEqual(filed([...registry.logs, install]), [sanitize(install)]);
  // A git or tool failure in run() reaches the same line without the deadline wrapper.
  const git = failureLine(Object.assign(new Error('Command failed: git init -q -b main\nfatal: boom'), { status: 128, signal: null }));
  assert.equal(git, 'release-smoke: Error: git init -q -b main ended with code 128');
  assert.deepEqual(filed([git]), [sanitize(git)]);
  const killed = failureLine(Object.assign(new Error('Command failed: npm view fake@1.2.1 version'), { status: null, signal: 'SIGTERM' }));
  assert.equal(killed, 'release-smoke: Error: npm view fake@1.2.1 version ended with signal SIGTERM');
  assert.equal(failureLine(new Error('Command failed: npm view x')), 'release-smoke: Error: npm view x did not complete');
});

// A package whose binary is a tiny server with the routes the smoke reads. Its project
// registry lives in the product home, unless `forget` drops what an older version saved.
const fakeServer = `
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const arg = name => process.argv[process.argv.indexOf(name) + 1];
mkdirSync(process.env.HSQ_HOME, { recursive: true });
const store = join(process.env.HSQ_HOME, 'projects.json');
const saved = !pkg.forget && existsSync(store) ? JSON.parse(readFileSync(store, 'utf8')) : [];
const projects = [...new Set([basename(arg('--repo')), ...saved])];
const save = () => writeFileSync(store, JSON.stringify(projects));
save();
createServer((req, res) => {
  const json = body => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
  if (req.url === '/api/v1/health') return json({ version: pkg.version, projects: projects.map(id => ({ id, name: id })) });
  if (req.url === '/api/v1/projects' && req.method === 'POST') {
    let body = ''; req.on('data', c => { body += c; });
    return req.on('end', () => { projects.push(basename(JSON.parse(body).root)); save(); json({}); });
  }
  if (req.url === '/api/v1/projects') return json({ projects: projects.map(id => ({ id })) });
  if (req.url === '/') return res.end('<script type="module" src="/assets/app.js"></script>');
  if (req.url === '/assets/app.js') { res.setHeader('content-type', 'text/javascript'); return res.end(''); }
  res.statusCode = 404; res.end();
}).listen(Number(arg('--port')), '127.0.0.1');
`;

function fakeInstall({ forget = [] } = {}) {
  return async (prefix, spec) => {
    const at = spec.lastIndexOf('@');
    const [name, version] = [spec.slice(0, at), spec.slice(at + 1)];
    const dir = join(prefix, 'node_modules', ...name.split('/'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, type: 'module', bin: { hsq: 'cli.js' }, forget: forget.includes(version) }));
    writeFileSync(join(dir, 'cli.js'), fakeServer);
  };
}

test('an upgrade boots the old version, saves a project, and the new version keeps it', async () => {
  await run({ name: '@scope/fake', version: '1.2.1-rc.1', upgradeFrom: '1.2.0' }, { install: fakeInstall() });
});

test('an upgrade that loses the saved project fails', async () => {
  await assert.rejects(run({ name: 'fake', version: '1.2.1', upgradeFrom: '1.2.0' }, { install: fakeInstall({ forget: ['1.2.1'] }) }),
    /The upgrade lost projects: saved/);
});

test('a booted version other than the one installed fails', async () => {
  const install = async (prefix, spec) => fakeInstall()(prefix, spec.replace(/@1\.2\.1$/, '@1.2.0'));
  await assert.rejects(run({ name: 'fake', version: '1.2.1' }, { install }), /Booted version 1\.2\.0, expected 1\.2\.1/);
});
