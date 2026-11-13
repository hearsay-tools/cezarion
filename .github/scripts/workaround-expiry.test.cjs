const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const yaml = require('yaml');
const { markersIn, expiredMarkers, updateCleanupIssue, TITLE } = require('./workaround-expiry.cjs');

const workflow = yaml.parse(fs.readFileSync(path.join(__dirname, '../workflows/workaround-expiry.yml'), 'utf8'));

test('workflow finds a marker on a closed issue in its own test and publishes it', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workaround-expiry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init');
  fs.writeFileSync(path.join(root, 'rules.md'), 'Rule <!-- until: hearsay-tools/cezarion#2492 -->\r\n<!-- until: hearsay-tools/squeal#95 -->\n<!-- until: example/repo#1 -->');
  fs.writeFileSync(path.join(root, 'untracked.md'), '<!-- until: example/repo#2 -->');
  fs.writeFileSync(path.join(root, 'ignored.txt'), '<!-- until: example/repo#3 -->');
  git('add', 'rules.md', 'ignored.txt');
  const step = workflow.jobs.report.steps.find(s => s.run);
  const [, script, flag] = step.run.split(' ');
  const { run } = require(path.resolve(__dirname, '../..', script));
  const calls = [], reports = [];
  const result = await run({ root, repository: 'hearsay-tools/cezarion', publish: flag === '--publish', print: text => reports.push(JSON.parse(text)), api: async (endpoint, method, data) => {
    calls.push({ endpoint, method, data });
    if (endpoint === 'repos/hearsay-tools/cezarion/issues/2492') return { state: 'closed' };
    if (endpoint === 'repos/hearsay-tools/squeal/issues/95') return { state: 'closed' };
    if (endpoint === 'repos/example/repo/issues/1') return { state: 'open' };
    if (method === 'POST') return { number: 9 };
    if (endpoint.includes('?state=open')) return [];
    assert.fail(`Unexpected API call: ${endpoint}`);
  } });
  assert.deepEqual(result, { action: 'create', number: 9 });
  assert.equal(reports[0].markers.length, 3);
  assert.deepEqual(reports[0].expired.map(m => [m.line, m.issue]), [[1, 'hearsay-tools/cezarion#2492'], [2, 'hearsay-tools/squeal#95']]);
  const body = calls.find(c => c.method === 'POST').data.body;
  assert.match(body, /rules\.md.*:1/);
  assert.match(body, /https:\/\/github.com\/hearsay-tools\/squeal\/issues\/95/);
  assert.doesNotMatch(body, /example\/repo/);
});

test('reader accepts standalone, inline and repeated markers; rejects malformed markers', () => {
  const text = ['<!-- until: a/b#1 -->', 'Rule <!-- until: a/b#2 --> <!-- until: a/b#3 -->', '```', '<!-- until: a/b#4 -->', '```', '<!-- until: a/b#0 -->', '<!-- until: a/b#x -->', '<!-- until: b#1 -->', '<!-- until: a/b#1', '<!-- until: a/b#01 -->'].join('\n');
  assert.deepEqual(markersIn('x.md', text).map(m => m.issue), ['a/b#1', 'a/b#2', 'a/b#3']);
});

test('reader skips markers that prose names inside code spans', () => {
  const text = [
    'Delete the `<!-- until: a/b#1 -->` marker.',
    'Also ``x ` <!-- until: a/b#2 --> y`` here.',
    'Real rule `code` <!-- until: a/b#3 -->',
    'Unclosed ` <!-- until: a/b#4 -->',
    'Mismatched `` <!-- until: a/b#5 --> `',
    'Escaped \\` <!-- until: a/b#6 --> `code`',
    '<!-- ` --> <!-- until: a/b#7 --> `code`',
    '<`example`!-- until: a/b#8 -->',
    '<!-- a comment that spans lines `',
    'still the comment --> <!-- until: a/b#9 --> `x`',
    'text <!--> `<!-- until: a/b#10 -->`',
    'text <!---> `<!-- until: a/b#11 -->`',
    'text <!-->',
    '`<!-- until: a/b#12 -->` <!-- until: a/b#13 -->',
    'Rule <span title="`">text</span> <!-- until: a/b#14 --> `code`',
    "Rule <a href='x`y' data-x=`z>link</a> <!-- until: a/b#15 --> `code`",
    'See <https://example.com/`> <!-- until: a/b#16 --> `code`',
    'Mail <me`x@example.com> <!-- until: a/b#17 --> `code`',
    'Not a tag <1 x> `<!-- until: a/b#18 -->`',
    'Escaped \\<!-- until: a/b#19 --> is text, and so is \\\\ before <!-- until: a/b#20 -->',
    'A backslash before a letter \\x stays, then `<!-- until: a/b#21 -->`',
  ].join('\n');
  assert.deepEqual(markersIn('spec.md', text).map(m => [m.line, m.issue]), [[3, 'a/b#3'], [4, 'a/b#4'], [5, 'a/b#5'],
    [6, 'a/b#6'], [7, 'a/b#7'], [10, 'a/b#9'], [14, 'a/b#13'], [15, 'a/b#14'], [16, 'a/b#15'], [17, 'a/b#16'], [18, 'a/b#17'], [20, 'a/b#20']]);
});

