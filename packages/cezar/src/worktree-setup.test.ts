import { describe, expect, it } from 'vitest';
import { resolveWorktreeSetup } from './worktree-setup.ts';

/**
 * Worktree setup (#917, spec `.ai/specs/2026-10-07-worktree-setup.md`). The resolver decides
 * what `config.json`'s `worktreeSetup` means: nothing, a setting that is invalid and must be
 * reported, or the commands to run.
 */
describe('resolveWorktreeSetup', () => {
  it('treats an absent key and an empty command list as no setup', () => {
    expect(resolveWorktreeSetup(undefined)).toEqual({ kind: 'none' });
    expect(resolveWorktreeSetup({ commands: [] })).toEqual({ kind: 'none' });
  });

  it('trims commands and defaults the timeout to 900 seconds', () => {
    expect(resolveWorktreeSetup({ commands: [' npm ci '] })).toEqual({
      kind: 'commands',
      commands: ['npm ci'],
      timeoutSeconds: 900,
    });
  });

  it('keeps a configured timeout', () => {
    expect(resolveWorktreeSetup({ commands: ['a'], timeoutSeconds: 60 })).toEqual({
      kind: 'commands',
      commands: ['a'],
      timeoutSeconds: 60,
    });
  });

  it('reports a wrong-typed command list with the path of the problem', () => {
    const plan = resolveWorktreeSetup({ commands: 'npm ci' });
    expect(plan.kind).toBe('invalid');
    expect(plan.kind === 'invalid' && plan.issue).toMatch(/^commands: /);
  });

  it.each([
    ['21 commands', { commands: Array.from({ length: 21 }, (_, i) => `echo ${i}`) }],
    ['a command over 4000 characters', { commands: ['x'.repeat(4001)] }],
    ['a blank command', { commands: ['   '] }],
    ['a zero timeout', { commands: ['a'], timeoutSeconds: 0 }],
    ['a timeout over 7200 seconds', { commands: ['a'], timeoutSeconds: 7201 }],
    ['a fractional timeout', { commands: ['a'], timeoutSeconds: 1.5 }],
    ['an unknown key', { commands: ['a'], command: 'b' }],
    ['a non-object', 'npm ci'],
  ])('reports %s as invalid', (_name, raw) => {
    expect(resolveWorktreeSetup(raw).kind).toBe('invalid');
  });

  it('accepts exactly 20 commands of 4000 characters and a 7200 second timeout', () => {
    const plan = resolveWorktreeSetup({ commands: Array.from({ length: 20 }, () => 'x'.repeat(4000)), timeoutSeconds: 7200 });
    expect(plan.kind).toBe('commands');
  });
});
