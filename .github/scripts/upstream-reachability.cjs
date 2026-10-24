// Which package source files production code reaches — the reachability column of
// `upstream-scan.cjs targets` (hearsay-tools/cezarion#1002). One in-memory esbuild bundle from
// the fork's production entry points; its `metafile.inputs` are the reachable files. Nothing
// is written. A file only tests import is absent from the inputs, which is how a port planner
// learns that the component an upstream commit edits is dead code here.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  isPackageSource, urlEntrySpecifiers, urlEntryCandidates, staticImportSpecifiers, distSourceCandidates, isRepoScript, distImportCandidates,
} = require('./upstream-targets.cjs');

/** Rounds of "bundle, then add the files the bundle starts by path" before giving up. */
const MAX_ROUNDS = 5;
/** Files esbuild parses as code; every other import (CSS, images, fonts) loads as an empty module. */
const CODE_FILE_RE = /\.(?:[cm]?[jt]sx?|json)$/;
/** Vite query imports whose target is a separately bundled entry, so production code. */
const WORKER_QUERY_RE = /^(?:worker|sharedworker)(?:&|$)/;
/**
 * Include static type-only specifiers in reachability; esbuild would erase them before
 * resolving. Drop specifiers only the type checker can resolve.
 */
const TS_LOADERS = { '.ts': 'ts', '.mts': 'ts', '.cts': 'ts', '.tsx': 'tsx' };
const TYPE_IMPORT = 'cez-type-import:';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function packageDirs(cwd) {
  const dir = path.join(cwd, 'packages');
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => `packages/${d.name}`).sort();
  } catch { return []; }
}

function firstFile(cwd, candidates) {
  return candidates.find((f) => isFile(path.join(cwd, f)));
}

/** The first existing source file a manifest target names: `dist/x.js` maps to `src/x.ts`. */
function sourceOf(cwd, pkgDir, target) {
  return firstFile(cwd, distSourceCandidates(pkgDir, target));
}

function exportTargets(exportsField) {
  if (typeof exportsField === 'string') return { '.': exportsField };
  const out = {};
  for (const [key, value] of Object.entries(exportsField ?? {})) {
    const target = typeof value === 'string' ? value : value?.import ?? value?.default;
    if (typeof target === 'string') out[key] = target;
  }
  return out;
}

/** Package source that repo scripts reach through a package's built `dist/`, which no bundle
 *  from source sees (`scripts/release.mjs`, `packages/cezar/scripts/check-pack.mjs`). The
 *  scripts themselves are not bundled; only the source files they name become roots. */
function scriptDistEntries(cwd) {
  const found = new Set();
  for (const dir of ['scripts', ...packageDirs(cwd).map((d) => `${d}/scripts`)]) {
    let names = [];
    try { names = fs.readdirSync(path.join(cwd, dir)).sort(); } catch { continue; }
    for (const file of names.map((n) => `${dir}/${n}`).filter(isRepoScript)) {
      const text = fs.readFileSync(path.join(cwd, file), 'utf8');
      for (const candidates of distImportCandidates(file, text)) {
        const entry = firstFile(cwd, candidates);
        if (entry) found.add(entry);
      }
    }
  }
  return found;
}

/** Production entry points: each `packages/*\/index.html` module script (the cockpit's
 *  `/src/main.tsx`), the `bin` and `exports` of every published manifest mapped from
 *  `dist/*.js` to `src/*.ts`, and the source behind every `dist/` file a repo script imports.
 *  Private libraries (contract, api-client) are not roots: they count as reachable only when
 *  web or the CLI imports them. */
function entryPoints(cwd) {
  const roots = scriptDistEntries(cwd);
  for (const pkgDir of packageDirs(cwd)) {
    let html = '';
    try { html = fs.readFileSync(path.join(cwd, pkgDir, 'index.html'), 'utf8'); } catch { /* no page */ }
    for (const m of html.matchAll(/<script\b[^>]*\btype="module"[^>]*\bsrc="\/([^"]+)"/g)) {
      const file = path.posix.join(pkgDir, m[1]);
      if (isFile(path.join(cwd, file))) roots.add(file);
    }
    const manifest = readJson(path.join(cwd, pkgDir, 'package.json'));
    if (!manifest || manifest.private) continue;
    const bins = typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {});
    for (const target of [...bins, ...Object.values(exportTargets(manifest.exports))]) {
      if (!/^(?:\.\/)?dist\//.test(target)) continue;
      const file = sourceOf(cwd, pkgDir, target);
      if (file) roots.add(file);
    }
  }
  return roots;
}

/** Workspace package name → its directory and `exports`, so they bundle from source. */
function workspacePackages(cwd) {
  const byName = new Map();
  for (const pkgDir of packageDirs(cwd)) {
    const manifest = readJson(path.join(cwd, pkgDir, 'package.json'));
    if (typeof manifest?.name === 'string') byName.set(manifest.name, { dir: pkgDir, exports: exportTargets(manifest.exports) });
  }
  return byName;
}

function workspaceFile(cwd, packages, specifier) {
  for (const [name, pkg] of packages) {
    if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;
    const target = pkg.exports[specifier === name ? '.' : `./${specifier.slice(name.length + 1)}`];
    const file = target ? sourceOf(cwd, pkg.dir, target) : undefined;
    return file ? path.join(cwd, file) : undefined;
  }
  return undefined;
}

