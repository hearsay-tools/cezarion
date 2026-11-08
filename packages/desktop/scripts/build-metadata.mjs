#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const identityScript = fileURLToPath(new URL('../../cezar/scripts/product-identity.mjs', import.meta.url));
function identity(rebrand) {
  return JSON.parse(execFileSync(process.execPath, [identityScript, ...(rebrand === undefined ? [] : ['--rebrand', rebrand])], { encoding: 'utf8' }));
}

/** Build inputs only. The release overlay also selects Rust's identity through TAURI_CONFIG. */
export function desktopMetadata({ rebrand, tauriConfig } = {}) {
  if (rebrand !== undefined && !['on', 'off'].includes(rebrand)) throw new Error('--rebrand must be on or off');
  const legacy = identity('off'), next = identity('on');
  if (tauriConfig?.identifier) {
    if (![legacy.desktopAppId, next.desktopAppId].includes(tauriConfig.identifier)) throw new Error('Unknown desktop identifier');
    const selected = tauriConfig.identifier === next.desktopAppId ? 'on' : 'off';
    if (rebrand !== undefined && rebrand !== selected) throw new Error('Desktop identifier conflicts with --rebrand');
    rebrand = selected;
  }
  const selected = identity(rebrand);
  const stem = selected.desktopAppId.split('.').at(-1);
  return { ...selected, legacyNpmPackage: legacy.npmPackage, nextNpmPackage: next.npmPackage,
    artifactStem: stem, feed: selected.rebrand ? `${stem}-desktop-latest` : 'desktop-latest',
    tagPrefix: selected.rebrand ? `${stem}-desktop-v` : 'desktop-v' };
}

export function rustMetadata(metadata) {
  return [
    ['PACKAGE', metadata.npmPackage], ['LEGACY_PACKAGE', metadata.legacyNpmPackage],
    ['NEXT_PACKAGE', metadata.nextNpmPackage], ['DISPLAY_NAME', metadata.displayName],
  ].map(([key, value]) => `pub const ${key}: &str = ${JSON.stringify(value)};`).join('\n')
    + `\npub const REBRAND: bool = ${metadata.rebrand};\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { rebrand: { type: 'string' }, rust: { type: 'boolean' } } });
    const metadata = desktopMetadata({ rebrand: values.rebrand, tauriConfig: JSON.parse(process.env.TAURI_CONFIG || '{}') });
    console.log(values.rust ? rustMetadata(metadata) : JSON.stringify(metadata));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
