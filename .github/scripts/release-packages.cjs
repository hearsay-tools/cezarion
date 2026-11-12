'use strict';

const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { releaseManifestDirs, publicationManifests } = require('../../packages/cezar/src/release/manifests.ts');
const { compatibilityManifests, withCompatibilityPackages } = require('../../packages/cezar/src/release/compatibility.ts');
const { withPublicationPackage } = require('../../packages/cezar/src/release/publication.ts');

const repoRoot = resolve(__dirname, '../..');

// Credentialed workflows run only trusted source. No build or dependency install is needed.
function releasePackages(root = repoRoot, rebrand) {
  const args = rebrand === undefined ? [] : ['--rebrand', rebrand ? 'on' : 'off'];
  const identity = JSON.parse(execFileSync(process.execPath,
    [join(repoRoot, 'packages/cezar/scripts/product-identity.mjs'), ...args], { encoding: 'utf8' }));
  const dirs = releaseManifestDirs(identity.rebrand);
  const source = Object.fromEntries(Object.entries(dirs).map(([key, dir]) =>
    [key, JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'))]));
  const active = publicationManifests(source, identity.rebrand);
  const publication = { ...active, ...compatibilityManifests(active.cezar, identity.rebrand) };
  return { dirs, source, publication };
}

// The name users install through: the alias, or the compatibility alias after the rebrand.
function installAlias(root = repoRoot, rebrand) {
  const { publication } = releasePackages(root, rebrand);
  return (publication.alias ?? publication.legacyAlias)?.name ?? '';
}

function packChecks({ root = repoRoot, rebrand, execute = execFileSync } = {}) {
  const { dirs, source, publication } = releasePackages(root, rebrand);
  const options = { cwd: root, stdio: 'inherit' };
  if (source.cezar.name === publication.cezar.name) {
    execute('npm', ['pack', '--dry-run', '--ignore-scripts', '-w', source.cezar.name], options);
  } else {
    withPublicationPackage(join(root, dirs.cezar), publication.cezar,
      cwd => execute('npm', ['pack', '--dry-run', '--ignore-scripts'], { ...options, cwd }));
  }
  if (dirs.alias) execute('npm', ['pack', '--dry-run', '--ignore-scripts'], { ...options, cwd: join(root, dirs.alias) });
  withCompatibilityPackages(join(root, dirs.cezar), publication.cezar, packages => {
    for (const { dir } of Object.values(packages)) execute('npm', ['pack', '--dry-run', '--ignore-scripts'], { ...options, cwd: dir });
  }, publication.legacyScoped !== undefined);
}

function cleanupTags({ root = repoRoot, rebrand, tag, dryRun = false, execute = execFileSync } = {}) {
  if (!/^pr-[1-9]\d*$/.test(tag || '')) throw new Error('Expected a PR dist-tag');
  const { publication } = releasePackages(root, rebrand);
  // Preserve the historical client cleanup, including when it is private.
  const keys = ['cezar', 'apiClient', 'alias', ...Object.keys(publication).filter(key => key.startsWith('legacy'))];
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

module.exports = { releasePackages, installAlias, packChecks, cleanupTags };
