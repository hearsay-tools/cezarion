const test = require('node:test');
const assert = require('node:assert/strict');
const { fileReleaseBlocker, blockerVersion, marker } = require('./release-blocker.cjs');

function github(open = []) {
  const state = { created: [], comments: [], listed: [] };
  return {
    state,
    paginate: async (method, args) => (await method(args)).data,
    rest: {
      issues: {
        listForRepo: async args => { state.listed.push(args); return { data: open }; },
        create: async args => { state.created.push(args); return { data: { number: 50, html_url: 'issue-50' } }; },
        createComment: async args => { state.comments.push(args); return { data: {} }; },
      },
    },
  };
}

test('a failed candidate files one release-blocker issue that records its version', async () => {
  const gh = github();
  const result = await fileReleaseBlocker({ github: gh, repo: { owner: 'o', repo: 'r' }, kind: 'release', version: '1.2.1', stage: 'tests of release candidate 1.2.1-rc.1', runUrl: 'run-1' });
  assert.deepEqual(result, { number: 50, url: 'issue-50', created: true });
  const [issue] = gh.state.created;
  assert.deepEqual(issue.labels, ['release-blocker', 'area-ci']);
  assert.equal(issue.title, 'Release 1.2.1 blocked: tests of release candidate 1.2.1-rc.1');
  assert.equal(blockerVersion(issue.body), '1.2.1');
  assert.match(issue.body, /\(run-1\)/);
  assert.match(issue.body, /refuses every stable release/);
  assert.deepEqual(gh.state.listed[0], { owner: 'o', repo: 'r', state: 'open', labels: 'release-blocker', per_page: 100 });
});

test('a repeated failure comments on the open blocker instead of filing another', async () => {
  const open = [{ number: 7, html_url: 'issue-7', body: `${marker('rehearsal', 'nightly')}\n...` }];
  const gh = github(open);
  const result = await fileReleaseBlocker({ github: gh, repo: { owner: 'o', repo: 'r' }, kind: 'rehearsal', stage: 'full suite failure', runUrl: 'run-2' });
  assert.deepEqual(result, { number: 7, url: 'issue-7', created: false });
  assert.equal(gh.state.created.length, 0);
  assert.equal(gh.state.comments[0].issue_number, 7);
  assert.match(gh.state.comments[0].body, /full suite failure\. \[Run\]\(run-2\)/);
});

test('a rehearsal blocker carries no release version, and a release blocker needs one', async () => {
  assert.equal(blockerVersion(marker('rehearsal', 'nightly')), null);
  assert.equal(blockerVersion('no marker'), null);
  await assert.rejects(fileReleaseBlocker({ github: github(), repo: {}, kind: 'release', version: '1.2.1-rc.1', stage: 's', runUrl: 'u' }), /stable version/);
});

test('a stable publish that failed before any name reached the registry files nothing', () => {
  const { publishedSome } = require('./release-blocker.cjs');
  const seen = [];
  const view = (name, version) => { seen.push(`${name}@${version}`); return name === 'alias'; };
  assert.equal(publishedSome({ names: 'pkg,alias', version: '1.2.1', view }), true);
  assert.deepEqual(seen, ['pkg@1.2.1', 'alias@1.2.1']);
  assert.equal(publishedSome({ names: 'pkg', version: '1.2.1', view }), false);
});

test('the registry read tells a published version from a missing one and throws on other errors', t => {
  const { viewVersion } = require('./release-blocker.cjs');
  const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
  const { join } = require('node:path');
  const dir = mkdtempSync(join(require('node:os').tmpdir(), 'npm-view-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'npm'), [
    '#!/bin/sh',
    'case "$2" in',
    '  pkg@1.2.1) echo 1.2.1 ;;',
    '  pkg@9.9.9) echo "npm error code E404" >&2; exit 1 ;;',
    '  *) echo "npm error code ETIMEDOUT" >&2; exit 1 ;;',
    'esac', '',
  ].join('\n'), { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  t.after(() => { process.env.PATH = path; });
  assert.equal(viewVersion('pkg', '1.2.1'), true);
  assert.equal(viewVersion('pkg', '9.9.9'), false);
  assert.throws(() => viewVersion('other', '1.0.0'), /Command failed/);
});
