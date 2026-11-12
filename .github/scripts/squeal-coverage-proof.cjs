'use strict';

// Compares the three runs of the Squeal coverage proof (ci.yml squeal-coverage-proof, hearsay-tools/squeal
// spec 020 D19, row 020-26c): Vitest shard 1/8 with V8 coverage under `squeal ci record` (`squeal`), and
// twice alone (`v8`, `v8-control`). It prints a Markdown job summary and writes the comparison as JSON.
// It reads only the downloaded artifacts, and it exits 0 whatever it finds: the proof gates nothing.
const fs = require('node:fs');
const path = require('node:path');

const RUNS = [
  { run: 'squeal', label: '(a) `squeal`' },
  { run: 'v8', label: '(b) `v8`' },
  { run: 'v8-control', label: '(c) `v8-control`' },
];
const PAIRS = [['squeal', 'v8'], ['v8', 'v8-control']];
const LISTED = 20;

function readJson(file) {
  try {
    return { value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    return { error: error.code === 'ENOENT' ? 'missing' : `does not read: ${error.message}` };
  }
}

/** Istanbul statement keys by source location, so two reports compare even when their ids differ. */
function statements(entry) {
  const seen = new Map();
  const covered = new Map();
  for (const [id, loc] of Object.entries(entry.statementMap ?? {})) {
    const at = `${loc.start.line}:${loc.start.column}-${loc.end.line}:${loc.end.column}`;
    const n = seen.get(at) ?? 0;
    seen.set(at, n + 1);
    covered.set(n === 0 ? at : `${at}#${n}`, (entry.s?.[id] ?? 0) > 0);
  }
  return covered;
}

/** The report's files by path relative to the run's checkout. */
function coverageFiles(report, root) {
  const prefix = root ? `${root.replace(/\/$/, '')}/` : null;
  const files = new Map();
  for (const [key, entry] of Object.entries(report)) {
    const file = entry.path ?? key;
    files.set(prefix && file.startsWith(prefix) ? file.slice(prefix.length) : file, statements(entry));
  }
  return files;
}

function readRun(input, run) {
  const dir = path.join(input, `squeal-coverage-proof-${run}`);
  const meta = readJson(path.join(dir, 'run.json'));
  const report = readJson(path.join(dir, 'coverage-final.json'));
  const info = { run, ...(meta.value ?? { runError: meta.error }) };
  if (report.error) return { info: { ...info, coverageError: report.error }, files: null };
  const files = coverageFiles(report.value, info.root);
  let total = 0;
  let covered = 0;
  for (const stmts of files.values()) for (const hit of stmts.values()) { total += 1; covered += hit ? 1 : 0; }
  return { info: { ...info, coverage: { files: files.size, statements: total, covered } }, files };
}

function compareFile(a, b) {
  const counts = { compared: 0, onlyFirst: 0, onlySecond: 0, unmatched: 0 };
  for (const [at, hit] of a) {
    if (!b.has(at)) { counts.unmatched += 1; continue; }
    counts.compared += 1;
    if (hit && !b.get(at)) counts.onlyFirst += 1;
    if (!hit && b.get(at)) counts.onlySecond += 1;
  }
  for (const at of b.keys()) if (!a.has(at)) counts.unmatched += 1;
  return counts;
}

/** Covered-statement differences between two reports, as counts of statements and files. */
function compareReports(first, second) {
  const result = { first: first.run, second: second.run, statements: { compared: 0, differing: 0, onlyFirst: 0, onlySecond: 0, unmatched: 0 },
    files: { compared: 0, differing: 0, onlyFirst: [], onlySecond: [] }, differingFiles: [] };
  for (const [file, a] of first.files) {
    const b = second.files.get(file);
    if (!b) { result.files.onlyFirst.push(file); continue; }
    const counts = compareFile(a, b);
    result.files.compared += 1;
    for (const key of ['compared', 'onlyFirst', 'onlySecond', 'unmatched']) result.statements[key] += counts[key];
    if (counts.onlyFirst + counts.onlySecond > 0) result.differingFiles.push({ file, onlyFirst: counts.onlyFirst, onlySecond: counts.onlySecond });
  }
  for (const file of second.files.keys()) if (!first.files.has(file)) result.files.onlySecond.push(file);
  result.statements.differing = result.statements.onlyFirst + result.statements.onlySecond;
  result.files.differing = result.differingFiles.length;
  result.differingFiles.sort((x, y) => (y.onlyFirst + y.onlySecond) - (x.onlyFirst + x.onlySecond) || (x.file < y.file ? -1 : 1));
  return result;
}

function readParts(dir) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => /^squeal-part-.*\.json$/.test(name)).sort();
  } catch {
    return { parts: [], errors: ['no parts directory'] };
  }
  const parts = [];
  const errors = [];
  for (const name of names) {
    const { value, error } = readJson(path.join(dir, name));
    if (error) errors.push(`${name}: ${error}`); else parts.push(value);
  }
  return { parts, errors };
}

