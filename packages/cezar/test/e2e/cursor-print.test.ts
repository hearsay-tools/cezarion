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

test('installed Cursor runner uses the bundled print mock, refuses legacy ACP resumes and fails an unqualified build headless', { timeout: 120_000 }, async () => {
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
    assert.ok(!paths.has('scripts/mock-cursor-acp.mjs'));
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
for (const transport of [undefined, 'cursor-acp']) {
  const events = [];
  const runner = createRunner('cursor', transport ? { sessionTransport: transport } : {});
  const result = await runner.run({ cwd: process.cwd(), userPrompt: 'mock:done', toolGrant: { kind: 'unset' }, timeoutMs: 10_000 }, event => events.push(event));
  assert.equal(events.find(event => event.type === 'session')?.sessionTransport, 'cursor-print');
  assert.match(result.text, /CEZ:DONE/);
  assert.equal(events.some(event => event.type === 'error'), false);
}
for (const transport of [undefined, 'cursor-acp']) {
  const events = [];
  const runner = createRunner('cursor', transport ? { sessionTransport: transport } : {});
  await runner.run({ cwd: process.cwd(), userPrompt: 'mock:done', toolGrant: { kind: 'unset' }, timeoutMs: 10_000,
    resume: true, sessionId: 'legacy-acp-session' }, event => events.push(event));
  assert.equal(events.some(event => event.type === 'session'), false);
  assert.match(events.find(event => event.type === 'error')?.message ?? '', /started on the ACP transport.*cannot resume/);
}
`, 'utf8');
    const run = await execFile(process.execPath, [smoke], { cwd: consumer, timeout: 30_000 });
    assert.equal(run.stderr, '');

    // An unqualified Cursor build fails `cez run` before inference, naming the fix
    // (hearsay-tools/cezarion#1267). The shim answers login and version checks only.
    const repo = join(root, 'repo');
    await mkdir(join(repo, '.ai', 'cezar'), { recursive: true });
    await writeFile(join(repo, 'a.txt'), 'one\n');
    await writeFile(join(repo, '.ai', 'cezar', 'config.json'), '{"defaultRunner":"cursor"}\n');
    for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'],
      ['-c', 'user.name=t', '-c', 'user.email=t@local', 'commit', '-q', '-m', 'base']]) {
      await execFile('git', args, { cwd: repo });
    }
    const shim = join(root, 'old-agent.mjs');
    await writeFile(shim, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) process.stdout.write('2026.01.01-0000000\\n');
else if (args.includes('status')) process.stdout.write('{"isAuthenticated":true,"status":"authenticated"}\\n');
else process.exit(1);
`, { mode: 0o755 });
    await assert.rejects(
      execFile(process.execPath, [join(installed, 'dist', 'index.js'), 'run', 'say hi', '--repo', repo], {
        cwd: repo, timeout: 60_000, maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, CEZ_DRY_RUN: '', CEZ_CURSOR_BIN: shim, CEZ_HOME: join(root, 'cez-home') },
      }),
      (error: unknown) => {
        const result = error as { code?: number; stderr?: string };
        assert.notEqual(result.code, 0);
        assert.match(result.stderr ?? '', /Cursor CLI cannot run this task: .+ Run "agent update" to install a supported Cursor CLI/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
