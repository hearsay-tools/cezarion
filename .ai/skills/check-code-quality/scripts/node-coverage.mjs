import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';
import convert from 'ast-v8-to-istanbul';
import { mergeIstanbulReports } from './istanbul-merge.mjs';
import { inlineSourceMap, resolveSourceMap, validateSelectedMap } from './source-snapshots.mjs';

function readSnapshots(raw) {
  const directory = join(raw, 'sources');
  return existsSync(directory) ? readdirSync(directory).filter(file => file.endsWith('.json'))
    .map(file => JSON.parse(readFileSync(join(directory, file), 'utf8'))) : [];
}

function snapshotFor(script, pid, snapshots) {
  const matching = snapshots.filter(snapshot => snapshot.url === script.url);
  const local = matching.filter(snapshot => snapshot.pid === pid);
  const candidates = local.length ? local : matching;
  const unique = new Map(candidates.map(snapshot => [JSON.stringify([snapshot.code, snapshot.error]), snapshot]));
  if (unique.size > 1) throw new Error(`Ambiguous generated source snapshots: ${script.url}`);
  return [...unique.values()][0];
}

function currentSource(snapshot, selected) {
  if (snapshot.error) throw new Error(`${snapshot.error}: ${snapshot.url}`);
  // Reparse the archived code rather than trusting serialized metadata.
  const inline = inlineSourceMap(snapshot.code);
  if (inline) {
    const map = resolveSourceMap(inline, snapshot.url);
    validateSelectedMap(map, selected);
    return map;
  }
  if (!/\.[cm]?js$/i.test(new URL(snapshot.url).pathname)) {
    throw new Error(`Missing inline source map for transformed source: ${snapshot.url}`);
  }
  if (readFileSync(new URL(snapshot.url), 'utf8') !== snapshot.code) {
    throw new Error(`Missing source map or stale generated source: ${snapshot.url}`);
  }
}

function selectedSnapshot(snapshot, selected) {
  return selected.has(snapshot.url) || snapshot.sourceMap?.sources.some(url => selected.has(url));
}

/** Convert each executed transform separately, then merge original-source counters. */
export async function nodeCoverageReport(raw, files, cwd) {
  const selected = new Set(files.map(file => pathToFileURL(resolve(cwd, file)).href));
  const snapshots = readSnapshots(raw);
  let report = {}, processes = 0;
  // quality-inputs.json and sources/ are metadata, never process coverage.
  for (const file of readdirSync(raw).filter(file => /^coverage-\d+-.*\.json$/.test(file))) {
    const pid = Number(/^coverage-(\d+)-/.exec(file)[1]);
    const data = JSON.parse(readFileSync(join(raw, file), 'utf8'));
    if (!Array.isArray(data.result)) throw new Error(`Invalid Node coverage report: ${file}`);
    processes++;
    for (const coverage of data.result) {
      const snapshot = snapshotFor(coverage, pid, snapshots);
      if (!snapshot) {
        if (selected.has(coverage.url)) throw new Error(`Missing generated source snapshot: ${coverage.url}`);
        continue;
      }
      if (!selectedSnapshot(snapshot, selected)) continue;
      const sourceMap = currentSource(snapshot, selected);
      const code = snapshot.code;
      if (coverage.functions.some(fn => fn.ranges.some(range => range.endOffset > code.length))) {
        throw new Error(`Coverage offsets exceed generated source snapshot: ${coverage.url}`);
      }
      const ast = parse(code, { sourceType: 'unambiguous', plugins: ['estree'], ranges: true }).program;
      const converted = await convert({ code, ast, coverage, sourceMap });
      const relevant = Object.fromEntries(Object.entries(converted).filter(([path]) => selected.has(pathToFileURL(resolve(path)).href)));
      report = mergeIstanbulReports(report, JSON.parse(JSON.stringify(relevant)));
    }
  }
  return { report, processes };
}
