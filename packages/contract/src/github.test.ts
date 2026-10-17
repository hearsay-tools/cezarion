import { describe, expect, it } from 'vitest';
import {
  GITHUB_COMMENT_COUNTS_MAX,
  GITHUB_CURSOR_MAX,
  githubCommentCountsDataSchema,
  githubCommentCountsQuerySchema,
  githubCommentsDataSchema,
  githubDataSchema,
  githubListQuerySchema,
} from './github.ts';

/** The paged list (hearsay-tools/cezarion#1183): cursors per side, exact totals, and the list
 *  `body` moving to the detail tier behind a deprecation. */
describe('githubDataSchema paging', () => {
  it('parses a list page without body and with totals and cursors', () => {
    const page = githubDataSchema.parse({
      available: true,
      issues: [{ kind: 'issue', number: 1, title: 't', author: 'a', createdAt: '2026-10-16T00:00:00Z', labels: [], url: 'u', comments: 0 }],
      prs: [],
      issuesTotal: 88,
      prsTotal: 12,
      issuesNextCursor: 'c1',
      prsNextCursor: null,
      commentsDeferred: true,
    });
    expect(page.issues[0]?.body).toBeUndefined();
    expect(page.issuesNextCursor).toBe('c1');
    expect(page.prsNextCursor).toBeNull();
  });
});

describe('githubListQuerySchema', () => {
  it('refuses contradictory list cursor state', () => {
    expect(githubListQuerySchema.safeParse({ issuesDone: '1', issuesCursor: 'x' }).success).toBe(false);
    expect(githubListQuerySchema.safeParse({ prsDone: '1', prsCursor: 'x' }).success).toBe(false);
    expect(githubListQuerySchema.safeParse({ issuesDone: '1', prsDone: '1' }).success).toBe(false);
    expect(githubListQuerySchema.safeParse({ issuesCursor: 'x'.repeat(GITHUB_CURSOR_MAX + 1) }).success).toBe(false);
    expect(githubListQuerySchema.safeParse({ issuesCursor: '' }).success).toBe(false);
    expect(githubListQuerySchema.safeParse({ issuesDone: '0' }).success).toBe(false);
  });

  it('accepts one exhausted side while the other pages', () => {
    expect(githubListQuerySchema.safeParse({ prsDone: '1', issuesCursor: 'c' }).success).toBe(true);
    expect(githubListQuerySchema.safeParse({ limit: 'banana' }).success).toBe(true);
    expect(githubListQuerySchema.safeParse({}).success).toBe(true);
  });
});

describe('githubCommentCountsQuerySchema', () => {
  it('bounds comment-count numbers', () => {
    const ok = (numbers: string) => githubCommentCountsQuerySchema.safeParse({ kind: 'issue', numbers }).success;
    expect(ok('1,2,3')).toBe(true);
    expect(ok(Array.from({ length: GITHUB_COMMENT_COUNTS_MAX }, (_, i) => i + 1).join(','))).toBe(true);
    for (const bad of ['', '0', '1,,2', '01', '1,abc', '-1', '1, 2', '99999999999999999']) expect(ok(bad)).toBe(false);
    expect(ok(Array.from({ length: GITHUB_COMMENT_COUNTS_MAX + 1 }, (_, i) => i + 1).join(','))).toBe(false);
    expect(githubCommentCountsQuerySchema.safeParse({ numbers: '1' }).success).toBe(false);
    expect(githubCommentCountsQuerySchema.safeParse({ kind: 'pr', numbers: '1', refresh: '0' }).success).toBe(false);
  });

  it('parses both answers of the counts route', () => {
    expect(githubCommentCountsDataSchema.parse({ available: true, counts: { 142: 3 } })).toEqual({ available: true, counts: { 142: 3 } });
    expect(githubCommentCountsDataSchema.safeParse({ available: false, reason: 'gh missing' }).success).toBe(true);
  });
});

describe('githubCommentsDataSchema detail', () => {
  it('parses comments detail', () => {
    const data = githubCommentsDataSchema.parse({ available: true, comments: [], detail: { body: 'b', additions: 1 } });
    expect(data.detail).toEqual({ body: 'b', additions: 1 });
  });
});
