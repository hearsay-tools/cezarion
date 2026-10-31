import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BranchClass } from '@open-mercato/cezar-contract';
import type { RunRecord } from '../runs/store.ts';
import { classifyBranches, deleteBranches, INCOMPLETE_PR_LOOKUP, type BranchForge, type ClassifyInput } from './repo-branches.ts';
import { addOrigin, commit, fakeForge, git, mergedPr, owners, runRecord, taskBranch } from './repo-branches.testkit.ts';

/**
 * What lets the branch sweep find every ref whose work landed (hearsay-tools/cezarion#2268): the
 * base `origin` read as git reads it, PR evidence that is complete per head or says it is not, and
 * a run's PR branch outside `cez/*`.
 */
describe('branch lifecycle classification (hearsay-tools/cezarion#2268)', () => {
  let root: string;
  let origin: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cez-lifecycle-'));
    origin = mkdtempSync(join(tmpdir(), 'cez-lifecycle-origin-'));
    await git(root, 'init', '-q', '-b', 'main');
    await commit(root, 'base.txt', 'base');
    await addOrigin(root, origin);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  });

  type Extra = Omit<Partial<ClassifyInput>, 'runs'> & { runs?: readonly RunRecord[] };
  const input = ({ runs = [], ...extra }: Extra = {}): ClassifyInput => ({
    root,
    runs: owners(runs),
    isActive: () => false,
    currentBranch: 'main',
    hasRemote: true,
    forge: fakeForge().forge,
    ...extra,
  });
  const classesOf = async (extra: Extra = {}) => {
    const result = await classifyBranches(input(extra));
    const cls = Object.fromEntries(result.payload.branches.map((b) => [b.name, b.class])) as Record<string, BranchClass>;
    return { ...result, cls };
  };

  /** One task branch merged into main by ancestry, one squash-merged as fixture PR 7; both pushed. */
  async function landedOnOrigin() {
    await taskBranch(root, 'cez/aaaaaaaa', 1);
    await git(root, 'merge', '-q', '--no-ff', '-m', 'Merge cez/aaaaaaaa', 'cez/aaaaaaaa');
    const squashTip = await taskBranch(root, 'cez/bbbbbbbb', 1);
    const squash = await commit(root, 'squash.txt', 'Squash cez/bbbbbbbb (#7)');
    await git(root, 'push', '-q', 'origin', 'main');
    const runs = [runRecord('aaaaaaaa-1', 'done'), runRecord('bbbbbbbb-1', 'done')];
    return { runs, forge: fakeForge({ prs: [mergedPr(7, 'cez/bbbbbbbb', squashTip, squash)] }).forge };
  }

  describe('the base `origin`', () => {
    it('resolves to the branch origin/HEAD names, with the same commit and PR base as `main`', async () => {
      const { runs, forge } = await landedOnOrigin();
      const viaOrigin = await classesOf({ configuredBase: 'origin', runs, forge });
      const viaMain = await classesOf({ configuredBase: 'main', runs, forge });
      expect(viaOrigin.baseSha).toBe(await git(root, 'rev-parse', 'refs/remotes/origin/main'));
      expect(viaOrigin.baseFullRef).toBe('refs/remotes/origin/main');
      expect(viaOrigin.payload.base).toBe('origin/main');
      expect(viaMain.baseSha).toBe(viaOrigin.baseSha);
      for (const { cls } of [viaOrigin, viaMain]) {
        expect(cls['cez/aaaaaaaa']).toBe('merged');
        // The PR targets `main`: only the alias's TARGET is the PR base, never the name `origin`.
        expect(cls['cez/bbbbbbbb']).toBe('merged');
      }
      expect((await classesOf({ configuredBase: 'origin/HEAD', runs, forge })).baseFullRef).toBe('refs/remotes/origin/main');
    });

    it('resolves to nothing when a tag or a ref git would read first shares its name', async () => {
      const { runs, forge } = await landedOnOrigin();
      await git(root, 'tag', 'origin', 'main');
      const tagged = await classesOf({ configuredBase: 'origin', runs, forge });
      expect(tagged.baseSha).toBeNull();
      expect(tagged.cls['cez/aaaaaaaa']).toBe('not-landed');
      expect(tagged.cls['cez/bbbbbbbb']).toBe('not-landed');
      await git(root, 'tag', '-d', 'origin');
      await git(root, 'update-ref', 'refs/origin', 'main');
      expect((await classesOf({ configuredBase: 'origin', runs, forge })).baseSha).toBeNull();
    });

    it('resolves to nothing without origin/HEAD, or when it ends outside origin\'s branches', async () => {
      const { runs, forge } = await landedOnOrigin();
      await git(root, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
      expect((await classesOf({ configuredBase: 'origin', runs, forge })).baseSha).toBeNull();
      // A chain of aliases ends where git's own reading of `origin` ends: its last, concrete ref.
      await git(root, 'symbolic-ref', 'refs/remotes/origin/alias', 'refs/remotes/origin/main');
      await git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/alias');
      expect((await classesOf({ configuredBase: 'origin', runs, forge })).baseFullRef).toBe('refs/remotes/origin/main');
      // A local branch — one this sweep may be about to delete — is never the base through an alias.
      await git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/heads/cez/aaaaaaaa');
      expect((await classesOf({ configuredBase: 'origin', runs, forge })).baseSha).toBeNull();
    });

    it('deletes against the concrete ref, and refuses when it moved after the classification', async () => {
      await landedOnOrigin();
      const merged = await git(root, 'rev-parse', 'cez/aaaaaaaa');
      const before = await git(root, 'rev-parse', 'main~2');
      // A not-landed row with no recorded PR makes the classification ask the forge, after it read
      // the base: the moment to move origin/main back under it.
      await taskBranch(root, 'cez/cccccccc', 1);
      const runs = [runRecord('aaaaaaaa-1', 'done'), runRecord('cccccccc-1', 'done')];
      const moving: BranchForge = {
        prStates: async () => ({ available: true, states: {} }),
        async prsForHeads() {
          await git(root, 'update-ref', 'refs/remotes/origin/main', before);
          return { available: true, prs: [], incomplete: new Set<string>() };
        },
      };
      const refused = await deleteBranches(input({ configuredBase: 'origin', runs, forge: moving }), ['cez/aaaaaaaa']);
      expect(refused.deleted).toEqual([]);
      expect(await git(root, 'rev-parse', 'cez/aaaaaaaa')).toBe(merged);

      await git(root, 'push', '-q', 'origin', 'main');
      await git(root, 'fetch', '-q', 'origin');
      const done = await deleteBranches(input({ configuredBase: 'origin', runs }), ['cez/aaaaaaaa']);
      expect(done.deleted).toEqual(['cez/aaaaaaaa']);
    });
  });

  describe('PR evidence', () => {
    it('keeps a branch whose PR history came back incomplete, and says why', async () => {
      const tip = await taskBranch(root, 'cez/aaaaaaaa', 1);
      const otherTip = await taskBranch(root, 'cez/bbbbbbbb', 1);
      const squash = await commit(root, 'squash.txt', 'Squash both');
      const { forge } = fakeForge({ prs: [mergedPr(1, 'cez/aaaaaaaa', tip, squash), mergedPr(2, 'cez/bbbbbbbb', otherTip, squash)], incomplete: ['cez/aaaaaaaa'] });
      const { payload, cls } = await classesOf({ runs: [runRecord('aaaaaaaa-1', 'done'), runRecord('bbbbbbbb-1', 'done')], forge });
      expect(cls['cez/aaaaaaaa']).toBe('not-landed');
      expect(cls['cez/bbbbbbbb']).toBe('merged');
      const byName = new Map(payload.branches.map((b) => [b.name, b]));
      expect(byName.get('cez/aaaaaaaa')?.keptReason).toBe(INCOMPLETE_PR_LOOKUP);
      expect(byName.get('cez/bbbbbbbb')).not.toHaveProperty('keptReason');
    });
  });

  describe('a run\'s PR branch outside cez/*', () => {
    const PR = 'https://github.com/acme/demo/pull/9';

    /** `fix/y` squash-merged as fixture PR 9; the run's own starter `cez/aaaaaaaa` never moved. */
    async function namedPr() {
      await git(root, 'branch', 'cez/aaaaaaaa');
      const tip = await taskBranch(root, 'fix/y', 1);
      const squash = await commit(root, 'squash.txt', 'fix: y (#9)');
      return { tip, squash };
    }

    it('is merged, owned by the run that recorded the PR, and deleted with its starter under that run\'s claim', async () => {
      const { tip, squash } = await namedPr();
      const { forge, calls } = fakeForge({ states: { 9: 'merged' }, prs: [mergedPr(9, 'fix/y', tip, squash)] });
      const runs = [runRecord('aaaaaaaa-1', 'done', { pullRequestUrl: PR })];
      const { payload, cls } = await classesOf({ runs, forge });
      expect(cls['fix/y']).toBe('merged');
      expect(cls['cez/aaaaaaaa']).toBe('empty');
      expect(payload.branches.find((b) => b.name === 'fix/y')).toMatchObject({ runId: 'aaaaaaaa-1', pr: { number: 9, state: 'merged' } });
      expect(calls.heads).toContain('fix/y');

      const claimed: string[][] = [];
      const result = await deleteBranches(input({ runs, forge, claimRuns: (ids) => { claimed.push([...ids]); return () => undefined; } }), ['fix/y', 'cez/aaaaaaaa']);
      expect(result.deleted.sort()).toEqual(['cez/aaaaaaaa', 'fix/y']);
      // One claim for both refs: a second claim of a run this request holds would refuse.
      expect(claimed).toEqual([['aaaaaaaa-1']]);
    });

    it('stays the user\'s branch unless every part of the evidence holds', async () => {
      const { tip, squash } = await namedPr();
      const cases: Array<{ label: string; runs: RunRecord[]; pr: ReturnType<typeof mergedPr> }> = [
        { label: 'no run recorded the PR', runs: [runRecord('aaaaaaaa-1', 'done', { pullRequestUrl: 'https://github.com/acme/demo/pull/10' })], pr: mergedPr(9, 'fix/y', tip, squash) },
        { label: 'the run is live', runs: [runRecord('aaaaaaaa-1', 'running', { pullRequestUrl: PR })], pr: mergedPr(9, 'fix/y', tip, squash) },
        { label: 'another base', runs: [runRecord('aaaaaaaa-1', 'done', { pullRequestUrl: PR })], pr: mergedPr(9, 'fix/y', tip, squash, 'develop') },
        { label: 'another tip', runs: [runRecord('aaaaaaaa-1', 'done', { pullRequestUrl: PR })], pr: mergedPr(9, 'fix/y', squash, squash) },
        { label: 'still open', runs: [runRecord('aaaaaaaa-1', 'done', { pullRequestUrl: PR })], pr: { ...mergedPr(9, 'fix/y', tip, squash), state: 'open', mergeCommitOid: null } },
      ];
      for (const { label, runs, pr } of cases) {
        const { cls } = await classesOf({ runs, forge: fakeForge({ prs: [pr] }).forge });
        expect(cls['fix/y'], label).toBe('other');
      }
      const result = await deleteBranches(input({ runs: cases[0]!.runs, forge: fakeForge({ prs: [cases[0]!.pr] }).forge }), ['fix/y']);
      expect(result.refused).toEqual([{ name: 'fix/y', reason: 'not a cezar task branch' }]);
    });

    it('matches a recorded PR URL despite whitespace, case and multiple trailing slashes', async () => {
      const { tip, squash } = await namedPr();
      const runs = [runRecord('aaaaaaaa-1', 'done', { pullRequestUrl: `  ${PR.toUpperCase()}///  ` })];
      const forge = fakeForge({ prs: [mergedPr(9, 'fix/y', tip, squash)] }).forge;
      const { payload } = await classesOf({ runs, forge });
      expect(payload.branches.find((row) => row.name === 'fix/y')).toMatchObject({
        class: 'merged', runId: 'aaaaaaaa-1', pr: { number: 9, url: PR, state: 'merged' },
      });
    });

    it('is not asked about when no run recorded a PR', async () => {
      await namedPr();
      const { forge, calls } = fakeForge();
      await classesOf({ runs: [runRecord('aaaaaaaa-1', 'done')], forge });
      expect(calls.heads).not.toContain('fix/y');
    });
  });
});
