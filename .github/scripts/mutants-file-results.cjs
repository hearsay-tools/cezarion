'use strict';
const fs = require('node:fs');
const path = require('node:path');
const USAGE = 'Usage: mutants-file.cjs packages/<pkg>/src/<file>.ts [--tests <files>] [--compare <json>] [--out <json>] [--concurrency <n>]\n  measures the committed HEAD\n  mutants-file.cjs --rescore <result.json> [--out <new.json>]\n  mutants-file.cjs --compare-results <before.json> <after.json> [--out <delta.json>]';
const sourceFile = file => typeof file === 'string' && /^packages\/[^/]+\/src\/.+\.tsx?$/.test(file) && !file.split('/').includes('..');
const keys = ['killed', 'timeout', 'survived', 'noCoverage', 'error', 'ignored'];
function validCounts(counts) {
  return counts && keys.every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0);
}
function validSurvivor(row) {
  return row && ['function', 'mutator', 'original', 'replacement'].every(key => typeof row[key] === 'string');
}
function validateResult(result) {
  if (result?.version !== 2) throw new Error('Unsupported result version: expected version 2');
  if (!sourceFile(result.file) || typeof result.head !== 'string' || !validCounts(result.counts) || !validCounts(result.rawCounts)) throw new Error('Invalid stored result identity or counts');
  if (![result.score, result.rawScore].every(n => Number.isFinite(n) && n >= 0 && n <= 100) || !Array.isArray(result.survivors) || !result.survivors.every(validSurvivor)) throw new Error('Invalid stored result scores or survivors');
  validateConsumers(result.consumers);
  return result;
}
function validateConsumers(consumers) {
  if (consumers === undefined) return;
  if (!consumers || !['merged', 'failed'].includes(consumers.state) || !Array.isArray(consumers.tests) || !consumers.tests.every(file => typeof file === 'string')) throw new Error('Invalid stored result consumer outcome');
  if (consumers.state === 'failed' && typeof consumers.reason !== 'string') throw new Error('Invalid stored result consumer failure');
}
function storedArgs(argv) {
  const [mode, ...args] = argv;
  const count = mode === '--rescore' ? 1 : 2;
  const inputs = args.slice(0, count);
  if (inputs.length !== count || inputs.some(name => !name || name.startsWith('--'))) throw new Error(USAGE);
  const tail = args.slice(count);
  if (tail.length && (tail.length !== 2 || tail[0] !== '--out' || !tail[1] || tail[1].startsWith('--'))) throw new Error(USAGE);
  return { ...(count === 1 ? { rescore: inputs[0] } : { compareResults: inputs }), ...(tail.length ? { out: tail[1] } : {}) };
}
function statOrMissing(file) {
  try { return fs.statSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
/** Probe access without opening/truncating the result; compare inode identities for aliases. */
function validateOutput(out, inputs) {
  if (out.endsWith(path.sep)) throw new Error('--out must name a regular file');
  const dest = statOrMissing(out);
  if (dest && !dest.isFile()) throw new Error('--out must name a regular file');
  for (const input of inputs) {
    const source = fs.statSync(input);
    if (path.resolve(out) === path.resolve(input) || (dest && dest.dev === source.dev && dest.ino === source.ino)) throw new Error('--out must not overwrite an input file');
  }
  fs.accessSync(dest ? out : path.dirname(out), dest ? fs.constants.W_OK : fs.constants.W_OK | fs.constants.X_OK);
}
function preflight(opts, deps) {
  const inputs = opts.compareResults ?? [opts.rescore ?? opts.compare].filter(Boolean);
  const results = inputs.map(name => validateResult(deps.readJson(name)));
  if (opts.file && results.some(result => result.file !== opts.file)) throw new Error('Comparison needs the same result version and file');
  if (opts.out) (deps.validateOutput ?? validateOutput)(opts.out, inputs);
  return results;
}
function point(p, zeroBased) {
  return p && Number.isSafeInteger(p.line) && p.line >= (zeroBased ? 0 : 1) && Number.isSafeInteger(p.column) && p.column >= (zeroBased ? 0 : 1);
}
function validRange(range, zeroBased) {
  return range && point(range.start, zeroBased) && point(range.end, zeroBased) && (range.end.line > range.start.line || (range.end.line === range.start.line && range.end.column >= range.start.column));
}
function validWireMutant(row) {
  return row && (row.static === undefined || typeof row.static === 'boolean') && typeof row.mutatorName === 'string' && typeof row.replacement === 'string' && ['Killed', 'Timeout', 'Survived', 'NoCoverage', 'CompileError', 'RuntimeError', 'Ignored'].includes(row.status) && validRange(row.location, false);
}
function scoringEvidence(result) {
  const evidence = result.scoringEvidence;
  if (!evidence || evidence.version !== 1 || !Array.isArray(evidence.ranges) || !evidence.ranges.every(r => r && typeof r.name === 'string' && validRange(r.range, true))) throw new Error('Result lacks complete scoring evidence; measure again with the current command');
  const data = evidence.report?.files?.[result.file];
  if (!data || typeof data.source !== 'string' || !Array.isArray(data.mutants) || !data.mutants.every(validWireMutant)) throw new Error('Invalid scoring evidence report');
  return evidence;
}
module.exports = { USAGE, sourceFile, storedArgs, validateResult, validateOutput, preflight, scoringEvidence };
