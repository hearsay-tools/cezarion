import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(),
  execFile: (...args: unknown[]) => execFileMock(...args),
}));
import { createGithubDriver, evictGithubProjectCaches } from './github.ts';
import { mergedPullRequestObservations } from '../../merge-observations.ts';

const root = '/completion-forge';
const driver = createGithubDriver(root, { owner: 'org', repo: 'repo' });
const sha = 'a'.repeat(40);
const input = { method: 'squash' as const, expectedHeadSha: sha, expectedHeadRef: 'cez/task', requirePassingChecks: true };
const readyInput = { expectedHeadSha: sha, expectedHeadRef: 'cez/task' };
let pr: Record<string, unknown>;
let calls: string[][];
let onCall: (args: string[]) => void;
let failure: string | undefined;
let workflowPage: unknown;
const mutations = () => calls.filter(args => args[1] === 'ready' || args.includes('PUT'));

beforeEach(() => {
  vi.stubEnv('CEZ_DRY_RUN', '0');
  evictGithubProjectCaches(root);
  mergedPullRequestObservations.clear();
  pr = {
    number: 42, title: 'Task PR', url: 'https://github.com/org/repo/pull/42', state: 'OPEN', isDraft: false,
    headRefName: 'cez/task', baseRefName: 'main', headRefOid: sha, mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN', reviewDecision: '', statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS' }],
  };
  calls = []; onCall = () => {}; failure = undefined; workflowPage = { total_count: 1, workflow_runs: [[1, "completed", true]] };
  execFileMock.mockReset().mockImplementation((_file, args: string[], opts, reply) => {
    calls.push(args);
    expect(opts.timeout).toBeLessThanOrEqual(15_000);
    onCall(args);
    if (failure && args.includes(failure)) return reply(new Error('GitHub refused'), { stdout: '', stderr: '' });
    let output: unknown;
    if (args[0] === 'pr' && args[1] === 'view') output = pr;
    else if (args[0] === 'pr' && args[1] === 'ready') { pr.isDraft = false; output = {}; }
    else if (args.some(arg => arg.includes('/actions/runs?'))) output = workflowPage;
    else if (args.includes('PUT')) output = { merged: true, sha: 'b'.repeat(40) };
    else if (args[1] === 'repos/org/repo') output = { allow_squash_merge: true };
    else if (args[1]?.includes('/rules/branches/')) output = [[]];
    else if (args[1] === 'repos/org/repo/branches/main') output = { protected: false };
    else throw new Error(`Unexpected gh arguments: ${args.join(' ')}`);
    reply(null, { stdout: JSON.stringify(output), stderr: '' });
  });
});
afterEach(() => vi.unstubAllEnvs());

describe('strict completion merge preflight through gh', () => {
  it.each([
    ['missing', []],
    ['null', null],
    ['pending', [{ name: 'test', status: 'IN_PROGRESS' }]],
    ['unknown', [{ name: 'test', conclusion: 'SURPRISE' }]],
    ['failing', [{ name: 'test', conclusion: 'FAILURE' }]],
    ['mixed', [{ name: 'test', conclusion: 'SUCCESS' }, { name: 'optional', conclusion: 'SURPRISE' }]],
  ])('refuses %s current-head checks even with an override', async (_label, checks) => {
    pr.statusCheckRollup = checks;
    expect(await driver.mergePR!(42, { ...input, overrideRules: true })).toMatchObject({ merged: false, code: 'checks-not-passing' });
    expect(mutations()).toEqual([]);
  });

  it.each([
    { total_count: 1, workflow_runs: [[1, 'in_progress', true]] },
    { total_count: 2, workflow_runs: [[1, 'completed', true]] },
    { total_count: 1, workflow_runs: [[1, 'completed', null]] },
  ])('blocks hidden reruns or incomplete workflow data %j', async page => {
    workflowPage = page;
    expect(await driver.mergePR!(42, input)).toMatchObject({ merged: false });
    expect(mutations()).toEqual([]);
  });
  it('blocks a workflow query error and cancellation during its read', async () => {
    failure = '--paginate';
    expect(await driver.mergePR!(42, input)).toMatchObject({ merged: false });
    failure = undefined;
    let proceed = true;
    onCall = args => { if (args.some(arg => arg.includes('/actions/runs?'))) proceed = false; };
    expect(await driver.mergePR!(42, { ...input, canProceed: () => proceed })).toMatchObject({ merged: false, code: 'cancelled' });
    expect(mutations()).toEqual([]);
  });

  it('uses every normalized passing check and GitHub’s expected SHA mutation', async () => {
    pr.statusCheckRollup = ['SUCCESS', 'NEUTRAL', 'SKIPPED'].map(conclusion => ({ name: conclusion, conclusion }));
    expect(await driver.mergePR!(42, input)).toMatchObject({ merged: true, number: 42 });
    expect(mutations()).toEqual([['api', '--method', 'PUT', 'repos/org/repo/pulls/42/merge', '-f', 'merge_method=squash', '-f', `sha=${sha}`]]);
  });

  it.each([
    [{ headRefOid: 'c'.repeat(40) }, 'stale-head'],
    [{ headRefName: 'other' }, 'stale-branch'],
    [{ statusCheckRollup: [] }, 'checks-not-passing'],
  ])('refreshes cached state before mutation: %j', async (patch, code) => {
    expect((await driver.prMergeState!(42)).available).toBe(true);
    Object.assign(pr, patch);
    expect(await driver.mergePR!(42, input)).toMatchObject({ merged: false, code });
    expect(mutations()).toEqual([]);
  });

  it('never uses a review override for completion merging', async () => {
    pr.reviewDecision = 'REVIEW_REQUIRED';
    expect(await driver.mergePR!(42, { ...input, overrideRules: true })).toMatchObject({ merged: false, code: 'blocked' });
    expect(mutations()).toEqual([]);
  });

  it.each([{ checks: [] }, { checks: [{ name: 'optional', conclusion: 'SURPRISE' }] }])('preserves manual merge semantics with checks $checks', async ({ checks }) => {
    pr.statusCheckRollup = checks;
    expect(await driver.mergePR!(42, { method: 'squash', expectedHeadSha: sha })).toMatchObject({ merged: true });
  });

  it('preserves an explicit manual rules override', async () => {
    pr.reviewDecision = 'REVIEW_REQUIRED';
    expect(await driver.mergePR!(42, { method: 'squash', expectedHeadSha: sha, overrideRules: true })).toMatchObject({ merged: true });
  });

  it('cancels when intent changes while fresh policy is fetching', async () => {
    let proceed = true;
    onCall = args => { if (args[1]?.includes('/rules/branches/')) proceed = false; };
    expect(await driver.mergePR!(42, { ...input, canProceed: () => proceed })).toMatchObject({ merged: false, code: 'cancelled' });
    expect(mutations()).toEqual([]);
  });

  it('reports a completed GitHub merge when intent changes during mutation', async () => {
    let proceed = true;
    onCall = args => { if (args.includes('PUT')) proceed = false; };
    expect(await driver.mergePR!(42, { ...input, canProceed: () => proceed })).toMatchObject({ merged: true });
    expect(proceed).toBe(false);
    expect(mutations()).toHaveLength(1);
  });
});

