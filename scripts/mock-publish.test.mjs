import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { publishFile } from '../packages/cezar/scripts/mock-publish.mjs';

test('mock publication exposes complete values during creation and replacement', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'cezar-mock-publish-'));
  const target = join(dir, 'result.json');
  const write = fs.writeFileSync;
  let observed;
  let boundaries = 0;
  fs.writeFileSync = (path, value) => {
    // Force the open-before-write boundary that a polling reader can observe.
    write(path, '');
    assert.deepEqual(fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : undefined, observed);
    boundaries++;
    write(path, value);
  };
  syncBuiltinESMExports();
  try {
    for (const value of [{ response: 'first' }, { response: 'second' }]) {
      publishFile(target, JSON.stringify(value));
      assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), value);
      observed = value;
    }
    assert.equal(boundaries, 2);
    assert.deepEqual(fs.readdirSync(dir), ['result.json']);
  } finally {
    fs.writeFileSync = write;
    syncBuiltinESMExports();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
