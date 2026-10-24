import { exceededMetrics } from './changed-functions.mjs';
import { runMetrics } from './metrics.mjs';

const identity = fn => JSON.stringify([fn.name, fn.line, fn.column]);

export async function measureFile(file, coverage, cwd) {
  let output = '';
  const code = await runMetrics([file.file, '--json', '--coverage', coverage], {
    cwd, stdout: { write: text => { output += text; } },
  });
  if (code) throw new Error(JSON.parse(output).error);
  const metrics = JSON.parse(output);
  if (metrics.sourceHash !== file.sourceHash) throw new Error(`Source changed: ${file.file}`);
  const measured = new Map(metrics.functions.map(fn => [identity(fn), fn]));
  const functions = file.functions.map(changed => {
    const fn = measured.get(identity(changed));
    if (!fn) throw new Error(`Missing function: ${file.file}:${changed.line}:${changed.column}`);
    return { ...changed, ...fn, exceeded: exceededMetrics(fn) };
  });
  return { file: file.file, sourceHash: file.sourceHash, functions };
}

export function finishReport(scan, files, measurement, errors = []) {
  const functions = files.flatMap(file => file.functions);
  const missing = functions.filter(fn => fn.crap === null || fn.coverage.status !== 'available');
  const exceeded = functions.filter(fn => fn.exceeded.length);
  const expected = scan.files.reduce((sum, file) => sum + file.functions.length, 0);
  const incomplete = errors.length > 0 || missing.length > 0 || functions.length !== expected;
  return {
    schemaVersion: 1, status: incomplete ? 'incomplete' : exceeded.length ? 'exceeded' : 'pass',
    base: scan.base, target: scan.target, head: scan.head, thresholds: scan.thresholds,
    complexityVariant: 'classic', coverageMetric: 'function-body-lines',
    summary: { files: files.length, functions: functions.length, expectedFunctions: expected,
      exceeded: exceeded.length, unavailable: missing.length,
      maxComplexity: maximum(functions.map(fn => fn.complexity)),
      maxCrap: maximum(functions.map(fn => fn.crap).filter(Number.isFinite)) },
    measurement, files, deletedFiles: scan.deletedFiles, errors,
  };
}

function maximum(values) { return values.length ? Math.max(...values) : null; }
const cell = text => String(text).replaceAll('|', '\\|').replaceAll('\n', ' ').replaceAll('\r', ' ');

function functionRow(file, fn) {
  const coverage = fn.coverage.status === 'available' ? `${fn.coverage.percent.toFixed(2)}%` : 'unavailable';
  const crap = fn.crap === null ? 'unavailable' : fn.crap.toFixed(4);
  const action = fn.crap === null ? fn.coverage.reason : fn.exceeded.length ? `Review: ${fn.exceeded.join(', ')}` : 'Pass';
  return [file, `${fn.name} (${fn.line}:${fn.column})`, fn.complexity, coverage, crap, action].map(cell).join(' | ');
}

export function markdownReport(report) {
  const { summary, thresholds } = report;
  const lines = [
    '# Code quality check', '', `Result: ${report.status.toUpperCase()}.`, '',
    `Pinned baseline: \`${report.base ?? 'unavailable'}\`. Head: \`${report.head ?? 'unavailable'}\`.`, '',
    `Checked ${summary.functions}/${summary.expectedFunctions} changed functions across ${summary.files} files.`,
    `Limits: complexity > ${thresholds.complexity} or CRAP > ${thresholds.crap}. Equality passes.`,
    `Maximum complexity: ${summary.maxComplexity ?? 'unavailable'}. Maximum CRAP: ${summary.maxCrap ?? 'unavailable'}.`, '',
    'CRAP uses executable function body line coverage, a line-coverage variant of the original basis-path metric.', '',
    '## Reproduce', '', '```json', JSON.stringify(report.command ?? null, null, 2), '```', '',
    '## Measurement', '', '```json', JSON.stringify(report.measurement, null, 2), '```', '',
  ];
  if (report.errors.length) lines.push('## Blockers', '', ...report.errors.map(error => `- ${cell(error)}`), '');
  for (const file of report.files) {
    lines.push(`## ${cell(file.file)}`, '', `SHA-256: \`${file.sourceHash}\`.`, '',
      '| File | Function (line:column) | Complexity | Body line coverage | CRAP | Action |',
      '| --- | --- | ---: | ---: | ---: | --- |',
      ...file.functions.map(fn => `| ${functionRow(file.file, fn)} |`), '');
  }
  return lines.join('\n') + '\n';
}
