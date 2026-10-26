#!/usr/bin/env node
// Merges the Vitest coverage reports of one CI run's shards into one Istanbul report.
// CI writes absolute runner paths. This script rewrites them relative to the repository
// root, so `check.mjs --coverage` finds each file in any checkout of the same commit.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { mergeIstanbulReports } from '../../.ai/skills/check-code-quality/scripts/istanbul-merge.mjs';

const shardFile = (input, number) => join(input, `vitest-coverage-shard-${number}`, 'coverage-final.json');

function readShard(input, number) {
  try {
    const report = JSON.parse(readFileSync(shardFile(input, number), 'utf8'));
    if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('expected an object');
    return report;
  } catch (error) {
    throw new Error(`Shard ${number} report is not valid JSON: ${error.message}`);
  }
}

function relativeReport(report, root) {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  const relative = {};
  for (const [key, entry] of Object.entries(report)) {
    const file = entry.path ?? key;
    if (!file.startsWith(prefix)) throw new Error(`Coverage path is outside the workspace: ${file}`);
    const repoPath = file.slice(prefix.length);
    relative[repoPath] = { ...entry, path: repoPath };
  }
  return Object.fromEntries(Object.entries(relative).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Merge the reports of shards 1..`shards`, all of which must be present. */
export function mergeShardReports({ input, shards, root }) {
  const numbers = Array.from({ length: shards }, (_, index) => index + 1);
  const missing = numbers.filter((number) => !existsSync(shardFile(input, number)));
  if (missing.length) throw new Error(`Missing coverage for ${missing.map((number) => `shard ${number}`).join(', ')}.`);
  const merged = numbers.reduce((target, number) => mergeIstanbulReports(target, readShard(input, number)), {});
  const report = relativeReport(merged, root);
  return { report, files: Object.keys(report).length };
}

function parseInput(argv) {
  const { values } = parseArgs({ args: argv, options: {
    input: { type: 'string' }, output: { type: 'string' }, shards: { type: 'string' }, root: { type: 'string' },
    meta: { type: 'string', multiple: true },
  } });
  const shards = Number(values.shards);
  if (!values.input || !values.output || !values.root || !Number.isInteger(shards) || shards < 1) {
    throw new Error('Usage: merge-vitest-coverage.mjs --input <dir> --output <dir> --shards <n> --root <repository root> [--meta key=value]...');
  }
  const meta = Object.fromEntries((values.meta ?? []).map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]));
  return { input: resolve(values.input), output: resolve(values.output), shards, root: values.root, meta };
}

export function main(argv) {
  try {
    const { input, output, shards, root, meta } = parseInput(argv);
    const { report, files } = mergeShardReports({ input, shards, root });
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, 'coverage-final.json'), JSON.stringify(report));
    writeFileSync(join(output, 'provenance.json'), `${JSON.stringify({ ...meta, shards, files, paths: 'relative to the repository root' }, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

// `import.meta.url` is the real path, so compare real paths: a symlinked start must still run `main`.
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}
