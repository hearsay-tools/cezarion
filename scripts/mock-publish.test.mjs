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
  const rename = fs.renameSync;
  const foreign = `${dir}.log`;
  write(foreign, 'previous\n');
  let observed;
  let boundaries = 0;
  fs.writeFileSync = (path, value, ...options) => {
    if (path !== `${target}.${process.pid}.tmp`) return write(path, value, ...options);
    // Force the open-before-write boundary that a polling reader can observe.
    write(path, '');
    assert.deepEqual(fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : undefined, observed);
    boundaries++;
    write(path, value, ...options);
  };
  fs.renameSync = (...args) => {
    // Model a recorder that appends when it observes publication renames.
    fs.appendFileSync(foreign, 'written\n');
    return rename(...args);
  };
  syncBuiltinESMExports();
  try {
    for (const value of [{ response: 'first' }, { response: 'second' }]) {
      publishFile(target, JSON.stringify(value));
      assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), value);
      observed = value;
    }
    assert.equal(boundaries, 2);
    assert.equal(fs.readFileSync(foreign, 'utf8'), 'previous\nwritten\nwritten\n');
    assert.deepEqual(fs.readdirSync(dir), ['result.json']);
  } finally {
    fs.writeFileSync = write;
    fs.renameSync = rename;
    fs.rmSync(foreign, { force: true });
    syncBuiltinESMExports();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('failed publication removes its temporary file and preserves the error', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'cezar-mock-publish-failure-'));
  const target = join(dir, 'result.json');
  const rename = fs.renameSync;
  const failure = new Error('forced rename failure');
  fs.renameSync = () => { throw failure; };
  syncBuiltinESMExports();
  try {
    fs.writeFileSync(target, 'previous');
    assert.throws(() => publishFile(target, 'replacement'), error => error === failure);
    assert.equal(fs.readFileSync(target, 'utf8'), 'previous');
    assert.deepEqual(fs.readdirSync(dir), ['result.json']);
  } finally {
    fs.renameSync = rename;
    syncBuiltinESMExports();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
