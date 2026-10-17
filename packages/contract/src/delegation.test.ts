import { describe, expect, it } from 'vitest';
import { workerContextSchema } from './delegation.ts';

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
