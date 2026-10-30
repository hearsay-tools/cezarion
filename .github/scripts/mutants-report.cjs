'use strict';
// The mutation report: a StrykerJS JSON report becomes a small artifact (collectPackage), the comment
// job checks that artifact as untrusted input (validateArtifact), and one function renders it as the
// Markdown comment. Pure functions; the job is advisory and never blocks a merge.
const { findEquivalent } = require('./mutants-equivalent.cjs');
const { PACKAGES } = require('./mutants-scope.cjs');

/** The hidden marker that finds the one comment to update. */
const MARKER = '<!-- cezar-mutation-report -->';
const LIMITS = { text: 200, reason: 300, undetected: 100, detected: 150, comment: 60000, packages: PACKAGES.length };
const VERSION = 1;

const COUNT_OF = {
  Killed: 'killed', Survived: 'survived', NoCoverage: 'noCoverage', Timeout: 'timeout',
  CompileError: 'error', RuntimeError: 'error', Ignored: 'ignored',
};
const COUNT_KEYS = ['killed', 'survived', 'noCoverage', 'timeout', 'error', 'ignored'];
const LISTED = ['Survived', 'NoCoverage', 'Killed', 'Timeout'];
const UNDETECTED = ['Survived', 'NoCoverage'];
const PACKAGE_STATES = ['completed', 'skipped', 'timed-out', 'error'];
const FILE_PATTERN = /^packages\/[A-Za-z0-9._-]+\/src\/[A-Za-z0-9._/-]+\.tsx?$/;

const oneLine = text => {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > LIMITS.text ? `${flat.slice(0, LIMITS.text - 1)}…` : flat;
};

/** The source text a mutant replaces. Stryker columns are 1-based and the end column is exclusive. */
function sliceSource(source, { start, end }) {
  const picked = source.split('\n').slice(start.line - 1, end.line);
  if (picked.length === 0) return '';
  picked[picked.length - 1] = picked.at(-1).slice(0, end.column - 1);
  picked[0] = picked[0].slice(start.column - 1);
  return picked.join('\n');
}

const inRanges = (line, ranges) => ranges.some(([from, to]) => line >= from && line <= to);
const rank = status => LISTED.indexOf(status);
const byPlace = (a, b) => rank(a.status) - rank(b.status) || a.line - b.line || a.column - b.column;

/** Keep the first `limit` rows of the group, and say how many did not fit. */
function capped(rows, limit) {
  return { rows: rows.slice(0, limit), dropped: Math.max(0, rows.length - limit) };
}

/** One package's result from the StrykerJS report: counts for every mutant, rows for the ones worth reading. */
function collectPackage({ name, report, changed, durationMs, relatedTests, entries = [] }) {
  const counts = Object.fromEntries(COUNT_KEYS.map(key => [key, 0]));
  const rows = [];
  for (const [file, data] of Object.entries(report.files ?? {})) {
    const ranges = changed.get(file);
    for (const m of ranges ? data.mutants : []) {
      if (!inRanges(m.location.start.line, ranges) || !COUNT_OF[m.status]) continue;
      const original = sliceSource(data.source ?? '', m.location);
      if (findEquivalent(entries, { file, mutator: m.mutatorName, original, replacement: m.replacement ?? '' })) {
        counts.equivalent = (counts.equivalent ?? 0) + 1;
        continue;
      }
      counts[COUNT_OF[m.status]] += 1;
      if (!LISTED.includes(m.status)) continue;
      rows.push({
        file, line: m.location.start.line, column: m.location.start.column, mutator: m.mutatorName, status: m.status,
        original: oneLine(original), replacement: oneLine(m.replacement ?? ''),
      });
    }
  }
  rows.sort(byPlace);
  const undetected = capped(rows.filter(r => UNDETECTED.includes(r.status)), LIMITS.undetected);
  const detected = capped(rows.filter(r => !UNDETECTED.includes(r.status)), LIMITS.detected);
  const changedLines = [...changed.values()].flat().reduce((sum, [from, to]) => sum + to - from + 1, 0);
  return {
    name, state: 'completed', reason: '', changedLines, relatedTests, durationMs, counts,
    mutants: [...undetected.rows, ...detected.rows], omitted: undetected.dropped + detected.dropped,
  };
}

function fail(message) {
  throw new Error(`mutation artifact: ${message}`);
}

function int(value, what, { max = 1e7, min = 0 } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) fail(`${what} is not an integer from ${min} to ${max}`);
  return value;
}

function str(value, what, max = LIMITS.text) {
  if (typeof value !== 'string' || value.length > max) fail(`${what} is not a string of at most ${max} characters`);
  return value;
}

