import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { releasePackages, packChecks, cleanupTags } = require('../.github/scripts/release-packages.cjs');
const { RELEASE_BUMP_FILE_RE, releaseBumpPaths } = require('../.github/scripts/release-bump-pr.cjs');
const { compatibilityEntry, COMPATIBILITY_ENTRIES } = require('../packages/cezar/src/release/compatibility.ts');
const { validateArchives } = require('../.github/scripts/pr-snapshot.cjs');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'release-identity-'));
  const put = (file, bytes) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), bytes);
  };
  put('package.json', '{"private":true,"type":"module"}\n');
  for (const module of ['home/identity.ts', 'release/manifests.ts', 'release/publication.ts',
    'release/compatibility.ts', 'release/stable.ts', 'release/snapshot.ts', 'core/product-env.ts']) {
    put(`packages/cezar/src/${module}`, readFileSync(join(root, 'packages/cezar/src', module)));
  }
  for (const script of ['release.mjs', 'release-snapshot.mjs']) {
    put(`scripts/${script}`, readFileSync(join(root, 'scripts', script), 'utf8')
      .replaceAll('/dist/', '/src/').replaceAll(/(from '[^']+)\.js';/g, "$1.ts';"));
  }
  const names = { contract: '@open-mercato/cezar-contract', apiClient: '@open-mercato/cezar-api-client',
    cezar: '@wjarka/cezarion', web: '@open-mercato/cezar-web' };
  for (const [key, name] of Object.entries(names)) {
    const folder = key === 'apiClient' ? 'api-client' : key;
    const pkg = { name, version: '1.2.3', private: key !== 'cezar', files: ['entry.js'] };
    if (key === 'web') pkg.devDependencies = { '@wjarka/cezarion': '^1.2.3' };
    put(`packages/${folder}/package.json`, `${JSON.stringify(pkg, null, 2)}\n`);
    put(`packages/${folder}/entry.js`, 'export {};\n');
  }
  put('packages/cezar/web/dist/index.html', 'real cockpit');
  put('npm-cli.js', `import { appendFileSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (!['publish','pack'].includes(args[0]) || (args[0] === 'publish' && !args.includes('--dry-run'))) throw Error('registry mutation');
const pkg = JSON.parse(readFileSync('package.json'));
appendFileSync(process.env.CALLS, JSON.stringify({args, pkg, cwd:process.cwd()})+'\\n');
if (args[0] === 'pack') {
  const dest = args[args.indexOf('--pack-destination')+1];
  mkdirSync(dest,{recursive:true}); writeFileSync(join(dest,'packed.tgz'),'stub');
  console.log(JSON.stringify([{filename:'packed.tgz'}]));
}
`);
  return dir;
}

const channels = {
  stable: { script: 'release.mjs', args: ['patch', '--dry-run'], tag: 'latest', version: '1.2.4', env: {} },
  dev: { tag: 'dev', version: '1.2.3-dev.9', env: { GITHUB_EVENT_NAME: 'push' } },
  nightly: { tag: 'nightly', version: '1.2.3-nightly.20261108.9', env: { GITHUB_EVENT_NAME: 'schedule', HSQ_RELEASE_CHANNEL: 'nightly' } },
  pr: { tag: 'pr-7', version: '1.2.3-pr7.9', env: { GITHUB_EVENT_NAME: 'pull_request_target' } },
};

function run(dir, channel, packOnly = false) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(CEZ_|HSQ_|GITHUB_|ACTIONS_ID_TOKEN_|NODE_AUTH_TOKEN)/.test(key)));
  return execFileSync(process.execPath, [join(dir, 'scripts', channel.script || 'release-snapshot.mjs'),
    ...(packOnly ? ['--pack-only'] : channel.args || ['--dry-run'])], {
    cwd: dir, encoding: 'utf8', env: { ...env,
      HSQ_RELEASE_ROOT: dir, HSQ_SNAPSHOT_ROOT: dir, CALLS: join(dir, 'calls.ndjson'),
      npm_execpath: join(dir, 'npm-cli.js'), GITHUB_REF_NAME: 'main', GITHUB_RUN_NUMBER: '9',
      GITHUB_RUN_ATTEMPT: '1', PR_NUMBER: '7', PR_HEAD_REPO: 'o/n', GITHUB_REPOSITORY: 'o/n',
      NIGHTLY_DATE: '20261108', ...channel.env,
    },
  });
}

function releaseSnapshot(dir, calls) {
  const manifests = {};
  for (const folder of ['packages/contract', 'packages/api-client', 'packages/cezar', 'packages/web']) {
    manifests[folder] = readFileSync(join(dir, folder, 'package.json'), 'utf8');
  }
  return { manifests, calls: calls.map(call => ({ ...call, cwd: relative(dir, call.cwd) })) };
}

