/**
 * Bundle private runtime contract code and declarations into the published service dist, then
 * rewrite emitted root and subpath references. Keep source imports unchanged. Remove this step
 * when private runtime resolution is no longer needed.
 *
 * Every subpath repoints to one bundle of `packages/contract/src/index.ts`, so it exports only
 * the names that index re-exports. A module the index reaches through a named re-export (`ask.ts`
 * names a few of `ask-schema.ts`'s) keeps only those names in the bundle. The build fails when an
 * emitted import names a contract value the bundle lacks (hearsay-tools/cezarion#1431).
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const dist = process.argv[2] ? resolve(process.argv[2]) : join(here, '..', 'dist');
const contractRoot = join(here, '..', '..', 'contract');
const entry = join(contractRoot, 'src', 'index.ts');
const outdir = join(dist, 'contract');
// The bare name and every module subpath (`@open-mercato/cezar-contract/runs`, hearsay-tools/cezarion#1237).
const SPEC = /(['"])@open-mercato\/cezar-contract(?:\/[^'"]*)?\1/g;
const CONTRACT = /^@open-mercato\/cezar-contract(?:\/[^'"]*)?$/;

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
const bundled = await build({
  metafile: true,
  entryPoints: [entry],
  outfile: join(outdir, 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  external: ['zod'],
});

// A wildcard re-export has no named import for the linker below to validate. Check its
// runtime export set before rewriting it: otherwise a missing module silently becomes the
// root bundle's unrelated exports (hearsay-tools/cezarion#1813).
const rootExports = new Set(Object.values(bundled.metafile.outputs).flatMap((output) => output.exports));
for (const file of referrers.filter((name) => name.endsWith('.js'))) {
  for (const match of readFileSync(file, 'utf8').matchAll(/export\s+\*\s+from\s+['"](@open-mercato\/cezar-contract\/([^'"]+))['"]/g)) {
    const source = join(contractRoot, 'src', `${match[2]}.ts`);
    const original = await build({
      entryPoints: [source], bundle: true, write: false, metafile: true,
      format: 'esm', platform: 'neutral', external: ['zod'],
    });
    const missing = Object.values(original.metafile.outputs).flatMap((output) => output.exports)
      .filter((name) => !rootExports.has(name));
    if (missing.length) {
      console.error(`inline-contract: ${relative(dist, file)} wildcard re-export of "${match[1]}" loses root exports: ${missing.join(', ')}`);
      process.exit(1);
    }
  }
}

// Link every emitted importer against the bundle, as Node does when the CLI starts, before
// anything is repointed. Each specifier loads as a module of its own that re-exports the bundle,
// so esbuild's message names the subpath. Every other import stays external: only contract
// names are checked. `import-is-undefined` covers a namespace member the bundle lacks.
const bundle = join(outdir, 'index.js');
const importers = referrers.filter((p) => p.endsWith('.js'));
const gaps = importers.length === 0 ? [] : await build({
  entryPoints: importers,
  absWorkingDir: dist,
  outdir: join(dist, '.inline-contract-check'),
  write: false,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'silent',
  logOverride: { 'import-is-undefined': 'error' },
  plugins: [{
    name: 'contract-exports',
    setup(check) {
      check.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point') return undefined;
        if (CONTRACT.test(args.path)) return { path: args.path, namespace: 'contract' };
        if (args.namespace === 'contract') return { path: bundle };
        return { external: true };
      });
      check.onLoad({ filter: /.*/, namespace: 'contract' }, () => ({ contents: `export * from ${JSON.stringify(bundle)};` }));
    },
  }],
}).then(() => [], (error) => {
  if (!Array.isArray(error?.errors)) throw error;
  return error.errors;
});
if (gaps.length > 0) {
  for (const { text, location } of gaps) {
    const where = location ? `${join(basename(dist), location.file)}:${location.line}` : basename(dist);
    const name = /import "([^"]+)"/i.exec(text)?.[1];
    const subpath = /"contract:([^"]+)"/.exec(text)?.[1];
    console.error(name && subpath
      ? `inline-contract: ${where} imports "${name}" from "${subpath}", which dist/contract/index.js does not export`
      : `inline-contract: ${where}: ${text}`);
  }
  console.error('inline-contract: the bundle holds only the names packages/contract/src/index.ts re-exports. '
    + 'Re-export each name there: an `export *` of its module, or the named re-export that reaches it.');
  process.exit(1);
}

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
