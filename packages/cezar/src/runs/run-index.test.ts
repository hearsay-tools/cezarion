import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRunIndexFromDisk } from './run-index.ts';

const handle = { owner: 'local', name: 'repo' };
const foreignPr = 'https://github.com/foreign/repo/pull/42';
const foreignIssue = 'https://github.com/foreign/repo/issues/43';
const localPr = 'https://github.com/local/repo/pull/44';
const record = (over: Record<string, unknown> = {}) => ({
  id: 'cold', title: 'Research', workflow: 'build', task: 'research', status: 'done',
  createdAt: '2026-09-01T00:00:00Z', tokensUsed: 0, archived: false, steps: [],
  referencedPullRequestUrl: foreignPr, referencedIssueUrl: foreignIssue,
  referencedPrCandidates: [foreignPr], referencedIssueCandidates: [foreignIssue],
  issueNumber: 43, referencedIssueNumberSeeded: true,
  ...over,
});

describe('repository scoping of cold disk records', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cez-cold-refs-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const seed = (over: Record<string, unknown> = {}) => {
    const bytes = JSON.stringify([record(over)]);
    writeFileSync(join(dir, 'runs.json'), bytes);
    return bytes;
  };

  it('removes foreign conclusions and seeded numbers, preserving all evidence and disk bytes', () => {
    const bytes = seed();
    const [run] = readRunIndexFromDisk(dir, handle);
    expect(run?.referencedPullRequestUrl).toBeUndefined();
    expect(run?.referencedIssueUrl).toBeUndefined();
    expect(run?.issueNumber).toBeUndefined();
    expect(run?.referencedIssueNumberSeeded).toBeUndefined();
    expect(run?.referencedPrCandidates).toEqual([foreignPr]);
    expect(run?.referencedIssueCandidates).toEqual([foreignIssue]);
    expect(readFileSync(join(dir, 'runs.json'), 'utf8')).toBe(bytes);
    // Scoping one read cannot mutate a subsequent unknown-identity read.
    expect(readRunIndexFromDisk(dir)[0]?.referencedPullRequestUrl).toBe(foreignPr);
  });

  it.each([undefined, null])('keeps previous behavior for unknown identity %s', (identity) => {
    seed();
    expect(readRunIndexFromDisk(dir, identity)[0]).toMatchObject({
      referencedPullRequestUrl: foreignPr, referencedIssueUrl: foreignIssue, issueNumber: 43,
    });
  });

  it.each(['port FOREIGN/Repo', `review ${foreignPr}`])('keeps prompt evidence: %s', (task) => {
    seed({ task });
    expect(readRunIndexFromDisk(dir, handle)[0]).toMatchObject({
      referencedPullRequestUrl: foreignPr, referencedIssueUrl: foreignIssue, issueNumber: 43,
    });
  });

  it('does not mistake a repository prefix in the prompt for corroboration', () => {
    seed({ task: 'port foreign/repository' });
    expect(readRunIndexFromDisk(dir, handle)[0]?.referencedPullRequestUrl).toBeUndefined();
  });

  it('preserves declared numbers, independently owned issue numbers and created PR ownership', () => {
    seed({
      markerRefs: { pr: 42, issue: 43 }, prNumber: 42,
      issueNumber: 43, referencedIssueNumberSeeded: undefined,
      pullRequestUrl: 'https://github.com/foreign/repo/pull/99',
    });
    const [run] = readRunIndexFromDisk(dir, handle);
    expect(run).toMatchObject({
      markerRefs: { pr: 42, issue: 43 }, prNumber: 42, issueNumber: 43,
      pullRequestUrl: 'https://github.com/foreign/repo/pull/99',
      referencedPrCandidates: [foreignPr], referencedIssueCandidates: [foreignIssue],
    });
    expect(run?.referencedPullRequestUrl).toBeUndefined();
    expect(run?.referencedIssueUrl).toBeUndefined();
  });

  it('keeps local references and does not promote an ambiguous candidate by removing foreign evidence', () => {
    seed({ referencedPullRequestUrl: localPr });
    expect(readRunIndexFromDisk(dir, handle)[0]?.referencedPullRequestUrl).toBe(localPr);
    seed({ referencedPullRequestUrl: undefined, referencedPrCandidates: [foreignPr, localPr] });
    const [run] = readRunIndexFromDisk(dir, handle);
    expect(run?.referencedPullRequestUrl).toBeUndefined();
    expect(run?.referencedPrCandidates).toEqual([foreignPr, localPr]);
  });

  it('scopes references restored by loaded-record reconciliation', () => {
    seed({
      referencedPullRequestUrl: undefined, markerRefs: { pr: 99 },
      pullRequestUrl: 'https://github.com/local/repo/pull/99',
    });
    expect(readRunIndexFromDisk(dir)[0]?.referencedPullRequestUrl).toBe(foreignPr);
    expect(readRunIndexFromDisk(dir, handle)[0]?.referencedPullRequestUrl).toBeUndefined();
  });
});