function oneOf(value, allowed, what) {
  if (!allowed.includes(value)) fail(`${what} is not one of ${allowed.join(', ')}`);
  return value;
}

function checkMutant(m) {
  const file = str(m?.file, 'mutant file', 300);
  if (!FILE_PATTERN.test(file) || file.includes('..')) fail('mutant file is not a source path');
  if (!/^[A-Za-z]{1,40}$/.test(str(m.mutator, 'mutator', 40))) fail('mutator is not a name');
  return {
    file, line: int(m.line, 'mutant line', { min: 1, max: 1e6 }), column: int(m.column, 'mutant column', { min: 1, max: 1e6 }),
    mutator: m.mutator, status: oneOf(m.status, LISTED, 'mutant status'),
    original: str(m.original, 'original'), replacement: str(m.replacement, 'replacement'),
  };
}

function checkPackage(p) {
  const counts = Object.fromEntries(COUNT_KEYS.map(key => [key, int(p?.counts?.[key], `count ${key}`)]));
  if (p?.counts?.equivalent !== undefined) counts.equivalent = int(p.counts.equivalent, 'count equivalent');
  if (!Array.isArray(p.mutants) || p.mutants.length > LIMITS.undetected + LIMITS.detected) fail('mutants is not a short list');
  return {
    name: oneOf(p.name, PACKAGES, 'package name'), state: oneOf(p.state, PACKAGE_STATES, 'package state'),
    reason: str(p.reason ?? '', 'reason', LIMITS.reason), changedLines: int(p.changedLines, 'changedLines'),
    relatedTests: p.relatedTests === null ? null : int(p.relatedTests, 'relatedTests'),
    durationMs: int(p.durationMs, 'durationMs', { max: 1e9 }), counts, mutants: p.mutants.map(checkMutant),
    omitted: int(p.omitted ?? 0, 'omitted'),
  };
}

/** Check an artifact the PR's own job wrote and return a copy that holds only the known fields. */
function validateArtifact(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('not an object');
  if (value.version !== VERSION) fail('unknown version');
  if (!Array.isArray(value.packages) || value.packages.length > LIMITS.packages) fail('packages is not a short list');
  return {
    version: VERSION, state: oneOf(value.state, ['ran', 'no-mutable-lines'], 'state'),
    head: /^[0-9a-f]{0,40}$/.test(value.head) ? value.head : fail('head is not a sha'),
    ...(value.warning === undefined ? {} : { warning: str(value.warning, 'warning', LIMITS.reason) }),
    stryker: str(value.stryker ?? '', 'stryker', 32), packages: value.packages.map(checkPackage),
  };
}

