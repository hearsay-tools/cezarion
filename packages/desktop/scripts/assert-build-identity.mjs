#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { desktopMetadata } from './build-metadata.mjs';
const metadata = desktopMetadata({ rebrand: process.argv[2] });
const executable = `src-tauri/target/release/${metadata.desktopExecutable}${process.platform === 'win32' ? '.exe' : ''}`;
const result = spawnSync(executable, ['--desktop-identity'], { encoding: 'utf8', timeout: 30000 });
assert.equal(result.status, 0, result.error?.message || result.stderr);
assert.deepEqual(JSON.parse(result.stdout), { identifier: metadata.desktopAppId, productName: metadata.displayName });
console.log(`PASS: built app reports ${metadata.desktopAppId} / ${metadata.displayName}`);
