import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  agentWebhooksResponseSchema,
  sendAgentReportResponseSchema,
  type SendAgentReportInput,
} from '@open-mercato/cezar-contract/projects';
import { AGENT_REPORT_MESSAGE_MAX_LENGTH } from '@open-mercato/cezar-contract/project-limits';
import { EXIT } from '../task-cli/cli.ts';
import { resolveCockpit, type DiscoverOptions } from '../task-cli/discovery.ts';
import { invalidResponse, refuse, request, TaskCliError, type Cockpit, type HttpResult } from '../task-cli/http.ts';

/**
 * `cez webhook` (hearsay-tools/cezarion#1576): list the project webhooks the owner exposed to
 * agents, and send one report through one of them. Inside a task it reaches the cockpit through
 * `CEZ_COCKPIT_URL` and `CEZ_PROJECT_ID`, and names the reporting task with `CEZ_TASK_ID`.
 */

export interface WebhookIo {
  stdout(line: string): void;
  readFile?: (path: string) => Promise<string>;
  discover?: (options: DiscoverOptions) => Promise<Cockpit>;
  /** The transport; tests point it at a test app. */
  http?: (cockpit: Cockpit, path: string, init?: { method?: string; body?: unknown }) => Promise<HttpResult>;
}

const USAGE = `cez webhook — send reports to the project webhooks the owner exposed to agents.
One JSON object per invocation; exit 0 ok, 1 not delivered, 2 refused or no cockpit, 64 usage.

  list                                     the exposed webhooks: id, name and what each is for
  send <name|id> (--message <text> | --message-file <path>) [--title <text>] [--data '<json object>']
                                           POST one report (Markdown message) to that webhook; the
                                           report names this task when CEZ_TASK_ID is set

Address: CEZ_COCKPIT_URL + CEZ_PROJECT_ID (set inside a task). --url <origin> or --repo <dir> look
for a cockpit instead.`;

const NO_COCKPIT = 'no cockpit address — this command works inside a task run by a cockpit';

const ADDRESS_FLAGS = { url: { type: 'string' }, repo: { type: 'string' } } as const;
const SEND_FLAGS = {
  message: { type: 'string' },
  'message-file': { type: 'string' },
  title: { type: 'string' },
  data: { type: 'string' },
} as const;

function usageError(error: string): never {
  throw new TaskCliError(EXIT.usage, { code: 'invalid_input', error });
}

interface Parsed {
  command: 'list' | 'send';
  webhook: string;
  values: { url?: string; repo?: string; message?: string; 'message-file'?: string; title?: string; data?: string };
}

function parse(argv: string[]): Parsed {
  const [name, ...rest] = argv;
  if (name !== 'list' && name !== 'send') usageError(name === undefined ? 'missing command (list, send)' : `unknown command "${name}"`);
  let values: Parsed['values'];
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: name === 'send' ? { ...ADDRESS_FLAGS, ...SEND_FLAGS } : ADDRESS_FLAGS,
    }));
  } catch (error) {
    usageError(error instanceof Error ? error.message : String(error));
  }
  const expected = name === 'send' ? 1 : 0;
  if (positionals.length !== expected) usageError(name === 'send' ? 'send takes one webhook name or id' : 'list takes no positional arguments');
  return { command: name, webhook: positionals[0] ?? '', values };
}

async function reportBody(values: Parsed['values'], env: NodeJS.ProcessEnv, io: WebhookIo): Promise<SendAgentReportInput> {
  if ((values.message === undefined) === (values['message-file'] === undefined)) usageError('give the report as --message OR --message-file');
  let message = values.message;
  if (values['message-file'] !== undefined) {
    try {
      message = await (io.readFile ?? ((path: string) => readFile(path, 'utf8')))(values['message-file']);
    } catch (error) {
      usageError(`cannot read ${values['message-file']}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!message?.trim()) usageError('the message is empty');
  if (message.length > AGENT_REPORT_MESSAGE_MAX_LENGTH) usageError(`the message is longer than ${AGENT_REPORT_MESSAGE_MAX_LENGTH} characters`);
  let data: Record<string, unknown> | undefined;
  if (values.data !== undefined) {
    try {
      data = JSON.parse(values.data) as Record<string, unknown>;
    } catch {
      usageError('--data must be a JSON object');
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) usageError('--data must be a JSON object');
  }
  const runId = env.CEZ_TASK_ID?.trim();
  return {
    message,
    ...(values.title?.trim() ? { title: values.title.trim() } : {}),
    ...(data ? { data } : {}),
    ...(runId ? { runId } : {}),
  };
}

export async function runWebhookCommand(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: WebhookIo = { stdout: (line) => console.log(line) },
): Promise<number> {
  const print = (value: unknown) => io.stdout(JSON.stringify(value));
  try {
    if (argv.length === 0 || argv[0] === 'help' || argv.includes('--help') || argv.includes('-h')) {
      io.stdout(USAGE);
      return argv.length === 0 ? EXIT.usage : EXIT.ok;
    }
    // Input is judged before any cockpit is looked for: a usage error is 64 with or without one.
    const { command, webhook, values } = parse(argv);
    const body = command === 'send' ? await reportBody(values, env, io) : undefined;
    const cockpit = await resolveCockpit(env, values, io.discover, NO_COCKPIT);
    const http = io.http ?? request;
    if (command === 'list') {
      const result = await http(cockpit, '/agent-webhooks');
      if (result.status !== 200) refuse(result);
      const parsed = agentWebhooksResponseSchema.safeParse(result.data);
      if (!parsed.success) invalidResponse('webhook list');
      print(parsed.data);
      return EXIT.ok;
    }
    const result = await http(cockpit, `/agent-webhooks/${encodeURIComponent(webhook)}`, { method: 'POST', body });
    if (result.status !== 200) refuse(result);
    const parsed = sendAgentReportResponseSchema.safeParse(result.data);
    if (!parsed.success) invalidResponse('webhook send');
    print(parsed.data);
    return parsed.data.ok ? EXIT.ok : EXIT.failed;
  } catch (error) {
    if (error instanceof TaskCliError) {
      print(error.body);
      return error.exitCode;
    }
    throw error;
  }
}
