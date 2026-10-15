// Upstream port targets — the pure half of `upstream-scan.cjs targets`
// (hearsay-tools/cezarion#1002, spec .ai/specs/2026-09-18-upstream-ledger.md § Port start check).
// A scan's `note` and `hint` describe the fork when the scan ran; this re-checks an upstream
// commit's files against the fork's HEAD when a port starts. Everything here is a function of
// its arguments: upstream-scan.cjs owns git, upstream-reachability.cjs owns the esbuild run.
'use strict';

const path = require('node:path');
const { cell, upstreamLink, forkLink } = require('./upstream-ledger.cjs');

const SOURCE_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'];
const SOURCE_FILE_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const PACKAGE_SOURCE_RE = /^packages\/[^/]+\/src\//;
const TEST_FILE_RE = /\.(?:test|spec)\./;
const TEST_SEGMENTS = new Set(['test', '__tests__', 'e2e', 'fixtures', '__fixtures__', '__snapshots__']);
/** Upstream statuses that need the file to exist in the fork already. */
const NEEDS_FORK_FILE = new Set(['M', 'D', 'R']);

/** Per file, what `git apply --check --3way` said: `clean`, `conflict` or `missing`.
 *  An `Applied patch to` line is the verdict for its file: an older git prints `patch failed`
 *  for the direct apply and then falls back to a three-way merge that may still apply. */
function parseApplyCheckByFile(output) {
  const applied = new Map();
  const failed = new Map();
  for (const line of output.split('\n')) {
    let m = /^Applied patch to '(.+)' (cleanly|with conflicts)\.$/.exec(line);
    if (m) { applied.set(m[1], m[2] === 'cleanly' ? 'clean' : 'conflict'); continue; }
    m = /^error: (.+): does not exist in index$/.exec(line);
    if (m) { failed.set(m[1], 'missing'); continue; }
    m = /^error: patch failed: (.+):\d+$/.exec(line) ?? /^error: (.+): patch does not apply$/.exec(line);
    if (m && failed.get(m[1]) !== 'missing') failed.set(m[1], 'conflict');
  }
  return new Map([...failed, ...applied]);
}

/** One file's dry-run verdict; a rename is read by its old path, where the fork's code would be. */
function dryRunOf(byFile, file) {
  return byFile.get(file.from ?? file.path) ?? byFile.get(file.path) ?? 'unknown';
}

/** `git diff-tree -r -z --name-status -M`: `{ status, path }`, plus `from` for a rename or copy. */
function parseNameStatus(text) {
  const tokens = text.split('\0');
  const files = [];
  for (let i = 0; i < tokens.length && tokens[i]; ) {
    const status = tokens[i][0];
    if (status === 'R' || status === 'C') {
      files.push({ status, from: tokens[i + 1], path: tokens[i + 2] });
      i += 3;
    } else {
      files.push({ status, path: tokens[i + 1] });
      i += 2;
    }
  }
  return files;
}

function isPackageSource(file) {
  return PACKAGE_SOURCE_RE.test(file);
}

/** A non-test source file under `packages/*\/src/`: the only files reachability can judge. */
function isReachabilityCandidate(file) {
  if (!isPackageSource(file) || !SOURCE_FILE_RE.test(file) || file.endsWith('.d.ts')) return false;
  const segments = file.split('/');
  if (TEST_FILE_RE.test(segments[segments.length - 1])) return false;
  return !segments.slice(3, -1).some((s) => TEST_SEGMENTS.has(s));
}

/** `production`, `test-only`, `unknown` or `n/a`. A failed or empty build is never evidence that
 *  a file is test-only, so it reads `unknown` (AGENTS.md: a fail-open helper needs a populated input). */
function reachabilityOf(file, reach) {
  if (!file.forkExists || !isReachabilityCandidate(file.path)) return 'n/a';
  if (reach.error || !reach.inputs || reach.inputs.size === 0) return 'unknown';
  return reach.inputs.has(file.path) ? 'production' : 'test-only';
}

/** Index just past the bracket that closes the one opened before `i`, skipping strings and templates. */
function skipBalanced(text, i) {
  let depth = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\'' || c === '"' || c === '`') { i = skipString(text, i); continue; }
    if (c === '(' || c === '{' || c === '[') depth += 1;
    else if (c === ')' || c === '}' || c === ']') {
      if (depth === 0) return i + 1;
      depth -= 1;
    }
    i += 1;
  }
  return i;
}

function skipString(text, i) {
  const quote = text[i];
  i += 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === quote) return i + 1;
    if (quote === '`' && c === '$' && text[i + 1] === '{') { i = skipBalanced(text, i + 2); continue; }
    if (quote !== '`' && c === '\n') return i;
    i += 1;
  }
  return i;
}

const LITERAL_RE = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\$]|\\.|\$(?!\{))*)/g;

/** Relative specifiers a file starts by path: every `./` or `../` string literal, or template
 *  prefix, inside a `new URL(…, import.meta.url)` call. A `.${ext}` template keeps its trailing dot. */
