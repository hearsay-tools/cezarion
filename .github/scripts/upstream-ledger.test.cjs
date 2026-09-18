const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');
const {
  parseLog,
  parseApplyCheck,
  validateLedger,
  scanRange,
  applyScan,
  renderScanReport,
  LEDGER_PATH,
} = require('./upstream-ledger.cjs');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_HEAD = 'c'.repeat(40);
const MERGE_BASE = 'd'.repeat(40);

function ledger(overrides = {}) {
  return {
    upstream: { repo: 'open-mercato/cezar', branch: 'main' },
    fork: { repo: 'hearsay-tools/cezarion' },
    origin: { mergeBase: MERGE_BASE, date: '2026-08-31' },
    scans: [],
    entries: [],
    ...overrides,
  };
}

function entry(overrides = {}) {
  return { sha: SHA_A, pr: 967, title: 'fix(runs): nudge (#967)', date: '2026-09-12', status: 'pending', ...overrides };
}

test('parseLog reads sha, date, title and the squash PR number', () => {
  const text = `${SHA_A}\x1f2026-09-12\x1ffix(runs): make the nudge reachable (#967)\n${SHA_B}\x1f2026-09-14\x1fdocs: no pr here\n`;
  assert.deepEqual(parseLog(text), [
    { sha: SHA_A, date: '2026-09-12', title: 'fix(runs): make the nudge reachable (#967)', pr: 967 },
    { sha: SHA_B, date: '2026-09-14', title: 'docs: no pr here' },
  ]);
});

test('parseApplyCheck counts files the 3-way dry run could not apply', () => {
  assert.equal(parseApplyCheck(''), 0);
  const out = [
    'Applied patch to \'packages/a.ts\' with conflicts.',
    'Applied patch to \'packages/b.ts\' cleanly.',
    'error: patch failed: packages/c.ts:12',
    'error: packages/c.ts: patch does not apply',
    'Applied patch to \'packages/a.ts\' with conflicts.',
  ].join('\n');
  assert.equal(parseApplyCheck(out), 2);
});

test('validateLedger accepts a decided ledger and names every violated rule', () => {
  const good = ledger({
    entries: [
      entry({ status: 'pending' }),
      entry({ sha: SHA_B, pr: 968, status: 'ported', fork: { pr: 101 }, decided: '2026-09-06' }),
    ],
  });
  assert.deepEqual(validateLedger(good), []);

  const bad = ledger({
    entries: [
      entry({ status: 'ported', decided: '2026-09-06' }),
      entry({ sha: SHA_B, status: 'rejected', decided: '2026-09-06' }),
      entry({ sha: SHA_B, status: 'planned', fork: {}, decided: '2026-09-06' }),
      entry({ sha: 'nothex', status: 'made-up' }),
      entry({ sha: 'e'.repeat(40), status: 'n/a', reason: 'release bump' }),
    ],
  });
  const problems = validateLedger(bad);
  assert.ok(problems.some((p) => p.includes(SHA_A.slice(0, 8)) && /ported/.test(p) && /fork/.test(p)), problems.join('\n'));
  assert.ok(problems.some((p) => p.includes(SHA_B.slice(0, 8)) && /rejected/.test(p) && /reason/.test(p)), problems.join('\n'));
  assert.ok(problems.some((p) => p.includes(SHA_B.slice(0, 8)) && /planned/.test(p) && /issue/.test(p)), problems.join('\n'));
  assert.ok(problems.some((p) => /duplicate/.test(p) && p.includes(SHA_B.slice(0, 8))), problems.join('\n'));
  assert.ok(problems.some((p) => /nothex/.test(p) && /sha/.test(p)), problems.join('\n'));
  assert.ok(problems.some((p) => /made-up/.test(p) && /status/.test(p)), problems.join('\n'));
  assert.ok(problems.some((p) => p.includes('eeeeeeee') && /decided/.test(p)), problems.join('\n'));
});

test('validateLedger rejects a missing origin or upstream repo', () => {
  assert.ok(validateLedger({ entries: [], scans: [] }).some((p) => /upstream\.repo/.test(p)));
  assert.ok(validateLedger(ledger({ origin: {} })).some((p) => /origin\.mergeBase/.test(p)));
});

test('scanRange starts at the merge base on the first scan and at the last head afterwards', () => {
  assert.equal(scanRange(ledger()), MERGE_BASE);
  const scanned = ledger({ scans: [{ date: '2026-09-16', upstreamHead: SHA_HEAD, since: MERGE_BASE, added: 3, report: 'scans/2026-09-16.md' }] });
  assert.equal(scanRange(scanned), SHA_HEAD);
});

test('applyScan appends unseen commits as pending, skips known shas and records the scan', () => {
  const known = entry({ status: 'ported', fork: { pr: 101 }, decided: '2026-09-06' });
  const before = ledger({ entries: [known] });
  const commits = [
    { sha: SHA_A, date: '2026-09-12', title: 'already known (#967)', pr: 967 },
    { sha: SHA_B, date: '2026-09-14', title: 'feat(x): new (#970)', pr: 970 },
  ];
  const { ledger: after, added } = applyScan(before, {
    commits, hints: { [SHA_B]: 2 }, upstreamHead: SHA_HEAD, date: '2026-09-18',
  });
  assert.deepEqual(added.map((e) => e.sha), [SHA_B]);
  assert.deepEqual(after.entries, [
    known,
    { sha: SHA_B, pr: 970, title: 'feat(x): new (#970)', date: '2026-09-14', status: 'pending', hint: { conflicts: 2 } },
  ]);
  assert.deepEqual(after.scans, [
    { date: '2026-09-18', upstreamHead: SHA_HEAD, since: MERGE_BASE, added: 1, report: 'scans/2026-09-18.md' },
  ]);
  assert.deepEqual(before.entries, [known], 'input ledger is not mutated');
  assert.deepEqual(before.scans, []);
});

