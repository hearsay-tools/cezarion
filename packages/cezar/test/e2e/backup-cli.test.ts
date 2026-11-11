import { emitProbe } from '../fixtures/emit-probe.ts';
import { Home } from '../../src/home/home.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

// Exercise the built CLI dispatch and writer path with a pre-change JSON file.
test('backup list and restore work without a cockpit', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cez-backup-cli-'));
  const env = { ...process.env, CEZ_HOME: home, HSQ_HOME: home };
  try {
    const cli = resolve('dist/index.js');
    const call = (...args: string[]) => execFileSync(process.execPath, [cli, 'backup', ...args], { env, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(call('list')), []);
    const sandbox = Home.sandbox(home);
    const accounts = sandbox.agentAccounts;
    Home.seed(sandbox, accounts, { version: 1, accounts: [], legacy: 'before' });
    const probe = join(home, 'backup-probe.mjs');
    const bootstrap = join(home, 'backup-smoke.mjs');
    await emitProbe(new URL('../fixtures/backup-accounts-probe.ts', import.meta.url), probe);
    writeFileSync(bootstrap, `
      import { probe } from './backup-probe.mjs';
      import { mergeWriteAgentAccounts } from ${JSON.stringify(pathToFileURL(resolve('dist/workspace/agent-accounts.js')).href)};
      import { resolveHome } from ${JSON.stringify(pathToFileURL(resolve('dist/home/resolve.js')).href)};
      await probe({ mergeWriteAgentAccounts, resolveHome }, process.argv[2]);
    `);
    execFileSync(process.execPath, [bootstrap, 'after'], { env });
    const entries = JSON.parse(call('list', 'agent-accounts.json'));
    assert.equal(entries.length, 1);
    call('restore', 'agent-accounts.json', '--at', entries[0].time);
    assert.equal(JSON.parse(readFileSync(accounts, 'utf8')).legacy, 'before');
    assert.equal(JSON.parse(call('list', 'agent-accounts.json')).length, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
