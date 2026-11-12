const test = require('node:test');
const assert = require('node:assert/strict');
const plan = require('./release-plan.cjs');
const { marker } = require('./release-blocker.cjs');

const sha = n => String(n).repeat(40).slice(0, 40);
const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-11-12T12:00:00Z');

test('semantic version precedence orders release candidates below their stable version', () => {
  const sorted = ['1.2.0', '1.2.1-rc.10', '1.2.1-rc.2', '1.2.1', '1.10.0', '1.2.1-nightly.20261112.5'].sort(plan.compareVersions);
  assert.deepEqual(sorted, ['1.2.0', '1.2.1-nightly.20261112.5', '1.2.1-rc.2', '1.2.1-rc.10', '1.2.1', '1.10.0']);
});

test('a release after a failed candidate takes the same version with the next rc number', () => {
  assert.equal(plan.nextCandidateVersion('1.3.0', ['1.2.0']), '1.3.0-rc.1');
  assert.equal(plan.nextCandidateVersion('1.3.0', ['1.3.0-rc.1', '1.3.0-rc.2', '1.30.0-rc.9', '1.3.0-rc.x']), '1.3.0-rc.3');
});

test('the candidate tag never moves next backwards', () => {
  assert.equal(plan.candidateDistTag('1.3.0-rc.1', {}), 'next');
  assert.equal(plan.candidateDistTag('1.3.0-rc.2', { next: '1.3.0-rc.1' }), 'next');
  assert.equal(plan.candidateDistTag('0.9.5-rc.1', { next: '1.3.0-rc.1' }), 'next-0.9');
  assert.equal(plan.stableDistTag('1.3.0', { latest: '1.2.0' }), 'latest');
  assert.equal(plan.stableDistTag('0.9.5', { latest: '1.2.0' }), 'latest-0.9');
});

test('the 24-hour rule reads the newest stable publish time and ignores prereleases', () => {
  const time = { created: '2020-01-01T00:00:00Z', '1.2.0': '2026-11-10T12:00:00Z', '1.3.0-rc.1': '2026-11-12T11:00:00Z' };
  assert.equal(plan.lastStablePublish(time), Date.parse('2026-11-10T12:00:00Z'));
  assert.equal(plan.lastStablePublish({ '1.3.0-rc.1': '2026-11-12T11:00:00Z' }), null);
});

test('a rollback publishes the next patch of the latest line from the stable tag below latest', () => {
  assert.equal(plan.rollbackVersion('1.2.1', ['1.2.0', '1.2.1', '1.3.0-rc.1']), '1.2.2');
  assert.equal(plan.rollbackVersion('1.2.1', ['1.2.0', '1.2.1', '1.2.2-rc.1']), '1.2.2');
  const tags = ['v1.1.0', 'v1.2.0', 'v1.2.1', 'v1.2.1-rc.1', 'vnext'];
  assert.equal(plan.rollbackTag('1.2.1', tags), 'v1.2.0');
  assert.equal(plan.rollbackTag('1.2.1', tags, 'v1.1.0'), 'v1.1.0');
  assert.throws(() => plan.rollbackTag('1.2.1', tags, 'v1.2.1'), /not a stable release tag below latest/);
  assert.throws(() => plan.rollbackTag('1.1.0', tags), /No stable release tag/);
});

const blocker = (number, body = '') => ({ number, state: 'open', labels: [{ name: 'release-blocker' }], body, html_url: `https://example.test/${number}` });

test('a rollback runs past the blocker of the release it replaces, and only past named others', () => {
  const issues = [
    blocker(1, `${marker('release', '1.2.1')}\nfailed promotion`),
    blocker(2, `${marker('release', '1.2.2')}\nfailed candidate`),
    blocker(3, `${marker('release', '1.1.0')}\nold release`),
    blocker(4, `${marker('rehearsal', 'nightly')}\nrehearsal`),
    blocker(5, 'filed by hand'),
    { ...blocker(6), labels: [{ name: 'bug' }] },
    { ...blocker(7), pull_request: {} },
  ];
  assert.deepEqual(plan.blockingIssues(issues).map(issue => issue.number), [1, 2, 3, 4, 5]);
  // Only the blocker of the replaced `latest` is exempt; a newer candidate's blocker must be named.
  assert.deepEqual(plan.blockingIssues(issues, { rollback: true, latest: '1.2.1' }).map(issue => issue.number), [2, 3, 4, 5]);
  assert.deepEqual(plan.blockingIssues(issues, { rollback: true, latest: '1.2.1', ignore: [2, 4, 5] }).map(issue => issue.number), [3]);
  assert.deepEqual(plan.parseIssueNumbers('#4, 5 6'), [4, 5, 6]);
  assert.deepEqual(plan.parseIssueNumbers(''), []);
  assert.throws(() => plan.parseIssueNumbers('4, five'), /Expected issue numbers/);
});