test('applyScan with nothing new changes nothing', () => {
  const before = ledger({ entries: [entry()] });
  const { ledger: after, added } = applyScan(before, { commits: [{ sha: SHA_A, date: '2026-09-12', title: 't', pr: 1 }], hints: {}, upstreamHead: SHA_HEAD, date: '2026-09-18' });
  assert.deepEqual(added, []);
  assert.deepEqual(after, before);
});

test('renderScanReport lists the new rows with upstream links and the status tally', () => {
  const l = ledger({
    entries: [
      entry({ status: 'ported', fork: { pr: 101 }, decided: '2026-09-06' }),
      entry({ sha: SHA_B, pr: 970, title: 'feat(x): new (#970)', date: '2026-09-14', status: 'pending', hint: { conflicts: 2 } }),
    ],
    scans: [{ date: '2026-09-18', upstreamHead: SHA_HEAD, since: MERGE_BASE, added: 1, report: 'scans/2026-09-18.md' }],
  });
  const md = renderScanReport(l, l.scans[0], [l.entries[1]]);
  assert.match(md, /^# Upstream scan 2026-09-18/m);
  assert.match(md, new RegExp(`${MERGE_BASE}\\.\\.${SHA_HEAD}`));
  assert.match(md, /https:\/\/github\.com\/open-mercato\/cezar\/pull\/970/);
  assert.match(md, /\| `bbbbbbbb` \|/);
  assert.match(md, /feat\(x\): new/);
  assert.match(md, /\| 2 \|/, 'conflict hint column');
  assert.match(md, /pending: 1/);
  assert.match(md, /ported: 1/);
});

test('the committed ledger is valid and every scan report it names exists', () => {
  const file = path.resolve(__dirname, '../..', LEDGER_PATH);
  assert.equal(fs.existsSync(file), true, `${LEDGER_PATH} is committed`);
  const l = yaml.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(validateLedger(l), []);
  for (const scan of l.scans) {
    assert.equal(fs.existsSync(path.resolve(path.dirname(file), scan.report)), true, `${scan.report} exists`);
  }
});

test('conflictHint counts a real conflicting commit even though git apply --check exits 0', () => {
  const { execFileSync } = require('node:child_process');
  const os = require('node:os');
  const { conflictHint } = require('./upstream-scan.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cez-upstream-hint-'));
  const run = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
  run('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'left alone\n');
  run('add', '.'); run('commit', '-q', '-m', 'base');
  run('checkout', '-q', '-b', 'theirs');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nTHEIRS\nthree\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'left alone\nplus a clean line\n');
  run('commit', '-q', '-am', 'theirs');
  const theirs = run('rev-parse', 'HEAD');
  run('checkout', '-q', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nOURS\nthree\n');
  run('commit', '-q', '-am', 'ours');
  assert.equal(conflictHint(theirs, dir), 1, 'a.txt conflicts, b.txt applies clean');
  assert.equal(run('status', '--porcelain'), '', 'the dry run leaves the tree untouched');
});

test('renderLedger groups entries by status with upstream and fork links', () => {
  const { renderLedger } = require('./upstream-ledger.cjs');
  const l = ledger({
    entries: [
      entry({ status: 'ported', fork: { pr: 101 }, decided: '2026-09-06' }),
      entry({ sha: SHA_B, pr: 970, title: 'feat(x): new (#970)', date: '2026-09-14', status: 'pending', hint: { conflicts: 2 }, note: 'applies clean' }),
      entry({ sha: 'e'.repeat(40), pr: 971, title: 'chore: bump', date: '2026-09-15', status: 'n/a', reason: 'release bump', decided: '2026-09-18' }),
    ],
    scans: [{ date: '2026-09-18', upstreamHead: SHA_HEAD, since: MERGE_BASE, added: 3, report: 'scans/2026-09-18.md' }],
  });
  const md = renderLedger(l);
  assert.match(md, /^# Upstream ledger/m);
  assert.match(md, /generated/i, 'says it is generated');
  assert.match(md, new RegExp(`Last scan: 2026-09-18 .*\`${SHA_HEAD.slice(0, 8)}\``));
  assert.match(md, /pending: 1 · ported: 1 · n\/a: 1/);
  const pendingAt = md.indexOf('## Pending (1)');
  const portedAt = md.indexOf('## Ported (1)');
  const naAt = md.indexOf('## N/a (1)');
  assert.ok(pendingAt > -1 && portedAt > pendingAt && naAt > portedAt, 'sections in status order');
  assert.match(md, /\[#970\]\(https:\/\/github\.com\/open-mercato\/cezar\/pull\/970\)/);
  assert.match(md, /\[PR #101\]\(https:\/\/github\.com\/hearsay-tools\/cezarion\/pull\/101\)/);
  assert.match(md, /applies clean/);
  assert.match(md, /release bump/);
});

test('the committed LEDGER.md is the render of the committed ledger', () => {
  const { renderLedger } = require('./upstream-ledger.cjs');
  const dir = path.dirname(path.resolve(__dirname, '../..', LEDGER_PATH));
  const l = yaml.parse(fs.readFileSync(path.join(dir, 'ledger.yaml'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(dir, 'LEDGER.md'), 'utf8'), renderLedger(l), 'run: node .github/scripts/upstream-scan.cjs render');
});
