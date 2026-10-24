import { fileURLToPath } from 'node:url';
import type { AgentWebhook } from '@open-mercato/cezar-contract';

/**
 * The "Project webhooks" part of an agent's system prompt (hearsay-tools/cezarion#1576): the
 * webhooks the owner exposed to agents in this project, by name and description, and the command
 * that sends a report to one. No exposed webhook: no part, so the zero-config prompt is unchanged.
 */

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** The absolute `cez webhook` command, so an agent needs no `cez` on its PATH. */
export function webhookCliCommand(): string {
  const source = import.meta.url.endsWith('.ts');
  const entry = fileURLToPath(new URL(source ? '../index.ts' : '../index.js', import.meta.url));
  return [process.execPath, ...(source ? ['--import', import.meta.resolve('tsx')] : []), entry].map(quote).join(' ') + ' webhook';
}

/** One line per webhook: the owner's description is what tells the agent when to use it. */
export function agentWebhooksPrompt(command: string, webhooks: readonly AgentWebhook[]): string | undefined {
  if (webhooks.length === 0) return undefined;
  const lines = webhooks.map((webhook) => `- "${webhook.name}"${webhook.description ? `: ${webhook.description.replace(/\s+/g, ' ').trim()}` : ''}`);
  return [
    '## Project webhooks',
    'The project owner lets you send reports to these webhooks. Read each description to decide when one applies, and use it instead of the channel it replaces (for example, a friction report goes to its webhook, not to a new GitHub issue):',
    ...lines,
    `Send one report with ${command} send '<name>' --message-file <report.md> [--title '<one line>'] [--data '<json object>'], or --message '<text>' for a short one. The message is Markdown; the report names this task. The command prints JSON: "ok": false means it was not delivered, and "error" says why. ${command} list prints the current list, which the owner can change while you work. Never put credentials or unrelated private data in a report.`,
  ].join('\n');
}