const refName = (ref) => (ref.project ? `${ref.project}:${ref.path}` : ref.path);

/** What the `squeal` run's parts say: records against test files, the coverage header and Squeal's own time. */
function summarizeParts({ parts, errors }) {
  const files = parts.flatMap((part) => part.testFiles ?? []);
  const noRecord = {};
  for (const file of files.filter((f) => f.record === undefined)) {
    const reason = file.noRecord ?? 'none named';
    noRecord[reason] = (noRecord[reason] ?? 0) + 1;
  }
  const headers = parts.map((part) => part.header?.coverage ?? null);
  const costs = [...new Map(parts.map((part) => part.header?.cost).filter(Boolean).map((cost) => [cost.command, cost])).values()];
  const sum = (list, key) => list.reduce((total, item) => total + (Number(item[key]) || 0), 0);
  const unique = (list) => [...new Set(list.map((item) => JSON.stringify(item)))].map((item) => JSON.parse(item));
  return {
    parts: parts.length, errors, formats: unique(parts.map((part) => part.format ?? 'unknown')), ends: unique(parts.map((part) => part.header?.end ?? 'unknown')),
    versions: unique(parts.map((part) => `Squeal ${part.header?.squealVersion ?? 'unknown'}, Vitest ${part.header?.runnerVersion ?? 'unknown'}`)),
    testFiles: files.length, withRecord: files.filter((f) => f.record !== undefined).length, noRecord,
    coverage: unique(headers.map((h) => h && { ...h, inspector: undefined })),
    collector: unique(headers.map((h) => (h && !('off' in h) ? h.collector ?? 'not named' : 'none'))),
    inspector: {
      loaded: [...new Set(headers.flatMap((h) => h?.inspector?.loaded ?? []).map(refName))].sort(),
      unknown: [...new Set(headers.flatMap((h) => h?.inspector?.unknown ?? []).map(refName))].sort(),
    },
    cost: costs.length ? { commands: costs.length, hooksMs: sum(costs, 'hooksMs'), threads: sum(costs, 'threads'), afterMs: sum(costs, 'afterMs') } : null,
    testMs: files.reduce((total, f) => total + (Number(f.durationMs) || 0), 0),
  };
}

const num = (n) => Number(n).toLocaleString('en-US');
// Two decimals under 10 s, one above, as the gate trial's summary rounds.
const secs = (s) => {
  if (s === null || s === undefined || Number.isNaN(Number(s))) return 'unknown';
  const scale = Math.abs(Number(s)) < 10 ? 100 : 10;
  return `${num(Math.round(Number(s) * scale) / scale)} s`;
};
const files = (n) => `${num(n)} test ${n === 1 ? 'file' : 'files'}`;
const pct = (part, whole) => (whole > 0 ? `${Math.round((1000 * part) / whole) / 10}%` : 'n/a');
const cpu = (info) => (typeof info.userSeconds === 'number' && typeof info.sysSeconds === 'number' ? info.userSeconds + info.sysSeconds : null);
const label = (run) => RUNS.find((r) => r.run === run).label;

function delta(name, a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') return `${name} unknown`;
  const sign = a >= b ? '+' : '-';
  return `${name} ${sign}${secs(Math.abs(a - b))} (${sign}${pct(Math.abs(a - b), b)})`;
}

function coverageLines(comparisons) {
  const lines = ['### Covered statements', '',
    '| Comparison | Statements compared | Covered state differs | Covered only in the first | Covered only in the second | Files compared | Files that differ | Files in one report only | Statements in one map only |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for (const c of comparisons) {
    const name = `${label(c.first)} against ${label(c.second)}`;
    if (c.missing) { lines.push(`| ${name} | ${c.missing} | | | | | | | |`); continue; }
    const s = c.statements;
    lines.push(`| ${name} | ${num(s.compared)} | ${num(s.differing)} (${pct(s.differing, s.compared)}) | ${num(s.onlyFirst)} | ${num(s.onlySecond)} | `
      + `${num(c.files.compared)} | ${num(c.files.differing)} | ${num(c.files.onlyFirst.length + c.files.onlySecond.length)} | ${num(s.unmatched)} |`);
  }
  for (const c of comparisons.filter((x) => !x.missing && x.differingFiles.length)) {
    lines.push('', `Files that differ, ${label(c.first)} against ${label(c.second)} (covered only in the first / only in the second), up to ${LISTED}:`, '');
    for (const f of c.differingFiles.slice(0, LISTED)) lines.push(`- \`${f.file}\`: ${f.onlyFirst} / ${f.onlySecond}`);
  }
  return lines;
}

