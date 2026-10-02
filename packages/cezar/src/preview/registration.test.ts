import { describe, expect, it } from 'vitest';
import type { PreviewServer } from '@open-mercato/cezar-contract';
import { previewHint, previewResult, validateRegistration } from './registration.ts';

const worktreePath = '/repo/.ai/cezar/worktrees/run-1';
const request = { command: 'npm run dev -- --port 5173 --strictPort', port: 5173 };
const base = { request, worktreePath, cezarPort: 4321, existing: [] as PreviewServer[], runId: 'run-1', enabled: true, headless: false };
const server = (port: number): PreviewServer => ({ port, command: 'npm run dev', label: 'npm', registeredAt: new Date().toISOString(), answeredAtRegistration: false });

describe('validateRegistration (#781)', () => {
  it('registers a new port with the first word of the command as its label', () => {
    const result = validateRegistration(base);
    expect(result.code).toBe('registered');
    expect(result.server).toMatchObject({ port: 5173, command: request.command, label: 'npm', answeredAtRegistration: false });
    expect(result.server).not.toHaveProperty('cwd');
  });

  it('keeps an explicit label, a cwd inside the worktree and the initial path', () => {
    const result = validateRegistration({ ...base, request: { ...request, cwd: 'apps/../apps/web', label: 'vite', path: '/members' } });
    expect(result.code).toBe('registered');
    expect(result.server).toMatchObject({ cwd: 'apps/web', label: 'vite', path: '/members' });
  });

  it.each(['../x', '/etc', 'apps/../../x'])('refuses cwd %s as cwd_outside_worktree', cwd => {
    expect(validateRegistration({ ...base, request: { ...request, cwd } })).toEqual({ code: 'cwd_outside_worktree' });
  });

  it("refuses cezar's own port as cezar_port", () => {
    expect(validateRegistration({ ...base, request: { ...request, port: 4321 } })).toEqual({ code: 'cezar_port' });
  });

  it("refuses a port another task's server holds as port_held, naming the task by title only", () => {
    const owner = { runId: 'run-2', title: 'Member management' };
    expect(validateRegistration({ ...base, owner })).toEqual({ code: 'port_held' });
    const hint = previewHint('port_held', { ...request, ownerTitle: owner.title });
    expect(hint).toContain("Do not stop the other task's server");
    expect(hint).toContain('Member management');
    expect(hint).not.toContain('/repo');
    expect(hint).not.toContain('run-2');
  });

  it('treats a port this run already owns as its own, not port_held', () => {
    const result = validateRegistration({ ...base, existing: [server(5173)], owner: { runId: 'run-1', title: 'This task' } });
    expect(result.code).toBe('replaced');
  });

  it('refuses a ninth port as too_many', () => {
    const existing = [3000, 3001, 3002, 3003, 3004, 3005, 3006, 3007].map(server);
    expect(validateRegistration({ ...base, existing })).toEqual({ code: 'too_many' });
  });

  it('replaces the registration for a port it already has, even at the limit', () => {
    const existing = [5173, 3001, 3002, 3003, 3004, 3005, 3006, 3007].map(server);
    const result = validateRegistration({ ...base, existing });
    expect(result.code).toBe('replaced');
    expect(result.server).toMatchObject({ port: 5173, command: request.command });
  });

  it('answers preview_disabled when the flag is off, telling the agent not to retry', () => {
    expect(validateRegistration({ ...base, enabled: false })).toEqual({ code: 'preview_disabled' });
    expect(previewHint('preview_disabled', request)).toMatch(/^Do not retry/);
  });

  it('answers headless when no cockpit owns the run', () => {
    expect(validateRegistration({ ...base, headless: true })).toEqual({ code: 'headless' });
  });

  it('answers worktree_missing without a worktree', () => {
    expect(validateRegistration({ ...base, worktreePath: undefined })).toEqual({ code: 'worktree_missing' });
  });
});

describe('previewResult (#781)', () => {
  it('carries the command and port into the registered message and hint', () => {
    const result = previewResult('registered', { ...request, label: 'vite' });
    expect(result).toMatchObject({ ok: true, code: 'registered', message: 'Registered `:5173` (vite) for this task.' });
    expect(result.hint).toContain('Cezar runs `npm run dev -- --port 5173 --strictPort` in the worktree');
    expect(result.hint).toContain('Do not wait for the user to open it.');
    expect(previewResult('replaced', request)).toMatchObject({ ok: true, message: 'Replaced the registration for `:5173`.', hint: result.hint });
  });

  it('distinguishes a run without a worktree from one whose worktree was removed', () => {
    expect(previewResult('worktree_missing', { ...request, withoutWorktree: true })).toEqual({
      ok: false,
      code: 'worktree_missing',
      message: 'This task runs without its own worktree, so live preview is not available.',
      hint: 'Do not retry. Report the command and port in your final message.',
    });
    expect(previewResult('worktree_missing', request)).toEqual({
      ok: false,
      code: 'worktree_missing',
      message: 'This task\'s worktree no longer exists.',
      hint: 'Do not retry.',
    });
  });

  it('marks every refusal ok: false', () => {
    for (const code of ['cwd_outside_worktree', 'cezar_port', 'port_held', 'too_many', 'worktree_missing', 'headless'] as const) {
      expect(previewResult(code, { ...request, ownerTitle: 'Other' }).ok).toBe(false);
    }
  });
});
