const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const action = require('../actions/node-dist/index.cjs');

const VERSION = '26.13.0';
const FILE = `node-v${VERSION}-linux-x64.tar.gz`;

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-dist-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A release archive with nodejs.org's layout: one top folder holding bin/node.
function fakeArchive(dir) {
  const top = path.join(dir, `node-v${VERSION}-linux-x64`);
  fs.mkdirSync(path.join(top, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(top, 'bin', 'node'), '#!/bin/sh\necho fake\n');
  execFileSync('tar', ['-czf', path.join(dir, FILE), '-C', dir, path.basename(top)]);
  return fs.readFileSync(path.join(dir, FILE));
}

async function serve(t, files) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const body = files[req.url];
    res.writeHead(body === undefined ? 404 : 200);
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { distUrl: `http://127.0.0.1:${server.address().port}/dist`, requests };
}

function sums(archive) {
  return `${'0'.repeat(64)}  node-v${VERSION}-darwin-arm64.tar.gz\n`
    + `${crypto.createHash('sha256').update(archive).digest('hex')}  ${FILE}\n`;
}

const quiet = () => {};

test('installs a checked release into the layout setup-node looks up, then reuses it without a request', async (t) => {
  const work = tempDir(t);
  const archive = fakeArchive(work);
  const { distUrl, requests } = await serve(t, {
    [`/dist/v${VERSION}/SHASUMS256.txt`]: sums(archive),
    [`/dist/v${VERSION}/${FILE}`]: archive,
  });
  const toolCache = path.join(work, 'toolcache');
  const options = { version: VERSION, platform: 'linux', arch: 'x64', toolCache, tempDir: work, distUrl, log: quiet };

  const installed = await action.install(options);

  assert.equal(installed, path.join(toolCache, 'node', VERSION, 'x64'));
  assert.equal(fs.readFileSync(path.join(installed, 'bin', 'node'), 'utf8'), '#!/bin/sh\necho fake\n');
  assert.ok(fs.existsSync(`${installed}.complete`), 'tool-cache find() needs the .complete marker');
  assert.equal(fs.existsSync(path.join(work, FILE)), false, 'the downloaded archive is removed');
  assert.deepEqual(requests, [`/dist/v${VERSION}/SHASUMS256.txt`, `/dist/v${VERSION}/${FILE}`]);

  await action.install(options);
  assert.equal(requests.length, 2, 'a version already in the tool cache needs no download');
});

test('an archive whose SHA-256 differs from SHASUMS256.txt is retried once and never installed', async (t) => {
  const work = tempDir(t);
  const archive = fakeArchive(work);
  const { distUrl, requests } = await serve(t, {
    [`/dist/v${VERSION}/SHASUMS256.txt`]: sums(Buffer.from('another archive')),
    [`/dist/v${VERSION}/${FILE}`]: archive,
  });
  const toolCache = path.join(work, 'toolcache');

  await assert.rejects(
    action.install({ version: VERSION, platform: 'linux', arch: 'x64', toolCache, tempDir: work, distUrl, log: quiet }),
    /SHA-256 of .* SHASUMS256\.txt says/,
  );
  assert.equal(requests.filter((url) => url.endsWith(FILE)).length, 2);
  assert.equal(fs.existsSync(path.join(toolCache, 'node', VERSION)), false);
});

test('a stalled download is aborted after the attempt timeout and retried once', async (t) => {
  const work = tempDir(t);
  const requests = [];
  const stalled = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200);
    res.write('partial');
    stalled.push(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const res of stalled) res.destroy(); server.close(); });
  const distUrl = `http://127.0.0.1:${server.address().port}/dist`;

  await assert.rejects(
    action.install({ version: VERSION, platform: 'linux', arch: 'x64', toolCache: path.join(work, 'tc'), tempDir: work, distUrl, timeoutMs: 50, log: quiet }),
    { name: 'TimeoutError' },
  );
  assert.deepEqual(requests, [`/dist/v${VERSION}/SHASUMS256.txt`, `/dist/v${VERSION}/SHASUMS256.txt`]);
  assert.equal(action.ATTEMPTS, 2, 'one retry, as the former setup-node retry step (hearsay-tools/cezarion#1214)');
});

test('a release missing from SHASUMS256.txt fails before any archive download', async (t) => {
  const work = tempDir(t);
  const { distUrl, requests } = await serve(t, { [`/dist/v${VERSION}/SHASUMS256.txt`]: `${'a'.repeat(64)}  other.tar.gz\n` });

  await assert.rejects(
    action.install({ version: VERSION, platform: 'linux', arch: 'x64', toolCache: path.join(work, 'tc'), tempDir: work, distUrl, log: quiet }),
    /SHASUMS256\.txt has no entry for node-v26\.13\.0-linux-x64\.tar\.gz/,
  );
  assert.deepEqual(requests, [`/dist/v${VERSION}/SHASUMS256.txt`]);
});

test('versions must be exact, as setup-node reads them from a version file', () => {
  assert.equal(action.parseVersion('26.13.0\n'), '26.13.0');
  assert.equal(action.parseVersion('v24.21.0'), '24.21.0');
  assert.equal(action.parseVersion('node 24.21.0\n'), '24.21.0');
  for (const spec of ['lts/*', '24', '24.x', '']) {
    assert.throws(() => action.parseVersion(spec), /needs an exact Node\.js version/);
  }
  assert.throws(() => action.resolveVersion({}), /set node-version or node-version-file/);
});

test('node-version wins over node-version-file, which is read from the workspace', (t) => {
  const work = tempDir(t);
  fs.writeFileSync(path.join(work, '.node-version'), '26.13.0\n');
  assert.equal(action.resolveVersion({ versionFile: '.node-version', workspace: work }), '26.13.0');
  assert.equal(action.resolveVersion({ version: '24.21.0', versionFile: '.node-version', workspace: work }), '24.21.0');
});

test('archive names and tool-cache paths follow nodejs.org and setup-node on each runner platform', () => {
  assert.equal(action.archiveName('24.21.0', 'linux', 'x64'), 'node-v24.21.0-linux-x64.tar.gz');
  assert.equal(action.archiveName('24.21.0', 'darwin', 'arm64'), 'node-v24.21.0-darwin-arm64.tar.gz');
  assert.equal(action.archiveName('24.21.0', 'win32', 'x64'), 'node-v24.21.0-win-x64.zip');
  assert.equal(action.archiveName('24.21.0', 'linux', 'arm'), 'node-v24.21.0-linux-armv7l.tar.gz');
  assert.throws(() => action.archiveName('24.21.0', 'aix', 'ppc64'), /no Node\.js archive for platform aix/);
  assert.equal(action.toolDir('/tc', '24.21.0', 'arm'), path.join('/tc', 'node', '24.21.0', 'armv7l'));
});

test('main writes the resolved version as a step output', async (t) => {
  const work = tempDir(t);
  const toolCache = path.join(work, 'tc');
  const installed = action.toolDir(toolCache, VERSION, os.arch());
  fs.mkdirSync(installed, { recursive: true });
  fs.writeFileSync(`${installed}.complete`, '');
  const output = path.join(work, 'output');
  t.mock.method(console, 'log', quiet);

  await action.main({ 'INPUT_NODE-VERSION': `v${VERSION}`, RUNNER_TOOL_CACHE: toolCache, RUNNER_TEMP: work, GITHUB_OUTPUT: output });

  assert.equal(fs.readFileSync(output, 'utf8'), `node-version=${VERSION}\n`);
  await assert.rejects(action.main({ 'INPUT_NODE-VERSION': VERSION }), /RUNNER_TOOL_CACHE is not set/);
});