const RESULT_JOB = { name: 'Rehearse the release tests / Release candidate result', conclusion: 'success' };

function nightlyGithub(runs, jobsByRun) {
  const listed = [];
  return {
    listed,
    paginate: async (method, args) => (await method(args)).data,
    rest: { actions: {
      listWorkflowRuns: async () => ({ data: { workflow_runs: runs } }),
      listJobsForWorkflowRun: async ({ run_id }) => { listed.push(run_id); return { data: jobsByRun[run_id] ?? [] }; },
    } },
  };
}

test('the newest Nightly that tested a published package decides the rehearsal gate', async () => {
  const run = (id, conclusion, hour) => ({ id, status: 'completed', conclusion, created_at: new Date(NOW - hour * HOUR).toISOString(), html_url: `run-${id}` });
  // A cancelled run and a run that skipped the rehearsal (main did not move, or a dry run) say nothing.
  const skipped = { 2: [{ name: 'Rehearse the release tests / Release candidate result', conclusion: 'skipped' }], 3: [RESULT_JOB] };
  let gh = nightlyGithub([run(1, 'cancelled', 1), run(2, 'success', 2), run(3, 'success', 26), run(4, 'failure', 50)], skipped);
  assert.deepEqual(await plan.rehearsalVerdict({ github: gh, repo: {} }), { passed: true, url: 'run-3' });
  assert.deepEqual(gh.listed, [2, 3]);
  gh = nightlyGithub([run(5, 'failure', 2), run(3, 'success', 26)], skipped);
  assert.match((await plan.rehearsalVerdict({ github: gh, repo: {} })).reason, /ended failure: run-5/);
  // A green Nightly without the published-package tests is not a passed rehearsal.
  gh = nightlyGithub([run(2, 'success', 2)], skipped);
  assert.match((await plan.rehearsalVerdict({ github: gh, repo: {} })).reason, /No recent Nightly run tested a published package/);
  assert.equal(plan.rehearsalOutcome(run(3, 'success', 1), [RESULT_JOB]), 'passed');
});

test('the candidate is the newest first-parent commit whose own ci.yml push run passed', () => {
  const runs = [
    { event: 'push', head_branch: 'main', status: 'completed', conclusion: 'success', head_sha: sha(3) },
    { event: 'push', head_branch: 'main', status: 'completed', conclusion: 'success', head_sha: sha(1) },
    { event: 'merge_group', head_branch: 'main', status: 'completed', conclusion: 'success', head_sha: sha(5) },
    { event: 'push', head_branch: 'main', status: 'completed', conclusion: 'failure', head_sha: sha(4) },
  ];
  assert.equal(plan.newestVerifiedCommit([sha(5), sha(4), sha(3), sha(2), sha(1)], runs), sha(3));
  assert.equal(plan.newestVerifiedCommit([sha(5), sha(4)], runs), null);
});

