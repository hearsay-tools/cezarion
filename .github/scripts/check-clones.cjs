#!/usr/bin/env node
// Scan Git data with trusted tooling; never load a candidate's config or scripts.
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const git = (cwd, args, options = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', ...options });
const eligible = (name) => /^packages\/[^/]+\/src\//.test(name) || name.startsWith('packages/cezar/scripts/');

/** All scan inputs are trusted paths materialized under packages/<workspace>/. */
function packageOf(root, name) {
  const relative = path.relative(root, name).split(path.sep);
  if (relative[0] !== 'packages' || !relative[1]) throw new Error('Clone report contains a path outside the scanned packages');
  return relative[1];
}

function materialize(repo, ref, scratch) {
  fs.rmSync(path.join(scratch, 'packages'), { recursive: true, force: true });
  fs.mkdirSync(path.join(scratch, 'packages'));
  const entries = git(repo, ['ls-tree', '-r', '-z', ref]).split('\0').filter(Boolean)
    .map((row) => { const tab = row.indexOf('\t'); const meta = row.slice(0, tab).split(' '); return { mode: meta[0], oid: meta[2], name: row.slice(tab + 1) }; })
    .filter(({ mode, name }) => mode.startsWith('100') && eligible(name));
  if (!entries.length) return;
  // One batch avoids a process for each source file. No checkout, symlinks or attributes.
  const blobs = git(repo, ['cat-file', '--batch'], {
    input: entries.map(({ oid }) => oid).join('\n') + '\n', encoding: null, maxBuffer: 128 * 1024 * 1024,
  });
  let offset = 0;
  for (const { name } of entries) {
    const end = blobs.indexOf(10, offset);
    const size = Number(blobs.subarray(offset, end).toString().split(' ')[2]);
    const target = path.join(scratch, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, blobs.subarray(end + 1, end + 1 + size));
    offset = end + size + 2;
  }
}

function scan(scratch, updateBaseline) {
  const baseline = path.join(scratch, 'baseline.json');
  fs.rmSync(path.join(scratch, 'report'), { recursive: true, force: true });
  const result = spawnSync(path.resolve(__dirname, '../../node_modules/.bin/jscpd'), [
    'packages', '--config', path.join(scratch, 'trusted-config.json'), '--no-gitignore', '--absolute', '--no-colors', '--no-tips',
    '--min-tokens', '50', '--min-lines', '5', '--format', 'typescript,tsx,javascript,jsx',
    '--ignore', '**/*.test.*,**/*.testkit.*,**/*.e2e.*,**/__fixtures__/**,**/fixtures/**',
    '--baseline', baseline, ...(updateBaseline ? ['--update-baseline'] : []),
    '--reporters', 'json', '--output', path.join(scratch, 'report'),
  ], { cwd: scratch, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`jscpd failed (${result.status}): ${result.stderr || result.stdout}`);
  const report = JSON.parse(fs.readFileSync(path.join(scratch, 'report/jscpd-report.json'), 'utf8'));
  if (!Array.isArray(report.duplicates)) throw new Error('Invalid clone report');
  return report.duplicates;
}

function relativeFile(scratch, file) {
  packageOf(scratch, file.name);
  if (!Number.isSafeInteger(file.start) || file.start < 1) throw new Error('Invalid clone location');
  return path.relative(scratch, file.name).split(path.sep).join('/');
}

function summarize(scratch, duplicates) {
  const pairs = new Map();
  const forbidden = [];
  for (const clone of duplicates) {
    const { firstFile, secondFile, tokens, isNew } = clone;
    const first = relativeFile(scratch, firstFile);
    const second = relativeFile(scratch, secondFile);
    if (!Number.isSafeInteger(tokens) || tokens <= 0 || typeof isNew !== 'boolean') throw new Error('Invalid clone accounting');
    const location = `${first}:${firstFile.start} ↔ ${second}:${secondFile.start}`;
    if (packageOf(scratch, firstFile.name) !== packageOf(scratch, secondFile.name)) {
      forbidden.push(`Cross-package clone: ${location}`);
    } else if (first === second) {
      if (isNew) forbidden.push(`New same-file clone: ${location}`);
    } else {
      const key = JSON.stringify([first, second].sort());
      const pair = pairs.get(key) || { tokens: 0, location };
      pair.tokens += tokens;
      pairs.set(key, pair);
    }
  }
  return { pairs, forbidden };
}

function compare(baseline, head) {
  const failures = [...head.forbidden];
  for (const [key, pair] of head.pairs) {
    const previous = baseline.pairs.get(key);
    if (!previous || pair.tokens > previous.tokens) {
      failures.push(`Clone token increase: ${pair.location} (baseline ${previous?.tokens ?? 0}, head ${pair.tokens} tokens)`);
    }
  }
  return failures;
}

function check({ repo = process.cwd(), base = 'origin/main', head = 'HEAD' } = {}) {
  const mergeBase = git(repo, ['merge-base', base, head]).trim();
  const headSha = git(repo, ['rev-parse', '--verify', `${head}^{commit}`]).trim();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cezar-clones-'));
  try {
    // Both scans use the same trusted paths and options; candidate config never runs.
    fs.writeFileSync(path.join(scratch, 'trusted-config.json'), '{}');
    materialize(repo, mergeBase, scratch);
    const baseline = summarize(scratch, scan(scratch, true));
    materialize(repo, headSha, scratch);
    const headReport = summarize(scratch, scan(scratch, false));
    const failures = compare(baseline, headReport);
    for (const failure of failures) process.stdout.write(`${failure}\n`);
    process.stdout.write(`Clone pairs: ${headReport.pairs.size}; violations: ${failures.length}\n`);
    return failures.length ? 1 : 0;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--base', '--head'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: check-clones.cjs [--base REF] [--head REF]');
    options[args[i].slice(2)] = args[i + 1];
  }
  process.exitCode = check(options);
}
module.exports = { check, eligible, summarize, compare };