function urlEntrySpecifiers(text) {
  const found = [];
  for (const m of text.matchAll(/\bnew\s+URL\s*\(/g)) {
    const start = m.index + m[0].length;
    const args = text.slice(start, skipBalanced(text, start) - 1).trim().replace(/,$/, '').trim();
    if (!/(?:^|,)\s*import\.meta\.url$/.test(args)) continue;
    for (const lit of args.matchAll(LITERAL_RE)) {
      const value = lit[1] ?? lit[2] ?? lit[3];
      if (/^\.\.?\//.test(value) && !found.includes(value)) found.push(value);
    }
  }
  return found;
}

/** Repo-relative paths a `urlEntrySpecifiers` result may name, most literal first. */
function urlEntryCandidates(fromFile, specifier) {
  const target = path.posix.join(path.posix.dirname(fromFile), specifier);
  if (specifier.endsWith('.')) return SOURCE_EXTENSIONS.map((ext) => `${target}${ext}`);
  if (target.endsWith('.js')) return [target, target.replace(/\.js$/, '.ts'), target.replace(/\.js$/, '.tsx')];
  return [target];
}

/** Every static `import … from`, side-effect `import '…'` and `export … from` specifier, in
 *  order and once each. Dynamic `import()` is left to the bundler, which follows it already. */
function staticImportSpecifiers(text) {
  const found = [];
  for (const m of text.matchAll(/\b(?:import|export)\b(?:[^'"`;()]*?\bfrom)?\s*(['"])([^'"\n]+)\1/g)) {
    if (!found.includes(m[2])) found.push(m[2]);
  }
  return found;
}

/** Every flag that applies to one file, in a fixed order. */
function fileFlags(file) {
  const flags = [];
  if (file.reachability === 'test-only') flags.push('test-only');
  if (NEEDS_FORK_FILE.has(file.status) && !file.forkExists) flags.push('missing');
  if (file.drift && file.drift.commits > 0) flags.push('drifted');
  return flags;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function flagsOf(file) {
  return fileFlags({ ...file, forkExists: file.fork.exists });
}

function forkCell(fork) {
  if (fork.exists) return 'present';
  if (!fork.lastTouch) return 'never in fork';
  return `absent, last touched by \`${fork.lastTouch.short}\` ${cell(fork.lastTouch.subject)}`;
}

function driftCell(drift) {
  if (!drift) return 'unknown';
  if (drift.commits === 0) return '0 commits';
  return `${plural(drift.commits, 'commit')}, +${drift.added} −${drift.deleted}`;
}

function fileCell(file) {
  return file.from ? `\`${cell(file.from)}\` → \`${cell(file.path)}\`` : `\`${cell(file.path)}\``;
}

function dryRunTally(files) {
  const counts = { conflict: 0, missing: 0, clean: 0, unknown: 0 };
  for (const f of files) counts[f.dryRun] += 1;
  const parts = [`${counts.conflict} conflict`, `${counts.missing} missing`, `${counts.clean} clean`];
  if (counts.unknown) parts.push(`${counts.unknown} unknown`);
  return parts.join(' · ');
}

function renderSection(ledger, section) {
  const { entry, intro, baseline, files } = section;
  const lines = [
    `## \`${entry.sha.slice(0, 8)}\`${entry.pr ? ` ${upstreamLink(ledger, entry)}` : ''} ${entry.title}${baseline ? '' : ' — baseline unknown'}`,
    '',
  ];
  const row = [`\`${entry.status}\``];
  const fork = forkLink(ledger, entry);
  if (fork) row.push(fork);
  row.push(Number.isInteger(entry.hint?.conflicts) ? `scan hint: ${plural(entry.hint.conflicts, 'conflict')}` : 'scan hint: none recorded');
  if (entry.note) row.push(`note: ${String(entry.note).trim().replace(/\s*\n\s*/g, ' ')}`);
  lines.push(`- Ledger row: ${row.join(' · ')}`);
  lines.push(baseline
    ? `- Baseline: \`${baseline.short}\` (${baseline.date}), the parent of \`${intro.short}\` ${intro.subject}, which added this row`
    : '- Baseline: unknown. This row is not in the history of `ledger.yaml` at `HEAD` (an unmerged scan?), so drift reads unknown.');
  const recorded = Number.isInteger(entry.hint?.conflicts) ? `scan recorded ${plural(entry.hint.conflicts, 'conflict')}` : 'scan recorded no hint';
  lines.push(`- Dry run now: ${dryRunTally(files)} (${recorded})`, '');
  lines.push('| File | Upstream | Fork | Flags | Reachability | Drift | Dry run |', '| --- | --- | --- | --- | --- | --- | --- |');
  const flagged = files.filter((f) => flagsOf(f).length > 0);
  const quiet = files.filter((f) => flagsOf(f).length === 0);
  for (const f of [...flagged, ...quiet]) {
    const cells = [fileCell(f), f.status, forkCell(f.fork), flagsOf(f).join(', '), f.reachability, driftCell(f.drift), f.dryRun];
    lines.push(`| ${cells.join(' | ')} |`);
  }
  lines.push('');
  return lines;
}

/** The Markdown report a planner reads before the design gate: one section per upstream commit. */
function renderTargetsReport(report) {
  const { ledger, head, reach, sections } = report;
  const flagged = sections.reduce((n, s) => n + s.files.filter((f) => flagsOf(f).length > 0).length, 0);
  const lines = [
    '# Upstream port targets',
    '',
    `- Fork \`HEAD\`: \`${head.short}\` (${head.date}) · ${plural(sections.length, 'upstream commit')} checked · ${plural(flagged, 'file')} flagged`,
    `- Reachability: ${reach.error ? `unknown — ${reach.error}` : `esbuild from ${plural(reach.roots, 'root')}, ${plural(reach.reachable, 'file')} reachable`}`,
    '- Flags: `test-only` = no production entry reaches it · `missing` = upstream changes a path the fork no longer has · `drifted` = fork commits touched it since the ledger row landed',
    '',
  ];
  for (const section of sections) lines.push(...renderSection(ledger, section));
  return `${lines.join('\n')}`;
}

module.exports = {
  SOURCE_EXTENSIONS,
  parseApplyCheckByFile,
  dryRunOf,
  parseNameStatus,
  isPackageSource,
  isReachabilityCandidate,
  reachabilityOf,
  urlEntrySpecifiers,
  urlEntryCandidates,
  staticImportSpecifiers,
  fileFlags,
  renderTargetsReport,
};
