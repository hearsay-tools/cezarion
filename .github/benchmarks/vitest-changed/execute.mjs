import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

function config(root, output, mode) {
  const file = join(root, '.ai/qa/vitest-changed-pilot', `${mode}.config.mjs`);
  mkdirSync(join(root, '.ai/qa/vitest-changed-pilot'), { recursive: true });
  const q = JSON.stringify;
  const source = `import base from ${q(pathToFileURL(join(root, 'vitest.config.ts')).href)};
export default { ...base, root: ${q(root)}, test: { ...base.test,
  reporters: [...base.test.reporters, 'json'], outputFile: { json: ${q(join(output, `${mode}.json`))} },
  coverage: { ...base.test.coverage, changed: false, reportsDirectory: ${q(join(output, `${mode}-coverage`))} }
}};\n`;
  writeFileSync(file, source);
  return file;
}

export function execute({ root, output, mode, shard, files, expected }) {
  const configPath = config(root, output, mode);
  const args = ['test', '--', `--config=${configPath}`, `--shard=${shard}/4`,
    '--maxWorkers=4', '--coverage.enabled', '--passWithNoTests=false',
    ...(mode === 'selective' ? files : [])];
  const log = openSync(join(output, `${mode}.log`), 'w');
  const start = performance.now();
  let result;
  try {
    result = spawnSync('/usr/bin/time', ['-v', '-o', join(output, `${mode}.time`),
      'timeout', '--signal=TERM', '--kill-after=15s', '24m', 'npm', ...args], {
      cwd: root, stdio: ['ignore', log, log], timeout: 25 * 60_000,
    });
  } finally { closeSync(log); }
  const record = { mode, args, wallMs: performance.now() - start, exitCode: result.status,
    signal: result.signal, error: result.error?.message, expected,
    coverageAvailable: existsSync(join(output, `${mode}-coverage/coverage-final.json`)) };
  const reportPath = join(output, `${mode}.json`);
  if (!existsSync(reportPath)) return { ...record, validInventory: false, reportError: 'Missing JSON test result' };
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const actual = report.testResults.map(test => relative(root, test.name)).sort();
  return { ...record, actual, validInventory: JSON.stringify(actual) === JSON.stringify(expected),
    tests: report.numTotalTests, passed: report.numPassedTests, failed: report.numFailedTests,
    skipped: report.numPendingTests, success: report.success,
    failedFiles: report.testResults.filter(test => test.status === 'failed')
      .map(test => relative(root, test.name)) };
}
