#!/usr/bin/env node
import { mkdtempSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { scanChanges, thresholds } from './changed-functions.mjs';
import { collectCoverage } from './coverage.mjs';
import { finishReport, markdownReport, measureFile } from './quality-report.mjs';

const HELP = `Usage: node <skill>/scripts/check.mjs --base <PR-target-ref> [options]

Scan changed JS/TS functions, collect coverage once, measure and report.
  --coverage <path>     Read current Istanbul coverage instead of running tests
  --runner <node|vitest> Collect fresh coverage with --test (default: vitest)
  --test <path>         Relevant test file; repeatable, run once as a group
  --project <name>      Vitest project; repeatable
  --node-import <path>  Node test setup module; repeatable
  --output <path.md>    Save Markdown and a sibling .json report
  --json               Print JSON instead of Markdown
  -h, --help           Show this help

Exit codes: 0 pass, 1 limits exceeded, 2 incomplete (including test failure).
Limits are CRAP > ${thresholds.crap} or complexity > ${thresholds.complexity}. Missing coverage cannot pass.
Coverage uses the target project's tests. No dependencies are downloaded.
`;

function localFile(file, cwd) {
  const path = realpathSync(resolve(cwd, file));
  if (!statSync(path).isFile()) throw new Error(`Expected a file: ${file}`);
  return path;
}

function validateRunner(values, runner) {
  if (!['node', 'vitest'].includes(runner)) throw new Error('Choose --runner node or vitest.');
  if ((values.runner || values.project || values['node-import']) && !values.test) throw new Error('Runner options require --test.');
  if (values.project && runner !== 'vitest') throw new Error('--project requires Vitest.');
  if (values['node-import'] && runner !== 'node') throw new Error('--node-import requires Node.');
  if (values.project?.some(name => !name.trim())) throw new Error('--project must be nonempty.');
}

function parseInput(args, cwd) {
  const { values, positionals } = parseArgs({ args, options: {
    base: { type: 'string' }, coverage: { type: 'string' }, runner: { type: 'string' },
    test: { type: 'string', multiple: true }, project: { type: 'string', multiple: true },
    'node-import': { type: 'string', multiple: true }, output: { type: 'string' },
    json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) return values;
  if (!values.base?.trim() || positionals.length) throw new Error('Supply --base <PR-target-ref>.');
  if (values.coverage && values.test) throw new Error('Use --coverage or --test, not both.');
  const runner = values.runner ?? 'vitest';
  validateRunner(values, runner);
  if (values.output && !values.output.endsWith('.md')) throw new Error('--output must end in .md.');
  const tests = (values.test ?? []).map(file => localFile(file, cwd));
  if (tests.some(file => !/\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(file))) throw new Error('--test must name a test file.');
  const imports = (values['node-import'] ?? []).map(file => localFile(file, cwd));
  return { ...values, runner, tests, imports, projects: values.project ?? [] };
}

function verifySnapshot(scan, cwd) {
  const current = scanChanges(scan.base, cwd);
  if (current.head !== scan.head || JSON.stringify(current.files) !== JSON.stringify(scan.files)
    || JSON.stringify(current.deletedFiles) !== JSON.stringify(scan.deletedFiles)) {
    throw new Error('Changed source set or HEAD changed during measurement. Run the check again.');
  }
}

function saveReport(report, options, cwd, stdout) {
  const markdown = markdownReport(report);
  const json = JSON.stringify(report, null, 2) + '\n';
  if (options.output) {
    const path = resolve(cwd, options.output);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, markdown);
    writeFileSync(path.slice(0, -3) + '.json', json);
  }
  stdout.write(options.json ? json : markdown);
}

export async function runCheck(args, { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr,
  collect = collectCoverage, measure = measureFile } = {}) {
  let temporary, scan, measurement = null;
  let options = { json: args.includes('--json') };
  const files = [];
  const errors = [];
  try {
    options = parseInput(args, cwd);
    if (options.help) { stdout.write(HELP); return 0; }
    scan = scanChanges(options.base, cwd);
    if (scan.files.length) {
      let coverage = options.coverage && localFile(options.coverage, cwd);
      measurement = coverage ? { runner: 'istanbul', path: coverage } : null;
      if (options.tests.length) {
        temporary = mkdtempSync(join(tmpdir(), 'code-quality-'));
        const result = await collect({ ...options, cwd, stderr, files: scan.files.map(file => file.file) }, temporary);
        coverage = result.path;
        const { path, ...provenance } = result;
        measurement = provenance;
      }
      if (!coverage) throw new Error('Supply --test for fresh coverage or --coverage for a current Istanbul report.');
      verifySnapshot(scan, cwd);
      for (const file of scan.files) files.push(await measure(file, coverage, cwd));
      verifySnapshot(scan, cwd);
    }
  } catch (error) {
    errors.push(error.message);
  } finally {
    if (temporary) {
      try { rmSync(temporary, { recursive: true, force: true }); }
      catch (error) { stderr.write(`check-code-quality: Could not remove ${temporary}: ${error.message}\n`); }
    }
  }
  const report = finishReport(scan ?? { files: [], deletedFiles: [], thresholds }, files, measurement, errors);
  report.command = { cwd, argv: [process.execPath, fileURLToPath(import.meta.url), ...args] };
  try { saveReport(report, options, cwd, stdout); }
  catch (error) { stderr.write(`check-code-quality: ${error.message}\n`); return 2; }
  return { pass: 0, exceeded: 1, incomplete: 2 }[report.status];
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runCheck(process.argv.slice(2));
}
