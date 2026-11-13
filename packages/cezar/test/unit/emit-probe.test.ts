import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { emitProbe } from '../fixtures/emit-probe.ts';

test('probe emission writes plain JavaScript that a child process runs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-emit-probe-'));
  try {
    const source = join(root, 'probe.ts');
    writeFileSync(source, 'const value: number = 7; console.log(value);');
    const target = join(root, 'probe.mjs');
    await emitProbe(pathToFileURL(source), target);
    assert.doesNotMatch(readFileSync(target, 'utf8'), /: number|sourceMappingURL/);
    assert.equal(execFileSync(process.execPath, [target], { encoding: 'utf8' }).trim(), '7');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
