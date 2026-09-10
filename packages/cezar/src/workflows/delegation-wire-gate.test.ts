import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const payload = { error: 'integration provider unavailable' };
const fixture = new URL('./__fixtures__/delegation-wire.mjs', import.meta.url).href;

function startParser(dir: string, path: string) {
  const script = join(dir, 'parser.mjs');
  writeFileSync(script, `import { existsSync, readFileSync } from 'node:fs';
const path = process.argv[2];
process.stdout.write('ready\\n');
const started = Date.now();
while (!existsSync(path)) {
  if (Date.now() - started > 5000) process.exit(2);
}
const body = readFileSync(path, 'utf8');
try {
  process.stdout.write(JSON.stringify({ ok: true, value: JSON.parse(body) }) + '\\n');
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message, bytes: body.length }) + '\\n');
  process.exitCode = 1;
}
`);
  const child = spawn(process.execPath, [script, path], { stdio: ['ignore', 'pipe', 'pipe'] });
  let resolveReady: () => void;
  const ready = new Promise<void>(resolve => { resolveReady = resolve; });
  const result = new Promise<{ ok: boolean; value?: unknown; error?: string; bytes?: number }>((resolve, reject) => {
    let stdout = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.includes('ready\n')) resolveReady();
    });
    child.stderr.on('data', chunk => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', () => {
      const line = stdout.trim().split('\n').at(-1);
      try { resolve(JSON.parse(line ?? 'null')); }
      catch { reject(new Error(`parser output: ${JSON.stringify(stdout)}`)); }
    });
  });
  return { ready, result };
}

describe('delegation wire reply publication', () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('a process polling existsSync then JSON.parse never observes truncated reply JSON', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cez-delegation-gate-'));
    const publisher = join(dir, 'publish.mjs');
    writeFileSync(publisher, `import { publishJson } from ${JSON.stringify(fixture)};
publishJson(process.argv[2], ${JSON.stringify(payload)});
`);
    for (let i = 0; i < 30; i++) {
      const path = join(dir, `${i}.reply.json`);
      const parser = startParser(dir, path);
      await parser.ready;
      execFileSync(process.execPath, [publisher, path]);
      expect(await parser.result, `iteration ${i}`).toEqual({ ok: true, value: payload });
    }
  });
});
