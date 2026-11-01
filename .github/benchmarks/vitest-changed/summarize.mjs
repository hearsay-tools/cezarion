import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { campaign } from './campaign.mjs';

function resultFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? resultFiles(join(root, entry.name)) : entry.name === 'results.json' ? [join(root, entry.name)] : []);
}

export function summarize(rows, cases = campaign()) {
  return cases.map(entry => {
    const samples = rows.filter(row => row.metadata.entry.id === entry.id);
    const full = samples.map(row => row.results.find(result => result.mode === 'full'));
    const selected = samples.map(row => row.results.find(result => result.mode === 'selective'));
    const complete = samples.length === 4 && new Set(samples.map(row => row.metadata.shard)).size === 4
      && [...full, ...selected].every(Boolean);
    if (!complete) return { id: entry.id, complete: false, shards: samples.map(row => row.metadata.shard) };
    const fullMs = full.reduce((sum, result) => sum + result.wallMs, 0);
    const selectiveMs = selected.reduce((sum, result) => sum + result.wallMs, 0);
    const selectionMs = samples.reduce((sum, row) => sum + row.selectionMs, 0);
    const selectiveFiles = new Set(selected.flatMap(result => result.actual ?? []));
    const fullFailedFiles = [...new Set(full.flatMap(result => result.failedFiles ?? []))];
    return { id: entry.id, head: entry.head, complete,
      sourceMatches: samples.every(row => row.metadata.entry.head === entry.head && row.metadata.entry.base === entry.base),
      inventoriesValid: [...full, ...selected].every(result => result.validInventory),
      allCommandsPassed: [...full, ...selected].every(result => result.exitCode === 0 && result.success),
      modes: [...new Set(samples.map(row => row.selectionMode))],
      fullFiles: new Set(full.flatMap(result => result.actual ?? [])).size, selectiveFiles: selectiveFiles.size,
      fullMs, selectiveMs, selectionMs, netSavedMs: fullMs - selectiveMs - selectionMs,
      netSavedPercent: (fullMs - selectiveMs - selectionMs) / fullMs * 100,
      longestFullMs: Math.max(...full.map(result => result.wallMs)),
      longestSelectiveWithSelectionMs: Math.max(...selected.map((result, index) => result.wallMs + samples[index].selectionMs)),
      fullFailedFiles, selectiveFailedFiles: [...new Set(selected.flatMap(result => result.failedFiles ?? []))],
      fullFailureFilesOutsideExecutedSelection: fullFailedFiles.filter(file => !selectiveFiles.has(file)) };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { input: { type: 'string' }, output: { type: 'string' } } });
  if (!values.input || !values.output) throw new Error('Use --input <artifact directory> --output <summary.json>');
  const rows = resultFiles(resolve(values.input)).map(file => JSON.parse(readFileSync(file, 'utf8')));
  const summary = { scope: 'Paired test commands; shared install/build excluded; candidate includes selection',
    cases: summarize(rows) };
  mkdirSync(dirname(resolve(values.output)), { recursive: true });
  writeFileSync(values.output, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}
