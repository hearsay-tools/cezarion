import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { emitProbe } from '../fixtures/emit-probe.ts';

// Check the real emitter with and without measurement; the child stays plain Node.
test('probe emission preserves execution and archives measurement maps before cleanup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-emit-probe-'));
  const previous = process.env.NODE_V8_COVERAGE;
  try {
    const source = join(root, 'probe.ts');
    writeFileSync(source, 'const value: number = 7; console.log(value);');
    const target = join(root, 'probe.mjs');
    delete process.env.NODE_V8_COVERAGE;
    await emitProbe(pathToFileURL(source), target);
    assert.doesNotMatch(readFileSync(target, 'utf8'), /sourceMappingURL/);
    assert.equal(execFileSync(process.execPath, [target], { encoding: 'utf8' }).trim(), '7');

    const raw = join(root, 'raw');
    mkdirSync(raw);
    writeFileSync(join(raw, 'quality-inputs.json'), JSON.stringify([source]));
    process.env.NODE_V8_COVERAGE = raw;
    await emitProbe(pathToFileURL(source), target);
    assert.match(readFileSync(target, 'utf8'), /sourceMappingURL=data:/);
    assert.equal(execFileSync(process.execPath, [target], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } }).trim(), '7');
    rmSync(target);
    // The archive must survive the generated child's file being removed.
    assert.ok(readdirSync(join(raw, 'sources')).length > 0);
  } finally {
    if (previous === undefined) delete process.env.NODE_V8_COVERAGE;
    else process.env.NODE_V8_COVERAGE = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