function fixture({ issues = [], nightly = 'success', time = { '1.2.0': '2026-11-10T00:00:00Z' }, versions = ['1.2.0'], distTags = { latest: '1.2.0' }, ref = 'refs/heads/main', base = '1.2.0' } = {}) {
  const calls = [];
  const github = {
    paginate: async (method, args) => (await method(args)).data,
    rest: {
      issues: { listForRepo: async args => { calls.push(['issues', args]); return { data: issues }; } },
      actions: {
        listWorkflowRuns: async args => {
          calls.push(['runs', args]);
          if (args.workflow_id === 'nightly.yml') return { data: { workflow_runs: [{ id: 99, status: 'completed', conclusion: nightly, created_at: '2026-11-12T03:30:00Z', html_url: 'nightly-run' }] } };
          return { data: { workflow_runs: [{ event: 'push', head_branch: 'main', status: 'completed', conclusion: 'success', head_sha: sha(2) }] } };
        },
        listJobsForWorkflowRun: async () => ({ data: [RESULT_JOB] }),
      },
    },
  };
  const git = (...args) => {
    if (args[0] === 'rev-list') return [sha(3), sha(2), sha(1)].join('\n');
    if (args[0] === 'show') { calls.push(['show', args[1]]); return JSON.stringify({ version: base }); }
    if (args[0] === 'tag') return 'v1.1.0\nv1.2.0';
    if (args[0] === 'rev-parse') return sha(7);
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  const context = { ref, sha: sha(3), repo: { owner: 'o', repo: 'r' } };
  const run = inputs => plan.planRelease({ github, context, git, packageName: '@scope/pkg', aliasName: 'pkg', now: NOW, view: () => ({ versions, time, distTags }), inputs });
  return { run, calls };
}

test('a release on main takes the newest verified commit, older than the dispatch commit', async () => {
  const { run, calls } = fixture({ versions: ['1.2.0', '1.2.1-rc.1'] });
  const result = await run({ bump: 'patch' });
  assert.equal(result.source_sha, sha(2));
  assert.equal(result.dispatch_sha, sha(3));
  assert.deepEqual(calls.find(([kind]) => kind === 'show'), ['show', `${sha(2)}:packages/cezar/package.json`]);
  assert.equal(result.version, '1.2.1');
  assert.equal(result.candidate, '1.2.1-rc.2');
  assert.equal(result.candidate_tag, 'next');
  assert.equal(result.stable_tag, 'latest');
  assert.equal(result.needs_suite, 'false');
  assert.equal(result.bump_sha, sha(2));
  assert.equal(result.bump_dir, 'source');
  assert.equal(result.previous, '1.2.0');
  assert.equal(result.alias, 'pkg');
  const ciRuns = calls.find(([kind, args]) => kind === 'runs' && args.workflow_id === 'ci.yml')[1];
  assert.deepEqual([ciRuns.event, ciRuns.branch, ciRuns.status], ['push', 'main', 'success']);
});

test('a release/** release runs the full suite on its head first', async () => {
  const { run } = fixture({ ref: 'refs/heads/release/1.1.x', base: '1.1.0' });
  const result = await run({ bump: 'patch' });
  assert.equal(result.source_sha, sha(3));
  assert.equal(result.needs_suite, 'true');
  assert.equal(result.version, '1.1.1');
  assert.equal(result.stable_tag, 'latest-1.1');
});

test('a release is refused while a blocker is open or the last rehearsal failed', async () => {
  await assert.rejects(fixture({ issues: [blocker(9, 'by hand')] }).run({ bump: 'patch' }), /Open release-blocker issue #9/);
  await assert.rejects(fixture({ nightly: 'failure' }).run({ bump: 'patch' }), /last Nightly rehearsal ended failure/);
});

test('a second stable release within 24 hours is refused; a retry after a failed candidate is not', async () => {
  await assert.rejects(fixture({ time: { '1.2.0': '2026-11-12T01:00:00Z' } }).run({ bump: 'patch' }), /within 24 hours is refused/);
  const retry = await fixture({ versions: ['1.2.0', '1.2.1-rc.1'], time: { '1.2.0': '2026-11-10T00:00:00Z', '1.2.1-rc.1': '2026-11-12T11:00:00Z' } }).run({ bump: 'patch' });
  assert.equal(retry.candidate, '1.2.1-rc.2');
});

test('a release on main below latest is refused until the version-bump PR merges', async () => {
  await assert.rejects(fixture({ base: '1.1.0' }).run({ bump: 'patch' }), /not above latest 1.2.0/);
  await assert.rejects(fixture({ versions: ['1.2.0', '1.2.1'] }).run({ bump: 'patch' }), /already published/);
});

test('a rollback ignores the 24-hour rule and the rehearsal, and its own blocker', async () => {
  const issues = [blocker(1, marker('release', '1.2.1')), blocker(2, 'unrelated')];
  const f = fixture({ issues, nightly: 'failure', time: { '1.2.1': '2026-11-12T11:00:00Z' }, versions: ['1.2.0', '1.2.1'], distTags: { latest: '1.2.1' } });
  await assert.rejects(f.run({ rollback: 'true' }), /#2/);
  const result = await f.run({ rollback: 'true', ignoreBlockers: '2' });
  assert.equal(result.mode, 'rollback');
  assert.equal(result.source_sha, sha(7));
  assert.equal(result.version, '1.2.2');
  assert.equal(result.record_bump, 'true');
  assert.equal(result.bump_sha, sha(3));
  assert.equal(result.bump_dir, '.');
  assert.equal(result.ignore_blockers, '2');
  assert.ok(!f.calls.some(([kind, args]) => kind === 'runs' && args.workflow_id === 'nightly.yml'));
});

test('only a rollback can name blockers, and only main or release/** can release', async () => {
  await assert.rejects(fixture().run({ bump: 'patch', ignoreBlockers: '3' }), /Only a rollback/);
  await assert.rejects(fixture({ ref: 'refs/heads/feature' }).run({ bump: 'patch' }), /main or a release/);
});

test('the promotion re-check refuses a blocker opened during the candidate tests', async () => {
  const { calls } = fixture();
  let open = [blocker(11, 'opened during tests')];
  const github = {
    paginate: async (method, args) => (method === github.rest.issues.listForRepo ? open : (await method(args)).data),
    rest: { issues: { listForRepo() {} }, actions: {
      listWorkflowRuns: async () => ({ data: { workflow_runs: [{ id: 1, status: 'completed', conclusion: 'success', created_at: '2026-11-12T00:00:00Z' }] } }),
      listJobsForWorkflowRun: async () => ({ data: [RESULT_JOB] }),
    } },
  };
  const registry = { versions: ['1.2.0', '1.2.1-rc.1'], time: { '1.2.0': '2026-11-10T00:00:00Z' }, distTags: { latest: '1.2.0' } };
  const recheck = () => plan.recheckGates({ github, context: { repo: {} }, mode: 'release', previous: '1.2.0', ignoreBlockers: '', packageName: '@scope/pkg', names: '@scope/pkg,pkg', sourceNames: 'pkg,@scope/pkg', version: '1.2.1', stableTag: 'latest', now: NOW, view: () => registry });
  await assert.rejects(recheck(), /Promotion refused:\n- Open release-blocker issue #11/);
  open = [];
  await recheck();
  assert.equal(calls.length, 0);
});

test('a rerun of an older plan is refused when the registry moved since the plan', () => {
  const at = (time, latest, extra = {}) => ({ versions: Object.keys(time), time, distTags: { latest, ...extra } });
  const check = (registry, overrides = {}) => plan.registryChanges({ registry, previous: '1.2.0', version: '1.2.1', stableTag: 'latest', rollback: false, now: NOW, ...overrides });
  assert.deepEqual(check(at({ '1.2.0': '2026-11-10T00:00:00Z' }, '1.2.0')), []);
  // A newer release went out after this run planned 1.2.1: publishing would move latest backwards.
  const moved = check(at({ '1.2.0': '2026-11-10T00:00:00Z', '1.3.0': '2026-11-12T10:00:00Z' }, '1.3.0'));
  assert.match(moved.join('\n'), /latest moved from 1\.2\.0 to 1\.3\.0/);
  assert.match(moved.join('\n'), /within 24 hours/);
  // A maintenance release under latest-1.1 within 24 hours trips the cooldown, not the tag.
  assert.match(check(at({ '1.2.0': '2026-11-10T00:00:00Z', '1.1.5': '2026-11-12T10:00:00Z' }, '1.2.0')).join('\n'), /within 24 hours/);
  // A rollback skips the cooldown but still needs the latest it planned against.
  assert.deepEqual(check(at({ '1.2.0': '2026-11-12T10:00:00Z' }, '1.2.0'), { rollback: true }), []);
  // A retry of this promotion, already on latest, passes; release.mjs verifies its source.
  assert.deepEqual(check(at({ '1.2.0': '2026-11-10T00:00:00Z', '1.2.1': '2026-11-12T11:00:00Z' }, '1.2.1')), []);
});

test('no publish from a stale plan moves a dist-tag backwards', () => {
  const registry = { versions: [], time: { '1.2.0': '2026-11-01T00:00:00Z', '1.1.6': '2026-11-02T00:00:00Z' },
    distTags: { latest: '1.2.0', 'latest-1.1': '1.1.6', next: '1.3.0-rc.1' } };
  // A rerun stage of an old 1.2.1-rc.1 plan after 1.3.0-rc.1 took next.
  assert.throws(() => plan.checkCandidateTag({ names: 'p', sourceNames: 'p', version: '1.2.1-rc.1', tag: 'next', view: () => registry }), /p: next points to 1\.3\.0-rc\.1/);
  plan.checkCandidateTag({ names: 'p', sourceNames: 'p', version: '1.3.0-rc.2', tag: 'next', view: () => registry });
  plan.checkCandidateTag({ names: 'p', sourceNames: 'p', version: '1.3.0-rc.1', tag: 'next', view: () => registry });
  // An old maintenance plan for 1.1.5 after 1.1.6 took latest-1.1.
  const stale = plan.registryChanges({ registry, previous: '1.2.0', version: '1.1.5', stableTag: 'latest-1.1', rollback: false, now: NOW });
  assert.match(stale.join('\n'), /latest-1\.1 points to 1\.1\.6/);
  assert.deepEqual(plan.registryChanges({ registry, previous: '1.2.0', version: '1.1.7', stableTag: 'latest-1.1', rollback: false, now: NOW }), []);
});

test('every published name is checked, and a name the registry lacks has no tag to regress', () => {
  // A publish that failed partway left the alias ahead of the package.
  const views = { '@scope/pkg': { distTags: { next: '1.2.0-rc.1' } }, alias: { distTags: { next: '1.3.0-rc.1' } }, fresh: null };
  const view = (name, options) => { assert.deepEqual(options, { optional: true }); return views[name]; };
  assert.throws(() => plan.checkCandidateTag({ names: '@scope/pkg,alias,fresh', sourceNames: '@scope/pkg,alias,fresh', version: '1.2.1-rc.1', tag: 'next', view }), /alias: next points to 1\.3\.0-rc\.1/);
  plan.checkCandidateTag({ names: '@scope/pkg,fresh', sourceNames: '@scope/pkg,fresh', version: '1.2.1-rc.1', tag: 'next', view });
});

test('a maintenance candidate upgrades from its own line, a main candidate from latest', async () => {
  assert.equal(plan.upgradeBaseline({ distTags: { latest: '1.2.0', 'latest-1.1': '1.1.6' } }, 'latest-1.1'), '1.1.6');
  assert.equal(plan.upgradeBaseline({ distTags: { latest: '1.2.0' } }, 'latest-1.1'), '');
  const result = await fixture({ ref: 'refs/heads/release/1.1.x', base: '1.1.6', distTags: { latest: '1.2.0', 'latest-1.1': '1.1.6' } }).run({ bump: 'patch' });
  assert.equal(result.upgrade_from, '1.1.6');
  assert.equal(result.previous, '1.2.0', 'the promotion re-check still compares against latest');
  assert.equal((await fixture().run({ bump: 'patch' })).upgrade_from, '1.2.0');
});

test('an optional registry read answers null for a missing package and throws on any other error', async t => {
  const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
  const { join } = require('node:path');
  const dir = mkdtempSync(join(require('node:os').tmpdir(), 'npm-view-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'npm'), '#!/bin/sh\nif [ "$2" = missing ]; then echo "npm error code E404" >&2; exit 1; fi\necho "npm error code ETIMEDOUT" >&2; exit 1\n', { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  t.after(() => { process.env.PATH = path; });
  assert.equal(plan.npmView('missing', { optional: true }), null);
  assert.throws(() => plan.npmView('missing'), /Command failed/);
  assert.throws(() => plan.npmView('other', { optional: true }), /Command failed/);
});

test('the candidate commit must publish the names the plan checked, and a rollback runs from main', async () => {
  const view = () => ({ distTags: {} });
  assert.throws(() => plan.checkCandidateTag({ names: 'pkg,alias', sourceNames: 'pkg,alias,legacy', version: '1.2.1-rc.1', tag: 'next', view }),
    /candidate commit publishes alias, legacy, pkg, the plan checked alias, pkg/);
  assert.equal(plan.namesMismatch('pkg,alias', 'alias,pkg'), null);
  const f = fixture({ ref: 'refs/heads/release/1.1.x', versions: ['1.2.0', '1.2.1'], distTags: { latest: '1.2.1' } });
  await assert.rejects(f.run({ rollback: 'true' }), /Dispatch a rollback from main/);
});

test('the promotion refuses when a partial publish left the alias ahead of the package', async () => {
  // The package still holds latest 1.2.0, but an earlier partial publish moved the alias to 1.3.0.
  const views = {
    '@scope/pkg': { versions: ['1.2.0'], time: { '1.2.0': '2026-11-10T00:00:00Z' }, distTags: { latest: '1.2.0' } },
    alias: { versions: ['1.2.0', '1.3.0'], time: {}, distTags: { latest: '1.3.0' } },
  };
  const github = {
    paginate: async (method, args) => (method === github.rest.issues.listForRepo ? [] : (await method(args)).data),
    rest: { issues: { listForRepo() {} }, actions: {
      listWorkflowRuns: async () => ({ data: { workflow_runs: [{ id: 1, status: 'completed', conclusion: 'success', created_at: '2026-11-12T00:00:00Z' }] } }),
      listJobsForWorkflowRun: async () => ({ data: [RESULT_JOB] }),
    } },
  };
  const recheck = version => plan.recheckGates({ github, context: { repo: {} }, mode: 'release', previous: '1.2.0', ignoreBlockers: '',
    packageName: '@scope/pkg', names: '@scope/pkg,alias', sourceNames: '@scope/pkg,alias', version, stableTag: 'latest', now: NOW, view: name => views[name] });
  await assert.rejects(recheck('1.2.1'), /alias: latest points to 1\.3\.0; publishing 1\.2\.1 under it would move it backwards/);
  await recheck('1.3.1');
});
