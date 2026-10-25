const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inboxTitle, post, main } = require('./friction-inbox.cjs');

const NOW = new Date('2026-10-25T12:00:00Z');
const TITLE = 'Friction inbox 2026-10-25';
const FINDING = '**Destination:** project\n**Type:** Long path\n**What happened:** three searches for one value.\n';

function finding(t, body = FINDING) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'friction-inbox-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'finding.md');
  fs.writeFileSync(file, body);
  return file;
}

// A gh double: each `issue list` call returns the next listing, and every
// call is recorded so a test can pin which writes happened.
function fakeGh({ listings, created = 0 }) {
  const calls = [];
  const gh = args => {
    calls.push(args);
    const [noun, verb] = args;
    if (noun === 'issue' && verb === 'list') return JSON.stringify(listings.shift() ?? []);
    if (noun === 'issue' && verb === 'create') return `https://github.com/hearsay-tools/cezarion/issues/${created}\n`;
    if (noun === 'issue' && verb === 'comment') return `https://github.com/hearsay-tools/cezarion/issues/${args[2]}#issuecomment-1\n`;
    return '';
  };
  return { gh, calls, verbs: () => calls.map(args => args.slice(0, 2).join(' ')) };
}

test('the inbox title carries the UTC date', () => {
  assert.equal(inboxTitle(new Date('2026-10-25T23:30:00-02:00')), 'Friction inbox 2026-10-26');
});

test('a finding goes to the existing inbox for today without creating one', t => {
  const fake = fakeGh({ listings: [[{ number: 4, title: 'Friction inbox 2026-10-24' }, { number: 5, title: TITLE }]] });
  const result = post({ bodyFile: finding(t), gh: fake.gh, now: NOW });
  assert.deepEqual(result, { issue: 5, url: 'https://github.com/hearsay-tools/cezarion/issues/5#issuecomment-1' });
  assert.deepEqual(fake.verbs(), ['issue list', 'issue comment']);
  assert.deepEqual(fake.calls[0].slice(2), ['--repo', 'hearsay-tools/cezarion', '--label', 'friction-inbox', '--state', 'all', '--limit', '100', '--json', 'number,title']);
});

test('the first finding of a day creates the labeled inbox and posts the file as written', t => {
  const fake = fakeGh({ listings: [[], [{ number: 9, title: TITLE }]], created: 9 });
  const file = finding(t);
  assert.equal(post({ bodyFile: file, gh: fake.gh, now: NOW }).issue, 9);
  assert.deepEqual(fake.verbs(), ['issue list', 'label create', 'issue create', 'issue list', 'issue comment']);
  const create = fake.calls[2];
  assert.equal(create[create.indexOf('--title') + 1], TITLE);
  assert.equal(create[create.indexOf('--label') + 1], 'friction-inbox');
  assert.deepEqual(fake.calls[4].slice(2), ['9', '--repo', 'hearsay-tools/cezarion', '--body-file', file]);
});

test('when two agents create the inbox at once, the lowest number wins and the other copy is closed', t => {
  const fake = fakeGh({ listings: [[], [{ number: 9, title: TITLE }, { number: 8, title: TITLE }]], created: 9 });
  assert.equal(post({ bodyFile: finding(t), gh: fake.gh, now: NOW }).issue, 8);
  assert.deepEqual(fake.verbs(), ['issue list', 'label create', 'issue create', 'issue list', 'issue close', 'issue comment']);
  assert.deepEqual(fake.calls[4].slice(2), ['9', '--repo', 'hearsay-tools/cezarion', '--comment', 'Duplicate of hearsay-tools/cezarion#8.']);
  assert.equal(fake.calls[5][2], '8');
});

test('a finding without a known destination is refused before any GitHub call', t => {
  for (const body of ['**Type:** Long path\n', '**Destination:** somewhere\n']) {
    const fake = fakeGh({ listings: [] });
    assert.throws(() => post({ bodyFile: finding(t, body), gh: fake.gh, now: NOW }), /Destination:\*\* project \| sdlc \| squeal/);
    assert.deepEqual(fake.calls, []);
  }
});

test('the command prints the comment URL, and reports usage and gh failures with exit codes', t => {
  const out = [];
  const err = [];
  const io = { now: NOW, stdout: text => out.push(text), stderr: text => err.push(text) };
  const fake = fakeGh({ listings: [[{ number: 5, title: TITLE }]] });
  assert.equal(main(['post', finding(t)], { ...io, run: fake.gh }), 0);
  assert.deepEqual(out, ['https://github.com/hearsay-tools/cezarion/issues/5#issuecomment-1\n']);

  assert.equal(main(['add', 'x.md'], { ...io, run: fake.gh }), 2);
  assert.match(err.at(-1), /^Usage: node \.github\/scripts\/friction-inbox\.cjs post <finding\.md>/);

  const failing = () => { throw Object.assign(new Error('Command failed'), { stderr: 'HTTP 403: Resource not accessible\n' }); };
  assert.equal(main(['post', finding(t)], { ...io, run: failing }), 1);
  assert.equal(err.at(-1), 'Friction inbox post failed: HTTP 403: Resource not accessible\n');
});
