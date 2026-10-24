import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { Cockpit, HttpResult } from '../task-cli/http.ts';
import { runWebhookCommand, type WebhookIo } from './cli.ts';

/** `cez webhook` (hearsay-tools/cezarion#1576): what each invocation asks the cockpit, and what
 *  it prints and exits with. The routes themselves are covered by project-webhooks-api.test.ts. */

const ENV = { CEZ_COCKPIT_URL: 'http://127.0.0.1:4321', CEZ_PROJECT_ID: 'proj', CEZ_TASK_ID: 'run-1' };

function harness(answer: (path: string, init?: { method?: string; body?: unknown }) => HttpResult) {
  const lines: string[] = [];
  const requests: Array<{ cockpit: Cockpit; path: string; init?: { method?: string; body?: unknown } }> = [];
  const io: WebhookIo = {
    stdout: (line) => lines.push(line),
    readFile: async (path) => (path === 'report.md' ? '# Friction\nSqueal skipped an edit.' : Promise.reject(new Error('ENOENT'))),
    http: async (cockpit, path, init) => {
      requests.push({ cockpit, path, init });
      return answer(path, init);
    },
  };
  return { io, lines, requests, json: () => JSON.parse(lines.at(-1)!) as Record<string, unknown> };
}

const sent = (ok: boolean) => ({
  status: 200,
  data: { ok, webhook: { id: 'friction', name: 'Friction reports' }, deliveryId: 'd-1', attempts: ok ? 1 : 3, ...(ok ? { status: 204 } : { status: 500, error: 'HTTP 500' }) },
});

describe('cez webhook', () => {
  it('lists the exposed webhooks through the project-scoped route', async () => {
    const h = harness(() => ({ status: 200, data: { webhooks: [{ id: 'friction', name: 'Friction reports', description: 'Tool friction' }] } }));
    expect(await runWebhookCommand(['list'], ENV, h.io)).toBe(0);
    expect(h.requests[0]!.cockpit.api).toBe('http://127.0.0.1:4321/api/v1/p/proj');
    expect(h.requests[0]!.path).toBe('/agent-webhooks');
    expect(h.json()).toEqual({ webhooks: [{ id: 'friction', name: 'Friction reports', description: 'Tool friction' }] });
  });

  it('sends a report from a file, naming this task, and exits 0 when delivered', async () => {
    const h = harness(() => sent(true));
    const code = await runWebhookCommand(['send', 'Friction reports', '--message-file', 'report.md', '--title', ' Squeal ', '--data', '{"severity":"low"}'], ENV, h.io);
    expect(code).toBe(0);
    expect(h.requests[0]!.path).toBe('/agent-webhooks/Friction%20reports');
    expect(h.requests[0]!.init).toEqual({
      method: 'POST',
      body: { message: '# Friction\nSqueal skipped an edit.', title: 'Squeal', data: { severity: 'low' }, runId: 'run-1' },
    });
    expect(h.json()).toMatchObject({ ok: true, webhook: { name: 'Friction reports' } });
  });

  it('exits 1 when the webhook did not take the report', async () => {
    const h = harness(() => sent(false));
    expect(await runWebhookCommand(['send', 'friction', '--message', 'hi'], ENV, h.io)).toBe(1);
    expect(h.json()).toMatchObject({ ok: false, error: 'HTTP 500' });
  });

  it('passes a refusal through verbatim and exits 2', async () => {
    const h = harness(() => ({ status: 404, data: { error: 'no webhook named "Task bot" is open to agents in this project' } }));
    expect(await runWebhookCommand(['send', 'Task bot', '--message', 'hi'], ENV, h.io)).toBe(2);
    expect(h.json()).toMatchObject({ code: 'refused', status: 404, error: 'no webhook named "Task bot" is open to agents in this project' });
  });

  it.each([
    [['send', 'x'], 'give the report as --message OR --message-file'],
    [['send', 'x', '--message', 'a', '--message-file', 'report.md'], 'give the report as --message OR --message-file'],
    [['send', 'x', '--message', '   '], 'the message is empty'],
    [['send', 'x', '--message', 'a', '--data', '[1]'], '--data must be a JSON object'],
    [['send', 'x', '--message', 'a', '--data', 'nope'], '--data must be a JSON object'],
    [['send', '--message', 'a'], 'send takes one webhook name or id'],
    [['list', 'extra'], 'list takes no positional arguments'],
    [['fire'], 'unknown command "fire"'],
  ])('refuses %j with exit 64 before looking for a cockpit', async (argv, error) => {
    const h = harness(() => sent(true));
    expect(await runWebhookCommand(argv, ENV, h.io)).toBe(64);
    expect(h.json()).toMatchObject({ code: 'invalid_input', error });
    expect(h.requests).toEqual([]);
  });

  it('refuses with exit 2 outside a task when no cockpit is named', async () => {
    const h = harness(() => sent(true));
    expect(await runWebhookCommand(['list'], {}, h.io)).toBe(2);
    expect(h.json()).toMatchObject({ code: 'no-cockpit' });
  });

  // bound: one cold `tsx` start of the whole CLI entry, which loads no server.
  it('is dispatched by the CLI entry before the cockpit flags are parsed', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../index.ts', import.meta.url)), 'webhook', '--help']);
    expect(stdout).toContain('cez webhook');
    expect(stdout).not.toContain('start the cockpit');
  }, 15_000);

  it('prints usage for --help', async () => {
    const h = harness(() => sent(true));
    expect(await runWebhookCommand(['--help'], ENV, h.io)).toBe(0);
    expect(h.lines[0]).toContain('cez webhook');
  });
});
