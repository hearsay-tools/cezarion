import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// The skill's own tests live beside its scripts. This file covers only this
// repository's wrapper, which pins the checkout's Vitest projects.
test('the repository wrapper emits JSON for a source file outside the checkout', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'cez-metrics-wrapper-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const file = join(cwd, 'source.ts');
  writeFileSync(file, 'export function choose(x: boolean) {\n if (x) return 1;\n return 2;\n}');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const cli = fileURLToPath(new URL('./metrics.mjs', import.meta.url));
  const output = execFileSync(process.execPath, [cli, file, '--function', 'choose', '--json'], { cwd: root, encoding: 'utf8' });
  const result = JSON.parse(output);
  assert.equal(result.file, file);
  assert.equal(result.functions.length, 1);
  assert.equal(result.functions[0].complexity, 2);
  assert.equal(result.functions[0].crap, null);
});
