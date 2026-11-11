/** Fail closed for public installers; PR/dry-run bundles are explicitly test artifacts. */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { desktopMetadata } from './build-metadata.mjs';
export function releaseConfig(platform, env, dryRun, metadata = desktopMetadata(), releaseRebrand = desktopMetadata().rebrand) {
  const requireValue = name => { if (!env[name]?.trim()) throw new Error(`Public desktop release requires ${name}`); return env[name]; };
  const bundle = { targets: platform === 'darwin' ? ['app', 'dmg'] : platform === 'win32' ? ['nsis'] : ['appimage', 'deb'], createUpdaterArtifacts: !dryRun };
  const config = { bundle };
  if (metadata.bridge) {
    if (!dryRun && !releaseRebrand) throw new Error('Public bridge builds require the release switch');
    bundle.resources = { '../bridge-payload/': 'bridge/' };
  }
  if (metadata.rebrand) {
    config.identifier = metadata.desktopAppId;
    config.productName = metadata.displayName;
    config.mainBinaryName = metadata.desktopExecutable;
    config.plugins = { updater: { endpoints: [`https://github.com/hearsay-tools/squawk/releases/download/${metadata.feed}/${metadata.feed}.json`] } };
  }
  if (!dryRun) {
    requireValue('TAURI_SIGNING_PRIVATE_KEY');
    const pubkey = requireValue('TAURI_SIGNING_PUBLIC_KEY');
    const key = Buffer.from(pubkey, 'base64').toString();
    if (!key.startsWith('untrusted comment:') || !key.trim().split('\n')[1]) throw new Error('TAURI_SIGNING_PUBLIC_KEY must be the exported Tauri .pub contents');
    config.plugins = { updater: { ...config.plugins?.updater, pubkey } };
  }
  if (platform === 'darwin') {
    if (!dryRun) for (const name of ['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID']) requireValue(name);
    bundle.macOS = { signingIdentity: dryRun ? '-' : env.APPLE_SIGNING_IDENTITY };
  }
  if (platform === 'win32' && !dryRun) {
    bundle.windows = { certificateThumbprint: requireValue('WINDOWS_CERTIFICATE_THUMBPRINT'), digestAlgorithm: 'sha256', timestampUrl: 'http://timestamp.digicert.com', tsp: true };
  }
  return config;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { rebrand: { type: 'string' }, bridge: { type: 'boolean' } } });
  const metadata = desktopMetadata({ rebrand: values.rebrand, bridge: values.bridge });
  const config = releaseConfig(process.platform, process.env, process.env.DESKTOP_DRY_RUN === 'true', metadata);
  if (values.rebrand !== undefined || values.bridge) Object.assign(config, { identifier: metadata.desktopAppId, productName: metadata.displayName });
  writeFileSync('release-config.json', JSON.stringify(config));
}