test('reader skips backtick and tilde fences and reports the marker after each closing fence', () => {
  for (const character of ['`', '~']) {
    for (const length of [3, 4]) {
      const fence = character.repeat(length);
      const text = [fence + ' markdown', '<!-- until: a/b#1 -->', fence, '<!-- until: a/b#2 -->'].join('\r\n');
      assert.deepEqual(markersIn('rules.md', text), [{ file: 'rules.md', line: 4, issue: 'a/b#2' }]);
    }
  }
});

test('only matching fences of sufficient length and no trailing text close a block', () => {
  const text = ['   ```` markdown', '<!-- until: a/b#1 -->', '~~~', '```', '```` trailing', '<!-- until: a/b#2 -->', '  `````  ', '<!-- until: a/b#3 -->', '~~~', '<!-- until: a/b#4 -->'].join('\n');
  assert.deepEqual(markersIn('rules.md', text), [{ file: 'rules.md', line: 8, issue: 'a/b#3' }]);
});

test('inline runs, indented code and invalid backtick info do not open a fence', () => {
  const text = ['Text ```', '<!-- until: a/b#1 -->', '    ~~~', '<!-- until: a/b#2 -->', '``` info`', '<!-- until: a/b#3 -->'].join('\n');
  assert.deepEqual(markersIn('rules.md', text).map(m => m.issue), ['a/b#1', 'a/b#2', 'a/b#3']);
});

test('fence-like lines inside HTML comments do not hide later markers', () => {
  for (const character of ['`', '~']) {
    const text = ['<!--', character.repeat(3) + 'md', '-->', 'Rule <!-- until: a/b#1 -->', character.repeat(3), '<!--', '<!-- until: a/b#2 -->', character.repeat(3), '<!-- until: a/b#3 -->'].join('\n');
    assert.deepEqual(markersIn('rules.md', text).map(m => [m.line, m.issue]), [[4, 'a/b#1'], [9, 'a/b#3']]);
  }
});

test('resolution is cached and an open issue is not expired', async () => {
  let calls = 0;
  const result = await expiredMarkers(markersIn('x.md', '<!-- until: a/b#1 -->\n<!-- until: a/b#1 -->'), async () => { calls++; return 'open'; });
  assert.deepEqual(result, []);
  assert.equal(calls, 1);
});

test('failed or invalid resolution is recorded without discarding readable issues', async () => {
  const markers = markersIn('x.md', '<!-- until: a/b#1 -->\n<!-- until: a/b#1 -->');
  const unchecked = [];
  assert.deepEqual(await expiredMarkers(markers, async () => { throw new Error('unavailable'); }, unchecked), []);
  assert.equal(unchecked.length, 2);
  assert.equal(unchecked[0].message, 'could not check: a/b#1 (API error)');
  const invalid = [];
  await expiredMarkers(markers, async () => 'unknown', invalid);
  assert.equal(invalid[0].status, 'API error');
});

test('open-or-update finds the exact title on a later page and updates instead of creating', async () => {
  const calls = [];
  const result = await updateCleanupIssue('a/b', [{ file: 'rules.md', line: 1, issue: 'a/b#1' }], async (endpoint, method, data) => {
    calls.push({ endpoint, method, data });
    if (method === 'PATCH') return {};
    if (endpoint.endsWith('page=1')) return Array.from({ length: 100 }, (_, number) => ({ title: 'Other', number }));
    return [{ title: TITLE, number: 7, pull_request: {} }, { title: TITLE, number: 8 }];
  });
  assert.deepEqual(result, { action: 'update', number: 8 });
  assert.equal(calls.at(-1).endpoint, 'repos/a/b/issues/8');
  assert.equal(calls.at(-1).method, 'PATCH');
  assert.equal(calls.some(c => c.method === 'POST'), false);
});

test('no expired markers leaves an existing issue unchanged without API calls', async () => {
  assert.deepEqual(await updateCleanupIssue('a/b', [], () => assert.fail('unexpected API call')), { action: 'none' });
});

