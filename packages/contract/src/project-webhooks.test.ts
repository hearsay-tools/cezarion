import { describe, expect, it } from 'vitest';
import {
  createProjectWebhookInputSchema,
  sendAgentReportInputSchema,
  updateProjectWebhookInputSchema,
} from './projects.ts';
import { AGENT_REPORT_MESSAGE_MAX_LENGTH, PROJECT_WEBHOOK_NAME_MAX_LENGTH } from './project-limits.ts';

/** The request shapes of the project webhook routes (hearsay-tools/cezarion#1576). */
describe('project webhook request schemas', () => {
  it('needs a name and an http(s) URL to create, and trims the name', () => {
    expect(createProjectWebhookInputSchema.parse({ name: ' Bot ', url: 'https://bot.example/hook' })).toEqual({ name: 'Bot', url: 'https://bot.example/hook' });
    expect(createProjectWebhookInputSchema.safeParse({ name: ' ', url: 'https://bot.example/hook' }).success).toBe(false);
    expect(createProjectWebhookInputSchema.safeParse({ name: 'x'.repeat(PROJECT_WEBHOOK_NAME_MAX_LENGTH + 1), url: 'https://a.example' }).success).toBe(false);
    expect(createProjectWebhookInputSchema.safeParse({ name: 'Bot', url: 'file:///etc/passwd' }).success).toBe(false);
    expect(createProjectWebhookInputSchema.safeParse({ name: 'Bot', url: 'https://a.example', triggers: ['done', 'done'] }).success).toBe(false);
  });

  it('refuses an edit that names no field, and accepts one that clears the token', () => {
    expect(updateProjectWebhookInputSchema.safeParse({}).success).toBe(false);
    expect(updateProjectWebhookInputSchema.parse({ token: '' })).toEqual({ token: '' });
    expect(updateProjectWebhookInputSchema.parse({ agent: false })).toEqual({ agent: false });
  });

  it('needs a non-empty bounded message and a JSON object as data', () => {
    expect(sendAgentReportInputSchema.parse({ message: ' hi ', data: { a: 1 } })).toEqual({ message: 'hi', data: { a: 1 } });
    expect(sendAgentReportInputSchema.safeParse({ message: '  ' }).success).toBe(false);
    expect(sendAgentReportInputSchema.safeParse({ message: 'x'.repeat(AGENT_REPORT_MESSAGE_MAX_LENGTH + 1) }).success).toBe(false);
    expect(sendAgentReportInputSchema.safeParse({ message: 'm', data: [1] }).success).toBe(false);
  });
});