function partLines(p) {
  const lines = ['', "### Squeal's records in (a)'s parts", ''];
  if (!p.parts) return [...lines, `No part reads (${p.errors.join('; ') || 'none'}).`];
  const reasons = Object.entries(p.noRecord).map(([reason, n]) => `${reason} ${n}`).join(', ') || 'none';
  const coverage = p.coverage.map((h) => (h === null ? 'none (an older part format)' : 'off' in h ? `off: ${h.off} (${h.note})`
    : `collector \`${h.collector ?? 'not named'}\`${h.collectorVersion ? ` (@vitest/coverage-v8 ${h.collectorVersion})` : ''}, provider ${h.providerVersion}, record ${h.recordVersion}${h.note ? `, note: ${h.note}` : ''}`));
  lines.push(`- Parts: ${p.parts} (${p.formats.join(', ')}; ${p.versions.join('; ')}), run end ${p.ends.join(', ')}.${p.errors.length ? ` Not read: ${p.errors.join('; ')}.` : ''}`,
    `- Coverage header: ${coverage.join('; ')}. Collector: ${p.collector.map((c) => `\`${c}\``).join(', ')} (expected \`v8\`).`,
    `- Test files: ${num(p.testFiles)}; with a record: ${num(p.withRecord)} (${pct(p.withRecord, p.testFiles)}); without: ${num(p.testFiles - p.withRecord)} (${reasons}).`,
    `- \`node:inspector\`: loaded by ${files(p.inspector.loaded.length)}, unknown for ${files(p.inspector.unknown.length)}.`);
  for (const [kind, list] of Object.entries(p.inspector)) if (list.length) lines.push(`  - ${kind}: ${list.slice(0, LISTED).map((f) => `\`${f}\``).join(', ')}${list.length > LISTED ? ', …' : ''}`);
  return lines;
}

function timeLines(infos, p) {
  const lines = ['', '### Time', '', '| Run | Exit code | Wall | CPU (user + sys) | CPUs | CPU model | Load before, after |', '|---|---:|---:|---:|---:|---|---|'];
  for (const info of infos) {
    if (info.runError) { lines.push(`| ${label(info.run)} | run.json ${info.runError} | | | | | |`); continue; }
    lines.push(`| ${label(info.run)} | ${info.exitCode} | ${secs(info.wallSeconds)} | ${secs(cpu(info))} | ${info.cpus ?? ''} | ${info.cpuModel ?? ''} | ${info.loadBefore ?? '?'}, ${info.loadAfter ?? '?'} |`);
  }
  const [a, b, c] = infos;
  lines.push('', `- (a) against (b): ${delta('wall', a.wallSeconds, b.wallSeconds)}, ${delta('CPU', cpu(a), cpu(b))}.`,
    `- (c) against (b), the run-to-run control: ${delta('wall', c.wallSeconds, b.wallSeconds)}, ${delta('CPU', cpu(c), cpu(b))}.`);
  if (p.cost) {
    lines.push(`- Squeal's own time in (a), from its parts: ${secs(p.cost.hooksMs / 1000)} in its hooks over ${p.cost.threads} processes and threads `
      + `(${pct(p.cost.hooksMs, p.testMs)} of the test files' summed ${secs(p.testMs / 1000)}), and ${secs(p.cost.afterMs / 1000)} after the command.`);
  } else lines.push("- Squeal's own time in (a): not in the parts.");
  return lines;
}

/** Reads the downloaded artifacts under `input` and returns the comparison and its Markdown summary. */
function compare(input) {
  const runs = Object.fromEntries(RUNS.map(({ run }) => [run, readRun(input, run)]));
  const comparisons = PAIRS.map(([first, second]) => {
    const missing = [first, second].filter((run) => !runs[run].files).map((run) => `${label(run)}: coverage ${runs[run].info.coverageError}`);
    return missing.length ? { first, second, missing: missing.join('; ') } : compareReports({ run: first, files: runs[first].files }, { run: second, files: runs[second].files });
  });
  const parts = summarizeParts(readParts(path.join(input, 'squeal-coverage-proof-squeal', 'parts')));
  const infos = RUNS.map(({ run }) => runs[run].info);
  const markdown = ['## Squeal coverage proof', '',
    'A proof: these jobs gate nothing and never fail the run. Vitest shard 1/8, three runs with V8 coverage on one commit: (a) under `squeal ci record`, (b) and (c) alone; (c) is the run-to-run control.', '',
    ...coverageLines(comparisons), ...partLines(parts), ...timeLines(infos, parts), ''].join('\n');
  return { comparison: { format: 'squeal-coverage-proof/1', runs: infos, comparisons, parts }, markdown };
}

function main(argv, { stdout = (text) => process.stdout.write(text), stderr = (text) => process.stderr.write(text) } = {}) {
  const option = (name) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
  const input = option('--input');
  const json = option('--json');
  if (!input) {
    stderr('Usage: node .github/scripts/squeal-coverage-proof.cjs --input <downloaded artifacts> [--json <comparison.json>]\n');
    return 0;
  }
  try {
    const { comparison, markdown } = compare(input);
    if (json) fs.writeFileSync(json, `${JSON.stringify(comparison, null, 2)}\n`);
    stdout(markdown);
  } catch (error) {
    stdout(`## Squeal coverage proof\n\nThe comparison failed: ${error.message}\n`);
    stderr(`${error.stack}\n`);
  }
  return 0;
}

module.exports = { compare, compareReports, coverageFiles, summarizeParts, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
