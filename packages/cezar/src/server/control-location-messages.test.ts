import { describe, expect, it } from 'vitest';
import { taskHelp } from '../task-cli/cli.ts';
import { unavailableProviderMessage } from './provider-action-gate.ts';
import { NO_WEBHOOK_ERROR } from './start-run-options.ts';

// Full literals from 8dfacd3d0: changing the source of a location must not change messages.
describe('control direction message bytes', () => {
  it('preserves the webhook refusal and CLI help line', () => {
    expect(NO_WEBHOOK_ERROR).toBe('this project has no task webhook — add a webhook with Task notifications on in Settings → General → Webhooks, or start without notify');
    expect(taskHelp().split('\n')).toContain('notify: start notifies the task webhook set in Settings → General only with --notify;');
  });

  it('preserves both provider refusals', () => {
    expect(unavailableProviderMessage(['codex'], {
      providers: [{ provider: 'codex', status: 'connected', enabled: false }],
    })).toBe('Codex is disabled. Enable it in Settings → Agents → Providers.');
    expect(unavailableProviderMessage(['codex'], {
      providers: [{ provider: 'codex', status: 'disconnected', enabled: true }],
    })).toBe('Codex credentials are unavailable. Authorize it in Settings → Agents → Providers.');
  });
});