for (const [name, channel] of Object.entries(channels)) {
  test(`${name} release publishes the new package and the compatibility packages`, () => {
    const dir = fixture();
    try {
      const stdout = run(dir, channel);
      const calls = readFileSync(join(dir, 'calls.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
      // npm refuses the unscoped name `hsq`, so the new identity publishes no alias package.
      assert.deepEqual(calls.map(c => c.pkg.name), ['@hearsay-tools/squawk', '@wjarka/cezarion', 'cezarion']);
      assert.deepEqual(calls.map(c => c.args), Array(3).fill(['publish', '--tag', channel.tag, '--access', 'public', '--ignore-scripts', '--dry-run']));
      const range = name === 'stable' ? `^${channel.version}` : channel.version;
      assert.equal(calls[0].pkg.version, channel.version);
      const result = JSON.parse(stdout.match(/result: (\{.*\})$/m)[1]);
      const command = `npx -p @hearsay-tools/squawk@${channel.version} hsq`;
      if (name === 'stable') assert.equal(result.runCommand, command);
      else assert.ok(result.installLines.every(line => line.startsWith(`${command} `)), result.installLines.join('\n'));
      for (const call of calls.slice(1)) {
        assert.deepEqual(call.pkg.dependencies, { [calls[0].pkg.name]: channel.version,
          ...(call.pkg.name === 'cezarion' ? { '@wjarka/cezarion': channel.version } : {}) });
        assert.deepEqual(call.pkg.bin, { cezarion: 'dist/index.js', cez: 'dist/index.js', hsq: 'dist/hsq.js' });
      }
      const source = readFileSync(join(dir, 'packages/cezar/package.json'), 'utf8');
      assert.equal(JSON.parse(source).name, '@wjarka/cezarion');
      assert.equal(JSON.parse(readFileSync(join(dir, 'packages/web/package.json'))).devDependencies['@wjarka/cezarion'], range);
      const snapshot = releaseSnapshot(dir, calls.map(call => {
        const { gitHead: _source, ...pkg } = call.pkg;
        const cwd = pkg.name === '@hearsay-tools/squawk' ? join(dir, '<publication>')
          : join(dir, '<compatibility>', pkg.name === 'cezarion' ? 'legacyAlias' : 'legacyScoped');
        return { ...call, pkg, cwd };
      }));
      const file = join(root, 'scripts/fixtures/release-identity', `${name}.json`);
      if (process.env.UPDATE_RELEASE_SNAPSHOTS === '1') writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
      assert.deepEqual(snapshot, JSON.parse(readFileSync(file)));
      assert.match(stdout, /publishedNames/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('renamed stable publication requires the source commit before calling npm', () => {
  const dir = fixture();
  try {
    assert.throws(() => run(dir, { script: 'release.mjs', args: ['patch'],
      env: { NODE_AUTH_TOKEN: 'fixture-token', GIT_DIR: join(dir, 'missing-git') } }),
      /not a git repository/);
    assert.equal(existsSync(join(dir, 'calls.ndjson')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('renamed stable publication carries the verified source commit into its npm manifest', () => {
  const dir = fixture();
  try {
    const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
    git(['init']);
    git(['-c', 'user.name=Release test', '-c', 'user.email=release@example.test', 'commit', '--allow-empty', '-m', 'source']);
    const source = git(['rev-parse', 'HEAD']);
    // This local npm stub records publication data. It never loads registry code.
    writeFileSync(join(dir, 'npm-cli.js'), `import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] !== 'publish') throw Error('unexpected npm operation');
appendFileSync(process.env.CALLS, JSON.stringify(JSON.parse(readFileSync('package.json')))+'\\n');
`);
    run(dir, { script: 'release.mjs', args: ['patch'], env: { NODE_AUTH_TOKEN: 'fixture-token' } });
    const published = readFileSync(join(dir, 'calls.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(published[0].gitHead, source);
    assert.equal(published[0].name, '@hearsay-tools/squawk');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('trusted PR archives accept only the projected identity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'identity-archives-'));
    try {
      const manifests = releasePackages(root).publication;
      const version = '1.2.3-pr7.9';
      const artifacts = join(dir, 'archives');
      mkdirSync(artifacts);
      const pack = (key, pkg, entry, missing) => {
        const folder = join(dir, key);
        rmSync(folder, { recursive: true, force: true });
        mkdirSync(join(folder, 'package'), { recursive: true });
        writeFileSync(join(folder, 'package/package.json'), JSON.stringify(pkg));
        if (key.startsWith('legacy')) {
          mkdirSync(join(folder, 'package/dist'), { recursive: true });
          for (const file of COMPATIBILITY_ENTRIES) {
            if (file !== missing) writeFileSync(join(folder, 'package', file), entry ?? compatibilityEntry());
          }
        }
        execFileSync('tar', ['-czf', join(artifacts, `${key}.tgz`), '-C', folder, 'package']);
      };
      pack('cezar', { name: manifests.cezar.name, version });
      for (const key of ['legacyScoped', 'legacyAlias']) {
        if (manifests[key]) {
          const pkg = { ...manifests[key], version, dependencies: Object.fromEntries(Object.keys(manifests[key].dependencies).map(name => [name, version])) };
          pack(key, pkg);
        }
      }
      const options = { artifacts, manifests, plan: { pr: 7, runNumber: 9, attempt: 1 } };
      assert.deepEqual(validateArchives(options).map(e => e.pkg.name), Object.values(manifests).filter(pkg => !pkg.private).map(pkg => pkg.name));
      const pkg = { ...manifests.legacyScoped, version, dependencies: { [manifests.cezar.name]: version } };
      pack('legacyScoped', { ...pkg, dependencies: { [manifests.cezar.name]: `^${version}` } });
      assert.throws(() => validateArchives(options), /Invalid forwarding manifest/);
      pack('legacyScoped', pkg, 'console.error("second notice");');
      assert.throws(() => validateArchives(options), /Invalid forwarding entry/);
      pack('legacyScoped', pkg);
      const alias = { ...manifests.legacyAlias, version, dependencies: Object.fromEntries(Object.keys(manifests.legacyAlias.dependencies).map(name => [name, version])) };
      pack('legacyAlias', { ...alias, dependencies: { [manifests.cezar.name]: version } });
      assert.throws(() => validateArchives(options), /Invalid forwarding manifest/);
      pack('legacyAlias', alias, undefined, 'bin.js');
      assert.throws(() => validateArchives(options), /Command failed/);
      pack('legacyAlias', alias);
      // The source workspace name is not a publication identity.
      pack('cezar', { name: '@wjarka/cezarion', version });
      assert.throws(() => validateArchives(options), /Unexpected snapshot package identity/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PR pack paths and artifact names', () => {
  const dir = fixture();
  try {
    run(dir, channels.pr, true);
    const calls = readFileSync(join(dir, 'calls.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls.map(c => c.pkg.name), ['@hearsay-tools/squawk', '@wjarka/cezarion', 'cezarion']);
    assert.deepEqual(calls.map(c => c.args), Array(3).fill(['pack', '--ignore-scripts', '--json', '--pack-destination', join(dir, 'snapshot-artifacts')]));
    assert.equal(readFileSync(join(dir, 'snapshot-artifacts/cezar.tgz'), 'utf8'), 'stub');
    assert.deepEqual(require('node:fs').readdirSync(join(dir, 'snapshot-artifacts')).sort(),
      ['cezar', 'legacyScoped', 'legacyAlias'].map(key => `${key}.tgz`).sort());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CI packs and cleanup use the new identity and the compatibility packages', () => {
  const dir = fixture();
  try {
    const calls = [];
    packChecks({ root: dir, execute: (cmd, args, options) => calls.push({ cmd, args, options, bytes: readFileSync(join(options.cwd, 'package.json'), 'utf8') }) });
    assert.equal(calls.length, 3);
    assert.equal(calls[0].cmd, 'npm');
    assert.deepEqual(calls[0].args, ['pack', '--dry-run', '--ignore-scripts']);
    assert.equal(JSON.parse(calls[0].bytes).name, '@hearsay-tools/squawk');
    assert.deepEqual(calls[1].args, ['pack', '--dry-run', '--ignore-scripts']);
    assert.equal('alias' in releasePackages(dir).dirs, false);
    assert.equal(RELEASE_BUMP_FILE_RE.test('alias-cezarion/package.json'), false);
    assert.equal(RELEASE_BUMP_FILE_RE.test('packages/cezar/package.json'), true);
    assert.deepEqual(releaseBumpPaths(), ['packages/*/package.json', 'pnpm-lock.yaml']);
    const cleanup = [];
    const names = cleanupTags({ root: dir, tag: 'pr-7', execute: (cmd, args) => cleanup.push({ cmd, args }) });
    assert.deepEqual(names, ['@hearsay-tools/squawk', '@open-mercato/cezar-api-client', '@wjarka/cezarion', 'cezarion']);
    assert.deepEqual(cleanup.map(c => c.args), names.map(pkg => ['dist-tag', 'rm', pkg, 'pr-7']));
    assert.deepEqual(cleanupTags({ root: dir, tag: 'pr-7', dryRun: true, execute: () => assert.fail('dry cleanup executed npm') }), names);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
