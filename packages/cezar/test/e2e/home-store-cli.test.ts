import { resolveHome } from '../../src/home/resolve.ts'; // test-home-read: resolve scratch paths after the CLI; constructing a sandbox would write a marker
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Home } from '../../src/home/home.ts';

function cleanEnv(home: string): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !['VITEST', 'NODE_TEST_CONTEXT', 'JEST_WORKER_ID', 'NODE_OPTIONS'].includes(name) && !name.startsWith('STRYKER_') && !name.startsWith('CEZ_') && !name.startsWith('HSQ_'))), CEZ_HOME: home, CEZ_DRY_RUN: '1' };
}

test('operator commands bootstrap unmarked homes and retain their write contracts', () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-home-cli-'));
  const cli = resolve('dist/index.js');
  const repo = join(root, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Tests', '-c', 'user.email=tests@cezar.invalid', 'commit', '-qm', 'fixture'], { cwd: repo });
  const run = (home: string, args: string[], env = cleanEnv(home)) => execFileSync(process.execPath, [cli, ...args], {
    env, encoding: 'utf8', timeout: 60_000, // bound: one dry workflow or operator CLI must terminate.
  });
  try {
    const commands: Array<[string, string[]]> = [
      ['run', ['run', 'mock:cezar-done', '--repo', repo]],
      ['projects', ['projects', 'add', repo]],
      ['remote', ['remote-settings', 'enable', '--port', '4321']],
    ];
    for (const [name, args] of commands) {
      const home = join(root, name);
      run(home, args);
      const selected = resolveHome({ purpose: 'cli', env: cleanEnv(home) }); // test-home-read: resolve scratch paths after the CLI; constructing a sandbox would write a marker
      assert.equal(JSON.parse(readFileSync(join(selected.config, 'install.json'), 'utf8')).kind, 'live', name);
      const config = name === 'remote' ? join(selected.remoteSettings, '4321.json') : selected.workspaceConfig;
      assert.ok(readFileSync(config).length > 0, name);
    }
    const backupHome = Home.sandbox(join(root, 'backup'));
    Home.seed(backupHome, backupHome.agentAccounts, { version: 1, accounts: [], value: 'old' });
    Home.seed(backupHome, backupHome.agentAccounts, { version: 1, accounts: [], value: 'new' });
    // Deliberately model a pre-marker install; its existing files and backups are upgrade input.
    rmSync(join(backupHome.root, 'install.json'));
    run(backupHome.rootOverride ?? backupHome.root, ['backup', 'restore', 'agent-accounts.json']);
    assert.equal(JSON.parse(readFileSync(join(backupHome.root, 'install.json'), 'utf8')).kind, 'live');
    assert.equal(JSON.parse(readFileSync(backupHome.agentAccounts, 'utf8')).value, 'old');

    const testHome = join(root, 'test-child');
    const env = { ...cleanEnv(testHome), NODE_TEST_CONTEXT: 'child-v8' };
    run(testHome, ['projects', 'add', repo], env);
    run(testHome, ['projects', 'add', repo], env);
    assert.equal(JSON.parse(readFileSync(join(resolveHome({ purpose: 'cli', env }).config, 'install.json'), 'utf8')).kind, 'test'); // test-home-read: resolve scratch paths after the CLI; constructing a sandbox would write a marker
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('read-only and invalid conditional commands leave a fresh home untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-home-cli-read-'));
  const cli = resolve('dist/index.js');
  const commands = [
    ['projects', 'list'], ['remote-settings', '--help'], ['install', '--invalid-option'],
    ['update', '--channel', 'invalid'], ['use'], ['link', join(root, 'missing')], ['unlink'],
    ['server-install', '--platform', 'invalid'], ['server-deploy', '--platform', 'invalid'],
    ['server-uninstall', '--platform', 'invalid'], ['backup', 'list'],
  ];
  try {
    for (const [index, args] of commands.entries()) {
      const home = join(root, String(index));
      try {
        execFileSync(process.execPath, [cli, ...args], { env: cleanEnv(home), stdio: 'pipe',
          timeout: 60_000, // bound: invalid commands must return without starting host services.
        });
      } catch (error) {
        assert.equal((error as { status?: number }).status, 1, args.join(' '));
      }
      assert.deepEqual(existsSync(home) ? readdirSync(home) : [], [], args.join(' '));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