/** Bundle workspace packages and `@/` from source; everything else bare stays external. */
function resolverPlugin(cwd) {
  const packages = workspacePackages(cwd);
  return {
    name: 'cez-reachability',
    setup(build) {
      build.onResolve({ filter: /^cez-type-import:/ }, async (args) => {
        const specifier = args.path.slice(TYPE_IMPORT.length);
        const resolved = await build.resolve(specifier, { kind: 'import-statement', importer: args.importer, resolveDir: args.resolveDir });
        if (resolved.errors.length) return { path: specifier, external: true };
        return { path: resolved.path, external: resolved.external, namespace: resolved.namespace };
      });
      build.onResolve({ filter: /\?/ }, async (args) => {
        const [bare, query] = args.path.split('?', 2);
        if (!WORKER_QUERY_RE.test(query)) return { path: args.path, namespace: 'cez-data' };
        const resolved = await build.resolve(bare, { kind: args.kind, importer: args.importer, resolveDir: args.resolveDir });
        return resolved.errors.length ? { errors: resolved.errors } : { path: resolved.path };
      });
      build.onResolve({ filter: /^virtual:|^\// }, (args) => ({ path: args.path, external: true }));
      build.onResolve({ filter: /^@\// }, (args) => {
        const pkg = /^(packages\/[^/]+)\//.exec(path.relative(cwd, args.importer).split(path.sep).join('/'));
        if (!pkg) return undefined;
        return build.resolve(`./${args.path.slice(2)}`, { kind: args.kind, importer: args.importer, resolveDir: path.join(cwd, pkg[1], 'src') });
      });
      build.onResolve({ filter: /^[^./]/ }, (args) => {
        const file = workspaceFile(cwd, packages, args.path);
        return file ? { path: file } : { path: args.path, external: true };
      });
      build.onLoad({ filter: /.*/, namespace: 'cez-data' }, () => ({ contents: '', loader: 'js' }));
      build.onLoad({ filter: /.*/ }, async (args) => {
        if (!CODE_FILE_RE.test(args.path)) return { contents: '', loader: 'js' };
        const loader = TS_LOADERS[path.extname(args.path)];
        if (!loader) return undefined;
        const text = await fs.promises.readFile(args.path, 'utf8');
        const keep = staticImportSpecifiers(text).map((s) => `\nimport ${JSON.stringify(TYPE_IMPORT + s)};`);
        return { contents: `${text}${keep.join('')}`, loader };
      });
    },
  };
}

/** Package source files a reachable file starts by path through `new URL(…, import.meta.url)`. */
function pathLoadedEntries(cwd, inputs) {
  const found = new Set();
  for (const file of inputs) {
    if (!isPackageSource(file) || !/\.[cm]?[jt]sx?$/.test(file)) continue;
    const text = fs.readFileSync(path.join(cwd, file), 'utf8');
    if (!text.includes('import.meta.url')) continue;
    for (const specifier of urlEntrySpecifiers(text)) {
      const entry = urlEntryCandidates(file, specifier).find((f) => isPackageSource(f) && isFile(path.join(cwd, f)));
      if (entry) found.add(entry);
    }
  }
  return found;
}

function firstError(err) {
  const e = err?.errors?.[0];
  if (e) return `${e.location ? `${e.location.file}:${e.location.line}: ` : ''}${e.text}`;
  return String(err?.message ?? err).split('\n')[0];
}

/** `{ roots, reachable, inputs, error }`. `error` is a one-line reason whenever the build cannot
 *  be trusted (no esbuild, no entry points, a failed build); callers then read every file as `unknown`. */
async function collectReachability(cwd) {
  const failed = (error, roots = 0) => ({ roots, reachable: 0, inputs: new Set(), error });
  let esbuild;
  try { esbuild = require('esbuild'); } catch (err) { return failed(`esbuild is not installed: ${firstError(err)}`); }
  const roots = entryPoints(cwd);
  if (roots.size === 0) return failed('no production entry points found');
  for (let round = 1; ; round += 1) {
    let result;
    try {
      result = await esbuild.build({
        absWorkingDir: cwd,
        entryPoints: [...roots],
        bundle: true,
        write: false,
        metafile: true,
        outdir: 'cez-reachability',
        outbase: '.',
        entryNames: '[dir]/[name]',
        format: 'esm',
        platform: 'neutral',
        tsconfigRaw: {},
        logLevel: 'silent',
        plugins: [resolverPlugin(cwd)],
      });
    } catch (err) {
      return failed(firstError(err), roots.size);
    }
    const inputs = new Set(Object.keys(result.metafile.inputs).filter((f) => !/^[\w-]+:/.test(f)));
    const added = [...pathLoadedEntries(cwd, inputs)].filter((f) => !roots.has(f));
    if (added.length === 0) return { roots: roots.size, reachable: inputs.size, inputs, error: null };
    if (round === MAX_ROUNDS) return failed(`path-loaded entries still growing after ${MAX_ROUNDS} builds`, roots.size);
    for (const f of added) roots.add(f);
  }
}

module.exports = { collectReachability, entryPoints };
