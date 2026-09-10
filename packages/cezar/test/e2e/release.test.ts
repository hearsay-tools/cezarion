import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
// This file lives at packages/cezar/test/e2e; the orchestrator it drives is at the REPO root,
// because a release spans every workspace and belongs to none of them.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const script = join(repoRoot, 'scripts', 'release.mjs');

// The orchestrator imports packages/cezar/dist/release/stable.js, so this suite (like the
// snapshot e2e) runs after `npm run build`.

/** A miniature of the real workspace: the three publishable manifests, in their real
 *  directories, with the same intra-release dependency edges the pipeline has to re-pin. */
async function makeFixture(version = '0.1.5'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cezar-release-'));
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'fake-monorepo', private: true, version: '0.0.0' }, null, 2)}\n`,
  );

  // The contract package joins the stamped set: private, so never published, but versioned in
  // lockstep and depended on by the api-client.
  await mkdir(join(root, 'packages', 'contract'), { recursive: true });
  await writeFile(
    join(root, 'packages', 'contract', 'package.json'),
    `${JSON.stringify({ name: '@scope/fake-contract', version: '0.9.9', private: true, files: ['index.js'] }, null, 2)}\n`,
  );
  await writeFile(join(root, 'packages', 'contract', 'index.js'), 'export {};\n');

  await mkdir(join(root, 'packages', 'api-client'), { recursive: true });
  await writeFile(
    join(root, 'packages', 'api-client', 'package.json'),
    `${JSON.stringify({ name: '@scope/fake-client', version, files: ['index.js'] }, null, 2)}\n`,
  );
  await writeFile(join(root, 'packages', 'api-client', 'index.js'), 'export {};\n');

  await mkdir(join(root, 'packages', 'cezar'), { recursive: true });
  await writeFile(
    join(root, 'packages', 'cezar', 'package.json'),
    `${JSON.stringify(
      {
        name: '@scope/fake-root',
        version,
        files: ['index.js'],
        devDependencies: { '@scope/fake-client': `^${version}` },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(root, 'packages', 'cezar', 'index.js'), 'export {};\n');

  await mkdir(join(root, 'packages', 'web'), { recursive: true });
  await writeFile(
    join(root, 'packages', 'web', 'package.json'),
    `${JSON.stringify(
      {
        name: '@scope/fake-web',
        version,
        private: true,
        dependencies: { '@scope/fake-client': `^${version}` },
        devDependencies: { '@scope/fake-root': `^${version}` },
      },
      null,
      2,
    )}\n`,
  );

  await mkdir(join(root, 'alias-cezarion'));
  await writeFile(
    join(root, 'alias-cezarion', 'package.json'),
    `${JSON.stringify(
      {
        name: 'fake-alias',
        version,
        files: ['bin.js'],
        dependencies: { '@scope/fake-root': `^${version}` },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(root, 'alias-cezarion', 'bin.js'), '#!/usr/bin/env node\n');
  await execFile('git', ['init', '-b', 'main'], { cwd: root });
  await execFile('git', ['add', '.'], { cwd: root });
  await execFile('git', ['-c', 'user.name=Release test', '-c', 'user.email=release@example.test', 'commit', '-m', 'source'], { cwd: root });
  return root;
}

const readPkg = async (root: string, ...segments: string[]) =>
  JSON.parse(await readFile(join(root, ...segments, 'package.json'), 'utf8')) as {
    version: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

function runScript(fixtureRoot: string, args: string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CEZ_RELEASE_ROOT: fixtureRoot,
    GITHUB_OUTPUT: join(fixtureRoot, 'github-output.txt'),
    NODE_AUTH_TOKEN: '',
    GITHUB_ACTIONS: '',
    // Pin these off so a host Actions job with `id-token: write` cannot make
    // the missing-token test see an OIDC path that the fixture never set.
    ACTIONS_ID_TOKEN_REQUEST_URL: '',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: '',
    ...extraEnv,
  };
  return execFile(process.execPath, [script, ...args], { env, maxBuffer: 10 * 1024 * 1024 });
}

async function writeNpmStub(root: string): Promise<{ stub: string; log: string }> {
  const stub = join(root, 'npm-stub.mjs');
  const log = join(root, 'npm-stub.log');
  await writeFile(
    stub,
    `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.NPM_STUB_LOG, \`\${process.argv.slice(2).join(' ')}\\n\`);
`,
  );
  return { stub, log };
}

test('a patch bump stamps every manifest, keeps the caret ranges, and emits the version', { timeout: 120_000 }, async () => {
  const root = await makeFixture('0.1.5');
  try {
    await writeFile(join(root, 'github-output.txt'), '');
    const { stdout } = await runScript(root, ['patch', '--dry-run']);
    assert.match(stdout, /dist-tag latest/);
    // Dependency order: the client is published before the service that depends on it, and the
    // alias last of all. A dependent published first would advertise a version that is not on
    // the registry yet.
    assert.ok(
      stdout.indexOf('@scope/fake-client') < stdout.indexOf('@scope/fake-root'),
      'the api-client must be published before the service',
    );
    assert.ok(
      stdout.indexOf('@scope/fake-root') < stdout.indexOf('fake-alias'),
      'the alias must be published last',
    );

    const clientPkg = await readPkg(root, 'packages', 'api-client');
    const cezarPkg = await readPkg(root, 'packages', 'cezar');
    const webPkg = await readPkg(root, 'packages', 'web');
    const aliasPkg = await readPkg(root, 'alias-cezarion');
    assert.equal(clientPkg.version, '0.1.6');
    assert.equal(cezarPkg.version, '0.1.6');
    assert.equal(webPkg.version, '0.1.6');
    assert.equal(aliasPkg.version, '0.1.6');
    // Caret, not an exact pin — the stable-release contract, on both edges.
    assert.deepEqual(aliasPkg.dependencies, { '@scope/fake-root': '^0.1.6' });
    assert.deepEqual(cezarPkg.devDependencies, { '@scope/fake-client': '^0.1.6' });
    assert.deepEqual(webPkg.dependencies, { '@scope/fake-client': '^0.1.6' });
    assert.deepEqual(webPkg.devDependencies, { '@scope/fake-root': '^0.1.6' });

    // The workspace root publishes nothing and must be left exactly as it was.
    const rootPkg = await readPkg(root);
    assert.equal(rootPkg.version, '0.0.0');

    const output = await readFile(join(root, 'github-output.txt'), 'utf8');
    assert.match(output, /^version=0\.1\.6$/m);
    assert.match(output, /^published=false$/m);
    assert.match(output, /^dryRun=true$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a private package is stamped but never published', { timeout: 120_000 }, async () => {
  const root = await makeFixture('0.1.5');
  try {
    // Mark the client private, the way the api-client is until its contract stops moving.
    const clientPath = join(root, 'packages', 'api-client', 'package.json');
    const clientPkg = JSON.parse(await readFile(clientPath, 'utf8')) as Record<string, unknown>;
    await writeFile(clientPath, `${JSON.stringify({ ...clientPkg, private: true }, null, 2)}\n`);

    await writeFile(join(root, 'github-output.txt'), '');
    const { stdout } = await runScript(root, ['patch', '--dry-run']);

    // Stamped in lockstep — a frozen version would strand the service's pin against it.
    assert.equal((await readPkg(root, 'packages', 'api-client')).version, '0.1.6');
    assert.deepEqual((await readPkg(root, 'packages', 'cezar')).devDependencies, {
      '@scope/fake-client': '^0.1.6',
    });

    // …but never handed to npm, and the skip is stated rather than silent.
    assert.match(stdout, /@scope\/fake-client is private — stamped to 0\.1\.6, not published/);
    assert.ok(
      !/npm publish[^\n]*\(@scope\/fake-client\)/.test(stdout),
      'a private package must not be published',
    );
    assert.match(stdout, /@scope\/fake-web is private — stamped to 0\.1\.6, not published/);
    // The other two still publish.
    assert.match(stdout, /\(@scope\/fake-root\)/);
    assert.match(stdout, /\(fake-alias\)/);

    const output = await readFile(join(root, 'github-output.txt'), 'utf8');
    assert.match(output, /^publishedNames=@scope\/fake-root,fake-alias$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the existing bump publishes the committed version verbatim', { timeout: 120_000 }, async () => {
  const root = await makeFixture('2.3.4');
  try {
    await writeFile(join(root, 'github-output.txt'), '');
    await runScript(root, ['existing', '--dry-run']);
    assert.equal((await readPkg(root, 'packages', 'cezar')).version, '2.3.4');
    const output = await readFile(join(root, 'github-output.txt'), 'utf8');
    assert.match(output, /^version=2\.3\.4$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a missing NPM token forces a dry run instead of publishing', { timeout: 120_000 }, async () => {
  const root = await makeFixture('0.1.5');
  try {
    await writeFile(join(root, 'github-output.txt'), '');
    // No --dry-run flag and no NODE_AUTH_TOKEN: the script must degrade, not publish.
    const { stdout } = await runScript(root, ['minor']);
    assert.match(stdout, /forcing --dry-run/);
    const output = await readFile(join(root, 'github-output.txt'), 'utf8');
    assert.match(output, /^published=false$/m);
    assert.match(output, /^version=0\.2\.0$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('OIDC without a token does not force a dry run and does not pass --provenance', { timeout: 120_000 }, async () => {
  const root = await makeFixture('0.1.5');
  try {
    await writeFile(join(root, 'github-output.txt'), '');
    const { stub, log } = await writeNpmStub(root);
    const { stdout } = await runScript(root, ['patch'], {
      NODE_AUTH_TOKEN: '',
      GITHUB_ACTIONS: 'true',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/oidc',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fake-oidc',
      npm_execpath: stub,
      NPM_STUB_LOG: log,
    });
    assert.doesNotMatch(stdout, /forcing --dry-run/);
    const output = await readFile(join(root, 'github-output.txt'), 'utf8');
    assert.match(output, /^published=true$/m);
    const npmArgs = await readFile(log, 'utf8');
    assert.match(npmArgs, /^publish /m);
    assert.doesNotMatch(npmArgs, /--dry-run/);
    // Trusted publishing generates provenance itself; a second --provenance is a duplicate.
    assert.doesNotMatch(npmArgs, /--provenance/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a token publish from Actions still passes --provenance', { timeout: 120_000 }, async () => {
  const root = await makeFixture('0.1.5');
  try {
    await writeFile(join(root, 'github-output.txt'), '');
    const { stub, log } = await writeNpmStub(root);
    await runScript(root, ['patch'], {
      NODE_AUTH_TOKEN: 'npm_fake_token',
      GITHUB_ACTIONS: 'true',
      npm_execpath: stub,
      NPM_STUB_LOG: log,
    });
    const npmArgs = await readFile(log, 'utf8');
    assert.match(npmArgs, /--provenance/);
    assert.doesNotMatch(npmArgs, /--dry-run/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a mid-set collision skips the already-published name and publishes the rest', { timeout: 120_000 }, async () => {
  const root = await makeFixture('0.1.5');
  try {
    await writeFile(join(root, 'github-output.txt'), '');
    const stub = join(root, 'npm-stub.mjs');
    const log = join(root, 'npm-stub.log');
    await writeFile(
      stub,
      `import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2);
appendFileSync(process.env.NPM_STUB_LOG, \`\${process.cwd()} \${args.join(' ')}\\n\`);
if (args[0] === 'view') {
  const spec = args[1] ?? '';
  if (spec === '@scope/fake-root@0.1.6') {
    process.stdout.write(JSON.stringify({ version: '0.1.6', gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }));
    process.exit(0);
  }
  process.exit(1);
}
if (args[0] === 'publish' && process.cwd().includes('packages/cezar')) {
  process.stderr.write('npm error code E403\\n');
  process.exit(1);
}
`,
    );
    const { stdout } = await runScript(root, ['patch'], {
      NODE_AUTH_TOKEN: 'npm_fake_token',
      GITHUB_ACTIONS: 'true',
      npm_execpath: stub,
      NPM_STUB_LOG: log,
    });
    assert.match(stdout, /@scope\/fake-root@0\.1\.6 already on the registry — skipping/);
    assert.match(stdout, /npm publish[^\n]*\(@scope\/fake-client\)/);
    assert.match(stdout, /npm publish[^\n]*\(fake-alias\)/);
    const output = await readFile(join(root, 'github-output.txt'), 'utf8');
    assert.match(output, /^published=true$/m);
    assert.match(output, /^publishedNames=@scope\/fake-client,@scope\/fake-root,fake-alias$/m);
    const npmArgs = await readFile(log, 'utf8');
    assert.match(npmArgs, /view @scope\/fake-root@0\.1\.6 version/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a publish failure that is not already on the registry still aborts', { timeout: 120_000 }, async () => {
  const root = await makeFixture('0.1.5');
  try {
    await writeFile(join(root, 'github-output.txt'), '');
    const stub = join(root, 'npm-stub.mjs');
    const log = join(root, 'npm-stub.log');
    await writeFile(
      stub,
      `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.NPM_STUB_LOG, \`\${process.cwd()} \${args.join(' ')}\\n\`);
if (args[0] === 'view') process.exit(1);
if (args[0] === 'publish' && process.cwd().includes('alias-cezarion')) {
  process.stderr.write('npm error code E404\\n');
  process.stderr.write('404 Not Found - PUT https://registry.npmjs.org/fake-alias - Not found\\n');
  process.exit(1);
}
`,
    );
    await assert.rejects(
      runScript(root, ['patch'], {
        NODE_AUTH_TOKEN: 'npm_fake_token',
        GITHUB_ACTIONS: 'true',
        npm_execpath: stub,
        NPM_STUB_LOG: log,
      }),
    );
    const output = await readFile(join(root, 'github-output.txt'), 'utf8');
    assert.doesNotMatch(output, /^published=true$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an unknown bump exits non-zero without touching the manifests', { timeout: 60_000 }, async () => {
  const root = await makeFixture('0.1.5');
  try {
    await writeFile(join(root, 'github-output.txt'), '');
    await assert.rejects(runScript(root, ['snapshot', '--dry-run']));
    assert.equal((await readPkg(root, 'packages', 'cezar')).version, '0.1.5');
    assert.equal((await readPkg(root, 'packages', 'api-client')).version, '0.1.5');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const recordedHead of ['different', 'missing', 'matching']) {
  test(`an existing publication with ${recordedHead} source is verified before finalization`, async () => {
    const root = await makeFixture();
    try {
      const { stdout: head } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: root });
      const gitHead = recordedHead === 'matching' ? head.trim() : 'a'.repeat(40);
      const metadata = {
        version: '0.1.6',
        ...(recordedHead === 'missing' ? {} : { gitHead }),
      };
      const stub = join(root, 'npm-stub.mjs');
      await writeFile(stub, `
if (process.argv[2] === 'publish') process.exit(1);
if (process.argv[2] === 'view') console.log(process.argv.includes('gitHead') ? ${JSON.stringify(JSON.stringify(metadata))} : '0.1.6');
`);
      await writeFile(join(root, 'github-output.txt'), '');
      const run = runScript(root, ['patch'], { NODE_AUTH_TOKEN: 'fake', npm_execpath: stub });
      if (recordedHead === 'matching') {
        await run;
        assert.match(await readFile(join(root, 'github-output.txt'), 'utf8'), /^published=true$/m);
      } else {
        await assert.rejects(run, /published source|source commit/i);
        assert.doesNotMatch(await readFile(join(root, 'github-output.txt'), 'utf8'), /^published=true$/m);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
