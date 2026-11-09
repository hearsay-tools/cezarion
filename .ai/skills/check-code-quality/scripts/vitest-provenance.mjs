import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import convert from 'ast-v8-to-istanbul';
import { inlineSourceMap, resolveSourceMap, selectedSources, validateSelectedMap } from './source-snapshots.mjs';

function authoredImports(map, url) {
  url = new URL(url).href;
  const index = map?.sources?.findIndex(source => new URL(source, url).href === url);
  const source = map?.sourcesContent?.[index];
  if (typeof source !== 'string') throw new Error(`Missing original import provenance: ${url}`);
  if (readFileSync(new URL(url), 'utf8') !== source) throw new Error(`Stale original import provenance: ${url}`);
  const path = new URL(url).pathname;
  const typed = /\.[cm]?tsx?$/i.test(path);
  const jsx = /\.[jt]sx$/i.test(path);
  const ast = parse(source, { sourceType: 'unambiguous', plugins: [...(typed ? ['typescript'] : []), ...(jsx ? ['jsx'] : [])] });
  const imports = new Map();
  for (const node of ast.program.body) {
    if (node.type !== 'ImportDeclaration') continue;
    for (const specifier of node.specifiers) {
      if (specifier.type === 'ImportSpecifier') imports.set(specifier.local.name, {
        name: specifier.imported.name ?? specifier.imported.value, module: node.source.value,
      });
    }
  }
  return imports;
}

function importedModule(node) {
  const init = node.init;
  if (node.id.type !== 'Identifier' || !/^__vite_ssr_import_\d+__$/.test(node.id.name)) return;
  if (init?.type !== 'AwaitExpression' || init.argument.type !== 'CallExpression'
    || init.argument.callee.name !== '__vite_ssr_import__') return;
  return init.argument.arguments[0]?.value;
}

function adapterImport(node, modules) {
  const init = node.init;
  if (node.id.type !== 'Identifier' || init?.type !== 'MemberExpression' || !init.computed
    || typeof init.property.value !== 'string') return;
  const object = init.object;
  if (object.type !== 'MemberExpression' || object.computed || object.property.name !== 'default'
    || object.object.type !== 'Identifier') return;
  const module = modules.get(object.object.name);
  if (!module) return;
  return { local: node.id.name, name: init.property.value, module };
}

function matchesAuthoredImport(adapter, imports) {
  const imported = imports.get(adapter.local);
  return imported?.name === adapter.name && (adapter.module === imported.module
    || adapter.module === `/@id/__vite-browser-external:${imported.module}`);
}

/** Remove only proved generated import adapters from the conversion AST. Offsets stay fixed. */
export function stripImportAdapters(code, map, url) {
  const ast = parse(code, { sourceType: 'unambiguous', plugins: ['estree'], ranges: true });
  const declarations = ast.program.body.filter(node => node.type === 'VariableDeclaration');
  const modules = new Map();
  for (const declaration of declarations) for (const node of declaration.declarations) {
    const module = importedModule(node);
    if (module) modules.set(node.id.name, module);
  }
  const candidates = declarations.filter(declaration => declaration.declarations.every(node => adapterImport(node, modules)));
  if (!candidates.length) return code;
  const imports = authoredImports(map, url);
  const spans = candidates.filter(declaration => declaration.declarations.every(node => matchesAuthoredImport(adapterImport(node, modules), imports)));
  for (const node of spans.reverse()) {
    code = code.slice(0, node.start) + code.slice(node.start, node.end).replace(/[^\r\n]/g, ' ') + code.slice(node.end);
  }
  return code;
}

/** Native V8 ranges must use captured native code, never a later Vite transform. */
export function nativeCoverageSource(url, functions, raw) {
  url = new URL(url).href;
  const directory = join(raw, 'sources');
  const snapshots = existsSync(directory) ? readdirSync(directory).filter(file => file.endsWith('.json'))
    .map(file => JSON.parse(readFileSync(join(directory, file), 'utf8'))) : [];
  const root = functions.find(fn => fn.functionName === '' && fn.ranges?.[0]?.startOffset === 0)?.ranges[0];
  // Modules loaded before precise coverage starts have function-only ranges.
  // Keep every snapshot candidate in that case so conflicting captures still fail.
  const matching = snapshots.filter(snapshot => snapshot.url === url
    && (!root || snapshot.code.length === root.endOffset));
  const unique = new Map(matching.map(snapshot => [JSON.stringify([snapshot.code, snapshot.error]), snapshot]));
  if (unique.size !== 1) throw new Error(`${unique.size ? 'Ambiguous' : 'Missing'} native generated source snapshot: ${url}`);
  const snapshot = [...unique.values()][0];
  if (snapshot.error) throw new Error(`${snapshot.error}: ${url}`);
  if (functions.some(fn => fn.ranges.some(range => range.startOffset < 0
    || range.endOffset < range.startOffset || range.endOffset > snapshot.code.length))) {
    throw new Error(`Coverage offsets exceed native source snapshot: ${url}`);
  }
  let map = inlineSourceMap(snapshot.code);
  if (map) {
    map = resolveSourceMap(map, url);
    validateSelectedMap(map, selectedSources(raw));
  } else if (!/\.[cm]?js$/i.test(new URL(url).pathname) || readFileSync(new URL(url), 'utf8') !== snapshot.code) {
    throw new Error(`Missing source map or stale native source snapshot: ${url}`);
  }
  return { code: snapshot.code, map };
}

export function preserveVitestSourceProvenance(vitest, raw) {
  const provider = vitest.coverageProvider;
  if (!provider) return;
  if (typeof provider.remapCoverage !== 'function') {
    throw new Error('The installed coverage provider lacks remapCoverage; native source provenance cannot be verified.');
  }
  const remap = provider.remapCoverage.bind(provider);
  provider.remapCoverage = (url, wrapperLength, result, functions) => {
    if (!wrapperLength) {
      const source = nativeCoverageSource(url, functions, raw);
      const ast = parse(source.code, { sourceType: 'unambiguous', plugins: ['estree'], ranges: true }).program;
      // Native code has no Vite scaffolding. Preserve even authored identifiers
      // that resemble Vite's reserved names; its synthetic-node rules do not apply.
      return convert({ code: source.code, sourceMap: source.map, ast, coverage: { url, functions } });
    }
    return remap(url, wrapperLength, { ...result, code: stripImportAdapters(result.code, result.map, url) }, functions);
  };
}