describe('ready-for-review through gh', () => {
  it('promotes the validated task draft with bounded fixed arguments then refreshes', async () => {
    pr.isDraft = true;
    expect(await driver.readyPR!(42, readyInput)).toMatchObject({ available: true, mergeState: { isDraft: false, headSha: sha } });
    expect(mutations()).toEqual([['pr', 'ready', '42', '--repo', 'github.com/org/repo']]);
    expect(calls[0]).toEqual(['pr', 'view', '42', '--json', 'number,url,state,isDraft,headRefName,headRefOid']);
    expect(calls.filter(args => args[0] === 'pr' && args[1] === 'view')).toHaveLength(2);
  });

  it.each([
    { headRefOid: 'c'.repeat(40) }, { headRefName: 'other' }, { state: 'CLOSED' }, { state: 'MERGED' },
    { url: 'https://github.com/foreign/repo/pull/42' }, { number: 43 },
  ])('refuses stale or foreign draft identity %j', async patch => {
    pr.isDraft = true;
    await driver.prMergeState!(42);
    Object.assign(pr, patch);
    expect(await driver.readyPR!(42, readyInput)).toMatchObject({ available: false });
    expect(mutations()).toEqual([]);
  });

  it('does not mutate an already ready PR', async () => {
    expect(await driver.readyPR!(42, readyInput)).toMatchObject({ available: true });
    expect(mutations()).toEqual([]);
  });

  it('fails closed when marking ready fails', async () => {
    pr.isDraft = true; failure = 'ready';
    expect(await driver.readyPR!(42, readyInput)).toMatchObject({ available: false });
    expect(calls.filter(args => args[1] === 'view')).toHaveLength(1);
  });

  it('detects a head change during ready before returning usable state', async () => {
    pr.isDraft = true;
    onCall = args => { if (args[1] === 'ready') pr.headRefOid = 'c'.repeat(40); };
    expect(await driver.readyPR!(42, readyInput)).toEqual({ available: false, reason: 'The pull request head changed.' });
  });

  it('cancels when intent changes during the ready preflight', async () => {
    pr.isDraft = true;
    let proceed = true;
    onCall = args => { if (args[1] === 'view') proceed = false; };
    expect(await driver.readyPR!(42, { ...readyInput, canProceed: () => proceed })).toMatchObject({ available: false, reason: expect.stringContaining('cancelled') });
    expect(mutations()).toEqual([]);
  });

  it('stops after ready when intent changes during that mutation', async () => {
    pr.isDraft = true;
    let proceed = true;
    onCall = args => { if (args[1] === 'ready') proceed = false; };
    expect(await driver.readyPR!(42, { ...readyInput, canProceed: () => proceed })).toMatchObject({ available: false, reason: expect.stringContaining('cancelled') });
    expect(calls.filter(args => args[1] === 'view')).toHaveLength(1);
    expect(mutations()).toHaveLength(1);
  });

  it('performs no command after cancellation or invalid input', async () => {
    expect((await driver.readyPR!(42, { ...readyInput, canProceed: () => false })).available).toBe(false);
    expect((await driver.readyPR!(-1, readyInput)).available).toBe(false);
    expect((await driver.mergePR!(42, { ...input, canProceed: () => false })).merged).toBe(false);
    expect(calls).toEqual([]);
  });

  it('supports dry-run ready and strict merging without gh', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    const dry = createGithubDriver('/dry', null);
    const expected = { expectedHeadSha: '0123456789abcdef0123456789abcdef01234567', expectedHeadRef: 'feat/dry-run' };
    expect((await dry.readyPR!(42, expected)).available).toBe(true);
    expect((await dry.mergePR!(42, { ...input, ...expected })).merged).toBe(true);
    expect(calls).toEqual([]);
  });
});
