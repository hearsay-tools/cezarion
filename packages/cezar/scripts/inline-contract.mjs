/**
 * Bundle private runtime contract code and declarations into the published service dist, then
 * rewrite emitted root and subpath references. Keep source imports unchanged. Remove this step
 * when private runtime resolution is no longer needed.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const dist = process.argv[2] ? resolve(process.argv[2]) : join(here, '..', 'dist');
const contractRoot = join(here, '..', '..', 'contract');
const entry = join(contractRoot, 'src', 'index.ts');
const outdir = join(dist, 'contract');
// The bare name and every module subpath (`@open-mercato/cezar-contract/runs`, hearsay-tools/cezarion#1237):
// all of them repoint to the one bundle, which exports every module's names.
const SPEC = /(['"])@open-mercato\/cezar-contract(?:\/[^'"]*)?\1/g;

/** Emitted files that name the package — the copy happens only if it is really used. */
const referrers = [];
const scan = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (p !== outdir) scan(p);
    } else if (/\.(js|d\.ts|js\.map)$/.test(entry.name)) {
      SPEC.lastIndex = 0;
      if (SPEC.test(readFileSync(p, 'utf8'))) referrers.push(p);
    }
  }
};
scan(dist);

rmSync(outdir, { recursive: true, force: true });
if (referrers.length === 0) {
  console.log('inline-contract ok — nothing in dist references the contract, nothing bundled');
  process.exit(0);
}

// `zod` stays external: it is a real dependency of this package, so npm resolves it normally and
// the tarball does not carry a second copy.
await build({
  entryPoints: [entry],
  outfile: join(outdir, 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  external: ['zod'],
});

// `tsc` is located through the module graph rather than a guessed `node_modules` path, because
// `typescript` is a devDependency of THIS package and may sit here or be hoisted to the workspace
// root. Via the manifest's own `bin` entry: TypeScript 7's `exports` map does not publish
// `./bin/tsc`, so resolving that subpath directly is ERR_PACKAGE_PATH_NOT_EXPORTED.
const require_ = createRequire(import.meta.url);
const tsManifest = require_.resolve('typescript/package.json');
const tscBin = join(dirname(tsManifest), require_(tsManifest).bin.tsc);

// The declarations for the bundle above. `tsc` mirrors `src/**` into `outdir`, so `index.d.ts`
// lands beside `index.js` and its relative siblings (`./health.js` → `./health.d.ts`) resolve as
// TypeScript expects. Those siblings have no runtime twin, which is correct: the bundle is
// self-contained and nothing imports those paths at runtime.
execFileSync(
  process.execPath,
  [
    tscBin,
    '--project',
    join(contractRoot, 'tsconfig.json'),
    '--emitDeclarationOnly',
    '--declarationMap',
    'false',
    '--sourceMap',
    'false',
    '--outDir',
    outdir,
  ],
  { stdio: 'inherit' },
);
if (!existsSync(join(outdir, 'index.d.ts'))) {
  console.error('inline-contract: tsc emitted no index.d.ts — the bundled contract would ship untyped');
  process.exit(1);
}

for (const p of referrers) {
  let rel = relative(dirname(p), join(outdir, 'index.js')).replaceAll('\\', '/');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  writeFileSync(p, readFileSync(p, 'utf8').replace(SPEC, `'${rel}'`), 'utf8');
}
console.log(`inline-contract ok — contract bundled with declarations, ${referrers.length} file(s) repointed`);
