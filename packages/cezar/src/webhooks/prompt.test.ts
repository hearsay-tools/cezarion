import { describe, expect, it } from 'vitest';
import { agentWebhooksPrompt, webhookCliCommand } from './prompt.ts';

describe('agentWebhooksPrompt (#1576)', () => {
  it('adds nothing when no webhook is exposed, so the default prompt is unchanged', () => {
    expect(agentWebhooksPrompt('cez webhook', [])).toBeUndefined();
  });

  it('lists each webhook with its description on one line, and the send and list commands', () => {
    const text = agentWebhooksPrompt('cez webhook', [
      { id: 'a', name: 'Friction reports', description: 'Tool friction.\n\nInstead of a GitHub issue.' },
      { id: 'b', name: 'Status' },
    ])!;
    expect(text.split('\n')[0]).toBe('## Project webhooks');
    expect(text).toContain('- "Friction reports": Tool friction. Instead of a GitHub issue.\n- "Status"\n');
    expect(text).toContain("cez webhook send '<name>' --message-file <report.md>");
    expect(text).toContain('cez webhook list prints the current list');
  });

  it('names the absolute command, ending in the webhook subcommand', () => {
    expect(webhookCliCommand()).toMatch(/index\.(ts|js)' webhook$/);
  });
});
