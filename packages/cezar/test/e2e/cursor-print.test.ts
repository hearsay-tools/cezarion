import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('installed Cursor runners resolve both bundled mocks without a source tree', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-cursor-package-'));
  try {
    const packDir = join(root, 'pack');
    const consumer = join(root, 'consumer');
    await mkdir(packDir);
    await mkdir(consumer);
    const packed = await execFile('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', packDir],
      { cwd: packageRoot, maxBuffer: 10 * 1024 * 1024 });
    const record = JSON.parse(packed.stdout)[0] as { filename: string; files: Array<{ path: string }> };
    const paths = new Set(record.files.map(file => file.path));
    assert.ok(paths.has('scripts/mock-cursor-print.mjs'));
    assert.ok(paths.has('scripts/mock-cursor-acp.mjs'));
    await writeFile(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
    await execFile('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock',
      join(packDir, record.filename)], { cwd: consumer, maxBuffer: 10 * 1024 * 1024 });
    const installed = join(consumer, 'node_modules', '@wjarka', 'cezarion');
    const smoke = join(consumer, 'cursor-smoke.mjs');
    await writeFile(smoke, `
import assert from 'node:assert/strict';
import { createRunner } from ${JSON.stringify(pathToFileURL(join(installed, 'dist/core/runner-factory.js')).href)};
process.env.CEZ_DRY_RUN = '1';
delete process.env.CEZ_CURSOR_BIN;
for (const [transport, expected] of [[undefined, 'cursor-print'], ['cursor-acp', 'cursor-acp']]) {
  const events = [];
  const runner = createRunner('cursor', transport ? { sessionTransport: transport } : {});
  const result = await runner.run({ cwd: process.cwd(), userPrompt: 'mock:done', timeoutMs: 10_000 }, event => events.push(event));
  assert.equal(events.find(event => event.type === 'session')?.sessionTransport, expected);
  assert.match(result.text, /CEZ:DONE/);
  assert.equal(events.some(event => event.type === 'error'), false);
}
`, 'utf8');
    const run = await execFile(process.execPath, [smoke], { cwd: consumer, timeout: 30_000 });
    assert.equal(run.stderr, '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