// Every character that can start HTML, a mention, a table column or Markdown: a link, an image, emphasis,
// strikethrough, an issue reference, an escape. `:` also breaks `https://` and `:emoji:` into plain text.
const MARKUP = /[&<>|@`\\[\]()!*_~:#]/g;

/**
 * Text for one table cell or one line of the comment: the artifact is untrusted, so it renders as plain
 * text. Numeric character references show the character and start no syntax. A bare `www.` is the one
 * link that needs no syntax character, so its dot is a reference too.
 */
const esc = text => String(text).replace(/\s+/g, ' ').trim()
  .replace(MARKUP, char => `&#${char.charCodeAt(0)};`).replace(/(www)\./gi, '$1&#46;');
const code = text => `<code>${esc(text)}</code>`;

const place = (m, ctx) => ctx.blobBase
  ? `[\`${m.file}:${m.line}\`](${ctx.blobBase}/${m.file}#L${m.line})` : `\`${m.file}:${m.line}\``;

const RESULT = { Survived: 'Survived', NoCoverage: 'Not covered', Killed: 'Killed', Timeout: 'Timed out' };

function table(rows, ctx) {
  const lines = ['| Where | Mutator | Original | Mutant | Result |', '|---|---|---|---|---|'];
  for (const m of rows) {
    lines.push(`| ${place(m, ctx)} | ${m.mutator} | ${code(m.original)} | ${code(m.replacement)} | ${RESULT[m.status]} |`);
  }
  return lines.join('\n');
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const seconds = ms => (ms >= 60_000 ? `${Math.round(ms / 6000) / 10} min` : `${Math.round(ms / 1000)} s`);

function countsLine(p) {
  const c = p.counts;
  const total = COUNT_KEYS.reduce((sum, key) => sum + c[key], 0);
  const parts = [`${c.killed} killed`, `${c.survived} survived`];
  if (c.noCoverage) parts.push(`${c.noCoverage} not covered`);
  if (c.timeout) parts.push(`${c.timeout} timed out`);
  if (c.error) parts.push(`${c.error} errors`);
  if (c.ignored) parts.push(`${c.ignored} ignored`);
  if (c.equivalent) parts.push(`${c.equivalent} equivalent`);
  return `${plural(total, 'mutant')} in ${plural(p.changedLines, 'changed line')}: ${parts.join(', ')}. ${seconds(p.durationMs)}.`;
}

const NOTICE = { skipped: 'Skipped', 'timed-out': 'Stopped', error: 'Failed' };

/** One package's section. `show` caps the rows: how many undetected and detected ones to print. */
function renderPackage(p, ctx, show) {
  const heading = `#### ${p.name}`;
  if (p.state !== 'completed') return { text: `${heading}\n${NOTICE[p.state]}: ${esc(p.reason)}`, shown: 0, listed: 0 };
  const undetected = p.mutants.filter(m => UNDETECTED.includes(m.status));
  const detected = p.mutants.filter(m => !UNDETECTED.includes(m.status));
  const shownU = undetected.slice(0, show.undetected);
  const shownD = detected.slice(0, show.detected);
  const parts = [heading, countsLine(p), `Tests run: the \`${p.name}\` package's own unit tests.`];
  parts.push(p.counts.survived + p.counts.noCoverage === 0 ? 'No mutant survived in the changed lines.'
    : shownU.length ? table(shownU, ctx) : '');
  if (shownD.length) {
    const count = p.counts.killed + p.counts.timeout;
    parts.push(`<details><summary>Killed and timed-out mutants (${count})</summary>\n\n${table(shownD, ctx)}\n\n</details>`);
  }
  return { text: parts.filter(Boolean).join('\n\n'), shown: shownU.length + shownD.length, listed: p.mutants.length + (p.omitted ?? 0) };
}

const shortSha = head => head.slice(0, 7);

function intro(ctx) {
  const link = ctx.runUrl ? ` · [job run](${ctx.runUrl})` : '';
  return `${MARKER}\n### Mutation report: surviving mutants in changed lines\n\n`
    + `Advisory: this report never blocks a merge. Commit \`${shortSha(ctx.head)}\`${link}`;
}

function compose(artifact, ctx, show) {
  const sections = artifact.packages.map(p => renderPackage(p, ctx, show));
  const left = sections.reduce((sum, s) => sum + s.listed - s.shown, 0);
  const incomplete = artifact.packages.some(p => p.state !== 'completed');
  const tail = [];
  if (left > 0) tail.push(`Left out to fit the comment: ${left} mutant rows.`);
  tail.push('A mutant that only tests in another package can kill shows here as a survivor: the job runs each package\'s own tests.');
  if (incomplete) tail.push('To see a skipped package, run Stryker on this change yourself: `STRYKER_PROJECT=<package> pnpm exec stryker run --mutate \'<file>:<from>-<to>\'`.');
  if (artifact.warning) tail.push(`Warning: ${esc(artifact.warning)}`);
  return [intro(ctx), ...sections.map(s => s.text), ...tail].join('\n\n') + '\n';
}

const ATTEMPTS = [
  { undetected: Infinity, detected: Infinity }, { undetected: Infinity, detected: 0 },
  { undetected: 50, detected: 0 }, { undetected: 25, detected: 0 }, { undetected: 10, detected: 0 },
  { undetected: 3, detected: 0 }, { undetected: 0, detected: 0 },
];

/** The comment for an artifact: the whole report that fits, with the marker on its first line. */
function renderReport(artifact, ctx) {
  if (artifact.state === 'no-mutable-lines') {
    return `${intro(ctx)}\n\nNo product source line changed in \`${shortSha(ctx.head)}\` (only tests, docs, scripts or configuration), so nothing was mutated.\n`;
  }
  let text = '';
  for (const show of ATTEMPTS) {
    text = compose(artifact, ctx, show);
    if (text.length <= LIMITS.comment) break;
  }
  return text;
}

const UNAVAILABLE = {
  failed: head => `The mutation job did not finish for \`${shortSha(head)}\` (it failed, timed out or was stopped), so there is no report for this commit.`,
  unreadable: head => `The mutation job's report for \`${shortSha(head)}\` could not be read, so there is no report for this commit.`,
};

/** The comment for a commit the job gave no usable report for. It replaces an older push's report. */
function renderUnavailable(reason, ctx) {
  return `${intro(ctx)}\n\n${UNAVAILABLE[reason](ctx.head)}\n`;
}

/** A first comment is worth posting only when the job had product lines to mutate. */
function shouldCreate(artifact) {
  return artifact.state !== 'no-mutable-lines';
}

module.exports = { MARKER, LIMITS, VERSION, collectPackage, validateArtifact, renderReport, renderUnavailable, shouldCreate };
