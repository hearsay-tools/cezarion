import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootEnv, cockpitAsset, parseArgs, run } from './release-smoke.mjs';

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
