import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceProject } from '../workspace/config.ts';
import { agentProfileRefusal, notifyRefusal, NO_WEBHOOK_ERROR } from './start-run-options.ts';

/**
 * The helpers behind `POST /runs` that answer without a route (hearsay-tools/cezarion#1635):
 * the lookups they skip, and a registry that cannot be read. The route's own answers are pinned
 * in `start-run-refusals.test.ts`.
 */
describe('notifyRefusal', () => {
  const withWebhook: WorkspaceProject = {
    id: 'p1',
    root: '/tmp/p1',
    name: 'p1',
    addedAt: '',
    lastOpenedAt: '',
    source: 'local',
    webhook: { url: 'https://bot.example/hook' },
  };

  it.each([[undefined], [false]])('reads no registry entry when notify is %s', async (notify) => {
    const lookup = vi.fn(async () => undefined);
    expect(await notifyRefusal(notify, 'p1', lookup)).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('refuses notify:true when the registry has no entry for the project', async () => {
    expect(await notifyRefusal(true, 'p1', async () => undefined)).toEqual({ error: NO_WEBHOOK_ERROR, status: 400 });
  });

  it('refuses notify:true when the registry cannot be read', async () => {
    const lookup = vi.fn(async () => { throw new Error('registry unreadable'); });
    expect(await notifyRefusal(true, 'p1', lookup)).toEqual({ error: NO_WEBHOOK_ERROR, status: 400 });
    expect(lookup).toHaveBeenCalledWith('p1');
  });

  it('lets notify:true through when the project has a task webhook', async () => {
    expect(await notifyRefusal(true, 'p1', async () => withWebhook)).toBeUndefined();
  });
});

describe('agentProfileRefusal', () => {
  it('resolves no account when the body names none', async () => {
    const resolve = vi.fn(async () => ({ error: 'unreachable' }));
    expect(await agentProfileRefusal(resolve, 'claude', undefined)).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('asks the picked runner for the named account and refuses a dangling id', async () => {
    const resolve = vi.fn(async (provider: string, id?: string) => ({ error: `unknown ${provider} account: ${id}` }));
    expect(await agentProfileRefusal(resolve, 'codex', 'gone')).toEqual({
      error: 'unknown codex account: gone',
      status: 400,
    });
    expect(resolve).toHaveBeenCalledWith('codex', 'gone');
  });

  it('lets a resolved account through', async () => {
    expect(await agentProfileRefusal(async () => ({ profile: {} }), 'claude', 'work')).toBeUndefined();
  });
});
