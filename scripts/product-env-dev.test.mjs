import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
test('dev launcher pins both port aliases over the ambient preferred port', async () => {
  const root = mkdtempSync(join(tmpdir(), 'env-dev-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({type: 'commonjs'}));
  const log = join(root, 'ports.jsonl');
  const cli = join(root, 'npm-cli.js');
  writeFileSync(cli, `const fs = require('node:fs');
const script = process.argv[3];
fs.appendFileSync(process.env.DEV_PORT_LOG, JSON.stringify({script, old: process.env.CEZ_API_PORT, preferred: process.env.HSQ_API_PORT}) + '\\n');
if (script === 'dev:server') require('node:http').createServer((req, res) => {res.end('ok');}).listen(Number(process.env.CEZ_API_PORT), '127.0.0.1');
`);
  try {
    // bound: the product has a 15 s health budget; allow 5 s more for child exit.
    const result = await exec(process.execPath, [new URL('./dev.mjs', import.meta.url).pathname], {
      timeout: 20_000, env: {...process.env, npm_execpath: cli, HSQ_API_PORT: '1', CEZ_API_PORT: '2', DEV_PORT_LOG: log},
    });
    assert.ok(existsSync(log), result.stdout + result.stderr);
    const entries = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(entries.map(entry => entry.script), ['dev:server', 'dev:web']);
    for (const entry of entries) {
      assert.equal(entry.old, entry.preferred); assert.notEqual(entry.preferred, '1');
    }
  } finally { rmSync(root, {recursive: true, force: true}); }
});
