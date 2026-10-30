import { WAIT_PHASE } from './test-factories.testkit.ts';
import { describe, expect, it } from 'vitest';
import { parentFileRefusal, peerWaitViewSchema, workerContextSchema, workerSpawnRequestSchema, workerSteerRequestSchema } from './delegation.ts';

describe('parent-file context reference', () => {
  const context = (...paths: string[]) => ({ artifacts: paths.map(path => ({ kind: 'parent-file' as const, path })) });

  it('accepts a worktree-relative path', () => {
    expect(workerContextSchema.parse(context('.ai/qa/1149/brief.md'))).toEqual(context('.ai/qa/1149/brief.md'));
  });

  it.each(['/abs', '../x', 'a/./b', 'a//b', '.git/config', 'sub/.GIT/x', ''])('refuses %j', path => {
    expect(workerContextSchema.safeParse(context(path)).success).toBe(false);
  });

  it('refuses a duplicated path, naming it', () => {
    const parsed = workerContextSchema.safeParse(context('a.md', 'b.md', 'a.md'));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map(issue => issue.message)).toContainEqual(expect.stringContaining('duplicate --attach path: a.md'));
  });

  it.each(['.gitignore', 'qa/.gitignore', 'qa/data/.GitIgnore'])('refuses an attached .gitignore %j, naming it', path => {
    const parsed = workerContextSchema.safeParse(context(path));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map(issue => issue.message)).toContainEqual(`--attach cannot attach a .gitignore: ${path}; ignore rules must come from the baseline`);
  });

  it.each(['qa/.gitignore.bak', 'qa/gitignore', '.gitignore-notes/x.md'])('accepts a near-miss name %j', path => {
    expect(workerContextSchema.safeParse(context(path)).success).toBe(true);
  });

  it('leaves baseline-file references as they were', () => {
    expect(workerContextSchema.safeParse({ artifacts: [{ kind: 'baseline-file', path: 'src/x.ts' }] }).success).toBe(true);
  });
});


describe('delegation refusal details', () => {
  it.each(['.gitignore', 'qa/.GITIGNORE', 'nested/path/.gitignore'])('names the refused parent file %s', path => {
    expect(parentFileRefusal(path)).toBe(`--attach cannot attach a .gitignore: ${path}; ignore rules must come from the baseline`);
  });

  it.each(['', 'README.md', '.gitignore/file.md', 'qa/.gitignore.bak'])('permits the parent file %j', path => {
    expect(parentFileRefusal(path)).toBeUndefined();
  });

  it.each(['a\\b', 'a:b', 'a\u0000b', 'a\u001fb', 'a\u007fb'])('refuses unsafe input path %j', path => {
    expect(workerContextSchema.safeParse({ artifacts: [{ kind: 'parent-file', path }] }).success).toBe(false);
  });

  it.each(['resolved', 'delivered'])('names the missing result on a %s peer wait', phase => {
    const result = peerWaitViewSchema.safeParse({ id: '11111111-1111-4111-8111-111111111111',
      peerIds: ['22222222-2222-4222-8222-222222222222'], deadline: '2026-10-30T12:00:00Z', phase });
    expect(result.error?.issues).toEqual([{ code: 'custom', message: `a ${phase} peer wait has a result`, path: ['result'] }]);
  });

  it('refuses an open peer result but permits a cancelled result', () => {
    const wait = { id: '11111111-1111-4111-8111-111111111111', peerIds: ['22222222-2222-4222-8222-222222222222'],
      deadline: '2026-10-30T12:00:00Z', result: { reason: 'timeout' } };
    expect(peerWaitViewSchema.safeParse({ ...wait, phase: WAIT_PHASE.open }).error?.issues)
      .toEqual([{ code: 'custom', message: 'an open peer wait has no result', path: ['result'] }]);
    expect(peerWaitViewSchema.safeParse({ ...wait, phase: WAIT_PHASE.cancelled }).success).toBe(true);
  });

  it('bounds the combined spawn text and distinguishes skill from workflow', () => {
    const request = { task: 't', baseline: 'main', requestId: '11111111-1111-4111-8111-111111111111' };
    expect(workerSpawnRequestSchema.safeParse({ ...request, context: { text: 'c'.repeat(99999) } }).success).toBe(true);
    expect(workerSpawnRequestSchema.safeParse({ ...request, context: { text: 'c'.repeat(100000) } }).success).toBe(false);
    expect(workerSpawnRequestSchema.safeParse({ ...request, skill: 'review', workflow: 'quick-task' }).success).toBe(false);
    expect(workerSpawnRequestSchema.safeParse({ ...request, skill: 'review' }).success).toBe(true);
    expect(workerSpawnRequestSchema.safeParse({ ...request, workflow: 'quick-task' }).success).toBe(true);
    expect(workerSteerRequestSchema.safeParse({ text: ' \n\t' }).success).toBe(false);
  });
});
