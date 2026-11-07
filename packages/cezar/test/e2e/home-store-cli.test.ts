import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Home } from '../../src/home/home.ts';

function cleanEnv(home: string): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !['VITEST', 'NODE_TEST_CONTEXT', 'JEST_WORKER_ID', 'NODE_OPTIONS'].includes(name) && !name.startsWith('STRYKER_') && !name.startsWith('CEZ_'))), CEZ_HOME: home, CEZ_DRY_RUN: '1' };
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
      ['update', ['update', '--channel', 'development']],
    ];
    for (const [name, args] of commands) {
      const home = join(root, name);
      run(home, args);
      assert.equal(JSON.parse(readFileSync(join(home, 'install.json'), 'utf8')).kind, 'live', name);
      const config = name === 'remote' ? join(home, 'remote-settings/4321.json') : join(home, 'config.json');
      assert.ok(readFileSync(config).length > 0, name);
    }
    const backupHome = Home.sandbox(join(root, 'backup'));
    Home.seed(backupHome, backupHome.agentAccounts, { version: 1, accounts: [], value: 'old' });
    Home.seed(backupHome, backupHome.agentAccounts, { version: 1, accounts: [], value: 'new' });
    // Deliberately model a pre-marker install; its existing files and backups are upgrade input.
    rmSync(join(backupHome.root, 'install.json'));
    run(backupHome.root, ['backup', 'restore', 'agent-accounts.json']);
    assert.equal(JSON.parse(readFileSync(join(backupHome.root, 'install.json'), 'utf8')).kind, 'live');
    assert.equal(JSON.parse(readFileSync(backupHome.agentAccounts, 'utf8')).value, 'old');

    const testHome = join(root, 'test-child');
    const env = { ...cleanEnv(testHome), NODE_TEST_CONTEXT: 'child-v8' };
    run(testHome, ['update', '--channel', 'development'], env);
    run(testHome, ['update', '--channel', 'development'], env);
    assert.equal(JSON.parse(readFileSync(join(testHome, 'install.json'), 'utf8')).kind, 'test');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
