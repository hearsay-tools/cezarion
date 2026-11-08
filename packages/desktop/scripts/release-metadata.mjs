#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { desktopMetadata } from './build-metadata.mjs';

export function releaseMetadata({ bridge = false, rebrand, version, refName, eventName } = {}) {
  const metadata = desktopMetadata({ bridge, rebrand });
  version ??= JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url))).version;
  const tag = `${metadata.tagPrefix}${version}`;
  if (eventName === 'push' && refName !== tag) throw new Error(`Tag ${refName} does not match ${tag}`);
  return { version, tag, stem: metadata.artifactStem, feed: metadata.feed, display_name: metadata.displayName, rebrand: String(metadata.rebrand) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { bridge: { type: 'boolean' }, rebrand: { type: 'string' }, 'github-output': { type: 'string' } } });
  const metadata = releaseMetadata({ bridge: values.bridge, rebrand: values.rebrand, refName: process.env.GITHUB_REF_NAME, eventName: process.env.GITHUB_EVENT_NAME });
  if (values['github-output']) appendFileSync(values['github-output'], Object.entries(metadata).map(([key, value]) => `${key}=${value}\n`).join(''));
  console.log(JSON.stringify(metadata));
}
