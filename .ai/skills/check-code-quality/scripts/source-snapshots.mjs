import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { threadId } from 'node:worker_threads';

/** Measurement is opt-in through the collector's raw directory and manifest. */
export function measurementEnabled() {
  return Boolean(process.env.NODE_V8_COVERAGE && existsSync(join(process.env.NODE_V8_COVERAGE, 'quality-inputs.json')));
}

export function selectedSources(raw) {
  const files = JSON.parse(readFileSync(join(raw, 'quality-inputs.json'), 'utf8'));
  if (!Array.isArray(files) || files.some(file => typeof file !== 'string')) throw new Error('Invalid quality input manifest.');
  return new Set(files.map(file => pathToFileURL(file).href));
}

/** Only inline maps carry the executed transform's own source provenance. */
export function inlineSourceMap(code) {
  const references = [...code.matchAll(/^[ \t]*(?:\/\/[#@]|\/\*[#@])\s*sourceMappingURL=([^\s*]+)(?:\s*\*\/)?[ \t]*$/gm)];
  if (!references.length) return undefined;
  if (references.length !== 1) throw new Error('Ambiguous source maps.');
  const reference = references[0][1];
  const match = /^data:application\/json(?:;charset=[^;,]+)?(;base64)?,(.*)$/.exec(reference);
  if (!match) throw new Error('Missing inline source map.');
  const map = JSON.parse(match[1] ? Buffer.from(match[2], 'base64').toString('utf8') : decodeURIComponent(match[2]));
  if (map.version !== 3 || !Array.isArray(map.sources) || typeof map.mappings !== 'string'
    || !Array.isArray(map.sourcesContent) || map.sourcesContent.length !== map.sources.length) {
    throw new Error('Incomplete inline source map.');
  }
  return map;
}

export function resolveSourceMap(map, url) {
  const root = map.sourceRoot ? new URL(map.sourceRoot.endsWith('/') ? map.sourceRoot : map.sourceRoot + '/', url).href : url;
  const sources = map.sources.map(source => new URL(source, root).href);
  if (new Set(sources).size !== sources.length) throw new Error('Ambiguous source map sources.');
  return { ...map, sourceRoot: '', sources };
}

export function validateSelectedMap(map, selected) {
  for (const [index, url] of map.sources.entries()) {
    if (!selected.has(url)) continue;
    if (typeof map.sourcesContent[index] !== 'string' || readFileSync(fileURLToPath(url), 'utf8') !== map.sourcesContent[index]) {
      throw new Error(`Stale or missing mapped source content: ${url}`);
    }
  }
}

/** Archive before a fixture removes its emitted file. Never alter the test process. */
export function recordGeneratedSource(url, code) {
  if (!measurementEnabled() || typeof url !== 'string' || !url.startsWith('file:')) return;
  const raw = process.env.NODE_V8_COVERAGE;
  const selected = selectedSources(raw);
  let map;
  try {
    map = inlineSourceMap(code);
    if (map) map = resolveSourceMap(map, url);
  } catch (error) {
    if (!selected.has(url)) return;
    archive(raw, { url, code, error: error.message });
    return;
  }
  if (!selected.has(url) && !map?.sources.some(source => selected.has(source))) return;
  try { if (map) validateSelectedMap(map, selected); }
  catch (error) { archive(raw, { url, code, sourceMap: map, error: error.message }); return; }
  archive(raw, { url, code, sourceMap: map });
}

function archive(raw, snapshot) {
  const directory = join(raw, 'sources');
  mkdirSync(directory, { recursive: true });
  const hash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  writeFileSync(join(directory, `${process.pid}-${threadId}-${hash}.json`), JSON.stringify({ ...snapshot, pid: process.pid }));
}
