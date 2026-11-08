#!/usr/bin/env node
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { desktopMetadata } from './build-metadata.mjs';

// The payload is built in the preceding, new-ID CI leg. It is embedded inside the signed
// old-ID updater bundle; the bridge never downloads an unauthenticated installer.
const { values } = parseArgs({ options: { payload: { type: 'string' }, platform: { type: 'string' } } });
const formats = { darwin: 'app.tar.gz', win32: 'setup.exe', linux: 'AppImage' };
const format = formats[values.platform];
if (!format || !values.payload) throw new Error('Usage: prepare-bridge.mjs --platform darwin|win32|linux --payload <new-ID updater artifact>');
mkdirSync('bridge-payload', { recursive: true });
copyFileSync(values.payload, `bridge-payload/payload.${format}`);
writeFileSync('bridge-payload/manifest.json', JSON.stringify({ ...desktopMetadata({ rebrand: 'on' }), format, sha256: createHash('sha256').update(readFileSync(values.payload)).digest('hex') }));
