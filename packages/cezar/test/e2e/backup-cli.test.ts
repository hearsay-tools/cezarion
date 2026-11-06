import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

// Exercise the built CLI dispatch and writer path with a pre-change JSON file.
test('backup list and restore work without a cockpit', () => {
  const home = mkdtempSync(join(tmpdir(), 'cez-backup-cli-'));
  const env = { ...process.env, CEZ_HOME: home };
  try {
    const cli = resolve('dist/index.js');
    const call = (...args: string[]) => execFileSync(process.execPath, [cli, 'backup', ...args], { env, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(call('list')), []);
    const accounts = join(home, 'agent-accounts.json');
    writeFileSync(accounts, '{"version":1,"accounts":[],"legacy":"before"}');
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { mergeWriteAgentAccounts } from './dist/workspace/agent-accounts.js';
      await mergeWriteAgentAccounts(store => { store.legacy = 'after'; });
    `], { env });
    const entries = JSON.parse(call('list', 'agent-accounts.json'));
    assert.equal(entries.length, 1);
    call('restore', 'agent-accounts.json', '--at', entries[0].time);
    assert.equal(JSON.parse(readFileSync(accounts, 'utf8')).legacy, 'before');
    assert.equal(JSON.parse(call('list', 'agent-accounts.json')).length, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
