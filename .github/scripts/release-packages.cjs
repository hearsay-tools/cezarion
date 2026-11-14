'use strict';

const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { RELEASE_MANIFEST_DIRS, publicationManifests } = require('../../packages/cezar/src/release/manifests.ts');
const { compatibilityManifests, withCompatibilityPackages } = require('../../packages/cezar/src/release/compatibility.ts');
const { withPublicationPackage } = require('../../packages/cezar/src/release/publication.ts');

const repoRoot = resolve(__dirname, '../..');

// Credentialed workflows run only trusted source. No build or dependency install is needed.
function releasePackages(root = repoRoot) {
  const dirs = RELEASE_MANIFEST_DIRS;
  const source = Object.fromEntries(Object.entries(dirs).map(([key, dir]) =>
    [key, JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'))]));
  const active = publicationManifests(source);
  const publication = { ...active, ...compatibilityManifests(active.cezar) };
  return { dirs, source, publication };
}

// The name users install through: the old unscoped alias, now a compatibility package.
function installAlias(root = repoRoot) {
  return releasePackages(root).publication.legacyAlias?.name ?? '';
}

// Every name a release publishes, in publication order.
function publishedNames(root = repoRoot) {
  const { publication } = releasePackages(root);
  return Object.values(publication).filter(manifest => manifest && manifest.private !== true).map(manifest => manifest.name);
}

function packChecks({ root = repoRoot, execute = execFileSync } = {}) {
  const { dirs, publication } = releasePackages(root);
  const options = { cwd: root, stdio: 'inherit' };
  withPublicationPackage(join(root, dirs.cezar), publication.cezar,
    cwd => execute('npm', ['pack', '--dry-run', '--ignore-scripts'], { ...options, cwd }));
  withCompatibilityPackages(join(root, dirs.cezar), publication.cezar, packages => {
    for (const { dir } of Object.values(packages)) execute('npm', ['pack', '--dry-run', '--ignore-scripts'], { ...options, cwd: dir });
  });
}

function cleanupTags({ root = repoRoot, tag, dryRun = false, execute = execFileSync } = {}) {
  if (!/^pr-[1-9]\d*$/.test(tag || '')) throw new Error('Expected a PR dist-tag');
  const { publication } = releasePackages(root);
  // Preserve the historical client cleanup, including when it is private.
  const keys = ['cezar', 'apiClient', ...Object.keys(publication).filter(key => key.startsWith('legacy'))];
  const names = keys.filter(key => publication[key]).map(key => publication[key].name);
  for (const name of names) {
    if (dryRun) continue;
    try { execute('npm', ['dist-tag', 'rm', name, tag], { cwd: root, stdio: 'inherit' }); }
    catch { console.log(`no ${tag} tag on ${name} (ok)`); }
  }
  return names;
}

if (require.main === module) {
  const [operation, ...args] = process.argv.slice(2);
  if (operation === 'pack-check') packChecks();
  else if (operation === 'cleanup') {
    if (!process.env.NODE_AUTH_TOKEN && !args.includes('--dry-run')) {
      console.log('NPM_TOKEN is not configured — nothing to clean up.');
    } else console.log(JSON.stringify(cleanupTags({ tag: process.env.TAG, dryRun: args.includes('--dry-run') })));
  } else throw new Error('Expected pack-check or cleanup');
}

module.exports = { releasePackages, installAlias, publishedNames, packChecks, cleanupTags };