test('workflow is weekly, dispatchable, serialized and uses only contents read and issues write', () => {
  assert.equal(workflow.on.schedule.length, 1);
  assert.equal(workflow.on.schedule[0].cron, '23 7 * * 1');
  assert.deepEqual(workflow.on.workflow_dispatch, {});
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.jobs.report.permissions, { contents: 'read', issues: 'write' });
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.match(workflow.jobs.report.if, /default_branch/);
  assert.equal(workflow.jobs.report.steps[0].with['persist-credentials'], false);
});

test('CLI uses gh api for resolution and publishes through stdin with no network', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workaround-expiry-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' });
  fs.writeFileSync(path.join(root, 'rule.md'), '<!-- until: external/repo#7 -->');
  execFileSync('git', ['add', 'rule.md'], { cwd: root });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  fs.writeFileSync(path.join(root, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] !== 'api') process.exit(2);
const projection = args[args.indexOf('--jq') + 1];
const expected = args[1].includes('?state=open') ? '[.[] | {number, title, pull_request}]' : args.includes('GET') ? '{state}' : '{number}';
if (!args.includes('--jq') || projection !== expected) process.exit(4);
if (args[1] === 'repos/external/repo/issues/7' && args.includes('GET')) console.log('{"state":"closed"}');
else if (args[1].includes('?state=open')) console.log('[]');
else if (args.includes('POST') && args.includes('--input') && args.at(-1) === '-') {
  const body = JSON.parse(fs.readFileSync(0, 'utf8'));
  fs.writeFileSync('published.json', JSON.stringify(body));
  console.log('{"number":8}');
} else process.exit(3);
`, { mode: 0o755 });
  const stdout = execFileSync(process.execPath, [path.join(__dirname, 'workaround-expiry.cjs'), '--publish'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PATH: root + path.delimiter + process.env.PATH, GITHUB_REPOSITORY: 'local/repo' },
  });
  assert.equal(JSON.parse(stdout).expired[0].issue, 'external/repo#7');
  const published = JSON.parse(fs.readFileSync(path.join(root, 'published.json'), 'utf8'));
  assert.equal(published.title, TITLE);
  assert.match(published.body, /external\/repo\/issues\/7/);
});


test('CLI failure reports the cause and issue endpoint without forwarding gh stderr', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workaround-expiry-error-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' });
  fs.writeFileSync(path.join(root, 'rule.md'), '<!-- until: external/repo#7 -->');
  execFileSync('git', ['add', 'rule.md'], { cwd: root });
  fs.writeFileSync(path.join(root, 'gh'), '#!/bin/sh\necho fixture-private-response >&2\nexit 1\n', { mode: 0o755 });
  const result = spawnSync(process.execPath, [path.join(__dirname, 'workaround-expiry.cjs')], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PATH: root + path.delimiter + process.env.PATH, GITHUB_REPOSITORY: 'local/repo' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /could not check: external\/repo#7 \(exit 1\)/);
  assert.doesNotMatch(result.stderr, /fixture-private-response/);
});


test('CLI publishes readable expired and unreadable markers together, then exits non-zero', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workaround-expiry-partial-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' });
  fs.writeFileSync(path.join(root, 'rule.md'), '<!-- until: public/repo#1 -->\n<!-- until: private/repo#2 -->');
  execFileSync('git', ['add', 'rule.md'], { cwd: root });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  fs.writeFileSync(path.join(root, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[1] === 'repos/public/repo/issues/1') console.log('{"state":"closed"}');
else if (args[1] === 'repos/private/repo/issues/2') { console.error('gh: Not Found (HTTP 404) private-response'); process.exit(1); }
else if (args[1].includes('?state=open')) console.log('[]');
else if (args.includes('POST')) {
  fs.writeFileSync('published.json', fs.readFileSync(0, 'utf8'));
  console.log('{"number":8}');
} else process.exit(3);
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [path.join(__dirname, 'workaround-expiry.cjs'), '--publish'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PATH: root + path.delimiter + process.env.PATH, GITHUB_REPOSITORY: 'local/repo' },
  });
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.expired[0].issue, 'public/repo#1');
  assert.equal(report.unchecked[0].message, 'could not check: private/repo#2 (404)');
  const published = JSON.parse(fs.readFileSync(path.join(root, 'published.json'), 'utf8'));
  assert.match(published.body, /public\/repo\/issues\/1/);
  assert.match(published.body, /could not check: private\/repo#2 \(404\)/);
  assert.doesNotMatch(result.stdout + result.stderr + published.body, /private-response/);
});
