// Upstream ledger — the pure half of the upstream scan (spec
// .ai/specs/2026-09-18-upstream-ledger.md). Everything here is a function of
// its arguments: the CLI in upstream-scan.cjs owns git, the filesystem and the
// clock, and the node:test guard in upstream-ledger.test.cjs validates the
// committed ledger through the same `validateLedger` the scan uses.
'use strict';

const LEDGER_PATH = '.ai/upstream/ledger.yaml';
const STATUSES = ['pending', 'planned', 'ported', 'partial', 'diverged', 'rejected', 'n/a'];
const SHA_RE = /^[0-9a-f]{7,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FIELD_SEP = '\x1f';
/** `git log --format` producing one `parseLog` line per commit. */
const LOG_FORMAT = `%H${FIELD_SEP}%as${FIELD_SEP}%s`;

/** One commit per line: `<sha>\x1f<YYYY-MM-DD>\x1f<subject>`; the squash subject's trailing `(#N)` is the upstream PR. */
function parseLog(text) {
  return text.split('\n').filter(Boolean).map((line) => {
    const [sha, date, ...rest] = line.split(FIELD_SEP);
    const title = rest.join(FIELD_SEP);
    const pr = /\(#(\d+)\)\s*$/.exec(title);
    return pr ? { sha, date, title, pr: Number(pr[1]) } : { sha, date, title };
  });
}

/** Distinct files `git apply --check --3way` could not apply cleanly. */
function parseApplyCheck(output) {
  const files = new Set();
  for (const line of output.split('\n')) {
    let m = /^Applied patch to '(.+)' with conflicts\.$/.exec(line);
    if (m) { files.add(m[1]); continue; }
    m = /^error: patch failed: (.+):\d+$/.exec(line);
    if (m) { files.add(m[1]); continue; }
    m = /^error: (.+): patch does not apply$/.exec(line);
    if (m) files.add(m[1]);
  }
  return files.size;
}

function hasForkLink(fork, keys) {
  if (!fork || typeof fork !== 'object') return false;
  return keys.some((k) => (k === 'commits' ? Array.isArray(fork.commits) && fork.commits.length > 0 : Number.isInteger(fork[k]) && fork[k] > 0));
}

/** Every rule the ledger must satisfy, as human-readable problems; empty means valid. */
function validateLedger(ledger) {
  const problems = [];
  if (!ledger || typeof ledger !== 'object') return ['ledger is not an object'];
  if (typeof ledger.upstream?.repo !== 'string' || !ledger.upstream.repo.includes('/')) problems.push('upstream.repo must be "owner/name"');
  if (typeof ledger.fork?.repo !== 'string' || !ledger.fork.repo.includes('/')) problems.push('fork.repo must be "owner/name"');
  if (!SHA_RE.test(ledger.origin?.mergeBase ?? '')) problems.push('origin.mergeBase must be a commit sha');
  if (!Array.isArray(ledger.scans)) problems.push('scans must be a list');
  else ledger.scans.forEach((scan, i) => {
    if (!DATE_RE.test(scan?.date ?? '')) problems.push(`scans[${i}].date must be YYYY-MM-DD`);
    if (!SHA_RE.test(scan?.upstreamHead ?? '')) problems.push(`scans[${i}].upstreamHead must be a commit sha`);
    if (typeof scan?.report !== 'string') problems.push(`scans[${i}].report must name the report file`);
  });
  if (!Array.isArray(ledger.entries)) return [...problems, 'entries must be a list'];
  const seen = new Set();
  for (const e of ledger.entries) {
    const id = typeof e?.sha === 'string' ? e.sha.slice(0, 8) : String(e?.sha);
    const at = (msg) => problems.push(`entry ${id}: ${msg}`);
    if (!SHA_RE.test(e?.sha ?? '')) at('sha must be a commit sha');
    else if (seen.has(e.sha)) at('duplicate sha');
    seen.add(e?.sha);
    if (typeof e?.title !== 'string' || !e.title) at('title is required');
    if (!DATE_RE.test(e?.date ?? '')) at('date must be YYYY-MM-DD');
    if (e?.pr !== undefined && !(Number.isInteger(e.pr) && e.pr > 0)) at('pr must be a positive integer');
    if (!STATUSES.includes(e?.status)) { at(`status "${e?.status}" is not one of ${STATUSES.join(', ')}`); continue; }
    if (e.status === 'pending') continue;
    if (!DATE_RE.test(e.decided ?? '')) at(`${e.status} needs a decided date`);
    const reason = typeof e.reason === 'string' && e.reason.trim().length > 0;
    switch (e.status) {
      case 'planned':
        if (!hasForkLink(e.fork, ['issue'])) at('planned needs fork.issue');
        break;
      case 'ported':
        if (!hasForkLink(e.fork, ['pr', 'commits'])) at('ported needs fork.pr or fork.commits');
        break;
      case 'partial':
        if (!hasForkLink(e.fork, ['pr', 'issue', 'commits'])) at('partial needs fork.pr, fork.issue or fork.commits');
        if (!reason) at('partial needs a reason');
        break;
      case 'diverged':
        if (!hasForkLink(e.fork, ['pr', 'commits'])) at('diverged needs fork.pr or fork.commits');
        if (!reason) at('diverged needs a reason');
        break;
      default: // rejected, n/a
        if (!reason) at(`${e.status} needs a reason`);
    }
  }
  return problems;
}

/** Where the next scan starts: the last scanned upstream head, or the fork point. */
function scanRange(ledger) {
  const last = ledger.scans?.length ? ledger.scans[ledger.scans.length - 1] : undefined;
  return last?.upstreamHead ?? ledger.origin.mergeBase;
}

/** Append unseen commits as `pending` and record the scan. Pure: returns a new ledger. */
function applyScan(ledger, { commits, hints, upstreamHead, date }) {
  const known = new Set(ledger.entries.map((e) => e.sha));
  const added = commits.filter((c) => !known.has(c.sha)).map((c) => {
    const e = { sha: c.sha, ...(c.pr !== undefined ? { pr: c.pr } : {}), title: c.title, date: c.date, status: 'pending' };
    if (Number.isInteger(hints?.[c.sha])) e.hint = { conflicts: hints[c.sha] };
    return e;
  });
  if (added.length === 0) return { ledger, added };
  const scan = { date, upstreamHead, since: scanRange(ledger), added: added.length, report: `scans/${date}.md` };
  return { ledger: { ...ledger, scans: [...ledger.scans, scan], entries: [...ledger.entries, ...added] }, added };
}

function upstreamLink(ledger, e) {
  return e.pr ? `[#${e.pr}](https://github.com/${ledger.upstream.repo}/pull/${e.pr})` : `[${e.sha.slice(0, 8)}](https://github.com/${ledger.upstream.repo}/commit/${e.sha})`;
}

function forkLink(ledger, e) {
  const f = e.fork ?? {};
  const parts = [];
  if (f.pr) parts.push(`[PR #${f.pr}](https://github.com/${ledger.fork.repo}/pull/${f.pr})`);
  if (f.issue) parts.push(`[issue #${f.issue}](https://github.com/${ledger.fork.repo}/issues/${f.issue})`);
  for (const c of f.commits ?? []) parts.push(`[${String(c).slice(0, 8)}](https://github.com/${ledger.fork.repo}/commit/${c})`);
  return parts.join(', ');
}

function tally(entries) {
  const counts = new Map(STATUSES.map((s) => [s, 0]));
  for (const e of entries) counts.set(e.status, (counts.get(e.status) ?? 0) + 1);
  return [...counts].filter(([, n]) => n > 0).map(([s, n]) => `${s}: ${n}`).join(' · ');
}

function cell(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** The markdown report for one scan: what arrived, with links, hints and the ledger tally after it. */
function renderScanReport(ledger, scan, added) {
  const lines = [
    `# Upstream scan ${scan.date}`,
    '',
    `- Upstream: \`${ledger.upstream.repo}\` @ \`${scan.upstreamHead}\``,
    `- Range: \`${scan.since}..${scan.upstreamHead}\``,
    `- New entries: ${added.length}, appended to \`ledger.yaml\` as \`pending\``,
    `- Ledger after this scan: ${tally(ledger.entries)}`,
    '',
    'Conflict hint = files a 3-way dry run of that commit could not apply onto this fork at scan time; 0 means the patch applies clean.',
    '',
    'Decisions live in `ledger.yaml` (rendered in `LEDGER.md`); this report is the record of what arrived.',
    '',
    '| Sha | Upstream | Date | Title | Conflicts |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const e of added) {
    lines.push(`| \`${e.sha.slice(0, 8)}\` | ${upstreamLink(ledger, e)} | ${e.date} | ${cell(e.title)} | ${e.hint?.conflicts ?? ''} |`);
  }
  return `${lines.join('\n')}\n`;
}

function heading(status) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/** LEDGER.md: the whole ledger grouped by status, in decision order, for browsing on GitHub. */
function renderLedger(ledger) {
  const last = ledger.scans.length ? ledger.scans[ledger.scans.length - 1] : undefined;
  const lines = [
    '# Upstream ledger',
    '',
    `Generated from \`ledger.yaml\` by \`node .github/scripts/upstream-scan.cjs render\`. Do not edit; edit the YAML.`,
    '',
    `- Upstream: [${ledger.upstream.repo}](https://github.com/${ledger.upstream.repo}) \`${ledger.upstream.branch}\``,
    `- Fork point: \`${ledger.origin.mergeBase.slice(0, 8)}\` (${ledger.origin.date})`,
    last ? `- Last scan: ${last.date} to \`${last.upstreamHead.slice(0, 8)}\` ([report](${last.report}))` : '- Last scan: none yet',
    `- Entries: ${ledger.entries.length} · ${tally(ledger.entries)}`,
    '',
  ];
  for (const status of STATUSES) {
    const rows = ledger.entries.filter((e) => e.status === status);
    if (rows.length === 0) continue;
    lines.push(`## ${heading(status)} (${rows.length})`, '');
    const decided = status !== 'pending';
    lines.push(decided
      ? '| Upstream | Date | Title | Fork | Decided | Reason / note |'
      : '| Upstream | Date | Title | Conflicts | Note |');
    lines.push(decided ? '| --- | --- | --- | --- | --- | --- |' : '| --- | --- | --- | --- | --- |');
    for (const e of rows) {
      const why = [e.reason, e.note].filter(Boolean).map(cell).join(' — ');
      lines.push(decided
        ? `| ${upstreamLink(ledger, e)} | ${e.date} | ${cell(e.title)} | ${forkLink(ledger, e)} | ${e.decided} | ${why} |`
        : `| ${upstreamLink(ledger, e)} | ${e.date} | ${cell(e.title)} | ${e.hint?.conflicts ?? ''} | ${cell(e.note)} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { LEDGER_PATH, LOG_FORMAT, STATUSES, parseLog, parseApplyCheck, validateLedger, scanRange, applyScan, renderScanReport, renderLedger, upstreamLink, forkLink, tally };
